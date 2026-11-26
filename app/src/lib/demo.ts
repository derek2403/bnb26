// Deterministic simulated state for demo pools: same output for every viewer at the same time, with a gentle
// drift (slow sines) so the numbers move like a live pool. Local user actions are layered on top (overlay).
import type { DemoPoolDef } from "@/config/demoPools";
import { nyseStatus } from "./nyse";
import { DEFAULT_SIM_PARAMS, type SimState } from "./sim";

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DemoOverlay = { dC: number; dU: number; dS: number; dX: number; dSp: number };
export const EMPTY_OVERLAY: DemoOverlay = { dC: 0, dU: 0, dS: 0, dX: 0, dSp: 0 };

const TWO_PI = Math.PI * 2;

export function demoState(def: DemoPoolDef, priceUsd: number, tSec: number, overlay: DemoOverlay = EMPTY_OVERLAY): SimState {
  const r = rng(hash(def.id));
  const ph1 = r() * TWO_PI;
  const ph2 = r() * TWO_PI;
  const ph3 = r() * TWO_PI;
  const uShare = 0.03 + r() * 0.07;
  const xNavBase = 0.9 + r() * 0.8;
  const spShare = 0.08 + r() * 0.12;
  const buffer = 6_000 + r() * 34_000;
  const pushOffset = Math.floor(r() * 45);

  // Slow drift: leverage +-0.1x over ~6h, a smaller 47-minute wobble; price +-0.25% over ~13 minutes.
  const lev = def.baseLeverage + 0.08 * Math.sin((TWO_PI * tSec) / 21600 + ph1) + 0.025 * Math.sin((TWO_PI * tSec) / 2820 + ph2);
  const P = priceUsd * (1 + 0.0025 * Math.sin((TWO_PI * tSec) / 780 + ph3));
  const V = def.tvlUsd * (1 + 0.012 * Math.sin((TWO_PI * tSec) / 86400 + ph2));
  const U = V * uShare;
  const stockUsd = V - U;
  const E = stockUsd / lev;
  const S = V - E;
  const X = def.tvlUsd / def.baseLeverage / xNavBase;
  const m = nyseStatus(tSec);
  const gapGuard = !m.open && m.nextOpen - tSec <= 3600;

  // Push oracle cadence: a new round about every 60 s.
  const sinceRound = (tSec + pushOffset) % 60;

  return {
    C: stockUsd / P + overlay.dC,
    U: U + overlay.dU,
    S: S + overlay.dS,
    X: X + overlay.dX,
    P,
    anchor: priceUsd,
    spDeposits: S * spShare + overlay.dSp,
    vaultBufferUsd: buffer,
    params: { ...DEFAULT_SIM_PARAMS },
    marketOpen: m.open,
    gapGuard,
    priceUpdatedAt: tSec - sinceRound,
    snapshotId: Math.floor(tSec / 300),
    riskSource: "RULE",
  };
}
