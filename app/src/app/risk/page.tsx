"use client";
import { useMemo, useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useReadContracts } from "wagmi";
import { AtlasMirrorAbi, MarketCalendarAbi, RiskOracleAbi } from "@/abi";
import { addr, deployments97, oracleFor } from "@/config/deployments";
import { useAtlasPull } from "@/hooks/useAtlasPull";
import { useDemoPrices, useNow } from "@/hooks/usePools";
import { fmtAge, fmtBps, fmtLev, fmtTime, fmtUsd, short } from "@/lib/format";
import { RISK_SOURCES } from "@/lib/types";
import { Addr, Card, KV, Offline, PageHeader, Stat, Tabs, useApi } from "@/components/ui";
import { VerifyPanel } from "@/components/CmcVerify";

type RiskParams = { triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxDevBps: bigint; openFeeBps: bigint; closedFeeBps: bigint; gapGuardSec: bigint; maxSellChunkUsd: bigint };
type RiskView = { params: RiskParams; source: number; refPrice: bigint; refTs: bigint; snapshotId: bigint; mintsPaused: boolean };
type Snapshot = { refPrice: bigint; volBps: bigint; liqUsd: bigint; premiumBps: bigint; cmcTs: bigint; snapshotId: bigint; responseHash: Hex };
// services GET /risk/snapshots -> risk_snapshots rows (snake_case; WAD values as strings).
type SnapshotRow = { snapshot_id: number | string; cmc_ts?: number | string; ref_price?: string; vol_bps?: number | string; liq_usd?: string; premium_bps?: number | string; response_hash?: string; tx_hash?: string | null; status?: string; chain_id?: number };

const w = (v?: bigint) => (v === undefined ? 0 : Number(v) / 1e18);

