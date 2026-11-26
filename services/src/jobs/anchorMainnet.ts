import { atlasCmcAnchorAbi } from "../abi/index.js";
import { env } from "../config/env.js";
import { mainnet } from "../config/deployments.js";
import { signer } from "../lib/chains.js";
import { kvGet, kvSet } from "../lib/db.js";
import { errMsg } from "../lib/log.js";
import { sendTx } from "../lib/tx.js";
import { anchorRange } from "./logAnchor.js";
import { lastPlan, postSnapshot } from "./riskEngine.js";
import { HOUR, MIN, type Job } from "./types.js";

/**
 * anchor-mainnet (15 min), BSC mainnet (56), read-only contracts, no money. Uses its own mainnet keys
 * (K_RISK56 for RiskOracle56 + AtlasCmcAnchor, the LogAnchor56 key for the daily root); never the testnet keys.
 *  - RiskOracle56.post(): the same snapshot risk-engine built for 97 (same snapshotId / responseHash)
 *  - AtlasCmcAnchor.anchor(cmcPriceE18, cmcTs, respHash): reads Atlas 0xf25af… in the same tx and emits the gap
 *  - daily: LogAnchor56.anchor(root, fromSeq, toSeq)
 */
const PRIMARY = "NVDA";

export async function anchorMainnetOnce(dryRun = false, force = false) {
  const out: Record<string, unknown> = {};
  if (!env().MAINNET_ENABLED) return { skipped: "MAINNET_ENABLED=false" };
  const d = mainnet();
  if (!d) return { skipped: "no mainnet deployments" };
  const s = signer("risk56");
  const plan = await lastPlan(PRIMARY);
  if (!s) out.risk = { skipped: "RISK56_PRIVATE_KEY / MAINNET_PRIVATE_KEY not set" };
  else if (!plan) out.risk = { skipped: "no snapshot built yet" };
  else {
    if (d.core.riskOracle) {
      try {
        out.risk = await postSnapshot(s, d.core.riskOracle, plan, "anchor-mainnet", dryRun);
      } catch (e) {
        out.risk = { error: errMsg(e) };
      }
    }
    const anchor = d.mainnet?.atlasCmcAnchor;
    const lastKey = "mainnet:atlasCmcAnchor:lastCmcTs";
    let lastTs = (await kvGet<string>(lastKey)) ?? "0";
    if (anchor) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onchain = (await s.public.readContract({ address: anchor, abi: atlasCmcAnchorAbi, functionName: "lastCmcTs" as any })) as bigint;
        if (onchain > BigInt(lastTs)) lastTs = onchain.toString();
      } catch {
        /* older ABI without lastCmcTs */
      }
    }
    if (anchor && (force || plan.cmcTs > BigInt(lastTs))) {
      const r = await sendTx(s, "anchor-mainnet", { address: anchor, abi: atlasCmcAnchorAbi, functionName: "anchor", args: [plan.refPrice, plan.cmcTs, plan.responseHash] }, { dryRun, note: { snapshotId: plan.snapshotId } });
      if (r.ok && !dryRun) await kvSet(lastKey, plan.cmcTs.toString());
      out.atlasCmcAnchor = { ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
    } else if (anchor) out.atlasCmcAnchor = { skipped: "no newer CMC data" };
  }
  // daily LogAnchor56
  const la = d.core.logAnchor;
  const a56 = signer("anchor56");
  const dayKey = "mainnet:logAnchor:lastAt";
  const lastAt = (await kvGet<number>(dayKey)) ?? 0;
  if (la && a56 && (force || Date.now() - lastAt >= 24 * HOUR)) {
    try {
      const r = await anchorRange(a56, la, "anchor-mainnet", dryRun);
      if ((r as { ok?: boolean }).ok && !dryRun) await kvSet(dayKey, Date.now());
      out.logAnchor56 = r;
    } catch (e) {
      out.logAnchor56 = { error: errMsg(e) };
    }
  }
  return out;
}

export const anchorMainnetJob: Job = { name: "mainnet", everyMs: 15 * MIN, needsDb: true, run: (ctx) => anchorMainnetOnce(ctx.dryRun, ctx.force) };
