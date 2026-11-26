export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** Decimal string or number -> fixed-point bigint with `decimals` digits, no float rounding drift. */
export function toFixed(value: number | string, decimals = 18): bigint {
  const s = typeof value === "number" ? numberToPlain(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`toFixed: not a decimal: ${s}`);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(i) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -v : v;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new Error("toFixed: non-finite");
  // up to 18 significant fraction digits without exponent notation
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  return n.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
}

export function fromFixed(v: bigint, decimals = 18): number {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const d = 10n ** BigInt(decimals);
  const n = Number(a / d) + Number(a % d) / Number(d);
  return neg ? -n : n;
}

/** Scale a fixed-point value between decimal bases (rounds down). */
export function rescale(v: bigint, fromDec: number, toDec: number): bigint {
  if (fromDec === toDec) return v;
  return fromDec < toDec ? v * 10n ** BigInt(toDec - fromDec) : v / 10n ** BigInt(fromDec - toDec);
}

export function median(xs: number[]): number | undefined {
  const a = xs.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
  if (a.length === 0) return undefined;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Annualised sigma of 1h log returns, in bps. Tokenized stocks trade 24/7 on DEX, so we annualise with
 * 24*365 periods. Returns 0 (= "unknown, keep previous rule leverage") with fewer than 12 returns.
 */
export function annualisedVolBps(closes: number[], periodsPerYear = 24 * 365): number {
  const c = closes.filter((x) => Number.isFinite(x) && x > 0);
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  if (r.length < 12) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.round(Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 10_000);
}

export function bpsDiff(a: number, b: number): number {
  return b === 0 ? 0 : Math.round(((a - b) / b) * 10_000);
}

export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);
export const clampBig = (x: bigint, lo: bigint, hi: bigint) => (x < lo ? lo : x > hi ? hi : x);

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** CMC timestamps: ISO string, seconds or milliseconds -> milliseconds. */
export function toMs(ts: unknown): number | undefined {
  if (ts === null || ts === undefined) return undefined;
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    if (/^\d+$/.test(ts)) {
      const n = Number(ts);
      return n > 1e12 ? n : n * 1000;
    }
    const d = Date.parse(ts);
    return Number.isNaN(d) ? undefined : d;
  }
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
