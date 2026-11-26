import { atlasMirrorAbi, atlasSingleFeedAbi, leveragePoolAbi, marketCalendarAbi, riskOracleAbi } from "../abi/index.js";
import { cmcAsset, type CmcAsset } from "../config/assets.js";
import { assetIdOf, oracleFor, testnet } from "../config/deployments.js";
import { toJsonValue } from "../lib/canonical.js";
import { publicClient } from "../lib/chains.js";
import { db } from "../lib/db.js";
import { governorState } from "../lib/governor.js";
import { errMsg } from "../lib/log.js";
import { fromFixed, nowSec } from "../lib/math.js";
import { listPools, POOL_MODE } from "../lib/pools.js";
import { getLatest } from "../jobs/cmcCollector.js";
import { lastPlan } from "../jobs/riskEngine.js";
import { gatherMcp, type McpEvidence } from "./mcp.js";

/** Everything the Risk Steward decides from. Code gathers it; the model only reads it. */
export interface Gathered {
  asset: string;
  assetId: `0x${string}`;
  now: number;
  onchain: Awaited<ReturnType<typeof readRisk>>;
  calendar: Awaited<ReturnType<typeof readCalendar>>;
  pools: Record<string, unknown>[];
  atlas: Record<string, unknown>;
  keeper: Record<string, unknown>;
  mcp: McpEvidence[];
  mcpErrors: { tool: string; error: string }[];
}

const SOURCE = ["RULE", "AGENT", "FALLBACK"] as const;

export async function readRisk(assetId: `0x${string}`) {
  const oracle = testnet()?.core.riskOracle;
  if (!oracle) throw new Error("no core.riskOracle in deployments");
  const c = publicClient("testnet");
  const rd = <F extends string>(functionName: F, args: unknown[] = []) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.readContract({ address: oracle, abi: riskOracleAbi, functionName: functionName as any, args: args as any }) as Promise<any>;
  const [view, rule, agent, snap, clamps, caps, timing, fb, enabled, agentId] = await Promise.all([
    rd("riskView", [assetId]),
    rd("ruleParams", [assetId]),
    rd("agentParams", [assetId]),
    rd("latestSnapshot", [assetId]),
    rd("clamps"),
    rd("stepCaps"),
    rd("timing"),
    rd("fallbackParams"),
    rd("agentEnabled"),
    rd("agentId"),
  ]);
  return {
    oracle,
    effective: view.params as RiskParamsT,
    source: SOURCE[Number(view.source)] ?? String(view.source),
    refPrice: view.refPrice as bigint,
    refTs: view.refTs as bigint,
    snapshotId: view.snapshotId as bigint,
    mintsPaused: view.mintsPaused as boolean,
    rule: rule as RiskParamsT,
    agent: { params: agent[0] as AgentParamsT, active: agent[1] as boolean, expiresAt: agent[2] as bigint, proposalId: agent[3] as bigint },
    snapshot: snap as { refPrice: bigint; volBps: bigint; liqUsd: bigint; premiumBps: bigint; cmcTs: bigint; snapshotId: bigint; responseHash: string },
    clamps: clamps as ClampsT,
    stepCaps: caps as { lev: bigint; bps: bigint; sec: bigint },
    timing: timing as { staleAfter: bigint; agentMaxTtl: bigint; loosenDelay: bigint; minProposalGapBlocks: bigint },
    fallback: fb as FallbackT,
    agentEnabled: enabled as boolean,
    expectedAgentId: agentId as bigint,
  };
}

export interface RiskParamsT {
  triggerLev: bigint;
  targetLev: bigint;
  lowerTriggerLev: bigint;
  maxDevBps: bigint;
  openFeeBps: bigint;
  closedFeeBps: bigint;
  gapGuardSec: bigint;
  maxSellChunkUsd: bigint;
}
export interface AgentParamsT {
  triggerLev: bigint;
  targetLev: bigint;
  lowerTriggerLev: bigint;
  maxDevBps: bigint;
  closedFeeBps: bigint;
  gapGuardSec: bigint;
  horizonSec: bigint;
}
export interface ClampsT {
  minTriggerLev: bigint;
  maxTriggerLev: bigint;
  minTargetLev: bigint;
  maxTargetLev: bigint;
  minLowerTriggerLev: bigint;
  maxLowerTriggerLev: bigint;
  minTriggerTargetGap: bigint;
  minTargetLowerGap: bigint;
  minMaxDevBps: bigint;
  maxMaxDevBps: bigint;
  minOpenFeeBps: bigint;
  maxOpenFeeBps: bigint;
  minClosedFeeBps: bigint;
  maxClosedFeeBps: bigint;
  minGapGuardSec: bigint;
  maxGapGuardSec: bigint;
}
export interface FallbackT {
  triggerLev: bigint;
  targetLev: bigint;
  lowerTriggerLev: bigint;
  maxDevBps: bigint;
  feeBps: bigint;
  gapGuardSec: bigint;
  maxSellChunkUsd: bigint;
}

