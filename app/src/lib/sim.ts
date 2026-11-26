// Local SplitStock pool simulator. Mirrors the core math in contracts/SPEC.md closely enough for demo pools,
// the offline scenario sandbox and "skip to pre-open" previews. Display-grade floats; never used for a tx.
//   V = C*P + U   E = V - S   xNav = E / X   L = C*P / E   CR = V / S
import type { ModeName, PoolSnapshot, Quote, RiskSourceName } from "./types";

export type SimParams = {
  triggerLev: number;
  targetLev: number;
  lowerTriggerLev: number;
  maxMintLev: number;
  stabilityCR: number;
  openFeeBps: number;
  closedFeeBps: number;
  dynFeeMaxBps: number;
  minFeeBps: number;
  redeemFeeBps: number;
  stabilityRedeemFeeBps: number;
  swapCostBps: number;
  spDiscountBps: number;
  closedMaxLev: number;
  gapTriggerLev: number;
  gapTargetLev: number;
};

export const DEFAULT_SIM_PARAMS: SimParams = {
  triggerLev: 2.67,
  targetLev: 2.0,
  lowerTriggerLev: 1.6,
  maxMintLev: 2.5,
  stabilityCR: 1.3,
  openFeeBps: 30,
  closedFeeBps: 100,
  dynFeeMaxBps: 50,
  minFeeBps: 10,
  redeemFeeBps: 20,
  stabilityRedeemFeeBps: 100,
  swapCostBps: 30,
  spDiscountBps: 100,
  closedMaxLev: 2.2,
  gapTriggerLev: 2.3,
  gapTargetLev: 1.8,
};

export type SimState = {
  C: number;
  U: number;
  S: number;
  X: number;
  P: number;
  anchor: number;
  spDeposits: number;
  vaultBufferUsd: number;
  params: SimParams;
  marketOpen: boolean;
  gapGuard: boolean;
  priceUpdatedAt: number;
  snapshotId: number;
  riskSource: RiskSourceName;
};

export class SimError extends Error {
  constructor(public errorName: string, detail?: string) {
    super(detail ? `${errorName}: ${detail}` : errorName);
  }
}

export function derive(s: Pick<SimState, "C" | "U" | "S" | "X" | "P" | "params">) {
  const V = s.C * s.P + s.U;
  const E = V - s.S;
  const xNav = s.X <= 0 ? 1 : E <= 0 ? 0 : E / s.X;
  const L = E <= 0 ? (s.C > 0 ? Number.POSITIVE_INFINITY : 0) : (s.C * s.P) / E;
  const CR = s.S <= 0 ? Number.POSITIVE_INFINITY : V / s.S;
  let mode: ModeName = "NORMAL";
  if (s.X <= 0) mode = "UNSEEDED";
  else if (!(s.P > 0)) mode = "NO_PRICE";
  else if (s.S > 0 && E <= 0) mode = "UNDERWATER";
  else if (CR < s.params.stabilityCR) mode = "STABILITY";
  return { V, E, xNav, L, CR, mode };
}

/** Effective trigger/target after the gap guard (SPEC: min(rule, gap value)). */
export function effective(s: SimState) {
  const p = s.params;
  const trigger = s.gapGuard ? Math.min(p.triggerLev, p.gapTriggerLev) : p.triggerLev;
  const target = s.gapGuard ? Math.min(p.targetLev, p.gapTargetLev) : p.targetLev;
  const lower = Math.min(p.lowerTriggerLev, target - 0.1);
  const maxMint = s.marketOpen ? Math.min(p.maxMintLev, trigger) : Math.min(p.maxMintLev, p.closedMaxLev, trigger);
  return { trigger, target, lower, maxMint };
}

export function fees(s: SimState) {
  const d = derive(s);
  const { target, trigger } = effective(s);
  const base = s.marketOpen ? s.params.openFeeBps : s.params.closedFeeBps;
  const tilt = Math.max(-1, Math.min(1, (d.L - target) / Math.max(0.01, trigger - target)));
  const dyn = Math.round(tilt * s.params.dynFeeMaxBps);
  const stable = Math.max(s.params.minFeeBps, base + dyn);
  const lever = d.mode === "STABILITY" ? 0 : Math.max(s.params.minFeeBps, base - dyn);
  const redeemLever = d.mode === "STABILITY" ? s.params.stabilityRedeemFeeBps : s.params.redeemFeeBps;
  return { stable, lever, redeem: s.params.redeemFeeBps, redeemLever };
}

const clone = (s: SimState): SimState => ({ ...s, params: { ...s.params } });