export default function RiskPage() {
  const [sym, setSym] = useState<"NVDA" | "TSLA">("NVDA");
  const assetId = useMemo(() => keccak256(toBytes(sym)), [sym]);
  const ro = addr(deployments97.core.riskOracle);
  const cal = addr(deployments97.core.marketCalendar);
  const mirror = addr(oracleFor(sym)?.mirror);
  const now = useNow(5000);
  const nowBig = BigInt(Math.floor(now / 60) * 60);
  const pull = useAtlasPull(sym === "NVDA" ? "nvdab" : "tslab");
  const prices = useDemoPrices();
  const timeline = useApi<{ snapshots?: SnapshotRow[] }>(`/api/risk/snapshots?asset=${sym}&chain=97&limit=24`, 60_000);

  const dummy = { address: ro ?? "0x0000000000000000000000000000000000000000", abi: RiskOracleAbi, functionName: "agentEnabled" } as const;
  const reads = useReadContracts({
    allowFailure: true,
    query: { enabled: !!ro, refetchInterval: 10_000 },
    contracts: [
      { address: ro!, abi: RiskOracleAbi, functionName: "riskView", args: [assetId], chainId: bscTestnet.id },
      { address: ro!, abi: RiskOracleAbi, functionName: "ruleParams", args: [assetId], chainId: bscTestnet.id },
      { address: ro!, abi: RiskOracleAbi, functionName: "latestSnapshot", args: [assetId], chainId: bscTestnet.id },
      { address: ro!, abi: RiskOracleAbi, functionName: "agentParams", args: [assetId], chainId: bscTestnet.id },
      mirror ? { address: mirror, abi: AtlasMirrorAbi, functionName: "latestRound", chainId: bscTestnet.id } : dummy,
      cal ? { address: cal, abi: MarketCalendarAbi, functionName: "dayIndexOf", args: [nowBig], chainId: bscTestnet.id } : dummy,
      cal ? { address: cal, abi: MarketCalendarAbi, functionName: "isOpen", args: [nowBig], chainId: bscTestnet.id } : dummy,
    ],
  });
  const r = reads.data;
  const view = r?.[0]?.status === "success" ? (r[0].result as RiskView) : undefined;
  const rule = r?.[1]?.status === "success" ? (r[1].result as RiskParams) : undefined;
  const snap = r?.[2]?.status === "success" ? (r[2].result as Snapshot) : undefined;
  const agent = r?.[3]?.status === "success" ? (r[3].result as readonly [RiskParams & { horizonSec: bigint }, boolean, bigint, bigint]) : undefined;
  const lr = mirror && r?.[4]?.status === "success" ? (r[4].result as readonly [bigint, { answer: bigint; srcUpdatedAt: bigint; pushedAt: bigint; srcTxHash: Hex }]) : undefined;
  const dayIndex = cal && r?.[5]?.status === "success" ? (r[5].result as bigint) : undefined;

  const sessions = useReadContracts({
    allowFailure: true,
    query: { enabled: !!cal && dayIndex !== undefined },
    contracts: Array.from({ length: 7 }, (_, i) => ({ address: cal!, abi: MarketCalendarAbi, functionName: "sessionOf" as const, args: [(dayIndex ?? 0n) + BigInt(i)] as const, chainId: bscTestnet.id })),
  });

  const push = lr ? w(lr[1].answer) : undefined;
  const ref = view ? w(view.refPrice) : undefined;
  const dev = push && ref ? (push - ref) / ref : undefined;
  const pullP = pull.data?.price ?? undefined;
  // Fallback prices (no CMC key on the app server) are placeholders, not CMC data: never label them "CMC RWA".
  const rwaRow = prices.data?.prices[sym];
  const rwa = rwaRow && rwaRow.source !== "fallback" ? rwaRow : undefined;
  const srcTx = lr && /^0x0*$/i.test(lr[1].srcTxHash) ? undefined : lr?.[1].srcTxHash;

  return (
    <>
      <PageHeader
        title="Risk"
        lede="Atlas sets the price. CoinMarketCap data sets the limits: the keeper posts a CMC snapshot to the RiskOracle, which computes the rule parameters on-chain. The AI Risk Steward may only tighten them immediately."
        right={<Tabs value={sym} onChange={setSym} items={[{ value: "NVDA", label: "NVDA" }, { value: "TSLA", label: "TSLA" }]} />}
      />
      {!ro && <div className="mb-4"><Offline what="The RiskOracle" note="It is not in deployments/97.json yet (core.riskOracle)." /></div>}

      <div className="grid gap-5 lg:grid-cols-4">
        <Card className="lg:col-span-4" title="Atlas vs CMC" right={view ? <span className="pill">limits from {RISK_SOURCES[view.source]}{view.snapshotId > 0n ? ` · CMC snapshot #${view.snapshotId}` : ""}</span> : undefined}>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Atlas price (on-chain)" value={push ? fmtUsd(push) : "–"} sub={lr ? `Atlas · ${fmtAge(now - Number(lr[1].srcUpdatedAt))} ago` : "no mirror"} />
            <Stat label="CMC reference (on-chain)" value={ref ? fmtUsd(ref) : "–"} sub={view?.refTs ? `CMC · ${fmtAge(now - Number(view.refTs))} ago` : "no snapshot yet"} />
            <Stat
              label="Deviation"
              value={dev !== undefined ? `${dev >= 0 ? "+" : ""}${(dev * 100).toFixed(2)}%` : "–"}
              tone={dev !== undefined && Math.abs(dev) * 1e4 > Number(view?.params.maxDevBps ?? 150) ? "bad" : "good"}
              sub={view ? `breaker at ${fmtBps(view.params.maxDevBps)}` : ""}
            />
            <Stat label="Volatility σ (CMC)" value={snap && snap.snapshotId > 0n ? `${(Number(snap.volBps) / 100).toFixed(1)}%` : "–"} sub="annualised, 1h k-lines" />
            <Stat label="Sell trigger (now)" value={view ? fmtLev(w(view.params.triggerLev)) : "–"} tone="lever" sub={view ? `target ${fmtLev(w(view.params.targetLev))} · buy < ${fmtLev(w(view.params.lowerTriggerLev))}` : ""} />
            <Stat label="Atlas pull (signed)" value={pullP ? fmtUsd(pullP) : "–"} sub={pull.data?.ts ? `${fmtAge(now - pull.data.ts)} ago` : rwa ? `CMC RWA ${fmtUsd(rwa.price)}` : "not configured"} />
          </div>
          {lr && (
            <p className="mt-3 text-xs text-muted">
              Mirror round relayed from the BSC mainnet Atlas feed
              {srcTx ? (
                <>
                  , source tx{" "}
                  <a className="num link" href={`https://bscscan.com/tx/${srcTx}`} target="_blank" rel="noreferrer">{short(srcTx, 6)}</a>
                </>
              ) : (
                ` (round #${lr[0].toString()}, pushed ${fmtAge(now - Number(lr[1].pushedAt))} ago)`
              )}
              . Mirror <Addr a={mirror} />.
            </p>
          )}
        </Card>

        <Card title="CMC snapshot (latest)" className="lg:col-span-2">
          {snap && snap.snapshotId > 0n ? (
            <>
              <KV k="Snapshot id" v={`#${snap.snapshotId}`} />
              <KV k="σ (annualised, 1h k-lines)" v={`${(Number(snap.volBps) / 100).toFixed(1)}%`} />
              <KV k="DEX liquidity (l)" v={fmtUsd(w(snap.liqUsd), { compact: true })} />
              <KV k="Premium vs underlying" v={`${Number(snap.premiumBps) >= 0 ? "+" : ""}${fmtBps(snap.premiumBps)}`} />
              <KV k="CMC timestamp" v={`${fmtTime(Number(snap.cmcTs))} (${fmtAge(now - Number(snap.cmcTs))} ago)`} />
              <KV k="responseHash" v={short(snap.responseHash, 8)} />
              <KV k="Source" v={view ? RISK_SOURCES[view.source] : "–"} />
            </>
          ) : (
            <p className="text-sm text-muted">No snapshot posted for {sym} yet.</p>
          )}
        </Card>

        <Card title="Parameters: rule vs effective" className="lg:col-span-2">
          {view ? (
            <table className="w-full text-sm">
              <thead>
                <tr><th className="table-head px-0">Param</th><th className="table-head text-right">Rule (CMC)</th><th className="table-head text-right">Agent</th><th className="table-head text-right">Effective</th></tr>
              </thead>
              <tbody className="num">
                {([
                  ["Sell trigger", "triggerLev", fmtLev],
                  ["Target", "targetLev", fmtLev],
                  ["Buy trigger", "lowerTriggerLev", fmtLev],
                  ["Max deviation", "maxDevBps", fmtBps],
                  ["Open fee", "openFeeBps", fmtBps],
                  ["Closed fee", "closedFeeBps", fmtBps],
                  ["Gap guard", "gapGuardSec", (v: number) => `${Math.round(v / 60)}m`],
                ] as const).map(([label, key, f]) => {
                  const isLev = key.endsWith("Lev");
                  const val = (p?: RiskParams) => (p ? (isLev ? (f as (n: number) => string)(w(p[key])) : (f as (n: number) => string)(Number(p[key]))) : "–");
                  const ag = agent?.[1] && key !== "openFeeBps" ? val(agent[0]) : "–";
                  return (
                    <tr key={key} className="border-t border-line">
                      <td className="py-1.5 text-muted">{label}</td>
                      <td className="py-1.5 text-right">{val(rule)}</td>
                      <td className="py-1.5 text-right">{ag}</td>
                      <td className="py-1.5 text-right font-semibold text-ink">{val(view.params)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t border-line">
                  <td className="py-1.5 text-muted">Max sell chunk</td>
                  <td className="py-1.5 text-right">{rule ? fmtUsd(w(rule.maxSellChunkUsd), { compact: true }) : "–"}</td>
                  <td className="py-1.5 text-right">–</td>
                  <td className="py-1.5 text-right font-semibold text-ink">{fmtUsd(w(view.params.maxSellChunkUsd), { compact: true })}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted">Waiting for RiskOracle.riskView().</p>
          )}
          {agent?.[1] && <p className="mt-2 text-xs text-muted">Agent values active until {fmtTime(Number(agent[2]))} (proposal #{agent[3].toString()}).</p>}
          {view?.mintsPaused && <p className="mt-2 text-xs text-bad">Mints are paused for {sym} (Guardian).</p>}
        </Card>

        <Card title="NYSE calendar (on-chain MarketCalendar)" className="lg:col-span-4">
          {sessions.data ? (
            <div className="grid grid-cols-7 gap-2">
              {sessions.data.map((s, i) => {
                const v = s.status === "success" ? (s.result as readonly [bigint, bigint]) : undefined;
                const open = v && v[0] > 0n;
                const day = new Date((now + i * 86400) * 1000);
                return (
                  <div key={i} className={`rounded-lg border px-2 py-2 text-center text-xs ${open ? "border-good/40" : "border-line bg-surface2"}`}>
                    <div className="font-medium text-ink">{day.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}</div>
                    <div className="num mt-1 text-muted">{open ? `${new Date(Number(v![0]) * 1000).toISOString().slice(11, 16)}–${new Date(Number(v![1]) * 1000).toISOString().slice(11, 16)} UTC` : "closed"}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted">MarketCalendar not deployed yet.</p>
          )}
        </Card>

        <Card title="Snapshot timeline (indexer)" className="lg:col-span-2">
          {timeline.data?.offline && <Offline />}
          {timeline.data?.data?.snapshots?.length ? (
            <ul className="divide-y divide-line text-xs">
              {timeline.data.data.snapshots.filter((s) => (s.chain_id ?? 97) === 97).map((s, i) => (
                <li key={`${s.snapshot_id}-${i}`} className="num flex items-center justify-between gap-2 py-1.5">
                  <span className="text-ink">#{String(s.snapshot_id)}</span>
                  <span className="text-muted">{s.cmc_ts ? fmtTime(Number(s.cmc_ts)) : ""}</span>
                  <span>{s.ref_price !== undefined ? fmtUsd(Number(s.ref_price) / 1e18) : ""}</span>
                  <span className="text-muted">σ {s.vol_bps !== undefined ? `${(Number(s.vol_bps) / 100).toFixed(0)}%` : "–"}</span>
                  <span className={s.status === "posted" ? "text-good" : "text-faint"}>{s.status}</span>
                  {s.tx_hash && <a className="link" href={`https://testnet.bscscan.com/tx/${s.tx_hash}`} target="_blank" rel="noreferrer">tx</a>}
                </li>
              ))}
            </ul>
          ) : (
            !timeline.data?.offline && <p className="text-sm text-muted">No snapshots indexed yet.</p>
          )}
        </Card>

        <VerifyPanel expected={snap?.responseHash} snapshotId={snap?.snapshotId} />
      </div>
    </>
  );
}
