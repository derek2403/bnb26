"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { usePoolList } from "@/hooks/usePools";
import { STOCK_NAMES } from "@/config/demoPools";
import { fmtLev, fmtPct, fmtUsd } from "@/lib/format";
import type { PoolRow } from "@/hooks/usePools";
import { LaunchpadBadge, ModePill, SplitBar, Stat, Tabs } from "./ui";

function Ticker({ sym }: { sym: string }) {
  return <span className="num flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface2 text-[11px] font-semibold text-ink">{sym.slice(0, 4)}</span>;
}

function Row({ r }: { r: PoolRow }) {
  const s = r.snap;
  return (
    <tr className="border-t border-line hover:bg-surface2/60">
      <td className="table-cell">
        <Link href={`/pools/${r.meta.id}`} className="flex items-center gap-3">
          <Ticker sym={r.meta.symbol} />
          <span>
            <span className="block font-medium text-ink">{r.meta.symbol}</span>
            <span className="block text-xs text-muted">{r.meta.name}</span>
          </span>
        </Link>
      </td>
      <td className="table-cell">
        <LaunchpadBadge label={r.meta.launchpad} />
      </td>
      <td className="table-cell num text-right">{s ? fmtUsd(s.price, { digits: 2 }) : "…"}</td>
      <td className="table-cell num text-right">{s ? fmtUsd(s.V, { compact: true }) : "…"}</td>
      <td className="table-cell num text-right text-lever">{s ? fmtLev(s.leverage) : "…"}</td>
      <td className="table-cell num text-right text-stable">{s ? (Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞") : "…"}</td>
      <td className="table-cell hidden w-40 xl:table-cell">{s ? <SplitBar snap={s} compact /> : null}</td>
      <td className="table-cell text-right">{s ? <ModePill mode={s.mode} /> : null}</td>
      <td className="table-cell text-right">
        <Link href={`/pools/${r.meta.id}`} className="btn btn-sm">
          Trade
        </Link>
      </td>
    </tr>
  );
}

function MobileCard({ r }: { r: PoolRow }) {
  const s = r.snap;
  return (
    <Link href={`/pools/${r.meta.id}`} className="card block">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Ticker sym={r.meta.symbol} />
          <div>
            <div className="font-medium text-ink">
              {r.meta.symbol} <span className="text-xs font-normal text-muted">{r.meta.name}</span>
            </div>
            <div className="mt-1">
              <LaunchpadBadge label={r.meta.launchpad} />
            </div>
          </div>
        </div>
        {s && <ModePill mode={s.mode} />}
      </div>
      {s && (
        <>
          <div className="num mt-3 grid grid-cols-4 gap-2 text-xs">
            <div>
              <div className="label">Price</div>
              {fmtUsd(s.price, { digits: 2 })}
            </div>
            <div>
              <div className="label">TVL</div>
              {fmtUsd(s.V, { compact: true })}
            </div>
            <div className="text-lever">
              <div className="label">Lev</div>
              {fmtLev(s.leverage)}
            </div>
            <div className="text-stable">
              <div className="label">CR</div>
              {Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞"}
            </div>
          </div>
          <div className="mt-3">
            <SplitBar snap={s} compact />
          </div>
        </>
      )}
    </Link>
  );
}

function LaunchingSoon({ p }: { p: { id: string; symbol: string; kind: "flap" | "four"; href: string } }) {
  const flap = p.kind === "flap";
  return (
    <Link href={p.href} className="card group flex items-center gap-3 border-dashed transition hover:border-stable/50">
      <Ticker sym={p.symbol} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{p.symbol}</span>
          <span className="text-xs text-muted">{STOCK_NAMES[p.symbol] ?? p.symbol}</span>
          <span className="pill border-warn/40 text-warn">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            Launching soon
          </span>
          <LaunchpadBadge label={flap ? "Flap" : "Four.meme"} short />
        </div>
        <div className="mt-1 text-xs text-muted">
          {flap ? "The SPLIT crowdfund on Flap opens this pool when it fills." : "A tTSLA meme graduating on Four.meme opens this pool."}
        </div>
      </div>
      <span className="shrink-0 text-sm text-stable group-hover:underline">{flap ? "Go to launch →" : "Go to memes →"}</span>
    </Link>
  );
}

type Filter = "all" | "Flap" | "Four.meme";

export function PoolTable() {
  const { rows, pending } = usePoolList();
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const real = rows.filter((r) => !r.meta.isDemo);
    const demo = rows.filter((r) => r.meta.isDemo).sort((a, b) => (b.snap?.V ?? 0) - (a.snap?.V ?? 0));
    return [...real, ...demo].filter((r) => filter === "all" || r.meta.launchpad === filter);
  }, [rows, filter]);
  const totals = useMemo(() => {
    const live = rows.filter((r) => r.snap);
    const V = live.reduce((a, r) => a + (r.snap!.V || 0), 0);
    const S = live.reduce((a, r) => a + (r.snap!.S || 0), 0);
    const E = live.reduce((a, r) => a + Math.max(0, r.snap!.E || 0), 0);
    return { V, S, E, n: rows.length, lev: E > 0 ? V / E : undefined };
  }, [rows]);
  const pendingShown = pending.filter((p) => filter === "all" || (filter === "Flap" ? p.kind === "flap" : p.kind === "four"));

  return (
    <div className="space-y-5">
      <div className="card grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total value locked" value={fmtUsd(totals.V, { compact: true })} />
        <Stat label="sUSD outstanding" value={fmtUsd(totals.S, { compact: true })} tone="stable" sub="$1 of pool value each" />
        <Stat label="xSTOCK equity" value={fmtUsd(totals.E, { compact: true })} tone="lever" sub={totals.lev ? `${fmtLev(totals.lev)} average leverage` : undefined} />
        <Stat label="Pools" value={totals.n + pending.length} sub={pending.length ? `${pending.length} launching soon` : "every launch opens one"} />
      </div>

      {pendingShown.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {pendingShown.map((p) => (
            <LaunchingSoon key={p.id} p={p} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All pools" },
            { value: "Flap", label: "Opened by Flap" },
            { value: "Four.meme", label: "Opened by Four.meme" },
          ]}
        />
        <span className="text-xs text-muted">Live state, refreshed every 10 s</span>
      </div>

      <div className="hidden overflow-x-auto rounded-card border border-line bg-surface md:block">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr>
              <th className="table-head">Pool</th>
              <th className="table-head">Launch</th>
              <th className="table-head text-right">Stock price</th>
              <th className="table-head text-right">TVL</th>
              <th className="table-head text-right">Leverage</th>
              <th className="table-head text-right">CR</th>
              <th className="table-head hidden xl:table-cell">sUSD / x split</th>
              <th className="table-head text-right">Mode</th>
              <th className="table-head" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Row key={r.meta.id} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:hidden">
        {shown.map((r) => (
          <MobileCard key={r.meta.id} r={r} />
        ))}
      </div>
    </div>
  );
}
