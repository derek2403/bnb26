"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useCandles } from "@/hooks/useMarket";
import type { Candle, Interval } from "@/lib/candles";
import { fmtNum, fmtUsd } from "@/lib/format";
import { Seg } from "../ui";

type Colors = { bg: string; line: string; grid: string; text: string; faint: string; up: string; down: string; accent: string; lever: string };

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const c = (n: string, a = 1) => `rgba(${cs.getPropertyValue(`--${n}`).trim().split(/\s+/).join(",")},${a})`;
  return { bg: c("surface"), line: c("line"), grid: c("line", 0.45), text: c("muted"), faint: c("faint"), up: c("good"), down: c("bad"), accent: c("accent"), lever: c("lever") };
}

function chartOptions(k: Colors) {
  return {
    layout: { background: { type: ColorType.Solid, color: k.bg }, textColor: k.text, fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontSize: 11, panes: { separatorColor: k.line, separatorHoverColor: k.line } },
    grid: { vertLines: { color: k.grid }, horzLines: { color: k.grid } },
    rightPriceScale: { borderColor: k.line, scaleMargins: { top: 0.12, bottom: 0.06 } },
    leftPriceScale: { borderColor: k.line },
    timeScale: { borderColor: k.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: k.faint, labelBackgroundColor: k.line }, horzLine: { color: k.faint, labelBackgroundColor: k.line } },
  };
}

type Legend = { o: number; h: number; l: number; c: number; v: number } | null;

const SOURCE_TEXT = (src: string | undefined, symbol: string, note?: string) =>
  src === "cmc" ? `CoinMarketCap k-lines · ${symbol}B on BSC` : src === "simulated" ? "Simulated history · live CMC price" : src === "synthetic" ? `Illustrative history around the live Atlas price · CMC k-lines unavailable${note && /not set/.test(note) ? " (no CMC key)" : ""}` : "Loading…";