export async function readCalendar(gapGuardSec: bigint) {
  const cal = testnet()?.core.marketCalendar;
  if (!cal) return { available: false as const };
  const c = publicClient("testnet");
  const now = BigInt(nowSec());
  const safe = async <T>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch {
      return undefined;
    }
  };
  const [isOpen, nextOpen, nextClose, inGap] = await Promise.all([
    safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "isOpen", args: [now] })),
    safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "nextOpen", args: [now] })),
    safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "nextClose", args: [now] })),
    safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "inGapGuard", args: [now, gapGuardSec] })),
  ]);
  const days: Record<string, unknown>[] = [];
  for (let i = 0; i < 7; i++) {
    const ts = now + BigInt(i * 86_400);
    const di = await safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "dayIndexOf", args: [ts] }));
    if (di === undefined) continue;
    const [session, holiday, early] = await Promise.all([
      safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "sessionOf", args: [di] })),
      safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "isHoliday", args: [di] })),
      safe(c.readContract({ address: cal, abi: marketCalendarAbi, functionName: "earlyCloseMinute", args: [di] })),
    ]);
    days.push({
      dateUtc: new Date(Number(ts) * 1000).toISOString().slice(0, 10),
      holiday,
      earlyCloseMinuteEt: early && early > 0n ? Number(early) : undefined,
      openUtc: session ? new Date(Number(session[0]) * 1000).toISOString() : undefined,
      closeUtc: session ? new Date(Number(session[1]) * 1000).toISOString() : undefined,
    });
  }
  return {
    available: true as const,
    isOpen,
    inGapGuard: inGap,
    nextOpenUtc: nextOpen ? new Date(Number(nextOpen) * 1000).toISOString() : undefined,
    nextCloseUtc: nextClose ? new Date(Number(nextClose) * 1000).toISOString() : undefined,
    secondsToNextOpen: nextOpen ? Number(nextOpen - now) : undefined,
    secondsToNextClose: nextClose ? Number(nextClose - now) : undefined,
    days,
  };
}

async function readPools(symbol: string) {
  const c = publicClient("testnet");
  const out: Record<string, unknown>[] = [];
  for (const p of (await listPools({ includeFactory: false })).filter((x) => x.symbol === symbol)) {
    try {
      const s = await c.readContract({ address: p.address, abi: leveragePoolAbi, functionName: "state" });
      const big = 2n ** 255n;
      out.push({
        id: p.id,
        kind: p.kind,
        mode: POOL_MODE[Number(s.mode)],
        priceUsd: fromFixed(s.price),
        priceAgeSec: Number(s.priceAge),
        priceFresh: s.priceFresh,
        tvlUsd: fromFixed(s.V),
        sUsdSupply: fromFixed(s.S),
        leverage: s.leverage >= big ? "infinite" : fromFixed(s.leverage),
        collateralRatio: s.collateralRatio >= big ? "infinite" : fromFixed(s.collateralRatio),
        effectiveTrigger: fromFixed(s.triggerLev),
        effectiveTarget: fromFixed(s.targetLev),
        marketOpen: s.marketOpen,
        gapGuard: s.gapGuard,
        mintsPaused: s.mintsPaused,
      });
    } catch (e) {
      out.push({ id: p.id, error: errMsg(e) });
    }
  }
  return out;
}

async function readAtlas(symbol: string) {
  const o = oracleFor(testnet(), symbol);
  const out: Record<string, unknown> = {};
  if (o?.atlasSource?.feed) {
    try {
      const m = publicClient("mainnet");
      const [r, dec] = await Promise.all([
        m.readContract({ address: o.atlasSource.feed, abi: atlasSingleFeedAbi, functionName: "latestRoundData" }),
        m.readContract({ address: o.atlasSource.feed, abi: atlasSingleFeedAbi, functionName: "decimals" }),
      ]);
      out.mainnetFeed = o.atlasSource.feed;
      out.priceUsd = fromFixed(r[1], Number(dec));
      out.ageSec = nowSec() - Number(r[3]);
    } catch (e) {
      out.mainnetError = errMsg(e);
    }
  }
  if (o?.mirror) {
    try {
      const t = publicClient("testnet");
      const [r, dec, halted] = await Promise.all([
        t.readContract({ address: o.mirror, abi: atlasMirrorAbi, functionName: "latestRoundData" }),
        t.readContract({ address: o.mirror, abi: atlasMirrorAbi, functionName: "decimals" }),
        t.readContract({ address: o.mirror, abi: atlasMirrorAbi, functionName: "halted" }),
      ]);
      out.mirrorPriceUsd = fromFixed(r[1], Number(dec));
      out.mirrorAgeSec = nowSec() - Number(r[3]);
      out.mirrorHalted = halted;
    } catch (e) {
      out.mirrorError = errMsg(e);
    }
  }
  return out;
}

