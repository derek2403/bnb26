import { concat, keccak256, type Address, type Hex } from "viem";
import { riskOracleAbi } from "../abi/index.js";
import { cmcAsset } from "../config/assets.js";
import { assetIdOf, riskSymbols, testnet } from "../config/deployments.js";
import { alert } from "../lib/alerts.js";
import { publicClient, signer, type Signer } from "../lib/chains.js";
import { toJsonValue } from "../lib/canonical.js";
import { db, kvGet, kvSet } from "../lib/db.js";
import { appendLog } from "../lib/hashlog.js";
import { errMsg, logger } from "../lib/log.js";
import { annualisedVolBps, median, nowSec, toFixed } from "../lib/math.js";
import { sendTx } from "../lib/tx.js";
import { getLatest, loadCandles, type Latest } from "./cmcCollector.js";
import { MIN, type Job } from "./types.js";
import type postgres from "postgres";

const log = logger("risk-engine");

/**
 * risk-engine (5 min): turns the latest keyed CMC data into a RiskOracle Snapshot and posts it (K_RISK97).
 * The rule params (trigger from σ, chunk from liquidity, open fee from premium) are computed ON-CHAIN from
 * these inputs, so a judge can recompute them from the CmcSnapshot event.
 *
 *   refPrice    = median(DEX price `p`, quotes/latest price, RWA tokenized price)      (fresh components only)
 *   volBps      = annualised σ of 1h log returns of k-line closes (last 7 days), 0 = unknown
 *   liqUsd      = DEX price `l`, or Σ pool liquidity from /v1/dex/token/pools when `l` is 0
 *   premiumBps  = RWA underlying vs tokenized premium
 *   cmcTs       = newest CMC status.timestamp among the components (seconds)
 *   snapshotId  = seq of the hash-log "snapshot" entry describing this snapshot (strictly increasing)
 *   responseHash= keccak256( bodyHash_1 ‖ bodyHash_2 ‖ … ) in the order listed in that entry's data.components
 */
export interface SnapshotPlan {
  asset: string;
  assetId: Hex;
  refPrice: bigint;
  volBps: bigint;
  liqUsd: bigint;
  premiumBps: bigint;
  cmcTs: bigint;
  snapshotId: bigint;
  responseHash: Hex;
  components: { kind: string; bodyHash: string; logSeq?: number; cmcTs?: number; value?: number }[];
  inputs: { dexPrice?: number; quotePrice?: number; rwaTokenized?: number; liqUsd?: number; volBps: number; premiumBps?: number; candles: number };
}

const FRESH_MS: Record<string, number> = { dex_price: 20 * MIN, quotes: 35 * MIN, rwa: 75 * MIN, pools: 3 * 60 * MIN, kline: 3 * 60 * MIN };

function fresh(l: Latest | undefined): l is Latest {
  if (!l) return false;
  const lim = FRESH_MS[l.kind] ?? 30 * MIN;
  return Date.now() - Date.parse(l.fetchedAt) <= lim;
}

