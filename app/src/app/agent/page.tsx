"use client";
import { useMemo, useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useReadContract, useReadContracts } from "wagmi";
import { RiskOracleAbi } from "@/abi";
import { addr, deployments97, TESTNET_EXTERNAL } from "@/config/deployments";
import { useNow } from "@/hooks/usePools";
import { fmtBps, fmtDuration, fmtLev, fmtTime, short } from "@/lib/format";
import { Addr, Card, Empty, KV, Offline, PageHeader, useApi } from "@/components/ui";

const STATUS = ["NONE", "APPLIED", "QUEUED", "EXECUTED", "VETOED", "CANCELLED"] as const;
type AgentParams = { triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxDevBps: bigint; closedFeeBps: bigint; gapGuardSec: bigint; horizonSec: bigint };
type Proposal = { assetId: Hex; params: AgentParams; agentId: bigint; inputsHash: Hex; outputHash: Hex; modelIdHash: Hex; createdAt: bigint; eta: bigint; tightenOnly: boolean; status: number };
// services GET /agent/proposals -> { runs: agent_runs rows, events }. validated = Validated + {evidence, rationale, confidence}.
type AgentRun = {
  id: number | string;
  asset?: string;
  model?: string;
  served_model?: string;
  tx_hash?: string | null;
  proposal_id?: number | string | null;
  status?: string;
  classification?: string;
  validated?: {
    rationale?: string;
    confidence?: number;
    evidence?: { tool: string; argsHash?: string; responseHash?: string }[];
    adjustments?: { field: string; requested: string; applied: string; reason: string }[];
  } | null;
};
type OffchainProposal = { txHash?: string; model?: string; rationale?: string; evidence?: { tool: string; argsHash?: string; responseHash?: string }[]; adjustments?: { field: string; requested: string; applied: string; reason: string }[] };

const ASSET_NAME: Record<string, string> = {
  [keccak256(toBytes("NVDA"))]: "NVDA",
  [keccak256(toBytes("TSLA"))]: "TSLA",
};

