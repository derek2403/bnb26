"use client";
import { bscTestnet } from "viem/chains";
import { useReadContracts } from "wagmi";
import { keccak256, toBytes } from "viem";
import { AtlasMirrorAbi, LogAnchorAbi, RiskOracleAbi } from "@/abi";
import { addr, deployments97, oracleFor } from "@/config/deployments";
import { useNow } from "@/hooks/usePools";
import { fmtAge, fmtTime } from "@/lib/format";
import { Card, Offline, PageHeader, useApi } from "@/components/ui";

// services GET /healthz (via /api/health) and GET /events/:kind (via /api/events/*). See BUILD_NOTES "## services".
type Health = {
  keeperOnline?: boolean;
  jobs?: { job: string; lastRunAt?: string; lastOkAt?: string; lastErrAt?: string; lastErr?: string; runs?: number; fails?: number }[];
  wallets?: { role: string; chain: string; address?: string; balance?: string; low?: boolean; error?: string }[];
};
type Events = { events?: { block_time?: string | number; name?: string; tx_hash?: string }[] };
const iso = (t?: string | number) => (t === undefined ? undefined : typeof t === "number" ? (t > 1e12 ? Math.floor(t / 1000) : t) : Math.floor(Date.parse(t) / 1000));

const STALE: Record<string, number> = { mirrored: 300, cmcSnapshot: 1800, agentProposal: 7200, anchor: 7200, sellZone: Infinity, buyZone: Infinity, anchor56: 172800 };

export default function StatusPage() {
  const now = useNow(1000);
  const q = useApi<Health>("/api/health", 15_000);
  const s = q.data?.data;
  const agentEv = useApi<Events>("/api/events/agent?name=AgentProposal&limit=1", 30_000);
  const sellEv = useApi<Events>("/api/events/zone?name=SellZone&limit=1", 30_000);
  const buyEv = useApi<Events>("/api/events/zone?name=BuyZone&limit=1", 30_000);
  const anc56 = useApi<Events>("/api/events/cmcAnchor?chain=56&limit=1", 60_000);
  const lastOf = (e?: Events | null) => iso(e?.events?.[0]?.block_time);
  const nvda = keccak256(toBytes("NVDA"));
  const ro = addr(deployments97.core.riskOracle);
  const la = addr(deployments97.core.logAnchor);
  const mirror = addr(oracleFor("NVDA")?.mirror);
  const dummy = { address: (ro ?? la ?? mirror)!, abi: RiskOracleAbi, functionName: "agentEnabled" } as const;
  const chain = useReadContracts({
    allowFailure: true,
    query: { enabled: !!(ro || la || mirror), refetchInterval: 10_000 },
    contracts: [
      mirror ? { address: mirror, abi: AtlasMirrorAbi, functionName: "latestRound", chainId: bscTestnet.id } : dummy,
      ro ? { address: ro, abi: RiskOracleAbi, functionName: "latestSnapshot", args: [nvda], chainId: bscTestnet.id } : dummy,
      la ? { address: la, abi: LogAnchorAbi, functionName: "latest", chainId: bscTestnet.id } : dummy,
    ],
  });
  const c = chain.data;
  const mirrorTs = mirror && c?.[0]?.status === "success" ? Number((c[0].result as readonly [bigint, { pushedAt: bigint }])[1].pushedAt) : undefined;
  const snapTs = ro && c?.[1]?.status === "success" ? Number((c[1].result as { cmcTs: bigint }).cmcTs) : undefined;
  const anchorTs = la && c?.[2]?.status === "success" ? Number((c[2].result as { timestamp: bigint }).timestamp) : undefined;

  const rows: { key: string; label: string; ts?: number; src: string }[] = [
    { key: "mirrored", label: "Last Mirrored (Atlas → testnet)", ts: mirrorTs, src: "on-chain" },
    { key: "cmcSnapshot", label: "Last CmcSnapshot (NVDA)", ts: snapTs || undefined, src: "on-chain" },
    { key: "agentProposal", label: "Last AgentProposal", ts: lastOf(agentEv.data?.data), src: "indexer" },
    { key: "sellZone", label: "Last SellZone", ts: lastOf(sellEv.data?.data), src: "indexer" },
    { key: "buyZone", label: "Last BuyZone", ts: lastOf(buyEv.data?.data), src: "indexer" },
    { key: "anchor", label: "Last log Anchor (97)", ts: anchorTs || undefined, src: "on-chain" },
    { key: "anchor56", label: "Last AtlasCmcAnchor (56)", ts: lastOf(anc56.data?.data), src: "indexer" },
  ];
  const keeperDown = q.data?.offline || s?.keeperOnline === false;

  return (
    <>
      <PageHeader title="Status" lede="Freshness of every keeper output and the health of the keeper, agent and indexer. If both the VM and the GitHub Actions backup are down, mints stop after the price ages out; redeems, redeemPair and rebalance keep working." />
      {keeperDown && (
        <div className="mb-4 rounded-card border border-bad/40 bg-bad/10 px-4 py-2 text-sm text-ink">
          Keeper offline or degraded. Mints may stop once the mirror price is older than 120 s. Exits are never blocked.
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Freshness">
          <ul className="divide-y divide-line text-sm">
            {rows.map((r) => {
              const age = r.ts ? now - r.ts : undefined;
              const stale = age !== undefined && age > (STALE[r.key] ?? Infinity);
              return (
                <li key={r.key} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-muted">{r.label}</span>
                  <span className={`num ${age === undefined ? "text-faint" : stale ? "text-warn" : "text-ink"}`}>
                    {age === undefined ? "never" : `${fmtAge(age)} ago`} <span className="text-[10px] text-faint">{r.ts ? fmtTime(r.ts) : ""} · {r.src}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Services">
          {q.data?.offline ? <Offline /> : s?.jobs ? (
            <ul className="divide-y divide-line text-sm">
              {s.jobs.map((j) => {
                const okAt = iso(j.lastOkAt);
                const errAt = iso(j.lastErrAt);
                const ok = !!okAt && (!errAt || okAt >= errAt);
                return (
                  <li key={j.job} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${ok ? "bg-good" : "bg-bad"}`} />{j.job}</span>
                    <span className="num truncate text-xs text-muted">{okAt ? `ok ${fmtAge(now - okAt)} ago` : "never ok"}{!ok && j.lastErr ? ` · ${j.lastErr.slice(0, 60)}` : ""}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-muted">Loading…</p>}
          {s?.wallets && s.wallets.length > 0 && (
            <div className="mt-4">
              <div className="label mb-1">Role wallets</div>
              <ul className="num text-xs text-muted">
                {s.wallets.map((w) => <li key={`${w.role}-${w.chain}`} className={w.low ? "text-warn" : ""}>{w.role} ({w.chain}) · {w.balance ?? w.error ?? "–"} BNB{w.low ? " · LOW" : ""}</li>)}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
