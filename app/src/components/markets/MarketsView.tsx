"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { STOCK_NAMES } from "@/config/demoPools";
import { fetchCandles } from "@/hooks/useMarket";
import { useDemoPrices, useNow, usePoolList, type PoolRow } from "@/hooks/usePools";
import { stats24h, syntheticCandles, type Candle } from "@/lib/candles";
import { fmtLev, fmtPct, fmtUsd } from "@/lib/format";
import { Change, Seg, SourceBadge, TickerIcon } from "../ui";
import { Sparkline } from "../Sparkline";

type Market = {
  id: string;
  symbol: string;
  name: string;
  launchpad: string;
  live: boolean;
  pending?: boolean;
  price?: number;
  change?: number;
  spark: number[];
  nav?: number;
  lev?: number;
  cr?: number;
  tvl?: number;
  sUSD?: number;
  equity?: number;
  vault?: number;
};

type SortKey = "default" | "price" | "change" | "lev" | "cr" | "tvl";
type Filter = "all" | "Flap" | "Four.meme";

const SPARK_BARS = 168; // 7 days of 1h bars

function sparkOf(c: Candle[] | undefined): number[] {
  return (c ?? []).slice(-SPARK_BARS).map((x) => x.c);
}

export function MarketsView() {
  const router = useRouter();
  const { rows, pending } = usePoolList();
  const prices = useDemoPrices();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "default", dir: -1 });
  const [q, setQ] = useState("");

  const realRows = rows.filter((r) => !r.meta.isDemo);
  const candleQs = useQueries({
    queries: realRows.map((r) => ({
      queryKey: ["candles", r.meta.id, "1h"],
      enabled: !!r.snap,
      staleTime: 60_000,
      refetchInterval: 60_000,
      queryFn: () => fetchCandles(r.meta.id, "1h", r.snap?.price),
    })),
  });

  const markets: Market[] = useMemo(() => {
    const fromRow = (r: PoolRow, candles?: Candle[]): Market => {
      const s = r.snap;
      const st = candles?.length ? stats24h(candles, s?.price) : {};
      // CMC quote change when we have one; otherwise the candles (never synthetic bars for a live market).
      const cmc = prices.data?.prices[r.meta.symbol];
      const change = cmc?.source === "cmc" && cmc.change24h !== undefined ? cmc.change24h / 100 : st.change;
      return {
        id: r.meta.id,
        symbol: r.meta.symbol,
        name: r.meta.name,
        launchpad: r.meta.launchpad,
        live: !r.meta.isDemo,
        price: s?.price,
        change,
        spark: sparkOf(candles),
        nav: s?.xNav,
        lev: s?.leverage,
        cr: s?.cr,
        tvl: s?.V,
        sUSD: s?.S,
        equity: s ? Math.max(0, s.E) : undefined,
        vault: s?.backstopUsd,
      };
    };
    const out: Market[] = [];
    realRows.forEach((r, i) => {
      const c = candleQs[i]?.data;
      out.push(fromRow(r, c?.source === "cmc" ? c.candles : undefined));
    });
    for (const p of pending) {
      const ref = prices.data?.prices[p.symbol];
      out.push({ id: p.id, symbol: p.symbol, name: STOCK_NAMES[p.symbol] ?? p.symbol, launchpad: p.kind === "flap" ? "Flap" : "Four.meme", live: true, pending: true, price: ref?.price, change: ref?.change24h !== undefined ? ref.change24h / 100 : undefined, spark: [] });
    }
    for (const r of rows.filter((x) => x.meta.isDemo)) {
      const c = r.snap ? syntheticCandles(r.meta.id, "1h", r.snap.price, now, SPARK_BARS + 2) : undefined;
      out.push(fromRow(r, c));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, pending, prices.data, now, candleQs.map((c) => c.dataUpdatedAt).join(",")]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = markets.filter((m) => (filter === "all" || m.launchpad === filter) && (!needle || m.symbol.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)));
    if (sort.key !== "default") {
      const val = (m: Market) => (sort.key === "price" ? m.price : sort.key === "change" ? m.change : sort.key === "lev" ? m.lev : sort.key === "cr" ? (Number.isFinite(m.cr) ? m.cr : 1e9) : m.tvl) ?? -Infinity;
      list = [...list].sort((a, b) => (val(a) - val(b)) * sort.dir);
    } else {
      list = [...list].sort((a, b) => Number(b.live) - Number(a.live) || (b.tvl ?? 0) - (a.tvl ?? 0));
    }
    return list;
  }, [markets, filter, sort, q]);

  const totals = useMemo(() => {
    const ok = markets.filter((m) => !m.pending && m.tvl !== undefined);
    const sum = (f: (m: Market) => number | undefined) => ok.reduce((a, m) => a + (f(m) ?? 0), 0);
    return { tvl: sum((m) => m.tvl), sUSD: sum((m) => m.sUSD), equity: sum((m) => m.equity), vault: sum((m) => m.vault), n: markets.filter((m) => !m.pending).length, launching: markets.filter((m) => m.pending).length };
  }, [markets]);

  const head = (key: SortKey, label: string, cls = "") => (
    <th className={`th cursor-pointer select-none text-right hover:text-ink ${cls}`} onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }))} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {label}
      {sort.key === key ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Markets</h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-muted">
            Each market splits one tokenized stock into <span className="text-lever">xSTOCK</span>, about 2× long exposure that is never liquidated, and <span className="text-stable">sUSD</span>, a dollar backed by the stock.
            You only need the test stock token to start.
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 divide-line rounded-card border border-line bg-surface sm:grid-cols-5 sm:divide-x">
        {[
          { k: "Total value locked", v: fmtUsd(totals.tvl, { compact: true }) },
          { k: "xSTOCK equity", v: fmtUsd(totals.equity, { compact: true }), tone: "text-lever" },
          { k: "sUSD outstanding", v: fmtUsd(totals.sUSD, { compact: true }), tone: "text-stable" },
          { k: "Insurance vaults", v: fmtUsd(totals.vault, { compact: true }) },
          { k: "Markets", v: `${totals.n}${totals.launching ? ` + ${totals.launching} launching` : ""}` },
        ].map((x, i) => (
          <div key={x.k} className={`px-4 py-3 ${i === 4 ? "col-span-2 border-t border-line sm:col-span-1 sm:border-t-0" : ""} ${i % 2 === 1 ? "border-l border-line sm:border-l-0" : ""} ${i >= 2 && i < 4 ? "border-t border-line sm:border-t-0" : ""}`}>
            <div className="label">{x.k}</div>
            <div className={`num mt-0.5 text-base font-medium ${x.tone ?? "text-ink"}`}>{x.v}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <Seg
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All" },
            { value: "Flap", label: "Opened by Flap" },
            { value: "Four.meme", label: "Opened by Four.meme" },
          ]}
        />
        <input className="input h-8 w-full py-1 font-sans sm:w-56" placeholder="Search ticker" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search markets" />
      </div>

      <div className="mt-2 overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full">
          <thead className="border-b border-line">
            <tr>
              <th className="th">Market</th>
              {head("price", "Price")}
              {head("change", "24h")}
              <th className="th hidden text-right lg:table-cell">7d</th>
              <th className="th hidden text-right md:table-cell">xSTOCK NAV</th>
              {head("lev", "Leverage", "hidden sm:table-cell")}
              {head("cr", "sUSD backing", "hidden md:table-cell")}
              {head("tvl", "TVL", "hidden md:table-cell")}
              <th className="th hidden xl:table-cell">Source</th>
              <th className="th hidden w-0 sm:table-cell" />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const href = m.pending ? "/launchpad" : `/trade/${m.id}`;
              return (
                <tr key={m.id} className="cursor-pointer border-t border-line first:border-t-0 hover:bg-surface2/70" onClick={() => router.push(href)}>
                  <td className="td">
                    <Link href={href} className="flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
                      <TickerIcon sym={m.symbol} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium text-ink">{m.symbol}</span>
                          <span className="num hidden text-xs text-lever sm:inline">x{m.symbol}</span>
                          {m.pending && <span className="pill border-warn/40 text-warn">Launching</span>}
                        </span>
                        <span className="block max-w-[140px] truncate text-xs text-muted sm:max-w-none">{m.name}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="td num text-right text-ink">{m.price !== undefined ? fmtUsd(m.price, { digits: 2 }) : "–"}</td>
                  <td className="td text-right">
                    <Change v={m.change} />
                  </td>
                  <td className="td hidden text-right lg:table-cell">
                    <span className="inline-flex justify-end">{m.spark.length > 1 ? <Sparkline values={m.spark} /> : <span className="text-xs text-faint">{m.pending ? "opens on graduation" : "–"}</span>}</span>
                  </td>
                  <td className="td num hidden text-right text-lever md:table-cell">{m.nav !== undefined ? fmtUsd(m.nav, { digits: m.nav >= 100 ? 2 : 4 }) : "–"}</td>
                  <td className="td num hidden text-right text-lever sm:table-cell">{m.lev !== undefined ? fmtLev(m.lev) : "–"}</td>
                  <td className="td num hidden text-right text-stable md:table-cell">{m.cr !== undefined ? (Number.isFinite(m.cr) ? fmtPct(m.cr, 0) : "∞") : "–"}</td>
                  <td className="td num hidden text-right text-ink md:table-cell">{m.tvl !== undefined ? fmtUsd(m.tvl, { compact: true }) : "–"}</td>
                  <td className="td hidden xl:table-cell">
                    <SourceBadge label={m.launchpad} />
                  </td>
                  <td className="td hidden text-right sm:table-cell">
                    <Link href={href} className={m.pending ? "btn btn-sm" : "btn-primary btn-sm"} onClick={(e) => e.stopPropagation()}>
                      {m.pending ? "Launchpad" : "Trade"}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={10} className="td py-10 text-center text-muted">
                  No market matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-faint">
        NVDA and TSLA are live pools on BSC testnet, priced by Atlas. The other markets use live CoinMarketCap stock prices with simulated pool state; trades there run in your browser only.
      </p>

      <section className="mt-8 grid gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-3">
        {[
          { n: "1", t: "Get the test stock", b: "On a market's trade screen, “Get test tNVDA” sends you free test NVIDIA. You also need a little tBNB for gas. Nothing else." },
          { n: "2", t: "Long 2x or hold a dollar", b: "Deposit tNVDA. Long 2x gives you xNVDA (about 2× NVIDIA, no liquidation). Stable gives you sUSD, worth $1 of the pool." },
          { n: "3", t: "Close any time", b: "Close turns xNVDA or sUSD back into tNVDA plus mUSDC at the live price. Redeems never pause." },
        ].map((s) => (
          <div key={s.n} className="bg-surface p-4">
            <div className="num text-xs text-faint">Step {s.n}</div>
            <div className="mt-1 text-sm font-semibold text-ink">{s.t}</div>
            <div className="mt-1 text-[13px] text-muted">{s.b}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