export function CandleChart({
  id,
  symbol,
  leverSymbol,
  livePrice,
  liveLabel = "Atlas",
  nav,
  leverage,
  interval,
  onInterval,
}: {
  id: string;
  symbol: string;
  leverSymbol: string;
  livePrice?: number;
  liveLabel?: string;
  nav?: number;
  leverage?: number;
  interval: Interval;
  onInterval: (i: Interval) => void;
}) {
  const q = useCandles(id, interval, livePrice);
  const [showNav, setShowNav] = useState(false);
  const [legend, setLegend] = useState<Legend>(null);
  const [themeTick, setThemeTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candle = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const navLine = useRef<ISeriesApi<"Line"> | null>(null);
  const liveLine = useRef<IPriceLine | null>(null);
  const colors = useRef<Colors | null>(null);
  const framed = useRef<string>("");
  const candles: Candle[] = useMemo(() => q.data?.candles ?? [], [q.data]);

  // create once
  useEffect(() => {
    if (!box.current) return;
    const k = readColors();
    colors.current = k;
    const c = createChart(box.current, { autoSize: true, ...chartOptions(k) });
    const cs = c.addSeries(CandlestickSeries, { upColor: k.up, downColor: k.down, wickUpColor: k.up, wickDownColor: k.down, borderVisible: false, priceLineVisible: false, lastValueVisible: false });
    const vs = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    const ns = c.addSeries(LineSeries, { color: k.lever, lineWidth: 1, priceScaleId: "left", visible: false, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
    vs.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });
    c.panes()[1]?.setStretchFactor(0.22);
    chart.current = c;
    candle.current = cs;
    volume.current = vs;
    navLine.current = ns;
    c.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(cs) as { open: number; high: number; low: number; close: number } | undefined;
      const v = p.seriesData.get(vs) as { value: number } | undefined;
      setLegend(d ? { o: d.open, h: d.high, l: d.low, c: d.close, v: v?.value ?? 0 } : null);
    });
    const mo = new MutationObserver(() => {
      const nk = readColors();
      colors.current = nk;
      c.applyOptions(chartOptions(nk));
      cs.applyOptions({ upColor: nk.up, downColor: nk.down, wickUpColor: nk.up, wickDownColor: nk.down });
      ns.applyOptions({ color: nk.lever });
      liveLine.current?.applyOptions({ color: nk.accent });
      setThemeTick((t) => t + 1); // recolor volume bars
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      mo.disconnect();
      c.remove();
      chart.current = null;
      candle.current = null;
      volume.current = null;
      navLine.current = null;
      liveLine.current = null;
    };
  }, []);

  // data
  useEffect(() => {
    const cs = candle.current;
    const vs = volume.current;
    const k = colors.current;
    if (!cs || !vs || !k || !candles.length) return;
    cs.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    const up = k.up.replace(/,1\)$/, ",0.45)");
    const down = k.down.replace(/,1\)$/, ",0.45)");
    vs.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, value: c.v, color: c.c >= c.o ? up : down })));
    const key = `${id}:${interval}`;
    if (!framed.current.startsWith(key)) {
      framed.current = key;
      const n = candles.length;
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 140), to: n + 4 });
    }
  }, [candles, id, interval, themeTick]);

  // live price line
  useEffect(() => {
    const cs = candle.current;
    const k = colors.current;
    if (!cs || !k) return;
    if (!livePrice || !(livePrice > 0)) return;
    if (!liveLine.current) liveLine.current = cs.createPriceLine({ price: livePrice, color: k.accent, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: liveLabel });
    else liveLine.current.applyOptions({ price: livePrice, title: liveLabel });
  }, [livePrice, liveLabel, candles.length]);

  // estimated xSTOCK NAV path: nav_t ≈ nav_now · (1 + L · (P_t / P_now − 1)), the pool's leverage applied to the move
  useEffect(() => {
    const ns = navLine.current;
    if (!ns || !chart.current) return;
    const on = showNav && !!nav && !!leverage && Number.isFinite(leverage) && candles.length > 0;
    chart.current.applyOptions({ leftPriceScale: { visible: on } });
    ns.applyOptions({ visible: on, title: `${leverSymbol} NAV est.` });
    if (!on) return;
    const pNow = livePrice ?? candles[candles.length - 1].c;
    ns.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, value: Math.max(0, nav! * (1 + leverage! * (c.c / pNow - 1))) })));
  }, [showNav, nav, leverage, candles, livePrice, leverSymbol]);

  const last = candles[candles.length - 1];
  const lg = legend ?? (last ? { o: last.o, h: last.h, l: last.l, c: last.c, v: last.v } : null);
  const chg = lg ? (lg.c - lg.o) / lg.o : 0;
  const tone = chg >= 0 ? "text-good" : "text-bad";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <Seg value={interval} onChange={onInterval} items={[{ value: "1h", label: "1H" }, { value: "4h", label: "4H" }, { value: "1d", label: "1D" }]} />
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted" title="Estimated from the pool's current leverage applied to each price move. Not historical pool data.">
          <input type="checkbox" className="accent-[rgb(var(--lever))]" checked={showNav} onChange={(e) => setShowNav(e.target.checked)} disabled={!nav} />
          <span className={showNav ? "text-lever" : ""}>{leverSymbol} NAV</span>
        </label>
        <span className="ml-auto truncate text-2xs text-faint" title={q.data?.note}>
          {SOURCE_TEXT(q.data?.source, symbol, q.data?.note)}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {lg && (
          <div className="num pointer-events-none absolute left-3 top-2 z-10 flex flex-wrap gap-x-3 text-2xs text-muted">
            <span className="text-ink">
              {symbol} · {interval.toUpperCase()}
            </span>
            <span>
              O <span className={tone}>{fmtNum(lg.o, 2)}</span>
            </span>
            <span>
              H <span className={tone}>{fmtNum(lg.h, 2)}</span>
            </span>
            <span>
              L <span className={tone}>{fmtNum(lg.l, 2)}</span>
            </span>
            <span>
              C <span className={tone}>{fmtNum(lg.c, 2)}</span>
            </span>
            <span className={tone}>
              {chg >= 0 ? "+" : ""}
              {(chg * 100).toFixed(2)}%
            </span>
            <span>Vol {fmtUsd(lg.v, { compact: true }).replace("$", "")}</span>
          </div>
        )}
        <div ref={box} className="absolute inset-0" />
        {q.isError && !candles.length && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">Chart data unavailable.</div>}
        {q.isLoading && !candles.length && <div className="absolute inset-0 flex items-center justify-center text-sm text-faint">Loading chart…</div>}
      </div>
    </div>
  );
}
