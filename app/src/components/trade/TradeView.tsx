"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { STOCK_NAMES } from "@/config/demoPools";
import { useDemoExecutor, useRealExecutor } from "@/hooks/useExecutor";
import { useCandles, useMarketStatus } from "@/hooks/useMarket";
import { EXPECTED_REAL, parseLaunchMarketId, useDemoPrices, useNow, usePool } from "@/hooks/usePools";
import { stats24h, type Interval } from "@/lib/candles";
import { fmtAge, fmtLev, fmtPct, fmtUsd } from "@/lib/format";
import { rememberMarket } from "../Header";
import { Change, MarketStatusPill, SourceBadge } from "../ui";
import { BottomTabs } from "./BottomTabs";
import { CandleChart } from "./CandleChart";
import { MarketSelector } from "./MarketSelector";
import { OrderPanel, type CloseWhat, type OrderTab } from "./OrderPanel";
import { StressDrawer } from "./StressTest";

function TopStat({ k, v, tone, title }: { k: string; v: ReactNode; tone?: string; title?: string }) {
  return (
    <div className="shrink-0" title={title}>
      <div className="text-2xs text-faint">{k}</div>
      <div className={`num text-[13px] ${tone ?? "text-ink"}`}>{v}</div>
    </div>
  );
}

