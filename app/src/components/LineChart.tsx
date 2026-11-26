"use client";
import { useMemo, useRef, useState } from "react";

export type Series = { key: string; label: string; color: string; values: (number | null)[] };

/** Multi-series line chart on ONE axis (callers index series to a common base). Crosshair + tooltip on hover,
 *  legend plus direct end labels, optional table view. Colors come from --chart-N tokens (validated palette). */
export function LineChart({ x, series, height = 280, fmt = (v: number) => v.toFixed(1), fmtX = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }), markers = [] }: {
  x: number[];
  series: Series[];
  height?: number;
  fmt?: (v: number) => string;
  fmtX?: (t: number) => string;
  markers?: { t: number; label: string; tone: "sell" | "buy" }[];
}) {
  const W = 760;
  const H = height;
  const pad = { l: 44, r: 92, t: 12, b: 26 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const { min, max } = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const s of series) for (const v of s.values) if (v !== null && Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    if (!Number.isFinite(mn)) return { min: 0, max: 1 };
    const padv = (mx - mn) * 0.08 || 1;
    return { min: mn - padv, max: mx + padv };
  }, [series]);
  const x0 = x[0] ?? 0;
  const x1 = x[x.length - 1] ?? 1;
  const sx = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const sy = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);

  const onMove = (e: React.MouseEvent) => {
    const svg = ref.current;
    if (!svg || x.length === 0) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - t) < Math.abs(x[best] - t)) best = i;
    setHover(best);
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <button className="btn btn-sm ml-auto" onClick={() => setTable((v) => !v)}>{table ? "Chart" : "Table"}</button>
      </div>
      {table ? (
        <div className="max-h-80 overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th className="table-head">Time</th>
                {series.map((s) => <th key={s.key} className="table-head text-right">{s.label}</th>)}
              </tr>
            </thead>
            <tbody className="num">
              {x.map((t, i) => (
                <tr key={t} className="border-t border-line">
                  <td className="px-3 py-1 text-muted">{fmtX(t)}</td>
                  {series.map((s) => <td key={s.key} className="px-3 py-1 text-right text-ink">{s.values[i] !== null ? fmt(s.values[i]!) : "–"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={series.map((s) => s.label).join(", ")}>
            {ticks.map((v, i) => (
              <g key={i}>
                <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgb(var(--line))" strokeWidth={1} />
                <text x={pad.l - 6} y={sy(v) + 3} textAnchor="end" fontSize={10} fill="rgb(var(--faint))" fontFamily="IBM Plex Mono, monospace">{fmt(v)}</text>
              </g>
            ))}
            {[0, 0.5, 1].map((f) => {
              const t = x0 + (x1 - x0) * f;
              return <text key={f} x={sx(t)} y={H - 8} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} fontSize={10} fill="rgb(var(--faint))">{x.length ? fmtX(t) : ""}</text>;
            })}
            {markers.map((m, i) => (
              <line key={i} x1={sx(m.t)} x2={sx(m.t)} y1={H - pad.b} y2={H - pad.b - 6} stroke={m.tone === "sell" ? "rgb(var(--bad))" : "rgb(var(--good))"} strokeWidth={2} />
            ))}
            {series.map((s) => {
              let d = "";
              s.values.forEach((v, i) => {
                if (v === null || !Number.isFinite(v)) return;
                d += `${d ? "L" : "M"}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}`;
              });
              const lastIdx = [...s.values.keys()].reverse().find((i) => s.values[i] !== null);
              return (
                <g key={s.key}>
                  <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {lastIdx !== undefined && (
                    <text x={sx(x[lastIdx]) + 6} y={sy(s.values[lastIdx]!) + 3} fontSize={10} fill="rgb(var(--muted))">{s.label}</text>
                  )}
                </g>
              );
            })}
            {hover !== null && (
              <g>
                <line x1={sx(x[hover])} x2={sx(x[hover])} y1={pad.t} y2={H - pad.b} stroke="rgb(var(--faint))" strokeWidth={1} strokeDasharray="3 3" />
                {series.map((s) => s.values[hover] !== null && (
                  <circle key={s.key} cx={sx(x[hover])} cy={sy(s.values[hover]!)} r={4} fill={s.color} stroke="rgb(var(--surface))" strokeWidth={2} />
                ))}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-md" style={{ left: `min(calc(${(sx(x[hover]) / W) * 100}% + 10px), calc(100% - 170px))` }}>
              <div className="text-muted">{fmtX(x[hover])}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-muted"><span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
                  <span className="num text-ink">{s.values[hover] !== null ? fmt(s.values[hover]!) : "–"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
