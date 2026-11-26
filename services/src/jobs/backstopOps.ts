import type { Abi, Address } from "viem";
import {
  backstopTreasuryAbi,
  backstopVaultAbi,
  creatorRegistrarAbi,
  flapTaxProcessorAbi,
  flapTaxTokenAbi,
  leveragePoolAbi,
  poolFactoryAbi,
  splitLauncherAbi,
} from "../abi/index.js";
import { kvGet, kvSet } from "../lib/db.js";
import { testnet } from "../config/deployments.js";
import { signer, publicClient, type Signer } from "../lib/chains.js";
import { errMsg } from "../lib/log.js";
import { WAD } from "../lib/math.js";
import { listPools } from "../lib/pools.js";
import { sendTx } from "../lib/tx.js";
import { MIN, type Job } from "./types.js";

/**
 * backstop-ops (10 min), all permissionless calls from K_OPS, each simulated first and sent only if it passes:
 *  - Flap TaxProcessor.dispatch() per SPLIT launcher (moves accrued tax into the VAULT slot -> BackstopVault)
 *  - BackstopTreasury.sweep() (OpenFour preset fees from FeeRouter)
 *  - cover(pool) on BackstopVault / BackstopTreasury for every pool whose CR < 1 (donate is capped at S − V on-chain)
 *  - SplitLauncher.openPool() once the SPLIT launch happened and the pool is not open yet (anyone may call it once);
 *    if the launcher lacks PoolFactory CREATOR_ROLE, CreatorRegistrar.registerFlapLauncher(factory, launchSalt) first
 *  - BackstopVault.sync() (revenue accounting) and, hourly, valueBuffer() (reads Atlas BNB/USD in-tx, emits BufferValued)
 *  - pegKeep() / milestone() when the deployed vault ABI has them (optional extras from the plan)
 * canCover(pool) is checked before cover(pool) when the ABI exposes it.
 */
function hasFn(abi: Abi | readonly unknown[], name: string): boolean {
  return (abi as readonly { type?: string; name?: string }[]).some((x) => x.type === "function" && x.name === name);
}

/** Grants CREATOR_ROLE to a Flap launcher through the permissionless CreatorRegistrar when it is missing. */
async function ensureFlapCreator(s: Signer, launcher: Address, dryRun: boolean) {
  const d = testnet();
  const registrar = d?.core?.creatorRegistrar as Address | undefined;
  const factory = d?.core?.poolFactory as Address | undefined;
  const lf = d?.flap?.launcherFactory as Address | undefined;
  const zero = (a?: string) => !a || /^0x0{40}$/i.test(a);
  if (zero(registrar) || zero(factory) || zero(lf)) return undefined;
  const c = publicClient("testnet");
  try {
    if (await c.readContract({ address: factory!, abi: poolFactoryAbi, functionName: "isCreator", args: [launcher] })) return undefined;
    if (!(await c.readContract({ address: registrar!, abi: creatorRegistrarAbi, functionName: "flapFactoryAllowed", args: [lf!] }))) {
      return { fn: "registerFlapLauncher", address: registrar, ok: false, reason: "flap.launcherFactory not allowlisted (run ConfigureRegistrar)" };
    }
    const salt = await c.readContract({ address: launcher, abi: splitLauncherAbi, functionName: "launchSalt" });
    return await tryCall(s, registrar!, creatorRegistrarAbi, "registerFlapLauncher", [lf!, salt], dryRun, { launcher });
  } catch (e) {
    return { fn: "registerFlapLauncher", address: registrar, ok: false, reason: errMsg(e) };
  }
}

