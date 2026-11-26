"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { addressUrl } from "@/config/chains";
import { fmtAge, fmtBps, fmtDuration, fmtLev, fmtPct, fmtUsd, short } from "@/lib/format";
import type { ModeName, PoolSnapshot } from "@/lib/types";

export function MockBanner() {
  return (
    <div className="border-b border-line bg-lever-soft/60 px-4 py-1.5 text-center text-[11px] text-ink/80">
      <span className="font-semibold">MOCK · TESTNET</span> · tNVDA, tTSLA and mUSDC are test tokens. sUSD and xSTOCK here have no value. No
      real-money pool exists.
    </div>
  );
}

export function PageHeader({ title, lede, right }: { title: string; lede?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {lede && <p className="mt-1 max-w-3xl text-sm text-muted">{lede}</p>}
      </div>
      {right}
    </div>
  );
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="card-title">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "stable" | "lever" | "good" | "bad" | "warn" }) {
  const color = tone === "stable" ? "text-stable" : tone === "lever" ? "text-lever" : tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`num mt-1 truncate text-lg font-semibold ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function KV({ k, v, mono = true }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-muted">{k}</span>
      <span className={`${mono ? "num" : ""} truncate text-right text-ink`}>{v}</span>
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

export function LaunchpadBadge({ label, short = false }: { label: string; short?: boolean }) {
  const tone = label === "Flap" ? "border-lever/40 text-lever" : label === "Four.meme" ? "border-good/40 text-good" : "";
  return (
    <span className={`pill ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {short ? label : `Opened by ${label}`}
    </span>
  );
}

const MODE_STYLE: Record<ModeName, string> = {
  UNSEEDED: "text-faint",
  NORMAL: "text-good",
  STABILITY: "text-warn",
  UNDERWATER: "text-bad",
  NO_PRICE: "text-bad",
};

export function ModePill({ mode }: { mode: ModeName }) {
  return (
    <span className="pill">
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${MODE_STYLE[mode]}`} />
      <span className={MODE_STYLE[mode]}>{mode.replace("_", " ")}</span>
    </span>
  );
}

export function MarketPill({ open, gapGuard, nextOpen, nextClose, now, feeBps }: { open: boolean; gapGuard: boolean; nextOpen?: number; nextClose?: number; now: number; feeBps?: number }) {
  const label = open ? "Market open" : gapGuard ? "Pre-open gap guard" : "Market closed";
  const tone = open ? "bg-good" : gapGuard ? "bg-warn" : "bg-faint";
  const when = open && nextClose ? `closes in ${fmtDuration(nextClose - now)}` : !open && nextOpen ? `opens in ${fmtDuration(nextOpen - now)}` : "";
  return (
    <span className="pill" title={`NYSE hours from the on-chain MarketCalendar. ${open ? "Open-market mint fee applies." : "Closed-market mint fee and leverage cap apply."}${when ? ` NYSE ${when}.` : ""}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      <span className="text-ink">{label}</span>
      {feeBps !== undefined && <span>· {fmtBps(feeBps)} fee</span>}
      {when && <span className="hidden text-faint sm:inline">· {when}</span>}
    </span>
  );
}

/** Mint fee base for the market pill: the RiskOracle open/closed fee when known, else the current sUSD mint fee. */
export function marketFeeBps(snap: PoolSnapshot): number {
  const base = snap.marketOpen ? snap.openFeeBps : snap.closedFeeBps;
  return base ?? snap.stableMintFeeBps;
}

export function PriceChip({ snap, pull, source = "Atlas" }: { snap: PoolSnapshot; pull?: { price: number | null; ts: number | null } | null; mirror?: { srcUpdatedAt: number } | null; source?: string }) {
  const pushFresh = snap.priceFresh && !snap.feedHalted;
  const dev = pull?.price && snap.price ? (pull.price - snap.price) / snap.price : undefined;
  const now = Math.floor(Date.now() / 1000);
  return (
    <span
      className="pill"
      title={`${source} price on-chain (AtlasMirror relays the BSC mainnet Atlas round). Age = time since the feed's updatedAt.${pull?.price ? ` Signed Atlas pull: ${fmtUsd(pull.price, { digits: 2 })}${pull.ts ? `, ${fmtAge(now - pull.ts)} ago` : ""}.` : ""}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${snap.feedHalted ? "bg-bad" : pushFresh ? "bg-good" : "bg-warn"}`} />
      <span className="num text-ink">{fmtUsd(snap.price, { digits: 2 })}</span>
      <span>
        · {source} · {fmtAge(snap.priceUpdatedAt > 0 ? Math.max(0, now - snap.priceUpdatedAt) : snap.priceAge)} ago
      </span>
      {dev !== undefined && <span className={`hidden sm:inline ${Math.abs(dev) > 0.01 ? "text-warn" : "text-faint"}`}>· pull {dev >= 0 ? "+" : ""}{(dev * 100).toFixed(2)}%</span>}
      {!pushFresh && !snap.feedHalted && <span className="text-warn">stale</span>}
      {snap.feedHalted && <span className="text-bad">HALTED</span>}
    </span>
  );
}

