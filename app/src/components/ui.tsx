"use client";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { addressUrl } from "@/config/chains";
import { fmtBps, fmtDuration, fmtLev, fmtPct, fmtUsd, short } from "@/lib/format";
import type { ModeName, PoolSnapshot } from "@/lib/types";

export function Card({ title, right, children, className = "", pad = true }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded-card border border-line bg-surface ${className}`}>
      {(title || right) && (
        <div className="flex min-h-[40px] items-center justify-between gap-2 border-b border-line px-4 py-2">
          {title && <h2 className="text-[13px] font-semibold text-ink">{title}</h2>}
          {right}
        </div>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone, size = "md" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "stable" | "lever" | "good" | "bad" | "warn"; size?: "sm" | "md" | "lg" }) {
  const color = tone === "stable" ? "text-stable" : tone === "lever" ? "text-lever" : tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink";
  const fs = size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base";
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`num mt-0.5 truncate font-medium ${fs} ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function KV({ k, v, mono = true, tone }: { k: ReactNode; v: ReactNode; mono?: boolean; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="text-muted">{k}</span>
      <span className={`${mono ? "num" : ""} truncate text-right ${tone ?? "text-ink"}`}>{v}</span>
    </div>
  );
}

export function Addr({ a, chainId, label }: { a?: string; chainId?: number; label?: string }) {
  if (!a) return <span className="text-faint">not deployed</span>;
  return (
    <a className="num link text-xs" href={addressUrl(a, chainId)} target="_blank" rel="noreferrer" title={a}>
      {label ?? short(a)}
    </a>
  );
}

export function Change({ v, digits = 2, className = "" }: { v: number | undefined | null; digits?: number; className?: string }) {
  if (v === undefined || v === null || !Number.isFinite(v)) return <span className={`num text-faint ${className}`}>–</span>;
  const tone = v > 0 ? "text-good" : v < 0 ? "text-bad" : "text-muted";
  return (
    <span className={`num ${tone} ${className}`}>
      {v > 0 ? "+" : ""}
      {(v * 100).toFixed(digits)}%
    </span>
  );
}

/** Stocks with a logo in public/logos (company logos from the tokenized-stock listings on CoinMarketCap). */
const LOGOS = new Set(["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "AVGO", "NFLX", "COIN", "MSTR", "AMD"]);

export function TickerIcon({ sym, size = 28 }: { sym: string; size?: number }) {
  const base = sym.toUpperCase().replace(/^X/, "");
  if (LOGOS.has(base)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/logos/${base}.png`} alt={`${base} logo`} width={size} height={size} className="shrink-0 rounded-full border border-line" style={{ width: size, height: size }} />
    );
  }
  return (
    <span className="num flex shrink-0 items-center justify-center rounded-full border border-line bg-surface2 font-semibold text-ink" style={{ width: size, height: size, fontSize: size <= 24 ? 9 : 10 }}>
      {sym.slice(0, 4)}
    </span>
  );
}

/** "Opened by Flap" / "Opened by Four.meme" source badge. */
const SOURCE_LOGO: Record<string, string> = { Flap: "/partners/flap.png", "Four.meme": "/partners/fourmeme.png" };

export function SourceBadge({ label, short: _compact = false, iconOnly = false }: { label: string; short?: boolean; iconOnly?: boolean }) {
  const logo = SOURCE_LOGO[label];
  if (iconOnly && logo) {
    // Logo only, in a box of a fixed size, so a row of badges lines up.
    return (
      <span className="inline-flex h-7 w-[72px] items-center justify-center rounded border border-line bg-surface" title={`Opened by ${label}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt={label} width={18} height={18} className="h-[18px] w-[18px] rounded-[3px] object-contain" />
      </span>
    );
  }
  return (
    <span className="pill" title={`Opened by ${label}`}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" width={14} height={14} className="h-3.5 w-3.5 rounded-[3px] bg-white object-contain" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-faint" />
      )}
      {label}
    </span>
  );
}

const MODE_STYLE: Record<ModeName, string> = {
  UNSEEDED: "text-faint",
  NORMAL: "text-muted",
  STABILITY: "text-warn",
  UNDERWATER: "text-bad",
  NO_PRICE: "text-bad",
};
const MODE_LABEL: Record<ModeName, string> = { UNSEEDED: "Unseeded", NORMAL: "Normal", STABILITY: "Stability mode", UNDERWATER: "Underwater", NO_PRICE: "No price" };