export default function AgentPage() {
  const ro = addr(deployments97.core.riskOracle);
  const now = useNow(1000);
  const count = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "proposalCount", chainId: bscTestnet.id, query: { enabled: !!ro, refetchInterval: 15_000 } });
  const agentIdOnChain = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "agentId", chainId: bscTestnet.id, query: { enabled: !!ro } });
  const enabled = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "agentEnabled", chainId: bscTestnet.id, query: { enabled: !!ro } });
  const n = Number(count.data ?? 0n);
  // Proposal ids are 1-based in RiskOracle (proposalCount == latest id); read the last 12.
  const ids = useMemo(() => Array.from({ length: Math.min(12, n) }, (_, i) => BigInt(n - i)), [n]);
  const props = useReadContracts({
    allowFailure: true,
    query: { enabled: !!ro && ids.length > 0, refetchInterval: 15_000 },
    contracts: ids.map((id) => ({ address: ro!, abi: RiskOracleAbi, functionName: "proposal" as const, args: [id] as const, chainId: bscTestnet.id })),
  });
  const off = useApi<{ runs?: AgentRun[] }>("/api/agent/proposals?limit=50", 30_000);
  const byId = new Map<string, OffchainProposal>(
    (off.data?.data?.runs ?? [])
      .filter((r) => r.proposal_id !== null && r.proposal_id !== undefined)
      .map((r) => [String(r.proposal_id), { txHash: r.tx_hash ?? undefined, model: r.served_model ?? r.model, rationale: r.validated?.rationale, evidence: r.validated?.evidence, adjustments: r.validated?.adjustments }]),
  );
  const agentId = agentIdOnChain.data && agentIdOnChain.data > 0n ? agentIdOnChain.data.toString() : deployments97.erc8004.agentId ? String(deployments97.erc8004.agentId) : null;
  const identity = addr(deployments97.erc8004.identity) ?? TESTNET_EXTERNAL.erc8004Identity;

  return (
    <>
      <PageHeader
        title="AI risk agent"
        lede="The agent reads CMC market and event data, the Atlas price and the pool state, and proposes risk limits on-chain. It can only make them stricter at once; loosening waits behind a timelock, and the Guardian can veto it. It cannot move funds, post prices or set funding."
      />
      <div className="mb-5 grid gap-5 md:grid-cols-3">
        <Card title="Identity (ERC-8004)">
          <KV k="agentId" v={agentId ?? "not registered"} />
          <KV k="IdentityRegistry" v={<Addr a={identity} />} />
          {agentId && (
            <a className="link text-xs" href={`https://testnet.bscscan.com/nft/${identity}/${agentId}`} target="_blank" rel="noreferrer">
              View agent NFT ↗
            </a>
          )}
        </Card>
        <Card title="Status">
          <KV k="Agent enabled" v={enabled.data === undefined ? "–" : enabled.data ? "yes" : "revoked by Guardian"} />
          <KV k="Proposals on-chain" v={n} />
          <KV k="RiskOracle" v={<Addr a={ro} />} />
        </Card>
        <Card title="What it cannot do">
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
            <li>Post the reference price or deviation (keeper only)</li>
            <li>Move funds, set funding or the open fee, pause exits</li>
            <li>Loosen without the timelock delay and the Guardian veto window, or leave the clamps</li>
          </ul>
        </Card>
      </div>
      {off.data?.offline && <div className="mb-4"><Offline note="On-chain proposals below still load; the agent's rationale and evidence come back when the API is up." /></div>}
      {ids.length > 0 && (() => {
        const r = props.data?.[0];
        const p = r?.status === "success" ? (r.result as Proposal) : undefined;
        return p && p.status !== 0 ? <LatestProposal id={ids[0]} p={p} off={byId.get(ids[0].toString())} now={now} ro={ro!} /> : null;
      })()}
      {ids.length === 0 && (off.data?.data?.runs?.length ?? 0) > 0 && <RunsList runs={off.data!.data!.runs!} />}
      {ids.length > 0 && <h2 className="mb-2 mt-6 text-sm font-semibold text-ink">All proposals</h2>}
      {ids.length === 0 ? (
        (off.data?.data?.runs?.length ?? 0) === 0 && <Empty>No proposals yet. The agent runs hourly and on calendar events (pre-open, close, half day, weekend).</Empty>
      ) : (
        <div className="space-y-3">
          {ids.map((id, i) => {
            const r = props.data?.[i];
            const p = r?.status === "success" ? (r.result as Proposal) : undefined;
            if (!p || p.status === 0) return null;
            return <ProposalCard key={id.toString()} id={id} p={p} off={byId.get(id.toString())} now={now} />;
          })}
        </div>
      )}
    </>
  );
}

