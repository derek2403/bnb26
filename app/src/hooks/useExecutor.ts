"use client";
import { useCallback, useMemo } from "react";
import { parseSignature, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { useConfig, usePublicClient } from "wagmi";
import { signTypedData } from "wagmi/actions";
import { LeveragePoolAbi, MockERC20PermitAbi, erc20Abi } from "@/abi";
import { useDemoWallet } from "@/components/DemoWallet";
import { useToast } from "@/components/Toaster";
import { toNum, MAX_UINT } from "@/lib/format";
import * as sim from "@/lib/sim";
import type { ActionName, Quote } from "@/lib/types";
import type { PoolDetail } from "./usePools";
import { describeError, useTx } from "./useTx";

export type Executor = {
  mode: "chain" | "simulation";
  /** Units for each action's input: asset decimals for mints, 18 for sUSD/x. */
  inputDecimals: (a: ActionName) => number;
  quote: (a: ActionName, amount: bigint) => Promise<Quote>;
  needsApproval: (a: ActionName, amount: bigint) => boolean;
  approve: (amount: bigint) => Promise<void>;
  run: (a: ActionName, amount: bigint, q: Quote, opts: { permit: boolean }) => Promise<boolean>;
  faucet: () => Promise<void>;
  supportsPermit: boolean;
  pending: string | null;
};

const SLIPPAGE_BPS = 50n; // 0.5%
const minOf = (v?: bigint) => (v ? (v * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n);
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

const LABEL: Record<ActionName, string> = {
  mintStable: "Mint sUSD",
  mintLever: "Mint xSTOCK",
  redeemStable: "Redeem sUSD",
  redeemLever: "Redeem xSTOCK",
  redeemPair: "Redeem pair",
};

export function useRealExecutor(d: PoolDetail): Executor {
  const client = usePublicClient({ chainId: bscTestnet.id });
  const config = useConfig();
  const { send, pending, account } = useTx();
  const toast = useToast();
  const a = d.meta?.addresses;
  const pool = a?.pool as Address;
  const ad = d.decimals.asset;

  const quote = useCallback(
    async (act: ActionName, amount: bigint): Promise<Quote> => {
      if (!client || !pool || amount <= 0n) return { out: 0, feeBps: 0 };
      try {
        switch (act) {
          case "mintStable": {
            const [out, fee] = await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintStable", args: [amount] });
            return { out: toNum(out), feeBps: Number(fee), raw: { out } };
          }
          case "mintLever": {
            const [out, fee] = await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewMintLever", args: [amount] });
            return { out: toNum(out), feeBps: Number(fee), raw: { out } };
          }
          case "redeemStable": {
            const [c, u, fee] = await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewRedeemStable", args: [amount] });
            const cOut = toNum(c, ad);
            const uOut = toNum(u, d.decimals.usdc);
            return { out: cOut * (d.snap?.price ?? 0) + uOut, cOut, uOut, feeBps: Number(fee), raw: { cOut: c, uOut: u } };
          }
          case "redeemLever": {
            const [c, u, fee] = await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewRedeemLever", args: [amount] });
            const cOut = toNum(c, ad);
            const uOut = toNum(u, d.decimals.usdc);
            return { out: cOut * (d.snap?.price ?? 0) + uOut, cOut, uOut, feeBps: Number(fee), raw: { cOut: c, uOut: u } };
          }
          case "redeemPair": {
            const S = d.snap?.S ?? 0;
            const X = d.snap?.X ?? 0;
            const userX = d.user?.x ?? 0n;
            // xMax in the pool's S:X ratio (+0.1%), capped at the wallet balance.
            let xMax = S > 0 ? (amount * BigInt(Math.floor((X / S) * 1e9)) * 1001n) / (1000n * 10n ** 9n) : userX;
            if (xMax > userX) xMax = userX;
            const [sB, xB, c, u] = await client.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "previewRedeemPair", args: [amount, xMax] });
            const cOut = toNum(c, ad);
            const uOut = toNum(u, d.decimals.usdc);
            return { out: cOut * (d.snap?.price ?? 0) + uOut, cOut, uOut, sBurned: toNum(sB), xBurned: toNum(xB), feeBps: d.snap?.redeemFeeBps ?? 20, raw: { sBurned: sB, xBurned: xMax, cOut: c, uOut: u } };
          }
        }
      } catch (e) {
        return { out: 0, feeBps: 0, error: describeError(e).split("\n")[0] };
      }
      return { out: 0, feeBps: 0 };
    },
    [client, pool, ad, d.decimals.usdc, d.snap?.price, d.snap?.S, d.snap?.X, d.user?.x],
  );

  const needsApproval = useCallback(
    (act: ActionName, amount: bigint) => (act === "mintStable" || act === "mintLever") && !!d.user && d.user.assetAllowance < amount,
    [d.user],
  );

  const approve = useCallback(
    async (amount: bigint) => {
      if (!a?.asset) return;
      await send({ address: a.asset, abi: erc20Abi, functionName: "approve", args: [pool, amount > 0n ? amount : MAX_UINT], label: `Approve ${d.meta?.assetSymbol}` });
      d.refetch();
    },
    [a?.asset, pool, send, d],
  );

  const run = useCallback(
    async (act: ActionName, amount: bigint, q: Quote, opts: { permit: boolean }) => {
      if (!pool) return false;
      const sym = d.meta?.symbol ?? "";
      const label = `${LABEL[act].replace("STOCK", sym)}${act === "mintStable" ? `-${sym}` : ""}`;
      let receipt = null;
      if ((act === "mintStable" || act === "mintLever") && opts.permit && a?.asset && account && client) {
        try {
          const [name, nonce] = await Promise.all([
            client.readContract({ address: a.asset, abi: MockERC20PermitAbi, functionName: "name" }),
            client.readContract({ address: a.asset, abi: MockERC20PermitAbi, functionName: "nonces", args: [account] }),
          ]);
          const permitDeadline = deadline();
          const signature = await signTypedData(config, {
            domain: { name, version: "1", chainId: bscTestnet.id, verifyingContract: a.asset },
            types: { Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ] },
            primaryType: "Permit",
            message: { owner: account, spender: pool, value: amount, nonce, deadline: permitDeadline },
          });
          const { r, s, v, yParity } = parseSignature(signature);
          const vv = Number(v ?? BigInt(27 + (yParity ?? 0)));
          receipt = await send({
            address: pool,
            abi: LeveragePoolAbi,
            functionName: act === "mintStable" ? "mintStableWithPermit" : "mintLeverWithPermit",
            args: [amount, minOf(q.raw?.out), deadline(), permitDeadline, vv, r, s],
            label: `${label} (permit)`,
          });
        } catch (e) {
          toast.push({ kind: "error", title: "Permit signature cancelled", body: e instanceof Error ? e.message.split("\n")[0] : String(e) });
          return false;
        }
      } else if (act === "mintStable" || act === "mintLever") {
        receipt = await send({ address: pool, abi: LeveragePoolAbi, functionName: act, args: [amount, minOf(q.raw?.out), deadline()], label });
      } else if (act === "redeemStable" || act === "redeemLever") {
        receipt = await send({ address: pool, abi: LeveragePoolAbi, functionName: act, args: [amount, minOf(q.raw?.cOut), minOf(q.raw?.uOut)], label });
      } else if (act === "redeemPair") {
        receipt = await send({ address: pool, abi: LeveragePoolAbi, functionName: "redeemPair", args: [amount, q.raw?.xBurned ?? 0n, minOf(q.raw?.cOut), minOf(q.raw?.uOut)], label });
      }
      d.refetch();
      return receipt?.status === "success";
    },
    [pool, a?.asset, account, client, config, send, d, toast],
  );

  const faucet = useCallback(async () => {
    if (!a?.asset) return;
    await send({ address: a.asset, abi: MockERC20PermitAbi, functionName: "faucet", label: `Faucet ${d.meta?.assetSymbol}` });
    d.refetch();
  }, [a?.asset, send, d]);

  return useMemo(
    () => ({
      mode: "chain" as const,
      inputDecimals: (act: ActionName) => (act === "mintStable" || act === "mintLever" ? ad : 18),
      quote,
      needsApproval,
      approve,
      run,
      faucet,
      supportsPermit: true,
      pending,
    }),
    [ad, quote, needsApproval, approve, run, faucet, pending],
  );
}

