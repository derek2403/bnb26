import { toFixed } from "../lib/math.js";
import type { Gathered } from "./gather.js";
import type { Decision } from "./schema.js";

/**
 * Off-chain mirror of RiskOracle.propose (contracts/SPEC.md §7.5), run before anything is signed:
 *   baseline b = active agent values, else the rule/fallback base (stale -> conservative merge with fallback)
 *   q = clamp(each field) -> step(q, b, caps) -> clamp again (R13) -> gaps(q)
 *   horizon = clamp(horizonSec, 300, agentMaxTtl)
 *   tightenOnly = trigger,target,lower,maxDev <= b  &&  closedFee,gapGuard >= b
 * The contract re-applies all of this; doing it here lets us classify, log every adjustment and skip no-ops.
 */
export interface AgentParamsBig {
  triggerLev: bigint;
  targetLev: bigint;
  lowerTriggerLev: bigint;
  maxDevBps: bigint;
  closedFeeBps: bigint;
  gapGuardSec: bigint;
  horizonSec: bigint;
}

export interface Validated {
  params: AgentParamsBig;
  baseline: Omit<AgentParamsBig, "horizonSec">;
  baselineSource: "agent" | "rule" | "fallback-merge";
  classification: "tighten" | "loosen" | "hold";
  tightenOnly: boolean;
  noop: boolean;
  adjustments: { field: string; requested: string; applied: string; reason: string }[];
  modelAction: Decision["action"];
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export function baselineOf(o: Gathered["onchain"], now: number): { b: Omit<AgentParamsBig, "horizonSec">; src: Validated["baselineSource"] } {
  if (o.agentEnabled && o.agent.active) {
    const a = o.agent.params;
    return { b: { triggerLev: a.triggerLev, targetLev: a.targetLev, lowerTriggerLev: a.lowerTriggerLev, maxDevBps: a.maxDevBps, closedFeeBps: a.closedFeeBps, gapGuardSec: a.gapGuardSec }, src: "agent" };
  }
  const hasSnap = o.snapshot.snapshotId > 0n;
  const age = BigInt(now) > o.snapshot.cmcTs ? BigInt(now) - o.snapshot.cmcTs : 0n;
  const stale = !hasSnap || age > o.timing.staleAfter;
  const fb = o.fallback;
  const fbP = { triggerLev: fb.triggerLev, targetLev: fb.targetLev, lowerTriggerLev: fb.lowerTriggerLev, maxDevBps: fb.maxDevBps, closedFeeBps: fb.feeBps, gapGuardSec: fb.gapGuardSec };
  const r = o.rule;
  const ruleP = { triggerLev: r.triggerLev, targetLev: r.targetLev, lowerTriggerLev: r.lowerTriggerLev, maxDevBps: r.maxDevBps, closedFeeBps: r.closedFeeBps, gapGuardSec: r.gapGuardSec };
  if (!stale) return { b: ruleP, src: "rule" };
  const src = hasSnap ? ruleP : fbP;
  return {
    b: {
      triggerLev: min(src.triggerLev, fbP.triggerLev),
      targetLev: min(src.targetLev, fbP.targetLev),
      lowerTriggerLev: min(src.lowerTriggerLev, fbP.lowerTriggerLev),
      maxDevBps: min(src.maxDevBps, fbP.maxDevBps),
      closedFeeBps: max(src.closedFeeBps, fbP.closedFeeBps),
      gapGuardSec: max(src.gapGuardSec, fbP.gapGuardSec),
    },
    src: "fallback-merge",
  };
}

export function validate(d: Decision, o: Gathered["onchain"], now: number): Validated {
  const adjustments: Validated["adjustments"] = [];
  const { b, src } = baselineOf(o, now);
  const c = o.clamps;
  const caps = o.stepCaps;
  const levOf = (x: number) => toFixed(Math.max(0, Math.round(x * 1e4) / 1e4).toFixed(4));
  const intOf = (x: number) => BigInt(Math.max(0, Math.round(x)));
  const q: Record<keyof Omit<AgentParamsBig, "horizonSec">, bigint> = {
    triggerLev: levOf(d.triggerLev),
    targetLev: levOf(d.targetLev),
    lowerTriggerLev: levOf(d.lowerTriggerLev),
    maxDevBps: intOf(d.maxDevBps),
    closedFeeBps: intOf(d.closedFeeBps),
    gapGuardSec: intOf(d.gapGuardSec),
  };
  const bounds: Record<keyof typeof q, [bigint, bigint, bigint]> = {
    triggerLev: [c.minTriggerLev, c.maxTriggerLev, caps.lev],
    targetLev: [c.minTargetLev, c.maxTargetLev, caps.lev],
    lowerTriggerLev: [c.minLowerTriggerLev, c.maxLowerTriggerLev, caps.lev],
    maxDevBps: [c.minMaxDevBps, c.maxMaxDevBps, caps.bps],
    closedFeeBps: [c.minClosedFeeBps, c.maxClosedFeeBps, caps.bps],
    gapGuardSec: [c.minGapGuardSec, c.maxGapGuardSec, caps.sec],
  };
  const note = (field: string, requested: bigint, applied: bigint, reason: string) => {
    if (requested !== applied) adjustments.push({ field, requested: requested.toString(), applied: applied.toString(), reason });
  };
  for (const k of Object.keys(q) as (keyof typeof q)[]) {
    const [lo, hi, cap] = bounds[k];
    const req = q[k];
    let v = req < lo ? lo : req > hi ? hi : req;
    note(k, req, v, "clamp");
    const prev = b[k];
    const sLo = prev > cap ? prev - cap : 0n;
    const sHi = prev + cap;
    const stepped = v < sLo ? sLo : v > sHi ? sHi : v;
    note(k, v, stepped, "step cap");
    v = stepped < lo ? lo : stepped > hi ? hi : stepped;
    note(k, stepped, v, "re-clamp");
    q[k] = v;
  }
  // gaps (tighten-only adjustments; may exceed a step cap, as on-chain)
  const tgtMax = q.triggerLev > c.minTriggerTargetGap ? q.triggerLev - c.minTriggerTargetGap : 0n;
  if (q.targetLev > tgtMax) {
    note("targetLev", q.targetLev, tgtMax, "trigger-target gap");
    q.targetLev = tgtMax;
  }
  const loMax = q.targetLev > c.minTargetLowerGap ? q.targetLev - c.minTargetLowerGap : 0n;
  if (q.lowerTriggerLev > loMax) {
    note("lowerTriggerLev", q.lowerTriggerLev, loMax, "target-lower gap");
    q.lowerTriggerLev = loMax;
  }
  const reqH = BigInt(Math.max(0, Math.round(d.horizonSec)));
  const horizon = min(max(reqH, 300n), o.timing.agentMaxTtl);
  note("horizonSec", reqH, horizon, "horizon bounds [300, agentMaxTtl]");

  const tightenOnly =
    q.triggerLev <= b.triggerLev &&
    q.targetLev <= b.targetLev &&
    q.lowerTriggerLev <= b.lowerTriggerLev &&
    q.maxDevBps <= b.maxDevBps &&
    q.closedFeeBps >= b.closedFeeBps &&
    q.gapGuardSec >= b.gapGuardSec;
  const noop = (Object.keys(q) as (keyof typeof q)[]).every((k) => q[k] === b[k]);
  const classification = noop ? "hold" : tightenOnly ? "tighten" : "loosen";
  return { params: { ...q, horizonSec: horizon }, baseline: b, baselineSource: src, classification, tightenOnly, noop, adjustments, modelAction: d.action };
}
