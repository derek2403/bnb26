"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { addressUrl } from "@/config/chains";
import { addr, deployments97, oracleFor } from "@/config/deployments";
import { listMetas, useRealMetas, usePool } from "@/hooks/usePools";
import { fmtLev, fmtPct, fmtUsd } from "@/lib/format";
import type { PoolMeta } from "@/lib/types";
import { Card, ModePill, SplitBar, Stat } from "@/components/ui";

export default function Home() {
  const { demo } = listMetas();
  const { real } = useRealMetas();
  const featured: PoolMeta[] = real.length ? real : demo.slice(0, 1);
  return (
    <div className="space-y-8">
      <section className="grid gap-6 lg:grid-cols-[1.3fr_1fr] lg:items-center">
        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="pill">BNB Hack Bangkok</span>
            <span className="pill">BSC testnet · mocks</span>
          </div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            Split a tokenized stock into a <span className="text-stable">stock-backed dollar</span> and <span className="text-lever">leverage that is never liquidated</span>.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted">
            A SplitStock pool holds tokenized NVIDIA. <b className="text-stable">sUSD</b> is a claim on exactly $1 of pool value; <b className="text-lever">xNVDA</b> owns the rest at a floating ~2x. Nobody borrows, so nobody is liquidated: a sell zone and a buy zone swap stock and USDC to keep leverage in a band. Atlas sets the price, CoinMarketCap data sets the risk limits, and every launch on Flap and OpenFour opens a new pool with its own insurance.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/pools" className="btn-primary">Open the pools</Link>
            <Link href="/scenario" className="btn">Break a sandbox pool</Link>
            <Link href="/proof" className="btn">Verify everything</Link>
          </div>
        </div>
        <FourDoors />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {featured.map((m) => <LiveCard key={m.id} meta={m} />)}
        {real.length < 2 && (
          <Card title="Launch status">
            <p className="text-sm text-muted">
              Two real pools are planned: NVDA, opened by the Flap crowdfund&apos;s openPool(), and TSLA, opened when a Four.meme meme graduates through our migrate module. Until they exist, the pools page shows demo pools priced from CoinMarketCap with simulated state.
            </p>
            <div className="mt-3 flex gap-2">
              <Link className="btn btn-sm" href="/launch">Flap crowdfund →</Link>
              <Link className="btn btn-sm" href="/memes">Four.meme launches →</Link>
            </div>
          </Card>
        )}
      </section>

      <section className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <JudgeVerify />
        <DripCard />
      </section>

      <section className="text-xs text-faint">
        Prior art: f(x) Protocol (AladdinDAO) splits ETH into a stable and a leveraged token with a stability mode. SplitStock is backed by stock, takes its trigger from outside data, handles market hours and gaps, and deleverages through a DEX with a backstop funded by launch tax. Limits: testnet assets are mocks; the testnet price comes through a relayed mirror; sUSD redeems pro rata once V ≤ S; no real-money mainnet pool exists.
      </section>
    </div>
  );
}