function requireMintable(s: SimState) {
  const d = derive(s);
  if (d.mode === "UNSEEDED") throw new SimError("NotSeeded");
  if (d.mode === "NO_PRICE") throw new SimError("NoPrice");
  return d;
}

export function mintStable(s0: SimState, cIn: number): { state: SimState; quote: Quote } {
  if (!(cIn > 0)) throw new SimError("ZeroAmount");
  const s = clone(s0);
  const d = requireMintable(s);
  if (d.mode === "STABILITY") throw new SimError("StabilityMode");
  if (d.mode === "UNDERWATER") throw new SimError("Underwater");
  const f = fees(s).stable;
  const out = cIn * s.P * (1 - f / 1e4);
  s.C += cIn;
  s.S += out;
  const after = derive(s);
  const cap = effective(s0).maxMint;
  if (after.L > cap) throw new SimError("LeverageTooHigh", `leverage after ${after.L.toFixed(2)}x > cap ${cap.toFixed(2)}x`);
  return { state: s, quote: { out, feeBps: f } };
}

export function mintLever(s0: SimState, cIn: number): { state: SimState; quote: Quote } {
  if (!(cIn > 0)) throw new SimError("ZeroAmount");
  const s = clone(s0);
  const d = requireMintable(s);
  if (d.mode === "UNDERWATER") throw new SimError("Underwater");
  const f = fees(s).lever;
  const out = (cIn * s.P * (1 - f / 1e4)) / d.xNav;
  s.C += cIn;
  s.X += out;
  return { state: s, quote: { out, feeBps: f } };
}

export function redeemStable(s0: SimState, amt: number): { state: SimState; quote: Quote } {
  if (!(amt > 0)) throw new SimError("ZeroAmount");
  if (amt > s0.S) throw new SimError("InsufficientReserves");
  const s = clone(s0);
  const d = derive(s);
  const f = fees(s).redeem;
  const frac = (amt * (1 - f / 1e4)) / Math.max(d.V, s.S);
  const cOut = frac * s.C;
  const uOut = frac * s.U;
  s.S -= amt;
  s.C -= cOut;
  s.U -= uOut;
  return { state: s, quote: { out: cOut * s.P + uOut, feeBps: f, cOut, uOut } };
}

export function redeemLever(s0: SimState, x: number): { state: SimState; quote: Quote } {
  if (!(x > 0)) throw new SimError("ZeroAmount");
  const s = clone(s0);
  const d = derive(s);
  if (d.E <= 0) throw new SimError("Underwater");
  const f = fees(s).redeemLever;
  const value = x * d.xNav * (1 - f / 1e4);
  const cOut = Math.min(value / s.P, s.C);
  const uOut = Math.min(value - cOut * s.P, s.U);
  s.X -= x;
  s.C -= cOut;
  s.U -= uOut;
  const after = derive(s);
  const { trigger } = effective(s0);
  if (s.S > 0 && after.L > trigger) throw new SimError("LeverageTooHigh", `leverage after ${after.L.toFixed(2)}x > trigger ${trigger.toFixed(2)}x`);
  return { state: s, quote: { out: cOut * s.P + uOut, feeBps: f, cOut, uOut } };
}

export function redeemPair(s0: SimState, sMax: number, xMax: number): { state: SimState; quote: Quote } {
  if (!(sMax > 0) && !(xMax > 0)) throw new SimError("ZeroAmount");
  const s = clone(s0);
  const share = Math.min(s.S > 0 ? sMax / s.S : 1, s.X > 0 ? xMax / s.X : 0);
  if (!(share > 0)) throw new SimError("BadPairRatio");
  const f = s.params.redeemFeeBps;
  const sBurned = share * s.S;
  const xBurned = share * s.X;
  const cOut = share * s.C * (1 - f / 1e4);
  const uOut = share * s.U * (1 - f / 1e4);
  s.S -= sBurned;
  s.X -= xBurned;
  s.C -= cOut;
  s.U -= uOut;
  return { state: s, quote: { out: cOut * s.P + uOut, feeBps: f, cOut, uOut, sBurned, xBurned } };
}

export type RebalanceResult = {
  zone: "NONE" | "SELL" | "BUY";
  route: "DEX" | "STABILITY_POOL" | "NONE";
  sizeUsd: number;
  levBefore: number;
  levAfter: number;
  note: string;
};

