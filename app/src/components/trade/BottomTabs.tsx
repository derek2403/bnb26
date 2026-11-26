"use client";
import { useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { txUrl } from "@/config/chains";
import { addr, deployments97, launcherForPool, TESTNET_EXTERNAL } from "@/config/deployments";
import { PROPOSAL_STATUS, useLatestProposal, useRisk } from "@/hooks/useMarket";
import type { PoolDetail } from "@/hooks/usePools";
import { fmtAge, fmtBps, fmtDuration, fmtLev, fmtNum, fmtPct, fmtTime, fmtUsd, short } from "@/lib/format";
import { Addr, CrGauge, KV, LeverageGauge, ModePill, Offline, SplitBar, UTabs, useApi } from "../ui";
import type { CloseWhat, OrderTab } from "./OrderPanel";

type Tab = "positions" | "pool" | "risk" | "activity";

export function BottomTabs({ d, change24h, now, onOrder }: { d: PoolDetail; change24h?: number; now: number; onOrder: (t: OrderTab, c?: CloseWhat) => void }) {
  const [tab, setTab] = useState<Tab>("positions");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <UTabs
        className="border-b border-line px-1"
        value={tab}
        onChange={setTab}
        items={[
          { value: "positions", label: "Positions" },
          { value: "pool", label: "Pool" },
          { value: "risk", label: "Risk & AI" },
          { value: "activity", label: "Activity" },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" && <Positions d={d} change24h={change24h} onOrder={onOrder} />}
        {tab === "pool" && <PoolTab d={d} />}
        {tab === "risk" && <RiskTab d={d} now={now} />}
        {tab === "activity" && <ActivityTab d={d} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ positions

function Positions({ d, change24h, onOrder }: { d: PoolDetail; change24h?: number; onOrder: (t: OrderTab, c?: CloseWhat) => void }) {
  const m = d.meta!;
  const s = d.snap;
  const { isConnected } = useAccount();
  const u = d.user;
  if (!u || (!isConnected && !m.isDemo)) return <div className="px-4 py-8 text-center text-sm text-muted">Connect a wallet to see your positions.</div>;
  const P = s?.price ?? 0;
  const L = s && Number.isFinite(s.leverage) ? s.leverage : 2;
  const crCap = s ? Math.min(1, Number.isFinite(s.cr) ? s.cr : 1) : 1;
  const asset = Number(formatUnits(u.asset, d.decimals.asset));
  const x = Number(formatUnits(u.x, 18));
  const sUSD = Number(formatUnits(u.sUSD, 18));
  const usdc = Number(formatUnits(u.usdc, d.decimals.usdc));
  const dep = d.spUser?.deposit ?? 0;
  const ch = change24h ?? 0;
  type R = { k: string; label: ReactNode; bal: number; unit: string; price?: number; value: number; pnl?: number; note: string; action?: ReactNode };
  const rows: R[] = [
    { k: "x", label: <span className="text-lever">{m.leverSymbol}</span>, bal: x, unit: m.leverSymbol, price: s?.xNav, value: x * (s?.xNav ?? 0), pnl: change24h !== undefined ? x * (s?.xNav ?? 0) * L * ch : undefined, note: `${fmtLev(L)} long ${m.symbol}, no liquidation`, action: x > 0 ? <button className="btn btn-sm" onClick={() => onOrder("close", "redeemLever")}>Close</button> : <button className="btn btn-sm" onClick={() => onOrder("long")}>Long</button> },
    { k: "s", label: <span className="text-stable">sUSD</span>, bal: sUSD, unit: "sUSD", price: crCap, value: sUSD * crCap, pnl: 0, note: `backed ${s && Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞"} by ${m.symbol}`, action: sUSD > 0 ? <span className="flex justify-end gap-1"><button className="btn btn-sm" onClick={() => onOrder("earn")}>Earn</button><button className="btn btn-sm" onClick={() => onOrder("close", "redeemStable")}>Redeem</button></span> : <button className="btn btn-sm" onClick={() => onOrder("stable")}>Mint</button> },
    ...(m.isDemo ? [] : [{ k: "sp", label: "Stability Pool", bal: dep, unit: "sUSD", price: crCap, value: dep * crCap + (d.spUser?.assetGain ?? 0) * P + (d.spUser?.stableReward ?? 0), pnl: undefined, note: d.spUser && (d.spUser.assetGain > 0 || d.spUser.stableReward > 0) ? `+${fmtNum(d.spUser.assetGain)} ${m.assetSymbol}, +${fmtNum(d.spUser.stableReward)} sUSD gains` : "earning funding", action: <button className="btn btn-sm" onClick={() => onOrder("earn")}>Manage</button> }]),
    { k: "a", label: m.assetSymbol, bal: asset, unit: m.assetSymbol, price: P, value: asset * P, pnl: change24h !== undefined ? asset * P * ch : undefined, note: "test stock in your wallet", action: undefined },
    { k: "u", label: "mUSDC", bal: usdc, unit: "mUSDC", price: 1, value: usdc, pnl: 0, note: "test dollars from closes", action: undefined },
  ];
  for (const r of rows) if (r.pnl !== undefined && Math.abs(r.pnl) < 0.005) r.pnl = 0;
  const total = rows.reduce((a, r) => a + r.value, 0);
  const pnlRaw = rows.reduce((a, r) => a + (r.pnl ?? 0), 0);
  const pnl = Math.abs(pnlRaw) < 0.005 ? 0 : pnlRaw;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="border-b border-line">
            <th className="th">Asset</th>
            <th className="th text-right">Balance</th>
            <th className="th text-right">Price</th>
            <th className="th text-right">Value</th>
            <th className="th text-right" title="Estimated from the 24h price move and the pool's leverage">24h P&amp;L (est.)</th>
            <th className="th">Note</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className="border-b border-line/60">
              <td className="td font-medium">{r.label}</td>
              <td className="td num text-right text-ink">{fmtNum(r.bal)}</td>
              <td className="td num text-right text-muted">{r.price !== undefined ? fmtUsd(r.price, { digits: r.price >= 100 ? 2 : 4 }) : "–"}</td>
              <td className="td num text-right text-ink">{fmtUsd(r.value)}</td>
              <td className={`td num text-right ${r.pnl === undefined || r.pnl === 0 ? "text-faint" : r.pnl > 0 ? "text-good" : "text-bad"}`}>{r.pnl === undefined ? "–" : `${r.pnl > 0 ? "+" : ""}${fmtUsd(r.pnl)}`}</td>
              <td className="td text-xs text-muted">{r.note}</td>
              <td className="td text-right">{r.action}</td>
            </tr>
          ))}
          <tr>
            <td className="td text-xs text-muted">Total</td>
            <td className="td" />
            <td className="td" />
            <td className="td num text-right font-medium text-ink">{fmtUsd(total)}</td>
            <td className={`td num text-right ${pnl > 0 ? "text-good" : pnl < 0 ? "text-bad" : "text-faint"}`}>{change24h === undefined ? "–" : `${pnl > 0 ? "+" : ""}${fmtUsd(pnl)}`}</td>
            <td className="td" colSpan={2} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ pool

function vaultOf(source: string, id: string, m?: PoolDetail["meta"]) {
  if (m?.launcher) return addr(m.addresses?.backstopVault);
  return source === "flap" ? addr(launcherForPool(id)?.vault) : source === "four" ? addr(deployments97.openfour.backstopTreasury) : undefined;
}

function PoolTab({ d }: { d: PoolDetail }) {
  const m = d.meta!;
  const s = d.snap;
  if (!s) return <div className="px-4 py-8 text-center text-sm text-muted">{d.loading ? "Reading the pool…" : "Pool state unavailable."}</div>;
  const vault = vaultOf(m.source, m.id, m);
  return (
    <div className="grid gap-px bg-line lg:grid-cols-3">
      <div className="bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Pool</span>
          <ModePill mode={s.mode} />
        </div>
        <KV k="Pool value" v={fmtUsd(s.V)} />
        <KV k={`${m.assetSymbol} held`} v={`${fmtNum(s.C)} (${fmtUsd(s.C * s.price, { compact: true })})`} />
        <KV k="mUSDC held" v={fmtUsd(s.U)} />
        <KV k="sUSD supply" v={fmtNum(s.S, 2)} tone="text-stable" />
        <KV k={`${m.leverSymbol} supply`} v={fmtNum(s.X)} tone="text-lever" />
        <KV k={`${m.leverSymbol} NAV`} v={fmtUsd(s.xNav, { digits: 4 })} tone="text-lever" />
        <div className="mt-3">
          <SplitBar snap={s} />
        </div>
      </div>
      <div className="space-y-5 bg-surface p-4">
        <LeverageGauge snap={s} />
        <CrGauge snap={s} />
        <div>
          <span className="label">Fees now</span>
          <KV k="Long 2x mint" v={fmtBps(s.leverMintFeeBps)} />
          <KV k="sUSD mint" v={fmtBps(s.stableMintFeeBps)} />
          <KV k="Close / redeem" v={fmtBps(s.redeemFeeBps)} />
        </div>
      </div>
      <div className="bg-surface p-4">
        <span className="label">Protection</span>
        <KV k="Stability Pool" v={s.spDeposits !== undefined ? fmtUsd(s.spDeposits, { compact: true }) : "–"} />
        <KV k="Insurance vault" v={s.backstopUsd !== undefined ? fmtUsd(s.backstopUsd, { compact: s.backstopUsd >= 10_000 }) : "–"} tone="text-good" />
        <KV k="Vault covers sUSD" v={s.backstopUsd !== undefined && s.S > 0 ? fmtPct(s.backstopUsd / s.S, 2) : "–"} />
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Loss order: sell zone → Stability Pool → insurance vault ({m.isDemo ? "simulated" : `funded by the ${m.launchpad} launch`}) → pro-rata on sUSD. xSTOCK takes losses first.
        </p>
        {!m.isDemo && m.addresses && (
          <div className="mt-3 border-t border-line pt-2">
            <span className="label">Contracts</span>
            <KV k="LeveragePool" v={<Addr a={m.addresses.pool} />} />
            <KV k={m.leverSymbol} v={<Addr a={m.addresses.xToken} />} />
            <KV k="sUSD" v={<Addr a={m.addresses.sUSD} />} />
            <KV k="Stability Pool" v={<Addr a={m.addresses.stabilityPool} />} />
            {vault && <KV k="Insurance vault" v={<Addr a={vault} />} />}
            <KV k={m.assetSymbol} v={<Addr a={m.addresses.asset} />} />
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ risk & AI

type AgentRun = { proposal_id?: number | string | null; tx_hash?: string | null; served_model?: string; model?: string; validated?: { rationale?: string; evidence?: { tool: string }[] } | null };

const STATUS_UI: Record<string, { text: string; tone: string }> = {
  APPLIED: { text: "Tightened · applied", tone: "border-good/40 text-good" },
  EXECUTED: { text: "Executed after timelock", tone: "border-good/40 text-good" },
  QUEUED: { text: "Queued · loosening waits", tone: "border-warn/40 text-warn" },
  VETOED: { text: "Vetoed by guardian", tone: "border-bad/40 text-bad" },
  CANCELLED: { text: "Cancelled", tone: "" },
  NONE: { text: "–", tone: "" },
};
const SOURCE = ["CMC rule", "AI agent", "Fallback"];

function RiskTab({ d, now }: { d: PoolDetail; now: number }) {
  const m = d.meta!;
  const s = d.snap;
  const r = useRisk(m.symbol);
  const ap = useLatestProposal(m.symbol);
  const runs = useApi<{ runs?: AgentRun[] }>("/api/agent/proposals?limit=50", 60_000);
  const atlas = m.isDemo ? undefined : s?.price;
  const dev = atlas && r.refPrice ? (atlas - r.refPrice) / r.refPrice : undefined;
  const p = ap.latest?.p;
  const status = p ? PROPOSAL_STATUS[p.status] ?? "NONE" : "NONE";
  const st = STATUS_UI[status];
  const off = ap.latest ? (runs.data?.data?.runs ?? []).find((x) => String(x.proposal_id) === ap.latest!.id.toString()) : undefined;
  const identity = addr(deployments97.erc8004.identity) ?? TESTNET_EXTERNAL.erc8004Identity;
  const w = (v: bigint) => Number(v) / 1e18;
  const breach = dev !== undefined && r.maxDevBps !== undefined && Math.abs(dev) * 1e4 > r.maxDevBps;
  return (
    <div className="grid gap-px bg-line lg:grid-cols-[1fr_1.3fr]">
      <div className="bg-surface p-4">
        <span className="label">Price check · Atlas vs CoinMarketCap</span>
        {m.isDemo && <p className="mt-1 text-xs text-faint">Simulated market: the pool limits are local defaults; the price check and agent apply to live markets.</p>}
        <KV k="Atlas price (on-chain)" v={atlas ? fmtUsd(atlas) : "–"} />
        <KV k="CMC reference (on-chain)" v={r.refPrice ? `${fmtUsd(r.refPrice)}${r.refTs ? ` · ${fmtAge(now - r.refTs)} ago` : ""}` : "–"} />
        <KV k="Deviation" v={dev !== undefined ? `${dev >= 0 ? "+" : ""}${(dev * 100).toFixed(2)}%` : "–"} tone={breach ? "text-bad" : "text-ink"} />
        <KV k="Mint breaker at" v={r.maxDevBps !== undefined ? `±${fmtBps(r.maxDevBps)}` : "–"} />
        <KV k="Volatility σ (CMC, annualised)" v={r.volBps !== undefined ? `${(r.volBps / 100).toFixed(1)}%` : "–"} />
        <KV k="DEX liquidity (CMC)" v={r.liqUsd !== undefined ? fmtUsd(r.liqUsd, { compact: true }) : "–"} />
        <div className="mt-3 border-t border-line pt-2">
          <span className="label">Limits now</span>
          <KV k="Sell zone above" v={r.effective ? fmtLev(r.effective.trigger) : s ? fmtLev(s.triggerLev) : "–"} tone="text-lever" />
          <KV k="Target" v={r.effective ? fmtLev(r.effective.target) : s ? fmtLev(s.targetLev) : "–"} />
          <KV k="Buy zone below" v={r.effective ? fmtLev(r.effective.lower) : s ? fmtLev(s.lowerTriggerLev) : "–"} />
          <KV k="Closed-market fee" v={r.effective ? fmtBps(r.effective.closedFeeBps) : "–"} />
          <KV k="Set by" v={r.source !== undefined ? `${SOURCE[r.source] ?? "–"}${r.snapshotId ? ` · snapshot #${r.snapshotId}` : ""}` : "–"} mono={false} />
        </div>
      </div>
      <div className="bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label">AI risk agent · latest proposal</span>
          {ap.agentId && (
            <a className="pill hover:text-ink" href={`https://testnet.bscscan.com/nft/${identity}/${ap.agentId}`} target="_blank" rel="noreferrer" title="ERC-8004 identity NFT on BSC testnet">
              ERC-8004 agent #{ap.agentId} ↗
            </a>
          )}
        </div>
        {p && ap.latest ? (
          <div className="mt-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="num font-medium text-ink">#{ap.latest.id.toString()}</span>
              <span className={`pill ${st.tone}`}>
                {st.text}
                {status === "QUEUED" ? ` · ${fmtDuration(Number(p.eta) - now)} left` : ""}
              </span>
              <span className="pill">{p.tightenOnly ? "stricter only" : "loosening"}</span>
              <span className="text-xs text-faint">{fmtTime(Number(p.createdAt))}</span>
            </div>
            <table className="mt-2 w-full text-[13px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="th px-0">Limit</th>
                  <th className="th text-right">CMC rule</th>
                  <th className="th pr-0 text-right">Agent</th>
                </tr>
              </thead>
              <tbody className="num">
                {[
                  ["Sell trigger", r.rule ? fmtLev(r.rule.trigger) : "–", fmtLev(w(p.params.triggerLev)), r.rule ? w(p.params.triggerLev) < r.rule.trigger : false],
                  ["Target", r.rule ? fmtLev(r.rule.target) : "–", fmtLev(w(p.params.targetLev)), r.rule ? w(p.params.targetLev) < r.rule.target : false],
                  ["Max CMC deviation", r.rule ? fmtBps(r.rule.maxDevBps) : "–", fmtBps(p.params.maxDevBps), r.rule ? Number(p.params.maxDevBps) < r.rule.maxDevBps : false],
                  ["Closed-market fee", r.rule ? fmtBps(r.rule.closedFeeBps) : "–", fmtBps(p.params.closedFeeBps), r.rule ? Number(p.params.closedFeeBps) > r.rule.closedFeeBps : false],
                ].map(([k, a, b, tighter]) => (
                  <tr key={k as string} className="border-b border-line/60">
                    <td className="py-1.5 font-sans text-muted">{k}</td>
                    <td className="py-1.5 text-right text-muted">{a}</td>
                    <td className={`py-1.5 text-right ${tighter ? "text-good" : "text-ink"}`}>
                      {b}
                      {tighter ? " ↓" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[13px] leading-relaxed text-ink">{off?.validated?.rationale ?? <span className="text-muted">{runs.isLoading ? "Loading the agent's reasoning…" : runs.data?.offline ? "Reasoning unavailable: the keeper API is offline." : "No reasoning recorded for this proposal."}</span>}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
              {off?.served_model || off?.model ? <span>Model {off.served_model ?? off.model} (TEE)</span> : null}
              {off?.validated?.evidence?.length ? <span>Evidence: {off.validated.evidence.slice(0, 4).map((e) => e.tool).join(", ")}</span> : null}
              {off?.tx_hash && (
                <a className="link" href={txUrl(off.tx_hash)} target="_blank" rel="noreferrer">
                  propose() tx ↗
                </a>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">{ap.loading ? "Reading proposals…" : `No agent proposal for ${m.symbol} yet. The agent runs hourly and before calendar events.`}</p>
        )}
        <p className="mt-3 border-t border-line pt-2 text-xs leading-relaxed text-faint">
          The agent reads CMC market and event data through a TEE model and proposes limits on-chain. It can only make them stricter at once; loosening waits 30 minutes behind a timelock and the guardian can veto. It cannot move funds or post prices.
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ activity

type EventRow = { chain_id?: number; block_time?: string | number; tx_hash?: string; name?: string; contract?: string; address?: string; args?: Record<string, unknown> };
const toSec = (t?: string | number) => {
  if (t === undefined || t === null || t === "") return undefined;
  const n = typeof t === "number" ? t : /^\d+$/.test(t) ? Number(t) : Math.floor(Date.parse(t) / 1000);
  return Number.isFinite(n) ? (n > 1e12 ? Math.floor(n / 1000) : n) : undefined;
};
const POOL_EVENTS = new Set(["Minted", "Redeemed", "SellZone", "BuyZone", "Seeded", "Donated", "ModeChanged", "Deposited", "Withdrawn", "GainsClaimed", "Defended", "MintsPaused"]);
const MODE_NAMES = ["Unseeded", "Normal", "Stability", "Underwater", "No price"];
const wad = (v: unknown) => {
  try {
    return Number(formatUnits(BigInt(String(v ?? "0")), 18));
  } catch {
    return 0;
  }
};
const amt = (v: unknown, digits = 4) => fmtNum(wad(v), digits);

/** One readable line per event: what happened, in token and dollar terms. */
function describe(e: EventRow, asset: string, lever: string): { label: string; tone?: string; text: string } {
  const a = e.args ?? {};
  const act = Number(a.action);
  switch (e.name) {
    case "Minted":
      return act === 1
        ? { label: "Long 2x", tone: "text-lever", text: `${amt(a.cIn)} ${asset} → ${amt(a.out, 2)} ${lever} @ ${fmtUsd(wad(a.price), { digits: 2 })}` }
        : { label: "Mint sUSD", tone: "text-stable", text: `${amt(a.cIn)} ${asset} → ${amt(a.out, 2)} sUSD @ ${fmtUsd(wad(a.price), { digits: 2 })}` };
    case "Redeemed": {
      const what = act === 4 ? `${amt(a.xBurned, 2)} ${lever} + ${amt(a.sBurned, 2)} sUSD` : act === 3 ? `${amt(a.xBurned, 2)} ${lever}` : `${amt(a.sBurned, 2)} sUSD`;
      const usdc = wad(a.uOut);
      return { label: act === 4 ? "Close pair" : act === 3 ? `Close ${lever}` : "Redeem sUSD", text: `${what} → ${amt(a.cOut)} ${asset}${usdc > 0 ? ` + ${fmtNum(usdc, 2)} mUSDC` : ""}` };
    }
    case "SellZone":
      return { label: "Sell zone", tone: "text-bad", text: `Sold ${amt(a.sold)} ${asset} for ${fmtUsd(wad(a.out))} · leverage ${fmtLev(wad(a.levBefore))} → ${fmtLev(wad(a.levAfter))}` };
    case "BuyZone":
      return { label: "Buy zone", tone: "text-good", text: `Bought ${amt(a.out)} ${asset} for ${fmtUsd(wad(a.spent))} · leverage ${fmtLev(wad(a.levBefore))} → ${fmtLev(wad(a.levAfter))}` };
    case "Defended":
      return { label: "Insurance vault", tone: "text-warn", text: `Covered ${fmtUsd(wad(a.usdcOut))} · backing ${fmtPct(wad(a.crBefore), 1)} → ${fmtPct(wad(a.crAfter), 1)}` };
    case "Donated":
      return { label: "Vault top-up", tone: "text-warn", text: `${fmtUsd(wad(a.usdcIn))} added · backing ${fmtPct(wad(a.crBefore), 1)} → ${fmtPct(wad(a.crAfter), 1)}` };
    case "ModeChanged":
      return { label: "Mode", text: `${MODE_NAMES[Number(a.previous)] ?? a.previous} → ${MODE_NAMES[Number(a.current)] ?? a.current}` };
    case "Seeded":
      return { label: "Pool opened", text: `Seeded ${amt(a.cIn)} ${asset} as first-loss ${lever} @ ${fmtUsd(wad(a.price), { digits: 2 })}` };
    case "Deposited":
      return { label: "Earn deposit", tone: "text-stable", text: `${amt(a.amount ?? a.assets, 2)} sUSD into the Stability Pool` };
    case "Withdrawn":
      return { label: "Earn withdraw", text: `${amt(a.amount ?? a.assets, 2)} sUSD from the Stability Pool` };
    case "GainsClaimed":
      return { label: "Earn claim", text: "Stability Pool gains claimed" };
    case "MintsPaused":
      return { label: "Mints paused", tone: "text-warn", text: "Price breaker or guardian paused minting; closing still works" };
    default:
      return { label: e.name ?? "Event", text: "" };
  }
}
const marketOf = (c?: string) => (c && c.includes(":") ? c.split(":")[1] : undefined);

function ActivityTab({ d }: { d: PoolDetail }) {
  const m = d.meta!;
  const q = useApi<{ events?: EventRow[] }>(m.isDemo ? null : "/api/events/all?limit=500", 20_000);
  if (m.isDemo) return <div className="px-4 py-8 text-center text-sm text-muted">Simulated market: no on-chain activity. Your simulated trades show as notifications.</div>;
  if (q.data?.offline) return <div className="p-4"><Offline note="Pool state, positions and the chart still work; recent events come back when the keeper API is up." /></div>;
  const mine = [m.addresses?.pool, m.addresses?.stabilityPool].filter(Boolean).map((x) => x!.toLowerCase());
  const vault = vaultOf(m.source, m.id, m)?.toLowerCase();
  const rows = (q.data?.data?.events ?? [])
    .filter((e) => (e.chain_id ?? 97) === 97 && e.name && POOL_EVENTS.has(e.name) && e.name !== "Initialized")
    .filter((e) => {
      const at = (e.address ?? "").toLowerCase();
      if (marketOf(e.contract) === m.id || mine.includes(at)) return true;
      // Insurance-vault events count when they name this pool.
      return !!vault && at === vault && String(e.args?.pool ?? "").toLowerCase() === (m.addresses?.pool ?? "").toLowerCase();
    })
    .slice(0, 40);
  if (!rows.length)
    return (
      <div className="px-4 py-8 text-center text-sm text-muted">
        {q.isLoading ? "Loading activity…" : `No trades in ${m.symbol} yet. Stress-test events run on the sandbox pool and are listed on Transparency.`}
      </div>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px]">
        <thead>
          <tr className="border-b border-line">
            <th className="th">Time</th>
            <th className="th">Action</th>
            <th className="th">Details</th>
            <th className="th text-right">Tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const x = describe(e, m.assetSymbol ?? "t" + m.symbol, m.leverSymbol);
            return (
              <tr key={`${e.tx_hash}-${i}`} className="border-b border-line/60">
                <td className="td num text-xs text-muted">{fmtTime(toSec(e.block_time))}</td>
                <td className={`td text-[13px] font-medium ${x.tone ?? "text-ink"}`}>{x.label}</td>
                <td className="td num max-w-[520px] truncate text-xs text-muted">{x.text}</td>
                <td className="td text-right">
                  {e.tx_hash && (
                    <a className="num link text-xs" href={txUrl(e.tx_hash)} target="_blank" rel="noreferrer">
                      {short(e.tx_hash)} ↗
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

