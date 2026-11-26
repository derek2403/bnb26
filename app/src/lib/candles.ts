// Shared (client + server) candle helpers: types, the deterministic synthetic generator used for demo markets and
// as the fallback when CMC has no k-lines, aggregation, and 24h stats.

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Interval = "1h" | "4h" | "1d";
export const INTERVALS: Interval[] = ["1h", "4h", "1d"];
export const INTERVAL_SEC: Record<Interval, number> = { "1h": 3600, "4h": 14_400, "1d": 86_400 };
/** Bars returned per interval (about 12 days of 1h, 50 days of 4h, 200 days of 1d). */
export const BARS: Record<Interval, number> = { "1h": 300, "4h": 300, "1d": 200 };

export type CandleResponse = {
  id: string;
  symbol: string;
  interval: Interval;
  /** cmc = CMC DEX k-lines of the tokenized stock on BSC; synthetic = generated around the live price (CMC
   *  unavailable); simulated = demo market. */
  source: "cmc" | "synthetic" | "simulated";
  token?: string;
  note?: string;
  candles: Candle[];
};

export const isInterval = (v: unknown): v is Interval => v === "1h" || v === "4h" || v === "1d";

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Uniform in (0,1) from a key (stable across calls). */
function u(key: string): number {
  let a = hash(key) || 1;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967297;
}

function gauss(key: string): number {
  return Math.sqrt(-2 * Math.log(u(`${key}a`))) * Math.cos(2 * Math.PI * u(`${key}b`));
}

const SIGMA: Record<Interval, number> = { "1h": 0.0045, "4h": 0.009, "1d": 0.019 };

/** Deterministic OHLCV ending at `anchor` (the current price) in the bar that contains `nowSec`. Each bar's shape
 *  is keyed by its absolute time bucket, so history stays put as time moves; only the scale follows `anchor`. */
export function syntheticCandles(seed: string, interval: Interval, anchor: number, nowSec: number, count = BARS[interval], baseVolume = 1_000_000): Candle[] {
  const step = INTERVAL_SEC[interval];
  const last = Math.floor(nowSec / step);
  const sigma = SIGMA[interval];
  const rets: number[] = [];
  for (let i = 0; i < count; i++) {
    const k = last - (count - 1) + i;
    // fat-ish tails plus a slow regime term so the chart has trends, not just noise
    const regime = 0.15 * Math.sin((k / 37) * Math.PI + u(`${seed}r`) * 6.28);
    rets.push(sigma * (gauss(`${seed}:${interval}:${k}`) * (1 + 0.4 * Math.abs(gauss(`${seed}:${interval}:${k}v`))) + regime * 0.25));
  }
  const closes = new Array<number>(count);
  closes[count - 1] = anchor;
  for (let i = count - 1; i > 0; i--) closes[i - 1] = closes[i] / Math.exp(rets[i]);
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const k = last - (count - 1) + i;
    const c = closes[i];
    const o = i === 0 ? c / Math.exp(rets[0]) : closes[i - 1];
    const wick = sigma * 0.6;
    const h = Math.max(o, c) * (1 + Math.abs(gauss(`${seed}:${k}h`)) * wick);
    const l = Math.min(o, c) * (1 - Math.abs(gauss(`${seed}:${k}l`)) * wick);
    const move = Math.abs(rets[i]) / sigma;
    const v = baseVolume * (step / 3600) ** 0.8 * (0.45 + u(`${seed}:${k}vol`)) * (1 + 0.6 * move);
    out.push({ t: k * step, o, h, l, c, v });
  }
  return out;
}

/** Merge consecutive bars into `step`-second buckets. */
export function aggregate(candles: Candle[], step: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.t / step) * step;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    } else out.push({ ...c, t });
  }
  return out;
}

/** 24h change, high, low and volume from candles (any interval up to 1d). */
export function stats24h(candles: Candle[], live?: number): { change?: number; high?: number; low?: number; volume?: number; last?: number } {
  if (!candles.length) return {};
  const lastBar = candles[candles.length - 1];
  const last = live ?? lastBar.c;
  const since = lastBar.t + 1 - 86_400;
  const win = candles.filter((c) => c.t >= since);
  const ref = candles.find((c) => c.t >= since - 3600) ?? candles[0];
  const open = win.length ? win[0].o : ref.o;
  return {
    last,
    change: open > 0 ? (last - open) / open : undefined,
    high: win.length ? Math.max(...win.map((c) => c.h), last) : undefined,
    low: win.length ? Math.min(...win.map((c) => c.l), last) : undefined,
    volume: win.reduce((a, c) => a + c.v, 0),
  };
}

// --------------------------------------------------------------- CMC k-line parsing (server route)

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const toSec = (v: unknown): number | undefined => {
  if (typeof v === "string" && !/^\d+(\.\d+)?$/.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  const n = num(v);
  if (n === undefined) return undefined;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
};

/** /v1/k-line/candles data -> candles sorted by time. Each candle is [open, high, low, close, volume, timestamp, …]
 *  or an object with open/high/low/close/volume/timestamp (shape parsed defensively, as in services/src/lib/cmc.ts). */
export function parseCmcCandles(data: unknown): Candle[] {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const list = Array.isArray(data) ? data : obj ? ((obj.candles ?? obj.list ?? obj.items ?? obj.klines ?? []) as unknown[]) : [];
  const out: Candle[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (Array.isArray(c)) {
      const t = toSec(c[5]);
      const close = num(c[3]);
      if (t !== undefined && close !== undefined && close > 0) out.push({ t, o: num(c[0]) ?? close, h: num(c[1]) ?? close, l: num(c[2]) ?? close, c: close, v: num(c[4]) ?? 0 });
    } else if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const t = toSec(o.timestamp ?? o.ts ?? o.t ?? o.time ?? o.time_open);
      const close = num(o.close ?? o.c);
      if (t !== undefined && close !== undefined && close > 0) out.push({ t, o: num(o.open ?? o.o) ?? close, h: num(o.high ?? o.h) ?? close, l: num(o.low ?? o.l) ?? close, c: close, v: num(o.volume ?? o.v) ?? 0 });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // drop duplicate timestamps (keep the last)
  return out.filter((c, i) => i === out.length - 1 || out[i + 1].t !== c.t);
}