export function previewRebalance(s0: SimState): RebalanceResult & { state: SimState } {
  const s = clone(s0);
  const d = derive(s);
  const { trigger, target, lower } = effective(s);
  const cost = s.params.swapCostBps / 1e4;
  if (d.E <= 0 || !(s.P > 0)) {
    return { state: s, zone: "NONE", route: "NONE", sizeUsd: 0, levBefore: d.L, levAfter: d.L, note: "Equity is gone: zones cannot act, the backstop waterfall applies." };
  }
  if (d.L > trigger) {
    const D = Math.max(0, (s.C * s.P - target * d.E) / (1 - target * cost));
    if (s.marketOpen) {
      s.C -= D / s.P;
      s.U += D * (1 - cost);
      const a = derive(s);
      return { state: s, zone: "SELL", route: "DEX", sizeUsd: D, levBefore: d.L, levAfter: a.L, note: `Sell zone: sold ${fmt(D)} of stock for mUSDC on PancakeSwap.` };
    }
    const burn = Math.min(D, s.spDeposits, s.S);
    if (burn <= 0) {
      return { state: s, zone: "SELL", route: "NONE", sizeUsd: D, levBefore: d.L, levAfter: d.L, note: "Market closed and the Stability Pool is empty: the sell waits for the open." };
    }
    const stockOut = burn / (s.P * (1 - s.params.spDiscountBps / 1e4));
    s.C -= Math.min(stockOut, s.C);
    s.S -= burn;
    s.spDeposits -= burn;
    const a = derive(s);
    return { state: s, zone: "SELL", route: "STABILITY_POOL", sizeUsd: burn, levBefore: d.L, levAfter: a.L, note: `Market closed: the Stability Pool burned ${fmt(burn)} sUSD for stock at a ${s.params.spDiscountBps / 100}% discount.` };
  }
  if (d.L < lower && s.U > 0) {
    const B = Math.min(s.U, Math.max(0, target * d.E - s.C * s.P));
    s.U -= B;
    s.C += (B * (1 - cost)) / s.P;
    const a = derive(s);
    return { state: s, zone: "BUY", route: "DEX", sizeUsd: B, levBefore: d.L, levAfter: a.L, note: `Buy zone: spent ${fmt(B)} mUSDC on stock to restore leverage.` };
  }
  return { state: s, zone: "NONE", route: "NONE", sizeUsd: 0, levBefore: d.L, levAfter: d.L, note: `Leverage ${d.L.toFixed(2)}x is inside the band [${lower.toFixed(2)}x, ${trigger.toFixed(2)}x].` };
}

export function shock(s0: SimState, bps: number): SimState {
  const s = clone(s0);
  const next = s.P * (1 + bps / 1e4);
  const min = s.anchor * 0.4;
  const max = s.anchor * 1.6;
  if (next < min || next > max) throw new SimError("OutOfBounds", `price must stay within [${fmt(min)}, ${fmt(max)}]`);
  s.P = next;
  s.priceUpdatedAt = Math.floor(Date.now() / 1000);
  return s;
}

export type WaterfallStep = { step: string; detail: string; crAfter: number; done: boolean };

/** Loss order after a gap: zones -> Stability Pool -> BackstopVault -> pro-rata haircut. */
export function waterfall(s0: SimState): { state: SimState; steps: WaterfallStep[]; payoutPerSusd: number } {
  let s = clone(s0);
  const steps: WaterfallStep[] = [];
  const cr = () => derive(s).CR;
  const r = previewRebalance(s);
  s = r.state;
  steps.push({ step: "Sell / buy zone", detail: r.note, crAfter: cr(), done: r.zone !== "NONE" && r.route !== "NONE" });
  // Stability Pool absorbs (offset) while CR < 1 if anything is left.
  let d = derive(s);
  if (d.V < s.S && s.spDeposits > 0) {
    const burn = Math.min(s.spDeposits, s.S, Math.max(0, s.C * s.P * 0.99));
    const stockOut = burn / (s.P * (1 - s.params.spDiscountBps / 1e4));
    s.C -= Math.min(stockOut, s.C);
    s.S -= burn;
    s.spDeposits -= burn;
    steps.push({ step: "Stability Pool", detail: `Burned ${fmt(burn)} of deposited sUSD against stock at a discount.`, crAfter: cr(), done: true });
  } else {
    steps.push({ step: "Stability Pool", detail: d.V < s.S ? "No deposits left to absorb." : "Not needed.", crAfter: cr(), done: false });
  }
  d = derive(s);
  if (d.V < s.S && s.vaultBufferUsd > 0) {
    const donate = Math.min(s.vaultBufferUsd, s.S - d.V);
    s.U += donate;
    s.vaultBufferUsd -= donate;
    steps.push({ step: "Insurance vault cover()", detail: `Swapped the vault's BNB to ${fmt(donate)} mUSDC and donated it (capped at the deficit).`, crAfter: cr(), done: true });
  } else {
    steps.push({ step: "Insurance vault cover()", detail: d.V < s.S ? "Buffer is empty." : "Not needed: CR is back above 1.", crAfter: cr(), done: false });
  }
  d = derive(s);
  const payout = s.S > 0 ? Math.min(1, d.V / s.S) : 1;
  steps.push({
    step: "Pro-rata haircut",
    detail: payout < 1 ? `sUSD redeems pro rata at ${fmt(payout)} per sUSD (V ≤ S).` : "No haircut: every sUSD still redeems for $1 of value.",
    crAfter: cr(),
    done: payout < 1,
  });
  return { state: s, steps, payoutPerSusd: payout };
}

