"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePoolList } from "@/hooks/usePools";
import { STOCK_NAMES } from "@/config/demoPools";
import { fmtLev, fmtUsd } from "@/lib/format";
import { TickerIcon } from "../ui";

export function MarketSelector({ id, symbol, name, leverSymbol }: { id: string; symbol: string; name: string; leverSymbol: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const { rows, pending } = usePoolList();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const needle = q.trim().toLowerCase();
  const list = [...rows]
    .sort((a, b) => Number(a.meta.isDemo) - Number(b.meta.isDemo) || (b.snap?.V ?? 0) - (a.snap?.V ?? 0))
    .filter((r) => !needle || r.meta.symbol.toLowerCase().includes(needle) || r.meta.name.toLowerCase().includes(needle));
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2.5 rounded px-1.5 py-1 hover:bg-surface2" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
        <TickerIcon sym={symbol} size={30} />
        <span className="text-left">
          <span className="flex items-center gap-1.5 text-[15px] font-semibold leading-tight text-ink">
            {symbol}
            <span className="num text-xs font-medium text-lever">/ {leverSymbol}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted" aria-hidden>
              <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </span>
          <span className="block text-xs leading-tight text-muted">{name}</span>
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[min(92vw,380px)] rounded-card border border-line bg-surface shadow-xl" role="listbox">
          <div className="border-b border-line p-2">
            <input autoFocus className="input h-8 py-1" placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-2xs uppercase tracking-wider text-faint">
            <span>Market</span>
            <span className="text-right">Price</span>
            <span className="text-right">Lev</span>
          </div>
          <div className="max-h-[360px] overflow-y-auto pb-1">
            {list.map((r) => (
              <Link
                key={r.meta.id}
                href={`/trade/${r.meta.id}`}
                onClick={() => setOpen(false)}
                className={`grid grid-cols-[1fr_auto_auto] items-center gap-x-4 px-3 py-1.5 hover:bg-surface2 ${r.meta.id === id ? "bg-surface2" : ""}`}
                role="option"
                aria-selected={r.meta.id === id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{r.meta.symbol}</span>
                  <span className="truncate text-xs text-muted">{r.meta.name}</span>
                  {!r.meta.isDemo && <span className="pill py-0 text-2xs text-accent">live</span>}
                </span>
                <span className="num text-right text-xs text-ink">{r.snap ? fmtUsd(r.snap.price, { digits: 2 }) : "…"}</span>
                <span className="num w-12 text-right text-xs text-lever">{r.snap ? fmtLev(r.snap.leverage) : "…"}</span>
              </Link>
            ))}
            {pending.map((p) => (
              <Link key={p.id} href="/launchpad" onClick={() => setOpen(false)} className="grid grid-cols-[1fr_auto] items-center gap-x-4 px-3 py-1.5 hover:bg-surface2">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{p.symbol}</span>
                  <span className="text-xs text-muted">{STOCK_NAMES[p.symbol]}</span>
                </span>
                <span className="pill border-warn/40 text-warn">Launching</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