export function TradeView({ id }: { id: string }) {
  const d = usePool(id);
  const real = useRealExecutor(d);
  const demo = useDemoExecutor(d);
  const now = useNow(1000);
  const prices = useDemoPrices();
  const [interval, setIntervalSel] = useState<Interval>("1h");
  const [orderTab, setOrderTab] = useState<OrderTab>("long");
  const [closeWhat, setCloseWhat] = useState<CloseWhat>("redeemLever");
  const [stress, setStress] = useState(false);
  const m = d.meta;
  const s = d.snap;
  const status = useMarketStatus(s, now, !!m && !m.isDemo);
  const day = useCandles(m ? id : undefined, "1h", s?.price);
  // 24h stats from CMC k-lines (live markets) or the simulated history (demo markets), never from synthetic bars.
  const st = day.data?.candles?.length && day.data.source !== "synthetic" ? stats24h(day.data.candles, s?.price) : {};
  const cmc = m ? prices.data?.prices[m.symbol] : undefined;
  const change = cmc?.source === "cmc" && cmc.change24h !== undefined ? cmc.change24h / 100 : st.change;

  useEffect(() => {
    if (m) rememberMarket(id);
  }, [id, m]);

  const onOrder = useCallback((t: OrderTab, c?: CloseWhat) => {
    setOrderTab(t);
    if (c) setCloseWhat(c);
    if (typeof window !== "undefined" && window.innerWidth < 1024) document.getElementById("order-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (!m) {
    const lm = parseLaunchMarketId(id);
    const e = EXPECTED_REAL.find((x) => x.id === id) ?? (lm ? { symbol: lm.symbol, kind: "flap" as const } : undefined);
    return <NotOpen id={id} symbol={e?.symbol} kind={e?.kind} searching={d.discovering} refPrice={e ? prices.data?.prices[e.symbol]?.price : undefined} />;
  }

  const exec = m.isDemo ? demo : real;
  const priceSrc = m.isDemo ? (cmc?.source === "cmc" ? "CMC" : "Reference") : "Atlas";
  const age = s ? (s.priceUpdatedAt > 0 ? Math.max(0, now - s.priceUpdatedAt) : s.priceAge) : undefined;
  const stale = s ? !s.priceFresh || s.feedHalted : false;

  return (
    <div className="flex min-h-[calc(100vh-48px)] flex-col">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5 lg:flex-nowrap">
        <MarketSelector id={id} symbol={m.symbol} name={m.name} leverSymbol={m.leverSymbol} />
        <div className="h-8 w-px shrink-0 bg-line" />
        <div className="shrink-0">
          <div className={`num text-lg font-semibold leading-tight ${change === undefined ? "text-ink" : change >= 0 ? "text-good" : "text-bad"}`}>{s ? fmtUsd(s.price, { digits: 2 }) : "…"}</div>
          <div className="text-2xs text-faint">
            {priceSrc}
            {age !== undefined ? ` · ${fmtAge(age)} ago` : ""}
            {stale && <span className="text-warn"> · stale</span>}
          </div>
        </div>
        <div className="order-last -mx-3 flex w-[calc(100%+1.5rem)] min-w-0 items-center gap-5 overflow-x-auto border-t border-line px-3 py-1.5 lg:order-none lg:mx-0 lg:w-auto lg:flex-1 lg:border-t-0 lg:py-1 lg:pl-2 lg:pr-0">
          <TopStat k="24h change" v={<Change v={change} />} />
          <TopStat k="24h high" v={st.high ? fmtUsd(st.high, { digits: 2 }) : "–"} />
          <TopStat k="24h low" v={st.low ? fmtUsd(st.low, { digits: 2 }) : "–"} />
          <TopStat k={`${m.leverSymbol} NAV`} v={s ? fmtUsd(s.xNav, { digits: s.xNav >= 100 ? 2 : 4 }) : "–"} tone="text-lever" />
          <TopStat k="Leverage" v={s ? fmtLev(s.leverage) : "–"} tone="text-lever" title="Pool leverage of xSTOCK, kept in a band by the sell and buy zones" />
          <TopStat k="sUSD backing" v={s ? (Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞") : "–"} tone="text-stable" title="Pool value / sUSD supply" />
          <TopStat k="Pool value" v={s ? fmtUsd(s.V, { compact: true }) : "–"} />
          <div className="flex shrink-0 items-center gap-2">
            <MarketStatusPill label={status.label} open={status.open} halfDay={status.halfDay} gapGuard={status.gapGuard} feeBps={status.feeBps} nextOpen={status.nextOpen} nextClose={status.nextClose} now={now} />
            <span className="hidden 2xl:inline-flex">
              <SourceBadge label={m.launchpad} />
            </span>
          </div>
        </div>
        <button className="btn btn-sm ml-auto shrink-0 border-warn/40 text-warn hover:bg-warn/10" onClick={() => setStress(true)} title="Shock a sandbox copy of this market">
          Stress test
        </button>
      </div>

      {/* terminal */}
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] content-start lg:content-normal lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(420px,1fr)_auto] xl:grid-cols-[minmax(0,1fr)_344px]">
        <div className="h-[380px] min-w-0 border-b border-line bg-surface sm:h-[440px] lg:h-auto lg:min-h-[420px]">
          <CandleChart id={id} symbol={m.symbol} leverSymbol={m.leverSymbol} livePrice={s?.price} liveLabel={m.isDemo ? "Live" : "Atlas"} nav={s?.xNav} leverage={s?.leverage} interval={interval} onInterval={setIntervalSel} />
        </div>
        <div id="order-panel" className="min-w-0 border-b border-line bg-surface lg:row-span-2 lg:border-b-0 lg:border-l">
          <OrderPanel d={d} exec={exec} tab={orderTab} setTab={setOrderTab} closeWhat={closeWhat} setCloseWhat={setCloseWhat} />
        </div>
        <div className="min-h-[260px] min-w-0 bg-surface lg:max-h-[420px]">
          <BottomTabs d={d} change24h={change} now={now} onOrder={onOrder} />
        </div>
      </div>

      <StressDrawer symbol={m.symbol} demoSnap={m.isDemo ? s : undefined} open={stress} onClose={() => setStress(false)} />
    </div>
  );
}

function NotOpen({ id, symbol, kind, searching, refPrice }: { id: string; symbol?: string; kind?: "flap" | "four"; searching: boolean; refPrice?: number }) {
  if (!symbol) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-lg font-semibold text-ink">Unknown market “{id}”</h1>
        <Link href="/" className="btn-primary mt-4">
          Back to markets
        </Link>
      </div>
    );
  }
  const four = kind === "four";
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <div className="rounded-card border border-line bg-surface p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">
            {symbol} <span className="font-normal text-muted">· {STOCK_NAMES[symbol] ?? symbol}</span>
          </h1>
          <span className="pill border-warn/40 text-warn">{searching ? "Looking on-chain…" : "Launching"}</span>
          <SourceBadge label={four ? "Four.meme" : "Flap"} />
        </div>
        {refPrice !== undefined && <div className="num mt-2 text-sm text-muted">Reference price {fmtUsd(refPrice, { digits: 2 })}</div>}
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {four
            ? "This market opens when a meme raised in tTSLA sells out on the Four.meme launchpad: graduation creates the TSLA pool, seeds its first-loss xTSLA and pairs the meme with sUSD."
            : "This market opens when its launch on Flap completes."}
        </p>
        <div className="mt-5 flex gap-2">
          <Link href="/launchpad" className="btn-primary">
            Go to Launchpad
          </Link>
          <Link href="/" className="btn">
            All markets
          </Link>
        </div>
      </div>
    </div>
  );
}