export async function buildSnapshot(symbol: string, minCmcTs = 0n): Promise<{ plan?: SnapshotPlan; reason?: string }> {
  const a = cmcAsset(symbol);
  if (!a) return { reason: `no CMC asset config for ${symbol}` };
  const [dex, quotes, rwa, pools, kline] = await Promise.all([
    getLatest("dex_price", symbol),
    getLatest("quotes", symbol),
    getLatest("rwa", symbol),
    getLatest("pools", symbol),
    getLatest("kline", symbol),
  ]);
  const components: SnapshotPlan["components"] = [];
  const prices: number[] = [];
  const dexPrice = fresh(dex) ? (dex.parsed.price as number | undefined) : undefined;
  if (dex && dexPrice) {
    prices.push(dexPrice);
    components.push({ kind: "dex_price", bodyHash: dex.bodyHash, logSeq: dex.logSeq, cmcTs: dex.cmcTs, value: dexPrice });
  }
  const quotePrice = fresh(quotes) ? (quotes.parsed.price as number | undefined) : undefined;
  if (quotes && quotePrice) {
    prices.push(quotePrice);
    components.push({ kind: "quotes", bodyHash: quotes.bodyHash, logSeq: quotes.logSeq, cmcTs: quotes.cmcTs, value: quotePrice });
  }
  const rwaTok = fresh(rwa) ? ((rwa.parsed.tokenized ?? rwa.parsed.averageTokenized) as number | undefined) : undefined;
  const premium = fresh(rwa) ? (rwa.parsed.premiumBps as number | undefined) : undefined;
  if (rwa && (rwaTok || premium !== undefined)) {
    if (rwaTok) prices.push(rwaTok);
    components.push({ kind: "rwa", bodyHash: rwa.bodyHash, logSeq: rwa.logSeq, cmcTs: rwa.cmcTs, value: rwaTok });
  }
  const ref = median(prices);
  if (!ref) return { reason: "no fresh CMC price component" };

  const candles = await loadCandles(symbol, "1h", nowSec() - 7 * 24 * 3600);
  const vol = annualisedVolBps(candles.map((c) => c.c));
  if (kline && fresh(kline) && vol > 0) components.push({ kind: "kline", bodyHash: kline.bodyHash, logSeq: kline.logSeq, cmcTs: kline.cmcTs, value: vol });

  let liq = dexPrice && dex ? ((dex.parsed.liquidityUsd as number | undefined) ?? 0) : 0;
  if (!(liq > 0) && pools && fresh(pools)) {
    liq = (pools.parsed.totalLiquidityUsd as number | undefined) ?? 0;
    if (liq > 0) components.push({ kind: "pools", bodyHash: pools.bodyHash, logSeq: pools.logSeq, cmcTs: pools.cmcTs, value: liq });
  }

  const tsMs = Math.max(...components.map((c) => c.cmcTs ?? 0));
  if (!(tsMs > 0)) return { reason: "components carry no CMC timestamp" };
  const cmcTs = BigInt(Math.min(Math.floor(tsMs / 1000), nowSec() + 20));
  if (cmcTs <= minCmcTs) return { reason: `no newer CMC data (on-chain cmcTs ${minCmcTs}, ours ${cmcTs})` };
  const responseHash = keccak256(concat(components.map((c) => c.bodyHash as Hex)));

  const entry = await appendLog({
    service: "risk-engine",
    kind: "snapshot",
    endpoint: "RiskOracle.post",
    bodyHash: responseHash,
    data: { asset: symbol, refPrice: ref, volBps: vol, liqUsd: liq, premiumBps: premium ?? 0, cmcTs: Number(cmcTs), components },
  });
  return {
    plan: {
      asset: symbol,
      assetId: assetIdOf(symbol),
      refPrice: toFixed(ref.toFixed(8)),
      volBps: BigInt(vol),
      liqUsd: liq > 0 ? toFixed(liq.toFixed(2)) : 0n,
      premiumBps: BigInt(premium ?? 0),
      cmcTs,
      snapshotId: BigInt(entry.seq),
      responseHash,
      components,
      inputs: { dexPrice, quotePrice, rwaTokenized: rwaTok, liqUsd: liq, volBps: vol, premiumBps: premium, candles: candles.length },
    },
  };
}

export function snapshotArg(p: SnapshotPlan) {
  return {
    refPrice: p.refPrice,
    volBps: p.volBps,
    liqUsd: p.liqUsd,
    premiumBps: p.premiumBps,
    cmcTs: p.cmcTs,
    snapshotId: p.snapshotId,
    responseHash: p.responseHash,
  };
}

