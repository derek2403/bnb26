import { formatUnits } from "viem";

export const WAD = 10n ** 18n;
export const MAX_UINT = 2n ** 256n - 1n;

/** bigint in `decimals` -> JS number (display only; never used for amounts sent on-chain). */
export function toNum(v: bigint | undefined | null, decimals = 18): number {
  if (v === undefined || v === null) return 0;
  if (v >= MAX_UINT / 2n) return Number.POSITIVE_INFINITY;
  return Number(formatUnits(v, decimals));
}

export function fmtUsd(n: number | undefined | null, opts: { compact?: boolean; digits?: number } = {}): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  if (!Number.isFinite(n)) return "∞";
  const { compact = false, digits } = opts;
  if (compact && Math.abs(n) >= 10_000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
  }
  const d = digits ?? (Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 || n === 0 ? 2 : 4);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
}

export function fmtNum(n: number | undefined | null, digits = 4): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  if (!Number.isFinite(n)) return "∞";
  const abs = Math.abs(n);
  const d = abs >= 1_000_000 ? 0 : abs >= 1000 ? 2 : abs >= 1 ? Math.min(digits, 4) : digits;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n);
}

export function fmtLev(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  if (!Number.isFinite(n)) return "∞";
  return `${n.toFixed(2)}x`;
}

export function fmtPct(n: number | undefined | null, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  if (!Number.isFinite(n)) return "∞";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtBps(bps: number | bigint | undefined | null): string {
  if (bps === undefined || bps === null) return "–";
  const n = Number(bps);
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}

export function fmtAge(sec: number | undefined | null): string {
  if (sec === undefined || sec === null || !Number.isFinite(sec)) return "–";
  if (sec < 0) return "0s";
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtTime(tsSec: number | undefined | null): string {
  if (!tsSec) return "–";
  return new Date(tsSec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function short(a: string | undefined | null, n = 4): string {
  if (!a) return "–";
  return a.length > 2 + n * 2 ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : a;
}

/** Parse a user-typed decimal string into units; returns undefined when invalid or empty. */
export function parseAmount(s: string, decimals = 18): bigint | undefined {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return undefined;
  const [i, f = ""] = t.split(".");
  if (f.length > decimals) return undefined;
  try {
    return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  } catch {
    return undefined;
  }
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