async function tryCall(s: Signer, address: Address, abi: Abi | readonly unknown[], fn: string, args: readonly unknown[], dryRun: boolean, note: unknown) {
  const r = await sendTx(s, "backstop-ops", { address, abi, functionName: fn, args }, { dryRun, note });
  return { fn, address, ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
}

export async function backstopOnce(dryRun = false) {
  const d = testnet();
  const s = signer("ops");
  if (!s) return [{ skipped: "OPS_PRIVATE_KEY not set" }];
  const out: Record<string, unknown>[] = [];
  const c = publicClient("testnet");

  // 1. Flap tax dispatch
  for (const l of d?.flap?.launchers ?? []) {
    let tp = l.taxProcessor;
    if (!tp && l.token) {
      try {
        tp = await c.readContract({ address: l.token, abi: flapTaxTokenAbi, functionName: "taxProcessor" });
      } catch {
        tp = undefined;
      }
    }
    if (tp) out.push(await tryCall(s, tp, flapTaxProcessorAbi, "dispatch", [], dryRun, { launcher: l.launcher }));
    if (l.launcher && hasFn(splitLauncherAbi, "openPool")) {
      try {
        const [launched, opened] = await Promise.all([
          c.readContract({ address: l.launcher, abi: splitLauncherAbi, functionName: "launched" }),
          c.readContract({ address: l.launcher, abi: splitLauncherAbi, functionName: "poolOpened" }),
        ]);
        if (launched && !opened) {
          const reg = await ensureFlapCreator(s, l.launcher, dryRun);
          if (reg) out.push(reg);
          out.push(await tryCall(s, l.launcher, splitLauncherAbi, "openPool", [], dryRun, { launcher: l.launcher }));
        }
      } catch (e) {
        out.push({ launcher: l.launcher, error: errMsg(e) });
      }
    }
    if (l.vault) {
      if (hasFn(backstopVaultAbi, "sync")) out.push(await tryCall(s, l.vault, backstopVaultAbi, "sync", [], dryRun, { vault: l.vault }));
      const vKey = `backstop:valueBuffer:${l.vault.toLowerCase()}`;
      if (hasFn(backstopVaultAbi, "valueBuffer") && Date.now() - ((await kvGet<number>(vKey)) ?? 0) >= 3_600_000) {
        const r = await tryCall(s, l.vault, backstopVaultAbi, "valueBuffer", [], dryRun, { vault: l.vault });
        if (r.ok && !dryRun) await kvSet(vKey, Date.now());
        out.push(r);
      }
      for (const fn of ["pegKeep", "milestone"]) if (hasFn(backstopVaultAbi, fn)) out.push(await tryCall(s, l.vault, backstopVaultAbi, fn, [], dryRun, { vault: l.vault }));
    }
  }

  // 2. OpenFour treasury sweep
  const treasury = d?.openfour?.backstopTreasury;
  if (treasury) out.push(await tryCall(s, treasury, backstopTreasuryAbi, "sweep", [], dryRun, {}));

  // 3. cover pools under water (CR < 1)
  const vaults = (d?.flap?.launchers ?? []).filter((l) => l.vault).map((l) => ({ addr: l.vault!, poolId: l.poolId, abi: backstopVaultAbi as Abi | readonly unknown[], kind: "vault" }));
  if (treasury) vaults.push({ addr: treasury, poolId: undefined, abi: backstopTreasuryAbi, kind: "treasury" });
  for (const p of await listPools()) {
    try {
      const st = await c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "state" });
      if (st.S === 0n || st.collateralRatio >= WAD) continue;
      // prefer the backstop that belongs to this pool's launch; any registered donor may still cover
      const ordered = [...vaults.filter((v) => v.poolId === p.id), ...vaults.filter((v) => v.poolId !== p.id)];
      for (const v of ordered) {
        if (!hasFn(v.abi, "cover")) continue;
        if (hasFn(v.abi, "canCover")) {
          try {
            const can = await c.readContract({ address: v.addr, abi: v.abi as Abi, functionName: "canCover", args: [p.address] });
            if (!can) continue;
          } catch {
            /* fall through to the simulation */
          }
        }
        const r = await tryCall(s, v.addr, v.abi, "cover", [p.address], dryRun, { pool: p.id, cr: st.collateralRatio.toString() });
        out.push({ pool: p.id, backstop: v.kind, ...r });
        if (r.ok) break;
      }
    } catch (e) {
      out.push({ pool: p.id, error: errMsg(e) });
    }
  }
  return out;
}

export const backstopOpsJob: Job = { name: "backstop", everyMs: 10 * MIN, run: (ctx) => backstopOnce(ctx.dryRun) };