export function useDemoExecutor(d: PoolDetail): Executor {
  const wallet = useDemoWallet();
  const toast = useToast();
  const id = d.meta?.id ?? "";
  const s = d.sim;

  const quote = useCallback(
    async (act: ActionName, amount: bigint): Promise<Quote> => {
      if (!s || amount <= 0n) return { out: 0, feeBps: 0 };
      return sim.quote(s, act, toNum(amount));
    },
    [s],
  );

  const run = useCallback(
    async (act: ActionName, amount: bigint) => {
      if (!s) return false;
      const n = toNum(amount);
      const b = wallet.balances(id);
      try {
        const label = `${LABEL[act].replace("STOCK", d.meta?.symbol ?? "")}`;
        const need = act === "mintStable" || act === "mintLever" ? b.asset : act === "redeemLever" ? b.x : b.sUSD;
        if (n > need + 1e-9) throw new sim.SimError("ERC20InsufficientBalance");
        let lines: string[] = [];
        if (act === "mintStable") {
          const r = sim.mintStable(s, n);
          wallet.apply(id, { asset: -n, sUSD: r.quote.out }, { dC: n, dS: r.quote.out });
          lines = [`Minted user cIn=${n.toFixed(4)} out=${r.quote.out.toFixed(4)} feeBps=${r.quote.feeBps}`];
        } else if (act === "mintLever") {
          const r = sim.mintLever(s, n);
          wallet.apply(id, { asset: -n, x: r.quote.out }, { dC: n, dX: r.quote.out });
          lines = [`Minted user cIn=${n.toFixed(4)} out=${r.quote.out.toFixed(4)} feeBps=${r.quote.feeBps}`];
        } else if (act === "redeemStable") {
          const r = sim.redeemStable(s, n);
          wallet.apply(id, { sUSD: -n, asset: r.quote.cOut ?? 0, usdc: r.quote.uOut ?? 0 }, { dS: -n, dC: -(r.quote.cOut ?? 0), dU: -(r.quote.uOut ?? 0) });
          lines = [`Redeemed sBurned=${n.toFixed(4)} cOut=${(r.quote.cOut ?? 0).toFixed(4)} uOut=${(r.quote.uOut ?? 0).toFixed(2)}`];
        } else if (act === "redeemLever") {
          const r = sim.redeemLever(s, n);
          wallet.apply(id, { x: -n, asset: r.quote.cOut ?? 0, usdc: r.quote.uOut ?? 0 }, { dX: -n, dC: -(r.quote.cOut ?? 0), dU: -(r.quote.uOut ?? 0) });
          lines = [`Redeemed xBurned=${n.toFixed(4)} cOut=${(r.quote.cOut ?? 0).toFixed(4)} uOut=${(r.quote.uOut ?? 0).toFixed(2)}`];
        } else if (act === "redeemPair") {
          const xMax = Math.min(b.x, s.S > 0 ? (n * s.X) / s.S : 0);
          const r = sim.redeemPair(s, n, xMax);
          const sb = r.quote.sBurned ?? 0;
          const xb = r.quote.xBurned ?? 0;
          wallet.apply(id, { sUSD: -sb, x: -xb, asset: r.quote.cOut ?? 0, usdc: r.quote.uOut ?? 0 }, { dS: -sb, dX: -xb, dC: -(r.quote.cOut ?? 0), dU: -(r.quote.uOut ?? 0) });
          lines = [`Redeemed sBurned=${sb.toFixed(4)} xBurned=${xb.toFixed(4)} cOut=${(r.quote.cOut ?? 0).toFixed(4)}`];
        }
        toast.push({ kind: "success", title: `${label}: done (simulation)`, body: "Simulated pool: nothing was sent on-chain.", lines });
        return true;
      } catch (e) {
        toast.push({ kind: "error", title: `${LABEL[act]}: failed (simulation)`, body: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    [s, wallet, id, toast, d.meta?.symbol],
  );

  const faucet = useCallback(async () => {
    const units = s && s.P > 0 ? Math.max(1, Math.round(2000 / s.P)) : 10;
    wallet.apply(id, { asset: units }, {});
    toast.push({ kind: "success", title: `Faucet ${d.meta?.assetSymbol}: +${units} (simulation)`, body: "Simulated balance for this demo pool." });
  }, [s, wallet, id, toast, d.meta?.assetSymbol]);

  return useMemo(
    () => ({
      mode: "simulation" as const,
      inputDecimals: () => 18,
      quote,
      needsApproval: () => false,
      approve: async () => {},
      run: (act: ActionName, amount: bigint) => run(act, amount),
      faucet,
      supportsPermit: false,
      pending: null,
    }),
    [quote, run, faucet],
  );
}
