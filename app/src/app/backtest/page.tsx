"use client";
import { LineChart } from "@/components/LineChart";
import { Card, Empty, Offline, PageHeader, Stat, useApi } from "@/components/ui";
import { fmtPct, fmtTime, fmtUsd } from "@/lib/format";

// services GET /backtest?days=30 (services/src/backtest/backtest.ts): 30-day replay on NVDAB 1h CMC k-lines.
type Point = { ts: number; price: number; xNav: number; naive2x: number; stock: number; leverage: number; cr: number; trigger: number };
type Ev = { ts: number; zone: "SELL" | "BUY"; sizeUsd: number; levBefore: number; levAfter: number };
type Backtest = { asset: string; from: number; to: number; candles: number; series: Point[]; events: Ev[]; summary: { worstCr: number; maxLeverage: number; sellZones: number; buyZones: number; underwaterHours: number } };
const sec = (t: number) => (t > 1e12 ? Math.floor(t / 1000) : t);

export default function BacktestPage() {
  const q = useApi<Backtest>("/api/backtest?days=30", 600_000);
  const b = q.data?.data;
  const asset = b?.asset ?? "NVDA";
  const pts = b?.series ?? [];
  const p0 = pts[0];
  const idx = (v: number, base?: number) => (base ? (v / base) * 100 : v);
  const last = pts[pts.length - 1];
  const worst = b?.summary?.worstCr ?? Infinity;
  return (
    <>
      <PageHeader
        title="Backtest"
        lede="A 30-day replay (NVDA) of the pool rules on NVDAB 1-hour CoinMarketCap k-lines: when the zones fire, how xNVDA compares with a naive 2x and with the stock itself, and the worst collateral ratio sUSD saw."
      />
      {q.data?.offline && <div className="mb-4"><Offline what="The backtest service" /></div>}
      {!pts.length ? (
        <Empty>{q.isLoading ? "Loading replay…" : "No backtest data yet. The services job computes it from stored k-lines (one CMC call per day)."}</Empty>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Card><Stat label={`x${asset} (rebalanced)`} value={last && p0 ? fmtPct(last.xNav / p0.xNav - 1) : "–"} tone="lever" /></Card>
            <Card><Stat label="Naive 2x (no rebalance)" value={last && p0 ? fmtPct(last.naive2x / p0.naive2x - 1) : "–"} /></Card>
            <Card><Stat label={`${asset}B spot`} value={last && p0 ? fmtPct(last.price / p0.price - 1) : "–"} /></Card>
            <Card><Stat label="Worst CR (sUSD)" value={Number.isFinite(worst) ? fmtPct(worst, 0) : "∞"} tone={worst < 1 ? "bad" : "stable"} sub={`${b?.summary?.sellZones ?? 0} sell · ${b?.summary?.buyZones ?? 0} buy zones`} /></Card>
          </div>
          <Card title="Indexed to 100 at the start">
            <LineChart
              x={pts.map((p) => sec(p.ts))}
              series={[
                { key: "x", label: `x${asset}`, color: "var(--chart-1)", values: pts.map((p) => idx(p.xNav, p0?.xNav)) },
                { key: "n", label: "Naive 2x", color: "var(--chart-2)", values: pts.map((p) => idx(p.naive2x, p0?.naive2x)) },
                { key: "s", label: `${asset}B`, color: "var(--chart-3)", values: pts.map((p) => idx(p.price, p0?.price)) },
              ]}
              markers={(b?.events ?? []).map((e) => ({ t: sec(e.ts), label: e.zone, tone: e.zone === "SELL" ? "sell" : "buy" }))}
            />
            <p className="mt-2 text-xs text-muted">Ticks on the time axis mark zone events (red = sell zone, green = buy zone). {b?.candles} candles, {fmtTime(sec(b?.from ?? 0))} to {fmtTime(sec(b?.to ?? 0))}.</p>
          </Card>
          <Card title="Zone events">
            <ul className="divide-y divide-line text-xs">
              {(b?.events ?? []).slice(0, 40).map((e, i) => (
                <li key={i} className="num flex justify-between gap-2 py-1.5">
                  <span className="text-muted">{fmtTime(sec(e.ts))}</span>
                  <span className={e.zone === "SELL" ? "text-bad" : "text-good"}>{e.zone}</span>
                  <span>{fmtUsd(e.sizeUsd, { compact: true })}</span>
                  <span className="text-muted">{e.levBefore.toFixed(2)}x → {e.levAfter.toFixed(2)}x</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
