"use client";
// Opens a MORE market launch on Flap from the connected wallet, exactly as contracts/script/FlapLaunch.s.sol
// `newLauncher()` does: mine a 0x7777 salt, register the predicted Launcher as a pool creator (CreatorRegistrar,
// permissionless for an allowed factory) if needed, then Portal.newLauncher{value: SALT_LOCK_FEE}(factory, config).
import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useConfig, useReadContracts } from "wagmi";
import { getBytecode, readContract } from "wagmi/actions";
import { CreatorRegistrarAbi, PoolFactoryAbi, SplitLauncherFactoryAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { useTx } from "@/hooks/useTx";
import { FlapPortalAbi, buildMeta, encodeSplitConfig } from "@/lib/flapLaunch";
import { mineSalt7777 } from "@/lib/salt7777";

export const FLAP = {
  portal: addr(deployments97.flap.portal),
  factory: addr(deployments97.flap.launcherFactory),
  registrar: addr(deployments97.core.creatorRegistrar),
  poolFactory: addr(deployments97.core.poolFactory),
};

export type MyLaunch = {
  launcher: Address;
  token: Address;
  stock: string;
  name: string;
  symbol: string;
  targetLeverage: number;
  targetRaise: string; // wei, as a string (bigint is not JSON)
  tx?: Hex;
  createdAt: number;
  /** "four": a launch on OpenFour (Four.meme); `launcher` then holds the launch token address. */
  venue?: "four";
  /** The market the launch opened, once known. */
  pool?: Address;
};

const LS_LAUNCHES = "more.flapLaunches.v1";
const LS_PENDING = "more.flapPendingSalt.v1";

function lsGet<T>(k: string): T | undefined {
  try {
    const v = window.localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
function lsSet(k: string, v: unknown) {
  try {
    if (v === undefined) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode / blocked storage: in-memory only */
  }
}

/** Launches this browser created, newest first. Persisted in localStorage. */
export function useMyLaunches() {
  const [list, setList] = useState<MyLaunch[]>([]);
  useEffect(() => {
    const v = lsGet<MyLaunch[]>(LS_LAUNCHES);
    if (Array.isArray(v)) setList(v.filter((x) => x && isAddress(x.launcher ?? "")));
  }, []);
  const add = useCallback((l: MyLaunch) => {
    setList((prev) => {
      const next = [l, ...prev.filter((p) => p.launcher.toLowerCase() !== l.launcher.toLowerCase())];
      lsSet(LS_LAUNCHES, next);
      return next;
    });
  }, []);
  const remove = useCallback((launcher: Address) => {
    setList((prev) => {
      const next = prev.filter((p) => p.launcher.toLowerCase() !== launcher.toLowerCase());
      lsSet(LS_LAUNCHES, next);
      return next;
    });
  }, []);
  return { list, add, remove };
}

export type LaunchStep = "idle" | "mining" | "checking" | "register" | "launch" | "done" | "error";

export type LaunchParams = {
  stock: string;
  targetLeverage: number;
  targetRaise: bigint;
  backstopSeed: bigint;
  saleDurationSec: number;
};

/** Live factory parameters for the form: minimum pool quote, lock fee, paired vault factory. */
export function useFlapFactoryInfo() {
  const r = useReadContracts({
    allowFailure: true,
    query: { enabled: !!FLAP.factory && !!FLAP.portal, refetchInterval: 60_000 },
    contracts: [
      { address: FLAP.factory!, abi: SplitLauncherFactoryAbi, functionName: "minPoolQuote", chainId: bscTestnet.id },
      { address: FLAP.portal!, abi: FlapPortalAbi, functionName: "SALT_LOCK_FEE", chainId: bscTestnet.id },
      { address: FLAP.factory!, abi: SplitLauncherFactoryAbi, functionName: "poolSymbol", chainId: bscTestnet.id },
    ],
  });
  const v = <T,>(i: number) => (r.data?.[i]?.status === "success" ? (r.data[i].result as T) : undefined);
  return { minPoolQuote: v<bigint>(0), lockFee: v<bigint>(1), stock: v<string>(2), loading: r.isLoading };
}

export function useFlapLaunch(onCreated: (l: MyLaunch) => void) {
  const config = useConfig();
  const { send, pending, isConnected } = useTx();
  const [step, setStep] = useState<LaunchStep>("idle");
  const [tries, setTries] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const start = useCallback(
    async (p: LaunchParams) => {
      if (busy.current) return;
      const { portal, factory, registrar, poolFactory } = FLAP;
      if (!portal || !factory || !registrar || !poolFactory) {
        setError("The Flap launcher is not deployed on this network.");
        setStep("error");
        return;
      }
      busy.current = true;
      setError(null);
      const fail = (m: string) => {
        setError(m);
        setStep("error");
      };
      try {
        const rd = <T,>(args: Parameters<typeof readContract>[1]) => readContract(config, { ...args, chainId: bscTestnet.id } as never) as Promise<T>;

        // 1. Salt: reuse an unused one from an earlier attempt (it may already be registered), else mine a new one.
        let salt: Hex | undefined;
        const prev = lsGet<{ salt: Hex; factory: Address }>(LS_PENDING);
        if (prev?.salt && prev.factory?.toLowerCase() === factory.toLowerCase()) {
          const l = await rd<Address>({ address: factory, abi: SplitLauncherFactoryAbi, functionName: "predictLauncher", args: [prev.salt] });
          const code = await getBytecode(config, { address: l, chainId: bscTestnet.id });
          if (!code || code === "0x") salt = prev.salt;
        }
        if (!salt) {
          setStep("mining");
          setTries(0);
          const m = await mineSalt7777(portal, { onProgress: setTries });
          setTries(m.tries);
          salt = m.salt;
        }

        // 2. Confirm on-chain: the factory predicts a 0x7777 token for this salt.
        setStep("checking");
        const [token, ok] = await rd<readonly [Address, boolean]>({ address: factory, abi: SplitLauncherFactoryAbi, functionName: "predictToken", args: [salt] });
        if (!ok) return fail("The mined address does not end in 7777. Try again.");
        lsSet(LS_PENDING, { salt, factory });
        const launcher = await rd<Address>({ address: factory, abi: SplitLauncherFactoryAbi, functionName: "predictLauncher", args: [salt] });
        const vaultFactory = await rd<Address>({ address: factory, abi: SplitLauncherFactoryAbi, functionName: "pairedVaultFactory" });
        const fee = await rd<bigint>({ address: portal, abi: FlapPortalAbi, functionName: "SALT_LOCK_FEE" });

        // 3. Let the launcher open a pool when the raise fills (permissionless for this factory).
        const isCreator = await rd<boolean>({ address: poolFactory, abi: PoolFactoryAbi, functionName: "isCreator", args: [launcher] });
        if (!isCreator) {
          setStep("register");
          const r = await send({ address: registrar, abi: CreatorRegistrarAbi, functionName: "registerFlapLauncher", args: [factory, salt], label: "Register market launcher" });
          if (!r || r.status !== "success") return fail("Registering the launcher did not go through. Nothing was spent except gas; you can try again.");
        }

        // 4. Create the launch on Flap.
        setStep("launch");
        const name = `${p.stock} Market`;
        const symbol = `${p.stock}M`;
        const data = encodeSplitConfig({
          name,
          symbol,
          meta: buildMeta(p.stock, p.targetLeverage),
          salt,
          targetRaise: p.targetRaise,
          backstopSeed: p.backstopSeed,
          saleDuration: BigInt(p.saleDurationSec),
          vaultFactory,
        });
        const r2 = await send({ address: portal, abi: FlapPortalAbi, functionName: "newLauncher", args: [factory, data], value: fee, label: "Send to Flap" });
        if (!r2 || r2.status !== "success") return fail("The launch was not created. You can try again; the same address is reused.");
        lsSet(LS_PENDING, undefined);
        onCreated({
          launcher,
          token,
          stock: p.stock,
          name,
          symbol,
          targetLeverage: Math.round(p.targetLeverage * 10) / 10,
          targetRaise: p.targetRaise.toString(),
          tx: r2.transactionHash,
          createdAt: Date.now(),
        });
        setStep("done");
      } catch (e) {
        fail(e instanceof Error ? e.message.split("\n")[0] : String(e));
      } finally {
        busy.current = false;
      }
    },
    [config, send, onCreated],
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
  }, []);

  return { start, reset, step, tries, error, pending, isConnected, busy: step === "mining" || step === "checking" || step === "register" || step === "launch" };
}