async function readKeeper(symbol: string) {
  const plan = await lastPlan(symbol);
  const fg = await getLatest("fear_greed", "*");
  const sql = db();
  let zones24h: unknown;
  if (sql) {
    const r = await sql<{ name: string; n: number }[]>`select name, count(*)::int as n from events where kind = 'zone' and block_time > ${nowSec() - 86_400} group by name`;
    zones24h = Object.fromEntries(r.map((x) => [x.name, x.n]));
  }
  return {
    lastSnapshotInputs: plan?.inputs,
    lastSnapshotId: plan?.snapshotId,
    fearGreed: fg?.parsed,
    zoneEvents24h: zones24h,
    cmcBudget: await governorState(),
  };
}

export async function gather(symbol: string): Promise<{ g: Gathered; asset: CmcAsset }> {
  const asset = cmcAsset(symbol);
  if (!asset) throw new Error(`no CMC asset config for ${symbol}`);
  const assetId = assetIdOf(symbol);
  const onchain = await readRisk(assetId);
  const [calendar, pools, atlas, keeper, mcp] = await Promise.all([
    readCalendar(onchain.effective.gapGuardSec),
    readPools(symbol),
    readAtlas(symbol),
    readKeeper(symbol),
    gatherMcp(asset),
  ]);
  return { g: { asset: symbol, assetId, now: nowSec(), onchain, calendar, pools, atlas, keeper, mcp: mcp.evidence, mcpErrors: mcp.errors }, asset };
}

/** Human-scale view of the on-chain risk state for the prompt (leverage as x, not WAD). */
export function riskForPrompt(o: Gathered["onchain"]) {
  const lev = (v: bigint) => fromFixed(v);
  const rp = (p: RiskParamsT) => ({
    triggerLev: lev(p.triggerLev),
    targetLev: lev(p.targetLev),
    lowerTriggerLev: lev(p.lowerTriggerLev),
    maxDevBps: Number(p.maxDevBps),
    openFeeBps: Number(p.openFeeBps),
    closedFeeBps: Number(p.closedFeeBps),
    gapGuardSec: Number(p.gapGuardSec),
  });
  return toJsonValue({
    source: o.source,
    effective: rp(o.effective),
    rule: rp(o.rule),
    agentActive: o.agent.active,
    agentValues: o.agent.active
      ? {
          triggerLev: lev(o.agent.params.triggerLev),
          targetLev: lev(o.agent.params.targetLev),
          lowerTriggerLev: lev(o.agent.params.lowerTriggerLev),
          maxDevBps: Number(o.agent.params.maxDevBps),
          closedFeeBps: Number(o.agent.params.closedFeeBps),
          gapGuardSec: Number(o.agent.params.gapGuardSec),
          expiresAtUtc: new Date(Number(o.agent.expiresAt) * 1000).toISOString(),
        }
      : null,
    snapshot: { refPriceUsd: fromFixed(o.snapshot.refPrice), volBps: Number(o.snapshot.volBps), liqUsd: fromFixed(o.snapshot.liqUsd), premiumBps: Number(o.snapshot.premiumBps), ageSec: o.snapshot.cmcTs > 0n ? nowSec() - Number(o.snapshot.cmcTs) : null },
    clamps: {
      triggerLev: [lev(o.clamps.minTriggerLev), lev(o.clamps.maxTriggerLev)],
      targetLev: [lev(o.clamps.minTargetLev), lev(o.clamps.maxTargetLev)],
      lowerTriggerLev: [lev(o.clamps.minLowerTriggerLev), lev(o.clamps.maxLowerTriggerLev)],
      minTriggerTargetGap: lev(o.clamps.minTriggerTargetGap),
      minTargetLowerGap: lev(o.clamps.minTargetLowerGap),
      maxDevBps: [Number(o.clamps.minMaxDevBps), Number(o.clamps.maxMaxDevBps)],
      closedFeeBps: [Number(o.clamps.minClosedFeeBps), Number(o.clamps.maxClosedFeeBps)],
      gapGuardSec: [Number(o.clamps.minGapGuardSec), Number(o.clamps.maxGapGuardSec)],
    },
    stepCaps: { lev: lev(o.stepCaps.lev), bps: Number(o.stepCaps.bps), sec: Number(o.stepCaps.sec) },
    timing: { agentMaxTtlSec: Number(o.timing.agentMaxTtl), loosenDelaySec: Number(o.timing.loosenDelay) },
    mintsPaused: o.mintsPaused,
    agentEnabled: o.agentEnabled,
  });
}
