import { annualisedVolBps } from "../lib/math.js";
import type { Candle } from "../lib/cmc.js";
import { loadCandles } from "../jobs/cmcCollector.js";

/**
 * 30-day replay of a SplitStock pool on real NVDAB 1h candles (CMC k-line, stored by cmc-collector).
 * Model (deliberately simple, documented in the /backtest page):
 *  - start fully in stock at L = target (2.0x): C·P = V, S = V − V/L, X such that xNAV = $1
 *  - every hour: σ over the trailing 168 candles -> rule trigger = clamp(2.67 − 0.0001·max(0, σbps − 5000), 2.2, 3.0),
 *    step-capped at 0.1 per hour; target = min(2.0, trigger − 0.3); lower trigger 1.6 (RiskOracle §7.3 defaults)
 *  - sell zone (L > trigger): sell stock back to target, paying `slipBps`; buy zone (L < lower, U > 0): buy back to target
 *  - no funding fee, no fees on mints, no gap guard / market-hours model, no StabilityPool route
 * Compared against xNVDA's naive 2x (hourly-rebalanced constant leverage) and NVDAB itself.
 */
export interface BacktestOptions {
  days?: number;
  slipBps?: number;
  asset?: string;
  candles?: Candle[];
}

export interface BacktestResult {
  asset: string;
  from?: number;
  to?: number;
  candles: number;
  series: { ts: number; price: number; xNav: number; naive2x: number; stock: number; leverage: number; cr: number; trigger: number }[];
  events: { ts: number; zone: "SELL" | "BUY"; levBefore: number; levAfter: number; sizeUsd: number; trigger: number; price: number }[];
  summary: { xNavEnd: number; naive2xEnd: number; stockEnd: number; worstCr: number; maxLeverage: number; sellZones: number; buyZones: number; underwaterHours: number };
  model: string;
}

export async function runBacktest(opts: BacktestOptions = {}): Promise<BacktestResult> {
  const days = opts.days ?? 30;
  const asset = opts.asset ?? "NVDA";
  const slip = (opts.slipBps ?? 30) / 10_000;
  const since = Math.floor(Date.now() / 1000) - (days + 7) * 86_400;
  const all = opts.candles ?? (await loadCandles(asset, "1h", since));
  const startTs = Math.floor(Date.now() / 1000) - days * 86_400;
  const startIdx = Math.max(0, all.findIndex((c) => c.ts >= startTs));
  const model = "SplitStock rule-only replay v1 (see services/src/backtest/backtest.ts)";
  const empty: BacktestResult = {
    asset,
    candles: 0,
    series: [],
    events: [],
    summary: { xNavEnd: 1, naive2xEnd: 1, stockEnd: 1, worstCr: Infinity, maxLeverage: 0, sellZones: 0, buyZones: 0, underwaterHours: 0 },
    model,
  };
  if (all.length - startIdx < 2) return empty;

  const p0 = all[startIdx].c;
  const V0 = 100_000;
  const L0 = 2.0;
  let C = V0 / p0;
  let U = 0;
  const S = V0 - V0 / L0;
  const X = V0 / L0; // xNAV0 = 1
  let naive = 1;
  let trigger = 2.67;
  const series: BacktestResult["series"] = [];
  const events: BacktestResult["events"] = [];
  let worstCr = Infinity;
  let maxLev = 0;
  let underwater = 0;
  for (let i = startIdx; i < all.length; i++) {
    const p = all[i].c;
    if (i > startIdx) naive *= 1 + 2 * (p / all[i - 1].c - 1);
    const window = all.slice(Math.max(0, i - 168), i + 1).map((c) => c.c);
    const vol = annualisedVolBps(window);
    if (vol > 0) {
      const raw = Math.min(3.0, Math.max(2.2, 2.67 - 0.0001 * Math.max(0, vol - 5000)));
      trigger = Math.min(trigger + 0.1, Math.max(trigger - 0.1, raw));
    }
    const target = Math.min(2.0, trigger - 0.3);
    const lower = Math.min(1.6, target - 0.2);
    let V = C * p + U;
    let E = V - S;
    let L = E > 0 ? (C * p) / E : Infinity;
    if (E > 0 && L > trigger) {
      const D = C * p - target * E; // USD of stock to sell
      const before = L;
      C -= D / p;
      U += D * (1 - slip);
      V = C * p + U;
      E = V - S;
      L = E > 0 ? (C * p) / E : Infinity;
      events.push({ ts: all[i].ts, zone: "SELL", levBefore: before, levAfter: L, sizeUsd: D, trigger, price: p });
    } else if (E > 0 && L < lower && U > 0) {
      const B = Math.min(U, target * E - C * p);
      if (B > 1) {
        const before = L;
        U -= B;
        C += (B * (1 - slip)) / p;
        V = C * p + U;
        E = V - S;
        L = E > 0 ? (C * p) / E : Infinity;
        events.push({ ts: all[i].ts, zone: "BUY", levBefore: before, levAfter: L, sizeUsd: B, trigger, price: p });
      }
    }
    const cr = V / S;
    if (E <= 0) underwater++;
    worstCr = Math.min(worstCr, cr);
    if (Number.isFinite(L)) maxLev = Math.max(maxLev, L);
    series.push({ ts: all[i].ts, price: p, xNav: Math.max(0, E) / X, naive2x: Math.max(0, naive), stock: p / p0, leverage: Number.isFinite(L) ? L : -1, cr, trigger });
  }
  const last = series[series.length - 1];
  return {
    asset,
    from: series[0]?.ts,
    to: last?.ts,
    candles: series.length,
    series,
    events,
    summary: {
      xNavEnd: last.xNav,
      naive2xEnd: last.naive2x,
      stockEnd: last.stock,
      worstCr,
      maxLeverage: maxLev,
      sellZones: events.filter((e) => e.zone === "SELL").length,
      buyZones: events.filter((e) => e.zone === "BUY").length,
      underwaterHours: underwater,
    },
    model,
  };
}
