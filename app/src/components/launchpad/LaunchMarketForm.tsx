"use client";
import Link from "next/link";
import { useState } from "react";
import { formatEther, parseEther, zeroAddress, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { useReadContracts } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { SplitLauncherAbi } from "@/abi";
import { addressUrl, tokenUrl, txUrl } from "@/config/chains";
import { STOCK_NAMES } from "@/config/demoPools";
import { FLAP, useFlapFactoryInfo, useFlapLaunch, useMyLaunches, type LaunchStep, type MyLaunch } from "@/hooks/useFlapLaunch";
import { LAUNCH_BOUNDS, byteLen, flapLauncherUrl } from "@/lib/flapLaunch";
import { fmtNum, short } from "@/lib/format";
import { TickerIcon } from "../ui";

const STOCKS = ["NVDA", "TSLA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "AVGO", "NFLX", "COIN", "MSTR", "AMD"] as const;
const LIVE = "NVDA"; // the Flap launcher factory's stock is fixed (immutable config)

const fmtBnb = (wei: bigint | undefined, d = 3) => (wei === undefined ? "…" : fmtNum(Number(formatEther(wei)), d));

function parseBnb(s: string): bigint | undefined {
  try {
    const t = s.trim();
    if (!t || !/^\d*\.?\d*$/.test(t)) return undefined;
    return parseEther(t as `${number}`);
  } catch {
    return undefined;
  }
}

const STEP_TEXT: Record<LaunchStep, string> = {
  idle: "",
  mining: "Finding a 7777 address…",
  checking: "Checking the address on-chain…",
  register: "Confirm 1 of 2 in your wallet: register the market launcher",
  launch: "Confirm in your wallet: send the launch to Flap",
  done: "Launch created on Flap.",
  error: "",
};

export function LaunchMarketForm() {
  const { list, add } = useMyLaunches();
  const info = useFlapFactoryInfo();
  const flow = useFlapLaunch(add);
  const { openConnectModal } = useConnectModal();

  const [stock, setStock] = useState<string>(LIVE);
  const [lev, setLev] = useState(2);
  const [raise, setRaise] = useState("4.7");
  const [seed, setSeed] = useState("0.2");
  const [days, setDays] = useState("3");
  const [advanced, setAdvanced] = useState(false);

  const target = parseBnb(raise);
  const seedWei = parseBnb(seed);
  const daysNum = Number(days);
  const durationSec = Number.isFinite(daysNum) ? Math.round(daysNum * 86400) : NaN;
  const quote = target !== undefined && seedWei !== undefined && target >= seedWei ? target - seedWei : undefined;
  const minQuote = info.minPoolQuote;
  const minTarget = minQuote !== undefined && seedWei !== undefined ? minQuote + seedWei : undefined;
  const name = `${stock} Market`;
  const symbol = `${stock}M`;

  let problem: string | null = null;
  if (stock !== LIVE) problem = "This stock cannot be launched on testnet yet.";
  else if (target === undefined) problem = "Enter a raise in tBNB.";
  else if (seedWei === undefined) problem = "Enter a seed in tBNB.";
  else if (target < LAUNCH_BOUNDS.minTarget || target > LAUNCH_BOUNDS.maxTarget) problem = "The raise must be between 0.5 and 1,000 tBNB.";
  else if (seedWei < LAUNCH_BOUNDS.minSeed || seedWei * 2n > target) problem = "The seed must be at least 0.01 tBNB and at most half the raise.";
  else if (!Number.isFinite(durationSec) || durationSec < LAUNCH_BOUNDS.minDuration || durationSec > LAUNCH_BOUNDS.maxDuration) problem = "The raise window must be between 10 minutes and 30 days.";
  else if (minQuote !== undefined && quote !== undefined && quote < minQuote) problem = `The raise is below Flap's minimum: at least ${fmtBnb(minTarget)} tBNB with a ${fmtBnb(seedWei, 2)} tBNB seed.`;
  else if (byteLen(name) > LAUNCH_BOUNDS.maxName || byteLen(symbol) > LAUNCH_BOUNDS.maxSymbol) problem = "Name or symbol too long.";
  if (!FLAP.factory || !FLAP.portal) problem = "The Flap launcher is not deployed on this network.";

  const submit = () => {
    if (problem || target === undefined || seedWei === undefined) return;
    if (!flow.isConnected) {
      openConnectModal?.();
      return;
    }
    void flow.start({ stock, targetLeverage: lev, targetRaise: target, backstopSeed: seedWei, saleDurationSec: durationSec });
  };

  return (
    <section className="mt-4 rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">Open a market</h2>
        <span className="pill">
          <span className="h-1.5 w-1.5 rounded-full bg-lever" />
          Pre-funded on Flap · BSC testnet
        </span>
      </div>

      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {/* 1. Stock */}
          <div>
            <div className="label">1 · Stock</div>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {STOCKS.map((s) => {
                const on = s === stock;
                const live = s === LIVE;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStock(s)}
                    disabled={flow.busy}
                    className={`flex min-w-0 items-center gap-2 rounded border px-2 py-2 text-left transition-colors ${on ? "border-accent bg-surface2" : "border-line hover:bg-surface2"} ${live ? "" : "opacity-60"}`}
                  >
                    <TickerIcon sym={s} size={22} />
                    <span className="min-w-0">
                      <span className="num block text-xs font-semibold text-ink">{s}</span>
                      <span className="block truncate text-2xs text-faint">{live ? "Available" : s === "TSLA" ? "Four.meme" : "Soon"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {stock === "TSLA" ? (
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                <span>
                  TSLA launches through Four.meme (OpenFour) on testnet: the{" "}
                  <a href="#four-launches" className="link">
                    TSLA Market launch
                  </a>{" "}
                  is pre-funding below. Its last buy sells it out and opens the TSLA market.
                </span>
                <FundFour />
              </div>
            ) : stock !== LIVE ? (
              <p className="mt-2 text-xs text-muted">{STOCK_NAMES[stock] ?? stock}: needs a tokenized stock and price feed on testnet before it can be launched.</p>
            ) : (
              <p className="mt-2 text-xs text-muted">NVIDIA, priced by the Atlas feed. The market pairs sUSD with leveraged xNVDA.</p>
            )}
          </div>

          {/* 2. Leverage */}
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">2 · Leverage you want</span>
              <span className="num text-sm font-semibold text-lever">{lev.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min={1.5}
              max={3}
              step={0.1}
              value={lev}
              onChange={(e) => setLev(Number(e.target.value))}
              disabled={flow.busy}
              className="mt-2 w-full accent-[rgb(var(--lever))]"
              aria-label="Requested leverage"
            />
            <div className="num flex justify-between text-2xs text-faint">
              <span>1.5x</span>
              <span>3x</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">Requested leverage is recorded with the launch. The market opens with MORE&apos;s standard band (about 1.5x–2.2x) and its risk settings apply.</p>
          </div>

          {/* 3. Raise */}
          <div>
            <div className="label">3 · Raise</div>
            <div className="mt-2 flex items-center gap-2">
              <input className="input max-w-[180px]" inputMode="decimal" value={raise} onChange={(e) => setRaise(e.target.value)} disabled={flow.busy} aria-label="Raise in tBNB" />
              <span className="text-xs text-muted">tBNB</span>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Minimum <span className="num text-ink">{fmtBnb(minTarget)}</span> tBNB with a {fmtBnb(seedWei, 2)} tBNB seed. Contributors fund this on Flap; you only pay the {fmtBnb(info.lockFee)} tBNB lock fee and gas.
            </p>
            <button type="button" className="mt-2 text-xs text-muted hover:text-ink" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? "Hide" : "Show"} advanced
            </button>
            {advanced && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-2xs text-faint">Seed for the market (tBNB)</span>
                  <input className="input mt-1" inputMode="decimal" value={seed} onChange={(e) => setSeed(e.target.value)} disabled={flow.busy} />
                </label>
                <label className="block">
                  <span className="text-2xs text-faint">Raise window (days)</span>
                  <input className="input mt-1" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} disabled={flow.busy} />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Summary + action */}
        <div className="self-start rounded-card border border-line bg-surface2 p-3">
          <div className="flex items-center gap-2">
            <TickerIcon sym={stock} size={28} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
              <div className="num text-2xs text-faint">${symbol}</div>
            </div>
          </div>
          <dl className="mt-3 space-y-1.5 text-xs">
            <Row k="Market" v={`sUSD + x${stock}`} />
            <Row k="Requested leverage" v={`${lev.toFixed(1)}x`} />
            <Row k="Raise" v={target !== undefined ? `${fmtBnb(target)} tBNB` : "–"} />
            <Row k="Seed for the market" v={seedWei !== undefined ? `${fmtBnb(seedWei)} tBNB` : "–"} />
            <Row k="Window" v={Number.isFinite(daysNum) ? `${fmtNum(daysNum, 2)} days` : "–"} />
            <Row k="Wallet confirms" v="1–2" />
          </dl>
          <button type="button" className="btn-primary mt-3 w-full" disabled={!!problem || flow.busy} onClick={submit}>
            {flow.busy ? (flow.step === "mining" ? "Finding a 7777 address…" : "Confirm in your wallet…") : "Send to Flap for pre-funding"}
          </button>
          {problem && <p className="mt-2 text-xs text-warn">{problem}</p>}
          {!problem && !flow.isConnected && flow.step === "idle" && <p className="mt-2 text-xs text-muted">You will be asked to connect a wallet first.</p>}
          {flow.step !== "idle" && flow.step !== "error" && (
            <p className={`mt-2 text-xs ${flow.step === "done" ? "text-good" : "text-muted"}`}>
              {STEP_TEXT[flow.step]}
              {flow.step === "mining" && <span className="num text-faint"> {flow.tries.toLocaleString()} tried</span>}
            </p>
          )}
          {flow.step === "error" && flow.error && <p className="mt-2 break-words text-xs text-bad">{flow.error}</p>}
          <p className="mt-2 text-2xs leading-relaxed text-faint">When the raise fills, the token launches on Flap and the seed opens the new {stock} market on MORE. If the raise misses its window, contributors get full refunds.</p>
        </div>
      </div>

      {list.length > 0 && (
        <div className="border-t border-line p-4">
          <div className="label">Your launches</div>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {list.map((l) => (
              <LaunchCard key={l.launcher} l={l} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">{k}</dt>
      <dd className="num text-ink">{v}</dd>
    </div>
  );
}

function LaunchCard({ l }: { l: MyLaunch }) {
  const fn = ["raised", "targetRaise", "saleDeadline", "launched", "failed", "token", "pool"] as const;
  const r = useReadContracts({
    allowFailure: true,
    query: { refetchInterval: 15_000 },
    contracts: fn.map((functionName) => ({ address: l.launcher, abi: SplitLauncherAbi, functionName, chainId: bscTestnet.id })),
  });
  const v = <T,>(i: number) => (r.data?.[i]?.status === "success" ? (r.data[i].result as T) : undefined);
  const raised = v<bigint>(0);
  const target = v<bigint>(1) ?? BigInt(l.targetRaise);
  const deadline = v<bigint>(2);
  const launched = v<boolean>(3);
  const failed = v<boolean>(4);
  const liveToken = v<Address>(5);
  const pool = v<Address>(6);
  const token = liveToken && liveToken !== zeroAddress ? liveToken : l.token;
  const pct = raised !== undefined && target > 0n ? Math.min(100, Number((raised * 10000n) / target) / 100) : 0;
  const open = !!pool && pool !== zeroAddress;
  const [funding, setFunding] = useState(false);
  const [fundMsg, setFundMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Demo funding: a server-side testnet key fills the rest of the raise and opens the market (no wallet popup).
  const fund = async () => {
    setFunding(true);
    setFundMsg(null);
    try {
      const res = await fetch("/api/launch/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launcher: l.launcher }) });
      const j = (await res.json()) as { ok: boolean; error?: string; steps?: string[] };
      setFundMsg(j.ok ? { ok: true, text: j.steps?.length ? `Done: ${j.steps.join("; ")}.` : "The market is open." } : { ok: false, text: j.error ?? "Funding failed." });
    } catch {
      setFundMsg({ ok: false, text: "Funding failed. Try again." });
    } finally {
      setFunding(false);
      void r.refetch();
    }
  };
  const status = pool && pool !== zeroAddress ? "Market open" : launched ? "Raise filled" : failed ? "Refunding" : raised === undefined ? "…" : "Pre-funding";

  return (
    <div className="min-w-0 rounded-card border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TickerIcon sym={l.stock} size={24} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-ink">{l.name}</div>
            <div className="num text-2xs text-faint">
              ${l.symbol} · wants {l.targetLeverage.toFixed(1)}x
            </div>
          </div>
        </div>
        <span className={`pill ${status === "Market open" || status === "Raise filled" ? "border-good/40 text-good" : failed ? "border-bad/40 text-bad" : ""}`}>{status}</span>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-sm bg-surface2">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="num mt-1 flex justify-between text-2xs text-faint">
        <span>
          {fmtBnb(raised)} / {fmtBnb(target)} tBNB · {pct.toFixed(0)}%
        </span>
        {deadline !== undefined && <span>ends {new Date(Number(deadline) * 1000).toLocaleDateString()}</span>}
      </div>
      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs">
        <span className="text-faint">Launcher</span>
        <a className="num link truncate" href={addressUrl(l.launcher)} target="_blank" rel="noreferrer" title={l.launcher}>
          {short(l.launcher, 6)}
        </a>
        <span className="text-faint">Token</span>
        <a className="num link truncate" href={tokenUrl(token)} target="_blank" rel="noreferrer" title={token}>
          {short(token, 6)}
        </a>
        {l.tx && (
          <>
            <span className="text-faint">Tx</span>
            <a className="num link truncate" href={txUrl(l.tx)} target="_blank" rel="noreferrer">
              {short(l.tx, 6)}
            </a>
          </>
        )}
      </div>
      {fundMsg && <p className={`mt-2 text-2xs ${fundMsg.ok ? "text-good" : "text-bad"}`}>{fundMsg.text}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {open ? (
          <Link href={`/trade/${l.stock.toLowerCase()}-${pool!.slice(2, 8).toLowerCase()}`} className="btn-primary btn-sm w-full">
            Trade this market
          </Link>
        ) : (
          <button className="btn-primary btn-sm w-full" disabled={funding || failed === true || raised === undefined} onClick={fund}>
            {funding ? "Funding and opening (about a minute)…" : launched ? "Open the market" : "Fund and open the market"}
          </button>
        )}
        <a href={flapLauncherUrl(l.launcher)} target="_blank" rel="noreferrer" className="btn btn-sm w-full">
          View on Flap
        </a>
      </div>
    </div>
  );
}

/** Demo funding for the TSLA Market launch on Four.meme: a server-side testnet key buys the rest, which graduates it. */
function FundFour() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/launch/fund-four", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = (await res.json()) as { ok: boolean; error?: string; steps?: string[] };
      setMsg(j.ok ? { ok: true, text: j.steps?.length ? `Done: ${j.steps.join("; ")}.` : "Done." } : { ok: false, text: j.error ?? "Funding failed." });
    } catch {
      setMsg({ ok: false, text: "Funding failed. Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button className="btn-primary btn-sm" disabled={busy} onClick={run}>
        {busy ? "Funding and graduating…" : "Fund and open the TSLA market"}
      </button>
      {msg && <span className={msg.ok ? "text-good" : "text-bad"}>{msg.text}</span>}
    </span>
  );
}