export function ModePill({ mode }: { mode: ModeName }) {
  return (
    <span className={`pill ${MODE_STYLE[mode]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {MODE_LABEL[mode]}
    </span>
  );
}

export function MarketStatusPill({ label, open, halfDay, gapGuard, feeBps, nextOpen, nextClose, now }: { label: string; open: boolean; halfDay?: boolean; gapGuard?: boolean; feeBps?: number; nextOpen?: number; nextClose?: number; now: number }) {
  const dot = open ? (halfDay ? "bg-warn" : "bg-good") : gapGuard ? "bg-warn" : "bg-faint";
  const when = open && nextClose ? `closes in ${fmtDuration(nextClose - now)}` : !open && nextOpen ? `opens in ${fmtDuration(nextOpen - now)}` : "";
  return (
    <span className="pill" title={`NYSE hours from the on-chain MarketCalendar.${when ? ` ${when}.` : ""} ${open ? "Open-market" : "Closed-market"} mint fee applies.`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-ink">{label}</span>
      {feeBps !== undefined && <span>· {fmtBps(feeBps)} fee</span>}
    </span>
  );
}

function pos(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
}

function Marker({ at }: { at: number }) {
  return <div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `calc(${at}% - 1px)` }} />;
}

export function LeverageGauge({ snap }: { snap: PoolSnapshot }) {
  const min = 1;
  const max = 3.2;
  const lo = pos(snap.lowerTriggerLev, min, max);
  const hi = pos(snap.triggerLev, min, max);
  const tg = pos(snap.targetLev, min, max);
  const inBand = snap.leverage >= snap.lowerTriggerLev && snap.leverage <= snap.triggerLev;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">Pool leverage</span>
        <span className={`num text-sm font-medium ${inBand ? "text-lever" : "text-bad"}`}>{fmtLev(snap.leverage)}</span>
      </div>
      <div className="relative mt-2 h-2">
        <div className="absolute inset-0 overflow-hidden rounded-sm bg-surface2">
          <div className="absolute inset-y-0 bg-lever/25" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
          <div className="absolute inset-y-0 right-0 bg-bad/25" style={{ left: `${hi}%` }} />
          <div className="absolute inset-y-0 w-px bg-ink/40" style={{ left: `${tg}%` }} />
        </div>
        <Marker at={pos(snap.leverage, min, max)} />
      </div>
      <div className="num mt-1.5 flex justify-between text-2xs text-faint">
        <span>buy zone &lt; {fmtLev(snap.lowerTriggerLev)}</span>
        <span>target {fmtLev(snap.targetLev)}</span>
        <span>sell zone &gt; {fmtLev(snap.triggerLev)}</span>
      </div>
    </div>
  );
}

export function CrGauge({ snap }: { snap: PoolSnapshot }) {
  const min = 0.8;
  const max = 3;
  const one = pos(1, min, max);
  const st = pos(snap.stabilityCR, min, max);
  const tone = snap.cr < 1 ? "text-bad" : snap.cr < snap.stabilityCR ? "text-warn" : "text-stable";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">sUSD backing (collateral ratio)</span>
        <span className={`num text-sm font-medium ${tone}`}>{Number.isFinite(snap.cr) ? fmtPct(snap.cr, 0) : "∞"}</span>
      </div>
      <div className="relative mt-2 h-2">
        <div className="absolute inset-0 overflow-hidden rounded-sm bg-surface2">
          <div className="absolute inset-y-0 left-0 bg-bad/25" style={{ width: `${one}%` }} />
          <div className="absolute inset-y-0 bg-warn/20" style={{ left: `${one}%`, width: `${st - one}%` }} />
          <div className="absolute inset-y-0 right-0 bg-stable/20" style={{ left: `${st}%` }} />
        </div>
        <Marker at={pos(snap.cr, min, max)} />
      </div>
      <div className="num mt-1.5 flex justify-between text-2xs text-faint">
        <span>pro rata &lt; 100%</span>
        <span>stability &lt; {fmtPct(snap.stabilityCR, 0)}</span>
        <span>300%</span>
      </div>
    </div>
  );
}

export function SplitBar({ snap, compact = false }: { snap: PoolSnapshot; compact?: boolean }) {
  const V = Math.max(snap.V, 1e-9);
  const s = Math.min(100, (snap.S / V) * 100);
  const e = Math.max(0, 100 - s);
  return (
    <div>
      {!compact && (
        <div className="mb-1.5 flex justify-between text-xs">
          <span className="text-stable">
            sUSD <span className="num">{fmtUsd(snap.S, { compact: true })}</span> ({s.toFixed(0)}%)
          </span>
          <span className="text-lever">
            xSTOCK <span className="num">{fmtUsd(Math.max(0, snap.E), { compact: true })}</span> ({e.toFixed(0)}%)
          </span>
        </div>
      )}
      <div className={`flex gap-px overflow-hidden rounded-sm bg-surface2 ${compact ? "h-1" : "h-2"}`}>
        <div className="bg-stable" style={{ width: `${s}%` }} />
        <div className="bg-lever" style={{ width: `${e}%` }} />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</div>;
}

export function Offline({ what = "The keeper API", note }: { what?: string; note?: string }) {
  return (
    <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink/80">
      {what} is not reachable right now. {note ?? "On-chain data still loads; history comes back when the keeper's API is up."}
    </div>
  );
}

/** Segmented control. */
export function Seg<T extends string>({ value, onChange, items, className = "" }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={`seg ${className}`} role="tablist">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} className={`seg-item ${value === i.value ? "seg-active" : ""}`} onClick={() => onChange(i.value)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** Underline tabs. */
export function UTabs<T extends string>({ value, onChange, items, className = "" }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div className={`flex overflow-x-auto ${className}`} role="tablist">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} className={`utab ${value === i.value ? "utab-active" : ""}`} onClick={() => onChange(i.value)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** GET one of our own /api routes (which proxy the services API). `offline` when it answers 503/err. */
export function useApi<T>(path: string | null, refetchMs = 30_000) {
  return useQuery({
    queryKey: ["api", path],
    enabled: !!path,
    refetchInterval: refetchMs,
    queryFn: async (): Promise<{ data: T | null; offline: boolean; status: number }> => {
      try {
        const r = await fetch(path!);
        if (!r.ok) return { data: null, offline: r.status === 503 || r.status >= 500, status: r.status };
        return { data: (await r.json()) as T, offline: false, status: r.status };
      } catch {
        return { data: null, offline: true, status: 0 };
      }
    },
  });
}