function ProposalCard({ id, p, off, now }: { id: bigint; p: Proposal; off?: OffchainProposal; now: number }) {
  const status = STATUS[p.status] ?? "NONE";
  const queued = status === "QUEUED";
  const [raw, setRaw] = useState<{ text: string; hash: Hex } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tone = status === "APPLIED" || status === "EXECUTED" ? "text-good" : status === "VETOED" ? "text-bad" : status === "QUEUED" ? "text-warn" : "text-muted";
  const loadRaw = async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/agent/raw/${p.outputHash}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setRaw({ text, hash: keccak256(toBytes(text)) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const w = (v: bigint) => Number(v) / 1e18;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          #{id.toString()} · {ASSET_NAME[p.assetId] ?? short(p.assetId)}
          <span className={`pill ${tone}`}>{status}{queued ? ` · ${fmtDuration(Number(p.eta) - now)}` : ""}</span>
          <span className="pill">{p.tightenOnly ? "tighten-only" : "loosening"}</span>
          {off?.adjustments && off.adjustments.length > 0 && <span className="pill text-warn" title={off.adjustments.map((a) => `${a.field}: ${a.requested} → ${a.applied} (${a.reason})`).join("\n")}>clamped</span>}
        </span>
      }
      right={<span className="text-xs text-muted">{fmtTime(Number(p.createdAt))}</span>}
    >
      <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
        <div className="num text-sm">
          <KV k="Trigger" v={fmtLev(w(p.params.triggerLev))} />
          <KV k="Target" v={fmtLev(w(p.params.targetLev))} />
          <KV k="Lower trigger" v={fmtLev(w(p.params.lowerTriggerLev))} />
          <KV k="Max deviation" v={fmtBps(p.params.maxDevBps)} />
          <KV k="Closed fee" v={fmtBps(p.params.closedFeeBps)} />
          <KV k="Gap guard" v={`${Number(p.params.gapGuardSec) / 60}m`} />
          <KV k="Horizon" v={`${Number(p.params.horizonSec) / 60}m`} />
        </div>
        <div className="space-y-2 text-xs">
          {off?.rationale ? <p className="text-sm text-ink">{off.rationale}</p> : <p className="text-muted">Rationale is served by the services API (indexer offline or not yet indexed).</p>}
          {off?.evidence && off.evidence.length > 0 && (
            <div>
              <div className="label mb-1">Evidence (CMC MCP calls)</div>
              <ul className="num space-y-0.5 text-muted">
                {off.evidence.slice(0, 8).map((e, i) => (
                  <li key={i}>
                    {e.tool} · resp {short(e.responseHash, 6)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="num text-muted">
            inputsHash {short(p.inputsHash, 8)} · outputHash {short(p.outputHash, 8)} · model {short(p.modelIdHash, 6)}
            {off?.model ? ` (${off.model})` : ""}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-sm" onClick={loadRaw}>Verify raw output JSON</button>
            {off?.txHash && (
              <a className="btn btn-sm" href={`https://testnet.bscscan.com/tx/${off.txHash}`} target="_blank" rel="noreferrer">propose() tx ↗</a>
            )}
          </div>
          {err && <p className="text-bad">Could not load raw JSON: {err}</p>}
          {raw && (
            <div>
              <p className={raw.hash.toLowerCase() === p.outputHash.toLowerCase() ? "text-good" : "text-bad"}>
                keccak256(raw) = {short(raw.hash, 10)} {raw.hash.toLowerCase() === p.outputHash.toLowerCase() ? "matches outputHash on-chain" : "does not match outputHash"}
              </p>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface2 p-2 text-[11px] text-muted">{raw.text.slice(0, 4000)}</pre>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

const STATUS_TEXT: Record<string, { text: string; tone: string }> = {
  APPLIED: { text: "Tightened · applied at once", tone: "border-good/40 text-good" },
  EXECUTED: { text: "Executed after the timelock", tone: "border-good/40 text-good" },
  QUEUED: { text: "Queued · loosening waits", tone: "border-warn/40 text-warn" },
  VETOED: { text: "Vetoed by the Guardian", tone: "border-bad/40 text-bad" },
  CANCELLED: { text: "Cancelled", tone: "" },
  NONE: { text: "–", tone: "" },
};

type RuleParams = { triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxDevBps: bigint; closedFeeBps: bigint; gapGuardSec: bigint };

function LatestProposal({ id, p, off, now, ro }: { id: bigint; p: Proposal; off?: OffchainProposal; now: number; ro: `0x${string}` }) {
  const rule = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "ruleParams", args: [p.assetId], chainId: bscTestnet.id, query: { refetchInterval: 30_000 } });
  const r = rule.data as RuleParams | undefined;
  const status = STATUS[p.status] ?? "NONE";
  const st = STATUS_TEXT[status] ?? STATUS_TEXT.NONE;
  const w = (v: bigint) => Number(v) / 1e18;
  const rows: { label: string; from?: string; to: string; tighter?: boolean }[] = [
    { label: "Sell trigger", from: r ? fmtLev(w(r.triggerLev)) : undefined, to: fmtLev(w(p.params.triggerLev)), tighter: r ? p.params.triggerLev < r.triggerLev : undefined },
    { label: "Target leverage", from: r ? fmtLev(w(r.targetLev)) : undefined, to: fmtLev(w(p.params.targetLev)), tighter: r ? p.params.targetLev < r.targetLev : undefined },
    { label: "Max CMC deviation", from: r ? fmtBps(r.maxDevBps) : undefined, to: fmtBps(p.params.maxDevBps), tighter: r ? p.params.maxDevBps < r.maxDevBps : undefined },
    { label: "Closed-market fee", from: r ? fmtBps(r.closedFeeBps) : undefined, to: fmtBps(p.params.closedFeeBps), tighter: r ? p.params.closedFeeBps > r.closedFeeBps : undefined },
    { label: "Gap guard", from: r ? `${Number(r.gapGuardSec) / 60}m` : undefined, to: `${Number(p.params.gapGuardSec) / 60}m`, tighter: r ? p.params.gapGuardSec > r.gapGuardSec : undefined },
  ];
  return (
    <Card
      className="mb-5 border-stable/40"
      title={
        <span className="flex flex-wrap items-center gap-2">
          Latest proposal #{id.toString()} · {ASSET_NAME[p.assetId] ?? short(p.assetId)}
          <span className={`pill ${st.tone}`}>{st.text}{status === "QUEUED" ? ` · ${fmtDuration(Number(p.eta) - now)} left` : ""}</span>
        </span>
      }
      right={<span className="text-xs text-muted">{fmtTime(Number(p.createdAt))} · valid {Number(p.params.horizonSec) / 3600}h</span>}
    >
      <div className="grid gap-5 md:grid-cols-[1fr_1.2fr]">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="table-head px-0">Limit</th>
              <th className="table-head text-right">CMC rule</th>
              <th className="table-head text-right">Agent</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((x) => (
              <tr key={x.label} className="border-t border-line">
                <td className="py-1.5 text-muted">{x.label}</td>
                <td className="py-1.5 text-right text-muted">{x.from ?? "–"}</td>
                <td className={`py-1.5 text-right font-semibold ${x.tighter ? "text-good" : "text-ink"}`}>
                  {x.to}
                  {x.tighter ? " ↓ stricter" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-2 text-sm">
          <div className="label">Why (agent rationale)</div>
          {off?.rationale ? <p className="text-ink">{off.rationale}</p> : <p className="text-muted">The rationale is served by the keeper&apos;s API, which has not indexed this proposal yet.</p>}
          {off?.evidence && off.evidence.length > 0 && (
            <p className="text-xs text-muted">Evidence: {off.evidence.slice(0, 6).map((e) => e.tool).join(", ")}</p>
          )}
          <p className="text-xs text-muted">The agent can only make limits stricter at once. Loosening waits behind the timelock, and the Guardian can veto it.</p>
          {off?.txHash && (
            <a className="btn btn-sm" href={`https://testnet.bscscan.com/tx/${off.txHash}`} target="_blank" rel="noreferrer">
              propose() tx ↗
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

function RunsList({ runs }: { runs: AgentRun[] }) {
  return (
    <Card title="Recent agent runs (keeper API)" className="mb-5">
      <ul className="divide-y divide-line text-sm">
        {runs.slice(0, 8).map((r) => (
          <li key={String(r.id)} className="py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{r.asset ?? "–"}</span>
              {r.classification && <span className="pill">{r.classification}</span>}
              {r.status && <span className="pill">{r.status}</span>}
              {r.tx_hash && (
                <a className="num link text-xs" href={`https://testnet.bscscan.com/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              )}
            </div>
            {r.validated?.rationale && <p className="mt-1 text-xs text-muted">{r.validated.rationale}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
