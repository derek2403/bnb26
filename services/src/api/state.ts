import { atlasMirrorAbi, leveragePoolAbi, marketCalendarAbi, riskOracleAbi } from "../abi/index.js";
import { assetIdOf, mainnet, oracleFor, riskSymbols, testnet } from "../config/deployments.js";
import { publicClient } from "../lib/chains.js";
import { errMsg } from "../lib/log.js";
import { nowSec } from "../lib/math.js";
import { listPools, POOL_MODE } from "../lib/pools.js";
import { allLatest } from "../jobs/cmcCollector.js";
import { lastPlan } from "../jobs/riskEngine.js";

const SOURCE = ["RULE", "AGENT", "FALLBACK"] as const;
const ZONE = ["NONE", "SELL", "BUY"] as const;
const ROUTE = ["DEX", "STABILITY_POOL"] as const;

/** Server-side multicall snapshot for /state (cached by the route). bigint values are serialised as strings. */
export async function readState() {
  const d = testnet();
  const c = publicClient("testnet");
  const pools = await listPools();
  const poolStates = await Promise.all(
    pools.map(async (p) => {
      try {
        const [s, pv] = await Promise.all([
          c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "state" }),
          c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "previewRebalance" }),
        ]);
        return {
          ...p,
          state: { ...s, mode: POOL_MODE[Number(s.mode)], riskSource: SOURCE[Number(s.riskSource)] },
          rebalance: { ...pv, zone: ZONE[Number(pv.zone)], route: ROUTE[Number(pv.route)] },
        };
      } catch (e) {
        return { ...p, error: errMsg(e) };
      }
    }),
  );
  const risk: Record<string, unknown> = {};
  const oracle = d?.core.riskOracle;
  for (const sym of riskSymbols(d)) {
    const entry: Record<string, unknown> = { assetId: assetIdOf(sym) };
    if (oracle) {
      try {
        const [view, agent] = await Promise.all([
          c.readContract({ address: oracle, abi: riskOracleAbi, functionName: "riskView", args: [assetIdOf(sym)] }),
          c.readContract({ address: oracle, abi: riskOracleAbi, functionName: "agentParams", args: [assetIdOf(sym)] }),
        ]);
        entry.view = { ...view, source: SOURCE[Number(view.source)] };
        entry.agent = { params: agent[0], active: agent[1], expiresAt: agent[2], proposalId: agent[3] };
      } catch (e) {
        entry.error = errMsg(e);
      }
    }
    const mirror = oracleFor(d, sym)?.mirror;
    if (mirror) {
      try {
        const [r, halted, dec] = await Promise.all([
          c.readContract({ address: mirror, abi: atlasMirrorAbi, functionName: "latestRoundData" }),
          c.readContract({ address: mirror, abi: atlasMirrorAbi, functionName: "halted" }),
          c.readContract({ address: mirror, abi: atlasMirrorAbi, functionName: "decimals" }),
        ]);
        entry.mirror = { address: mirror, roundId: r[0], answer: r[1], decimals: dec, updatedAt: r[3], ageSec: nowSec() - Number(r[3]), halted };
      } catch (e) {
        entry.mirror = { address: mirror, error: errMsg(e) };
      }
    }
    const plan = await lastPlan(sym);
    if (plan) entry.lastSnapshotPlan = { snapshotId: plan.snapshotId, cmcTs: plan.cmcTs, inputs: plan.inputs, responseHash: plan.responseHash };
    risk[sym] = entry;
  }
  let calendar: Record<string, unknown> | undefined;
  const cal = d?.core.marketCalendar;
  if (cal) {
    const now = BigInt(nowSec());
    try {
      const [isOpen, nextOpen, nextClose] = await Promise.all([
        c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "isOpen", args: [now] }),
        c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "nextOpen", args: [now] }),
        c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "nextClose", args: [now] }),
      ]);
      calendar = { isOpen, nextOpen, nextClose };
    } catch (e) {
      calendar = { error: errMsg(e) };
    }
  }
  const cmc = (await allLatest()).map((l) => ({ kind: l.kind, key: l.key, parsed: l.parsed, bodyHash: l.bodyHash, logSeq: l.logSeq, cmcTs: l.cmcTs, fetchedAt: l.fetchedAt }));
  return {
    at: new Date().toISOString(),
    chainId: d?.chainId,
    deploymentsUpdatedAt: { testnet: d?.updatedAt, mainnet: mainnet()?.updatedAt },
    pools: poolStates,
    risk,
    calendar,
    cmc,
  };
}
