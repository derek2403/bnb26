"use client";
import { useMemo, useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { useReadContract, useReadContracts } from "wagmi";
import { LogAnchorAbi, RiskOracleAbi } from "@/abi";
import { addressUrl, txUrl } from "@/config/chains";
import { addr, deployments56, deployments97, MAINNET_EXTERNAL, TESTNET_EXTERNAL, type Deployments } from "@/config/deployments";
import { fmtTime, short } from "@/lib/format";
import { entryHash as computeEntryHash, GENESIS, rootFromProof, type ProofStep } from "@/lib/verify";
import { Card, Offline, PageHeader, Tabs, useApi } from "@/components/ui";
import { ProofEvents } from "@/components/ProofEvents";
import { VerifyPanel } from "@/components/CmcVerify";

function flatten(d: Deployments): { path: string; address: string }[] {
  const out: { path: string; address: string }[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out.push({ path: p, address: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${(x as { id?: string })?.id ?? i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "_example" && k !== "deployer" && !/tx$/i.test(k)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(d, "");
  return out;
}

// Kinds are the services indexer's EVENT_KINDS (services/src/jobs/indexer.ts).
const TRACKS: { label: string; kinds: string[] }[] = [
  { label: "Developer (RWA + AI agent)", kinds: ["pool", "zone", "agent", "stability", "sandbox"] },
  { label: "CMC × Atlas", kinds: ["mirror", "risk", "cmcAnchor", "anchor"] },
  { label: "Flap", kinds: ["launch", "backstop", "factory"] },
  { label: "Four.meme / OpenFour", kinds: ["openfour", "backstop", "factory"] },
];

type EventRow = { chain_id?: number; block_number?: string | number; block_time?: string | number; tx_hash?: string; name?: string; contract?: string; args?: Record<string, unknown> };

const toSec = (t?: string | number) => (t === undefined ? undefined : typeof t === "number" ? (t > 1e12 ? Math.floor(t / 1000) : t) : Math.floor(Date.parse(t) / 1000));

const SECTION: Record<string, string> = {
  tokens: "Test tokens",
  core: "Core protocol",
  oracles: "Oracles (Atlas mirror, scenario feeds)",
  pools: "Pools",
  dex: "DEX",
  flap: "Flap launch",
  openfour: "Four.meme (OpenFour fork)",
  erc8004: "AI agent identity (ERC-8004)",
  mainnet: "Mainnet contracts",
  external: "External (verified)",
};

function AddressTable({ d, chainId, ext }: { d: Deployments; chainId: number; ext: Record<string, string> }) {
  const rows = useMemo(() => {
    const ex = Object.entries(ext).map(([k, a]) => ({ path: `external.${k}`, address: a }));
    const seen = new Set<string>();
    return [...flatten(d), ...ex].filter((r) => !/^0x0{40}$/i.test(r.address) && (seen.has(r.path) ? false : (seen.add(r.path), true)));
  }, [d, ext]);
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; address: string }[]>();
    for (const r of rows) {
      const [top, ...rest] = r.path.split(".");
      const key = top.replace(/\[.*$/, "");
      const id = top.includes("[") ? top.slice(top.indexOf("[") + 1, -1) : "";
      const name = [id, rest.join(".").replace(/\[(\w[\w-]*)\]/g, " $1")].filter(Boolean).join(" · ");
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push({ name: name || key, address: r.address });
    }
    return [...m.entries()];
  }, [rows]);
  if (!rows.length) return <p className="text-sm text-muted">deployments/{chainId}.json is empty.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr>
            <th className="table-head px-0">Contract</th>
            <th className="table-head">Address</th>
            <th className="table-head text-right">BscScan</th>
          </tr>
        </thead>
        {groups.map(([g, items]) => (
          <tbody key={g}>
            <tr>
              <td colSpan={3} className="pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-faint">{SECTION[g] ?? g}</td>
            </tr>
            {items.map((r) => (
              <tr key={`${g}.${r.name}`} className="border-t border-line">
                <td className="py-1.5 pr-3 text-muted">{r.name}</td>
                <td className="num px-3 py-1.5 text-xs text-ink">
                  <span className="hidden lg:inline">{r.address}</span>
                  <span className="lg:hidden">{short(r.address, 6)}</span>
                </td>
                <td className="py-1.5 text-right">
                  <a className="link text-xs" href={addressUrl(r.address, chainId)} target="_blank" rel="noreferrer">
                    View ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

const NVDA_ID = keccak256(toBytes("NVDA"));

export default function ProofPage() {
  const has56 = flatten(deployments56).length > 0;
  const [chain, setChain] = useState<"97" | "56">("97");
  const chainId = chain === "97" ? bscTestnet.id : bsc.id;
  const ro = addr(deployments97.core.riskOracle);
  const snap = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "latestSnapshot", args: [NVDA_ID], chainId: bscTestnet.id, query: { enabled: !!ro, refetchInterval: 60_000 } });
  const s = snap.data as { snapshotId: bigint; responseHash: Hex; cmcTs: bigint } | undefined;
  return (
    <>
      <PageHeader title="Proof" lede="Every price and every CMC call is provable on-chain. The full address book with BscScan links, the events behind each demo step, and one CMC snapshot you can re-verify in your browser." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          className="lg:col-span-2"
          title="Address book"
          right={has56 ? <Tabs value={chain} onChange={setChain} items={[{ value: "97", label: "BSC testnet (97)" }, { value: "56", label: "BSC mainnet (56)" }]} /> : <span className="text-xs text-muted">BSC testnet (97)</span>}
        >
          <AddressTable d={chain === "97" ? deployments97 : deployments56} chainId={chainId} ext={chain === "97" ? TESTNET_EXTERNAL : MAINNET_EXTERNAL} />
          {chain === "97" && deployments97.updatedAt && <p className="mt-2 text-[11px] text-faint">deployments/97.json updated {deployments97.updatedAt}</p>}
        </Card>
        <ProofEvents />
        <VerifyPanel
          className=""
          title={s && s.snapshotId > 0n ? `Verify CMC snapshot #${s.snapshotId} (NVDA, ${fmtTime(Number(s.cmcTs))})` : "Verify a CMC snapshot"}
          expected={s?.responseHash}
          snapshotId={s?.snapshotId}
        />
        <CmcUsage />
        <LogVerifier />
        {TRACKS.map((t) => <TrackEvents key={t.label} track={t} />)}
      </div>
    </>
  );
}

function TrackEvents({ track }: { track: { label: string; kinds: string[] } }) {
  const [kind, setKind] = useState(track.kinds[0]);
  const q = useApi<{ events?: EventRow[] }>(`/api/events/${kind}?limit=10`, 30_000);
  return (
    <Card title={track.label} right={<select className="input w-auto py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>{track.kinds.map((k) => <option key={k}>{k}</option>)}</select>}>
      {q.data?.offline ? <Offline what="The indexer" /> : q.data?.data?.events?.length ? (
        <ul className="divide-y divide-line text-xs">
          {q.data.data.events.map((e, i) => (
            <li key={i} className="flex items-center justify-between gap-2 py-1.5">
              <span className="truncate text-muted">
                {e.block_time !== undefined ? fmtTime(toSec(e.block_time)) : ""} <span className="text-ink">{e.name ?? kind}</span> {e.contract ? `· ${e.contract}` : ""} {e.chain_id === 56 ? "· mainnet" : ""}
              </span>
              {e.tx_hash && <a className="num link shrink-0" href={txUrl(e.tx_hash, e.chain_id)} target="_blank" rel="noreferrer">{short(e.tx_hash)}</a>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{q.isLoading ? "Loading…" : `No ${kind} events indexed yet.`}</p>
      )}
    </Card>
  );
}

type KeyInfoRow = { ts: string | number; credits_used_day?: number; credits_used_month?: number; credits_left_month?: number; credit_limit_monthly?: number; summed_credit_count?: number };
type Usage = { governor?: Record<string, unknown>; today?: { endpoint: string; calls: number; credits: number; errors: number }[]; keyInfo?: KeyInfoRow[] };

function CmcUsage() {
  const q = useApi<Usage>("/api/cmc/usage", 60_000);
  const u = q.data?.data;
  const k = u?.keyInfo?.[0];
  return (
    <Card title="CoinMarketCap key usage (/v1/key/info)">
      {q.data?.offline ? <Offline /> : u ? (
        <div className="text-sm">
          <div className="num text-ink">
            {k ? `${k.credits_used_month ?? "–"} credits used this month · ${k.credits_left_month ?? "–"} left · today ${k.credits_used_day ?? "–"}` : "No key/info snapshot yet."}
          </div>
          {k?.summed_credit_count !== undefined && <div className="mt-1 text-xs text-muted">Sum of credit_count in our log: {k.summed_credit_count} (reconciles with key/info).</div>}
          {u.today && u.today.length > 0 && (
            <table className="num mt-2 w-full text-xs">
              <thead><tr><th className="table-head px-0">Endpoint today</th><th className="table-head text-right">calls</th><th className="table-head text-right">credits</th><th className="table-head text-right">errors</th></tr></thead>
              <tbody>
                {u.today.map((r) => (
                  <tr key={r.endpoint} className="border-t border-line"><td className="truncate py-1 text-muted">{r.endpoint}</td><td className="text-right">{r.calls}</td><td className="text-right">{r.credits}</td><td className="text-right">{r.errors}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {u.keyInfo && u.keyInfo.length > 1 && (
            <ul className="num mt-2 max-h-28 overflow-auto text-xs text-muted">
              {u.keyInfo.slice(0, 24).map((h, i) => <li key={i}>{fmtTime(toSec(h.ts))} · month {h.credits_used_month ?? "–"} · day {h.credits_used_day ?? "–"}</li>)}
            </ul>
          )}
        </div>
      ) : <p className="text-sm text-muted">Loading…</p>}
      <p className="mt-2 text-[11px] text-faint">The browser never calls CMC; all calls are made server-side with the key in the X-CMC_PRO_API_KEY header.</p>
    </Card>
  );
}

type ProofResp = { seq: number; entry: Record<string, unknown> & { prevHash: Hex; entryHash: Hex }; anchor: { chainId: number; root: Hex; fromSeq: number; toSeq: number; tx?: string | null }; proof: ProofStep[] };

function LogVerifier() {
  const anchor = addr(deployments97.core.logAnchor);
  const count = useReadContract({ address: anchor, abi: LogAnchorAbi, functionName: "count", chainId: bscTestnet.id, query: { enabled: !!anchor } });
  const n = Number(count.data ?? 0n);
  const anchors = useReadContracts({
    allowFailure: true,
    query: { enabled: !!anchor && n > 0 },
    contracts: Array.from({ length: Math.min(n, 64) }, (_, i) => ({ address: anchor!, abi: LogAnchorAbi, functionName: "anchorAt" as const, args: [BigInt(n - 1 - i)] as const, chainId: bscTestnet.id })),
  });
  const onchain = (anchors.data ?? []).map((a, i) => (a.status === "success" ? { index: n - 1 - i, ...(a.result as { root: Hex; fromSeq: bigint; toSeq: bigint; timestamp: bigint }) } : null)).filter(Boolean) as { index: number; root: Hex; fromSeq: bigint; toSeq: bigint; timestamp: bigint }[];
  const [seq, setSeq] = useState("");
  const [paste, setPaste] = useState("");
  const [res, setRes] = useState<{ lines: { ok: boolean | null; text: string }[] } | null>(null);

  const check = (p: ProofResp) => {
    const lines: { ok: boolean | null; text: string }[] = [];
    const prev = (p.entry.prevHash ?? GENESIS) as Hex;
    const h = computeEntryHash(prev, p.entry);
    lines.push({ ok: h.toLowerCase() === String(p.entry.entryHash).toLowerCase(), text: `entryHash = keccak256(prevHash ‖ canonicalJSON(entry)) = ${h}` });
    const root = rootFromProof(h, p.proof ?? []);
    lines.push({ ok: root.toLowerCase() === p.anchor.root.toLowerCase(), text: `Merkle root from ${p.proof?.length ?? 0} proof steps = ${root}` });
    const on = onchain.find((a) => a.root.toLowerCase() === root.toLowerCase());
    lines.push(on ? { ok: true, text: `Matches on-chain LogAnchor #${on.index} (seq ${on.fromSeq}–${on.toSeq}, ${fmtTime(Number(on.timestamp))})` } : { ok: anchor ? false : null, text: anchor ? "Root not found among the latest on-chain anchors" : "LogAnchor not deployed" });
    setRes({ lines });
  };

  const fetchSeq = async () => {
    setRes(null);
    try {
      const r = await fetch(`/api/logs/proof/${encodeURIComponent(seq.trim())}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = (await r.json()) as ProofResp;
      setPaste(JSON.stringify(p, null, 2));
      check(p);
    } catch (e) {
      setRes({ lines: [{ ok: false, text: e instanceof Error ? e.message : String(e) }] });
    }
  };

  return (
    <Card title="Log verifier">
      <p className="text-xs text-muted">
        Every service-log entry (CMC call, keeper tx, agent I/O) is chained: entryHash = keccak256(prevHash ‖ canonicalJSON(entry)). Hourly, the ordered Merkle root of a seq range goes to LogAnchor ({n} anchors on-chain). Everything below is recomputed in your browser.
      </p>
      <div className="mt-2 flex gap-2">
        <input className="input" placeholder="log seq, e.g. 42" value={seq} onChange={(e) => setSeq(e.target.value.replace(/[^0-9]/g, ""))} />
        <button className="btn whitespace-nowrap" disabled={!seq} onClick={fetchSeq}>Fetch + verify</button>
      </div>
      <textarea className="input mt-2 h-28" placeholder="or paste the JSON from /api/logs/proof/<seq>" value={paste} onChange={(e) => setPaste(e.target.value)} />
      <button className="btn btn-sm mt-2" disabled={!paste.trim()} onClick={() => { try { check(JSON.parse(paste) as ProofResp); } catch (e) { setRes({ lines: [{ ok: false, text: e instanceof Error ? e.message : String(e) }] }); } }}>
        Verify pasted proof
      </button>
      {res && (
        <ul className="mt-2 space-y-1 break-all font-mono text-xs">
          {res.lines.map((l, i) => <li key={i} className={l.ok === true ? "text-good" : l.ok === false ? "text-bad" : "text-muted"}>{l.ok === true ? "✓" : l.ok === false ? "✕" : "·"} {l.text}</li>)}
        </ul>
      )}
    </Card>
  );
}