function LiveCard({ meta }: { meta: PoolMeta }) {
  const d = usePool(meta.id);
  const s = d.snap;
  return (
    <Link href={`/pools/${meta.id}`} className="card block transition hover:border-stable/40">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-ink">
          {meta.symbol} pool <span className="font-normal text-muted">· opened by {meta.launchpad}</span>
        </div>
        {s && <ModePill mode={s.mode} />}
      </div>
      {s ? (
        <>
          <div className="mt-4 grid grid-cols-5 gap-3">
            <Stat label="V" value={fmtUsd(s.V, { compact: true })} />
            <Stat label="S" value={fmtUsd(s.S, { compact: true })} tone="stable" />
            <Stat label="xNAV" value={fmtUsd(s.xNav, { digits: 3 })} tone="lever" />
            <Stat label="L" value={fmtLev(s.leverage)} tone="lever" />
            <Stat label="CR" value={Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞"} tone="stable" />
          </div>
          <div className="mt-4"><SplitBar snap={s} /></div>
        </>
      ) : (
        <div className="mt-4 text-sm text-muted">Reading pool.state()…</div>
      )}
    </Link>
  );
}

function FourDoors() {
  const doors = [
    { t: "Atlas price", b: "Mainnet NVDAB feed, mirrored to testnet each round; signed pull payloads as a check.", c: "border-stable/40" },
    { t: "CMC risk limits", b: "Keyed CMC data → RiskOracle: σ sets the trigger, liquidity sets the chunk, premium sets the fee.", c: "border-stable/40" },
    { t: "Flap launch", b: "SPLIT crowdfund opens the NVDA pool; tax funds its BackstopVault.", c: "border-lever/40" },
    { t: "OpenFour graduation", b: "A meme raised in tTSLA graduates into a new TSLA pool; fees fund its BackstopTreasury.", c: "border-lever/40" },
  ];
  return (
    <div className="relative grid grid-cols-2 gap-3">
      {doors.map((d) => (
        <div key={d.t} className={`card border ${d.c}`}>
          <div className="text-sm font-semibold text-ink">{d.t}</div>
          <div className="mt-1 text-xs text-muted">{d.b}</div>
        </div>
      ))}
      <div className="pointer-events-none absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center overflow-hidden rounded-2xl border-4 border-bg shadow-lg">
        <span className="h-full w-1/2 bg-stable" />
        <span className="h-full w-1/2 bg-lever" />
      </div>
    </div>
  );
}

function JudgeVerify() {
  const nvda = deployments97.pools.find((p) => p.kind === "flap");
  const launcher = deployments97.flap.launchers[0];
  const items = [
    { label: "NVDA LeveragePool: read state() on BscScan", href: nvda ? `${addressUrl(nvda.pool)}#readContract` : undefined },
    { label: "AtlasMirror: Mirrored events (each cites the mainnet Atlas tx)", href: addr(oracleFor("NVDA")?.mirror) ? `${addressUrl(oracleFor("NVDA")!.mirror!)}#events` : undefined },
    { label: "RiskOracle: CmcSnapshot and AgentProposal events", href: addr(deployments97.core.riskOracle) ? `${addressUrl(deployments97.core.riskOracle!)}#events` : undefined },
    { label: "Flap SplitLauncher: contributions, launch, openPool", href: launcher ? `${addressUrl(launcher.launcher)}#events` : undefined },
    { label: "LogAnchor: hourly Merkle roots of the CMC call log", href: addr(deployments97.core.logAnchor) ? `${addressUrl(deployments97.core.logAnchor!)}#events` : undefined },
  ];
  return (
    <Card title="Judge quick-verify">
      <ol className="space-y-2 text-sm">
        {items.map((it, i) => (
          <li key={i} className="flex gap-3">
            <span className="num text-faint">{i + 1}</span>
            {it.href ? <a className="link" href={it.href} target="_blank" rel="noreferrer">{it.label} ↗</a> : <span className="text-muted">{it.label} <span className="text-faint">(not deployed yet)</span></span>}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted">More on <Link className="link" href="/proof">/proof</Link> (address book, event streams per track, CMC key usage, log verifier) and <Link className="link" href="/status">/status</Link>.</p>
    </Card>
  );
}

function DripCard() {
  const { address } = useAccount();
  const [ch, setCh] = useState<{ question: string; token: string; enabled: boolean } | null>(null);
  const [answer, setAnswer] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => fetch("/api/drip").then((r) => r.json()).then(setCh).catch(() => setCh(null));
  useEffect(() => {
    void load();
  }, []);
  const submit = async () => {
    if (!address || !ch) return;
    setMsg("Sending…");
    const r = await fetch("/api/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, answer, token: ch.token }) });
    const b = await r.json().catch(() => ({}));
    setMsg(r.ok ? `Sent ${b.amount} tBNB: ${b.hash}` : `Not sent: ${b.error ?? r.status}`);
    setAnswer("");
    void load();
  };
  return (
    <Card title="Test gas">
      <p className="text-sm text-muted">0.005 tBNB once per wallet per day, enough for a few pool transactions. Stock tokens come from the faucet button on each pool.</p>
      {ch?.enabled === false ? (
        <p className="mt-3 text-xs text-faint">The drip is not configured on this deployment.</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <span className="num flex items-center whitespace-nowrap text-sm text-ink">{ch?.question ?? "…"}</span>
          <input className="input" value={answer} onChange={(e) => setAnswer(e.target.value)} inputMode="numeric" placeholder="answer" />
          <button className="btn-primary whitespace-nowrap" disabled={!address || !answer} onClick={submit}>{address ? "Drip" : "Connect"}</button>
        </div>
      )}
      {msg && <p className="mt-2 break-all text-xs text-muted">{msg}</p>}
    </Card>
  );
}