/** Posts one snapshot to a RiskOracle (97 or 56). Skips when the oracle already has CMC data this new. */
export async function postSnapshot(s: Signer, oracle: Address, p: SnapshotPlan, service: string, dryRun: boolean) {
  const last = await s.public.readContract({ address: oracle, abi: riskOracleAbi, functionName: "latestSnapshot", args: [p.assetId] });
  if (last.snapshotId > 0n && (p.cmcTs <= last.cmcTs || p.snapshotId <= last.snapshotId)) {
    return { ok: false, skipped: true, reason: `no newer CMC data (on-chain cmcTs ${last.cmcTs}, ours ${p.cmcTs})` };
  }
  const r = await sendTx(s, service, { address: oracle, abi: riskOracleAbi, functionName: "post", args: [p.assetId, snapshotArg(p)] }, { dryRun, note: { asset: p.asset, snapshotId: p.snapshotId } });
  const sql = db();
  if (sql && !dryRun)
    await sql`insert into risk_snapshots (chain_id, asset, asset_id, snapshot_id, ref_price, vol_bps, liq_usd, premium_bps, cmc_ts, response_hash, components, tx_hash, status, error)
              values (${s.wallet.chain.id}, ${p.asset}, ${p.assetId}, ${p.snapshotId.toString()}, ${p.refPrice.toString()}, ${p.volBps.toString()}, ${p.liqUsd.toString()},
                      ${p.premiumBps.toString()}, ${p.cmcTs.toString()}, ${p.responseHash}, ${sql.json(toJsonValue({ components: p.components, inputs: p.inputs }) as postgres.JSONValue)},
                      ${r.hash ?? null}, ${r.ok ? "posted" : "failed"}, ${r.ok ? null : (r.revert ?? r.error ?? null)})`;
  return { ok: r.ok, hash: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
}

export async function lastPlan(symbol: string): Promise<SnapshotPlan | undefined> {
  const v = await kvGet<Record<string, unknown>>(`risk:plan:${symbol}`);
  if (!v) return undefined;
  return {
    ...(v as unknown as SnapshotPlan),
    refPrice: BigInt(v.refPrice as string),
    volBps: BigInt(v.volBps as string),
    liqUsd: BigInt(v.liqUsd as string),
    premiumBps: BigInt(v.premiumBps as string),
    cmcTs: BigInt(v.cmcTs as string),
    snapshotId: BigInt(v.snapshotId as string),
  };
}

export async function riskOnce(dryRun = false) {
  const d = testnet();
  const oracle = d?.core.riskOracle;
  const out: Record<string, unknown>[] = [];
  if (!oracle) return [{ skipped: "no core.riskOracle in deployments" }];
  const s = signer("risk97");
  for (const sym of riskSymbols(d)) {
    try {
      const last = await publicClient("testnet").readContract({ address: oracle, abi: riskOracleAbi, functionName: "latestSnapshot", args: [assetIdOf(sym)] });
      const { plan, reason } = await buildSnapshot(sym, last.cmcTs);
      if (!plan) {
        out.push({ asset: sym, skipped: reason });
        continue;
      }
      await kvSet(`risk:plan:${sym}`, toJsonValue(plan));
      if (!s) {
        out.push({ asset: sym, skipped: "RISK97_PRIVATE_KEY not set", snapshotId: plan.snapshotId.toString() });
        continue;
      }
      const r = await postSnapshot(s, oracle, plan, "risk-engine", dryRun);
      out.push({ asset: sym, snapshotId: plan.snapshotId.toString(), refPrice: plan.inputs, ...r });
    } catch (e) {
      out.push({ asset: sym, error: errMsg(e) });
      log.warn("risk post failed", { asset: sym, error: errMsg(e) });
    }
  }
  // stale-snapshot alert: the pool falls back to conservative params after 15 min
  try {
    const pub = publicClient("testnet");
    for (const sym of riskSymbols(d)) {
      const src = await pub.readContract({ address: oracle, abi: riskOracleAbi, functionName: "source", args: [assetIdOf(sym)] });
      if (Number(src) === 2) void alert(`risk-fallback-${sym}`, `RiskOracle ${sym} is on FALLBACK (snapshot stale or missing)`);
    }
  } catch {
    /* informational */
  }
  return out;
}

export const riskEngineJob: Job = {
  name: "risk",
  everyMs: 5 * MIN,
  needsDb: true,
  run: (ctx) => riskOnce(ctx.dryRun),
};