function pos(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
}

export function LeverageGauge({ snap }: { snap: PoolSnapshot }) {
  const min = 1;
  const max = 3.2;
  const lo = pos(snap.lowerTriggerLev, min, max);
  const hi = pos(snap.triggerLev, min, max);
  const tg = pos(snap.targetLev, min, max);
  const cur = pos(snap.leverage, min, max);
  const inBand = snap.leverage >= snap.lowerTriggerLev && snap.leverage <= snap.triggerLev;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">Leverage (xSTOCK)</span>
        <span className={`num text-sm font-semibold ${inBand ? "text-lever" : "text-bad"}`}>{fmtLev(snap.leverage)}</span>
      </div>
      <div className="relative mt-2 h-3 overflow-hidden rounded-full bg-surface2">
        <div className="absolute inset-y-0 left-0 bg-stable/20" style={{ width: `${lo}%` }} />
        <div className="absolute inset-y-0 bg-lever/15" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        <div className="absolute inset-y-0 right-0 bg-bad/20" style={{ left: `${hi}%` }} />
        <div className="absolute inset-y-0 w-px bg-ink/40" style={{ left: `${tg}%` }} />
      </div>
      <div className="relative h-3">
        <div className="absolute -top-[18px] h-[18px] w-0.5 rounded bg-ink" style={{ left: `calc(${cur}% - 1px)` }} />
      </div>
      <div className="num flex justify-between text-[10px] text-faint">
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
  const cur = pos(snap.cr, min, max);
  const one = pos(1, min, max);
  const st = pos(snap.stabilityCR, min, max);
  const tone = snap.cr < 1 ? "text-bad" : snap.cr < snap.stabilityCR ? "text-warn" : "text-stable";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">Collateral ratio (sUSD)</span>
        <span className={`num text-sm font-semibold ${tone}`}>{Number.isFinite(snap.cr) ? fmtPct(snap.cr, 0) : "∞"}</span>
      </div>
      <div className="relative mt-2 h-3 overflow-hidden rounded-full bg-surface2">
        <div className="absolute inset-y-0 left-0 bg-bad/25" style={{ width: `${one}%` }} />
        <div className="absolute inset-y-0 bg-warn/20" style={{ left: `${one}%`, width: `${st - one}%` }} />
        <div className="absolute inset-y-0 right-0 bg-stable/15" style={{ left: `${st}%` }} />
      </div>
      <div className="relative h-3">
        <div className="absolute -top-[18px] h-[18px] w-0.5 rounded bg-ink" style={{ left: `calc(${cur}% - 1px)` }} />
      </div>
      <div className="num flex justify-between text-[10px] text-faint">
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
            xSTOCK equity <span className="num">{fmtUsd(Math.max(0, snap.E), { compact: true })}</span> ({e.toFixed(0)}%)
          </span>
        </div>
      )}
      <div className={`flex overflow-hidden rounded-full bg-surface2 ${compact ? "h-1.5" : "h-2.5"}`}>
        <div className="bg-stable" style={{ width: `${s}%` }} />
        <div className="bg-lever" style={{ width: `${e}%` }} />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</div>;
}

export function Offline({ what = "The services API", note }: { what?: string; note?: string }) {
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink/80">
      {what} is not reachable right now. {note ?? "On-chain data on this page still loads; history and rationale come back when the keeper's API is up."}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-surface2 p-1">
      {items.map((i) => (
        <button key={i.value} className={`tab ${value === i.value ? "tab-active" : ""}`} onClick={() => onChange(i.value)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function NavLinkCard({ href, title, body, tone }: { href: string; title: string; body: string; tone?: "stable" | "lever" }) {
  return (
    <Link href={href} className="card block transition hover:border-stable/40">
      <div className={`text-sm font-semibold ${tone === "stable" ? "text-stable" : tone === "lever" ? "text-lever" : "text-ink"}`}>{title} →</div>
      <div className="mt-1 text-xs text-muted">{body}</div>
    </Link>
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