function fmt(n: number) {
  return n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

export function toSnapshot(s: SimState, now = Math.floor(Date.now() / 1000)): PoolSnapshot {
  const d = derive(s);
  const f = fees(s);
  const e = effective(s);
  return {
    C: s.C,
    U: s.U,
    S: s.S,
    X: s.X,
    price: s.P,
    priceUpdatedAt: s.priceUpdatedAt,
    priceAge: Math.max(0, now - s.priceUpdatedAt),
    priceFresh: now - s.priceUpdatedAt <= 120,
    feedHalted: false,
    V: d.V,
    E: d.E,
    xNav: d.xNav,
    leverage: d.L,
    cr: d.CR,
    mode: d.mode,
    marketOpen: s.marketOpen,
    gapGuard: s.gapGuard,
    mintsPaused: false,
    triggerLev: e.trigger,
    targetLev: e.target,
    lowerTriggerLev: e.lower,
    maxMintLev: e.maxMint,
    stableMintFeeBps: d.mode === "STABILITY" ? 0 : f.stable,
    leverMintFeeBps: f.lever,
    redeemFeeBps: f.redeem,
    stabilityRedeemFeeBps: s.params.stabilityRedeemFeeBps,
    stabilityCR: s.params.stabilityCR,
    openFeeBps: s.params.openFeeBps,
    closedFeeBps: s.params.closedFeeBps,
    riskSource: s.riskSource,
    snapshotId: s.snapshotId,
    spDeposits: s.spDeposits,
    backstopUsd: s.vaultBufferUsd,
  };
}

/** Build a SimState from a real on-chain snapshot (for pre-open previews of real or sandbox pools). */
export function fromSnapshot(p: PoolSnapshot, anchor?: number): SimState {
  return {
    C: p.C,
    U: p.U,
    S: p.S,
    X: p.X,
    P: p.price,
    anchor: anchor ?? p.price,
    spDeposits: p.spDeposits ?? 0,
    vaultBufferUsd: p.backstopUsd ?? 0,
    params: {
      ...DEFAULT_SIM_PARAMS,
      triggerLev: p.triggerLev || DEFAULT_SIM_PARAMS.triggerLev,
      targetLev: p.targetLev || DEFAULT_SIM_PARAMS.targetLev,
      lowerTriggerLev: p.lowerTriggerLev || DEFAULT_SIM_PARAMS.lowerTriggerLev,
      maxMintLev: p.maxMintLev || DEFAULT_SIM_PARAMS.maxMintLev,
      stabilityCR: p.stabilityCR || DEFAULT_SIM_PARAMS.stabilityCR,
      redeemFeeBps: p.redeemFeeBps,
    },
    marketOpen: p.marketOpen,
    gapGuard: p.gapGuard,
    priceUpdatedAt: p.priceUpdatedAt,
    snapshotId: p.snapshotId,
    riskSource: p.riskSource,
  };
}

/** Quote any action without mutating. */
export function quote(s: SimState, action: string, amount: number, xMax?: number): Quote {
  try {
    switch (action) {
      case "mintStable":
        return mintStable(s, amount).quote;
      case "mintLever":
        return mintLever(s, amount).quote;
      case "redeemStable":
        return redeemStable(s, amount).quote;
      case "redeemLever":
        return redeemLever(s, amount).quote;
      case "redeemPair":
        return redeemPair(s, amount, xMax ?? (s.S > 0 ? (amount * s.X) / s.S : 0)).quote;
    }
  } catch (e) {
    return { out: 0, feeBps: 0, error: e instanceof SimError ? e.message : String(e) };
  }
  return { out: 0, feeBps: 0 };
}
