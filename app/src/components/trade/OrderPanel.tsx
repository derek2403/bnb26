"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatUnits, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { LeveragePoolAbi, StabilityPoolAbi, erc20Abi } from "@/abi";
import type { Executor } from "@/hooks/useExecutor";
import type { PoolDetail } from "@/hooks/usePools";
import { useTx } from "@/hooks/useTx";
import { fmtBps, fmtDuration, fmtLev, fmtNum, fmtPct, fmtUsd, MAX_UINT, nowSec, parseAmount } from "@/lib/format";
import * as sim from "@/lib/sim";
import type { ActionName, PoolMeta, PoolSnapshot, Quote } from "@/lib/types";
import { Seg } from "../ui";

export type OrderTab = "long" | "stable" | "close" | "earn";
export type CloseWhat = "redeemLever" | "redeemStable" | "redeemPair";

const SLIPPAGE = 0.005;

function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-xs">
      <span className="text-muted">{k}</span>
      <span className={`num text-right ${tone ?? "text-ink"}`}>{v}</span>
    </div>
  );
}

/** Pool leverage / CR after an action, from the local simulator on the current snapshot (display only). */
function after(snap: PoolSnapshot | null, action: ActionName, n: number, xMax?: number): { L?: number; CR?: number } {
  if (!snap || !(n > 0)) return {};
  try {
    const s = sim.fromSnapshot(snap);
    const r =
      action === "mintLever" ? sim.mintLever(s, n) : action === "mintStable" ? sim.mintStable(s, n) : action === "redeemLever" ? sim.redeemLever(s, n) : action === "redeemStable" ? sim.redeemStable(s, n) : sim.redeemPair(s, n, xMax ?? (s.S > 0 ? (n * s.X) / s.S : 0));
    const d = sim.derive(r.state);
    return { L: d.L, CR: d.CR };
  } catch {
    return {};
  }
}

export function OrderPanel({
  d,
  exec,
  tab,
  setTab,
  closeWhat,
  setCloseWhat,
}: {
  d: PoolDetail;
  exec: Executor;
  tab: OrderTab;
  setTab: (t: OrderTab) => void;
  closeWhat: CloseWhat;
  setCloseWhat: (c: CloseWhat) => void;
}) {
  const meta = d.meta!;
  const tabs: { value: OrderTab; label: string }[] = [
    { value: "long", label: "Long 2x" },
    { value: "stable", label: "Stable" },
    { value: "close", label: "Close" },
    { value: "earn", label: "Earn" },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-4 border-b border-line" role="tablist">
        {tabs.map((t) => {
          const active = tab === t.value;
          const tone = t.value === "long" ? "text-lever" : t.value === "stable" ? "text-stable" : "text-ink";
          return (
            <button key={t.value} role="tab" aria-selected={active} onClick={() => setTab(t.value)} className={`relative py-2.5 text-[13px] font-medium transition-colors ${active ? tone : "text-muted hover:text-ink"}`}>
              {t.label}
              {active && <span className={`absolute inset-x-0 bottom-0 h-0.5 ${t.value === "long" ? "bg-lever" : t.value === "stable" ? "bg-stable" : "bg-accent"}`} />}
            </button>
          );
        })}
      </div>
      <div className="flex-1 p-4">
        {tab === "earn" ? <EarnPanel d={d} /> : <TradeForm key={`${meta.id}:${tab}`} d={d} exec={exec} tab={tab} closeWhat={closeWhat} setCloseWhat={setCloseWhat} />}
      </div>
    </div>
  );
}

const EXPLAIN: Record<Exclude<OrderTab, "earn">, (m: PoolMeta) => string> = {
  long: (m) => `Long 2x: about 2× ${m.name} exposure as ${m.leverSymbol}. Nobody borrows, so it is never liquidated.`,
  stable: (m) => `Stable: sUSD is a dollar backed by the pool's ${m.symbol}. Each one claims $1 of pool value.`,
  close: (m) => `Close: turn ${m.leverSymbol} or sUSD back into ${m.assetSymbol} plus mUSDC at the live price.`,
};

function TradeForm({ d, exec, tab, closeWhat, setCloseWhat }: { d: PoolDetail; exec: Executor; tab: Exclude<OrderTab, "earn">; closeWhat: CloseWhat; setCloseWhat: (c: CloseWhat) => void }) {
  const meta = d.meta!;
  const snap = d.snap;
  const user = d.user;
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const action: ActionName = tab === "long" ? "mintLever" : tab === "stable" ? "mintStable" : closeWhat;
  const isMint = action === "mintLever" || action === "mintStable";
  const dec = exec.inputDecimals(action);
  const [input, setInput] = useState("");
  const [q, setQ] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const amount = parseAmount(input, dec);
  const n = amount !== undefined ? Number(formatUnits(amount, dec)) : 0;

  useEffect(() => setInput(""), [action]);

  const balance = useMemo(() => {
    if (!user) return undefined;
    if (isMint) return user.asset;
    if (action === "redeemLever") return user.x;
    return user.sUSD;
  }, [user, action, isMint]);
  const unit = isMint ? meta.assetSymbol : action === "redeemLever" ? meta.leverSymbol : "sUSD";

  useEffect(() => {
    let live = true;
    setQ(null);
    if (!amount || amount <= 0n) return;
    const t = setTimeout(async () => {
      const r = await exec.quote(action, amount);
      if (live) setQ(r);
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, input, exec.mode, snap?.snapshotId, snap?.price]);

  const needsWallet = exec.mode === "chain" && !isConnected;
  const insufficient = balance !== undefined && amount !== undefined && amount > balance;
  const needsApprove = !!amount && amount > 0n && exec.needsApproval(action, amount);
  const blocked = q?.error;
  const xMax = action === "redeemPair" && snap && snap.S > 0 && user ? Math.min(Number(formatUnits(user.x, 18)), (n * snap.X) / snap.S) : undefined;
  const proj = useMemo(() => after(snap, action, n, xMax), [snap, action, n, xMax]);

  const verb = action === "mintLever" ? `Open Long 2x` : action === "mintStable" ? "Mint sUSD" : action === "redeemLever" ? `Close ${meta.leverSymbol}` : action === "redeemStable" ? "Redeem sUSD" : "Redeem pair";
  const label = needsWallet
    ? "Connect wallet"
    : !snap
      ? "Loading market…"
      : !amount || amount <= 0n
        ? "Enter an amount"
        : insufficient
          ? `Not enough ${unit}`
          : blocked
            ? "Not available now"
            : needsApprove
              ? `Approve ${meta.assetSymbol}`
              : verb;
  const disabled = !needsWallet && (!snap || !amount || amount <= 0n || insufficient || !!blocked || busy || !!exec.pending);

  const submit = async () => {
    if (needsWallet) return openConnectModal?.();
    if (!amount) return;
    setBusy(true);
    try {
      if (needsApprove) {
        await exec.approve(amount);
        return;
      }
      const quote = q ?? (await exec.quote(action, amount));
      if (await exec.run(action, amount, quote, { permit: false })) setInput("");
    } finally {
      setBusy(false);
    }
  };

  const setPct = (p: number) => {
    if (balance === undefined) return;
    const v = p >= 1 ? balance : (balance * BigInt(Math.round(p * 100))) / 100n;
    setInput(formatUnits(v, dec));
  };

  const btn = tab === "long" ? "btn-lever" : tab === "stable" ? "btn-stable" : "btn-primary";
  const faucetLeft = user?.lastFaucetAt && user.faucetCooldown ? user.lastFaucetAt + user.faucetCooldown - nowSec() : 0;
  const noAsset = !!user && user.asset === 0n;
  const P = snap?.price ?? 0;
  const value = isMint ? n * P : action === "redeemLever" ? n * (snap?.xNav ?? 0) : n * Math.min(1, snap && Number.isFinite(snap.cr) ? snap.cr : 1);

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">{EXPLAIN[tab](meta)}</p>

      {tab === "close" && (
        <Seg
          className="w-full [&>button]:flex-1"
          value={closeWhat}
          onChange={setCloseWhat}
          items={[
            { value: "redeemLever", label: meta.leverSymbol },
            { value: "redeemStable", label: "sUSD" },
            { value: "redeemPair", label: "Pair" },
          ]}
        />
      )}

      {isMint && noAsset && (
        <div className="rounded border border-accent/40 bg-accent/5 p-3">
          <div className="text-xs font-medium text-ink">Step 1 · get the test stock</div>
          <div className="mt-0.5 text-xs text-muted">
            You only need {meta.assetSymbol}. {exec.mode === "simulation" ? "This simulated market credits it locally." : "It is free; the faucet sends it to your wallet."}
          </div>
          <button className="btn-accent btn-sm mt-2 w-full" onClick={() => (needsWallet ? openConnectModal?.() : exec.faucet())} disabled={faucetLeft > 0 || !!exec.pending}>
            {needsWallet ? "Connect wallet" : faucetLeft > 0 ? `Faucet again in ${fmtDuration(faucetLeft)}` : `Get test ${meta.assetSymbol}`}
          </button>
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted">{isMint ? "Deposit" : "Amount"}</span>
          <span className="num text-muted">
            Available <span className="text-ink">{balance !== undefined ? fmtNum(Number(formatUnits(balance, dec))) : "–"}</span> {unit}
          </span>
        </div>
        <div className="mt-1 flex items-center rounded border border-line bg-surface2 focus-within:border-accent">
          <input className="num w-full bg-transparent px-3 py-2.5 text-base text-ink outline-none placeholder:text-faint" inputMode="decimal" placeholder="0.00" value={input} onChange={(e) => setInput(e.target.value)} aria-label={`Amount in ${unit}`} />
          <span className="num shrink-0 pr-3 text-xs text-muted">{unit}</span>
        </div>
        <div className="mt-1.5 grid grid-cols-4 gap-1">
          {[0.25, 0.5, 0.75, 1].map((p) => (
            <button key={p} className="rounded border border-line py-1 text-2xs font-medium text-muted hover:bg-surface2 hover:text-ink disabled:opacity-40" disabled={!balance} onClick={() => setPct(p)}>
              {p === 1 ? "MAX" : `${p * 100}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded border border-line px-3 py-2">
        {blocked ? (
          <div className="text-xs text-bad">Not available: {blocked}</div>
        ) : (
          <>
            {isMint ? (
              <Row k="You receive" v={q ? `${fmtNum(q.out)} ${action === "mintLever" ? meta.leverSymbol : "sUSD"}` : "–"} tone={action === "mintLever" ? "text-lever" : "text-stable"} />
            ) : (
              <Row k="You receive" v={q ? `${fmtNum(q.cOut ?? 0)} ${meta.assetSymbol} + ${fmtNum(q.uOut ?? 0, 2)} mUSDC` : "–"} />
            )}
            <Row k="Value" v={q ? fmtUsd(isMint ? (action === "mintLever" ? q.out * (snap?.xNav ?? 0) : q.out) : q.out) : n > 0 ? `≈ ${fmtUsd(value)}` : "–"} />
            {action === "mintLever" && <Row k="Exposure" v={q && snap ? `≈ ${fmtUsd(q.out * snap.xNav * (proj.L ?? snap.leverage))} of ${meta.symbol}` : "–"} />}
            {action === "redeemPair" && q && <Row k="Burns" v={`${fmtNum(q.sBurned ?? 0)} sUSD + ${fmtNum(q.xBurned ?? 0)} ${meta.leverSymbol}`} />}
            <Row k="Fee" v={q ? fmtBps(q.feeBps) : fmtBps(isMint ? (action === "mintLever" ? snap?.leverMintFeeBps : snap?.stableMintFeeBps) : snap?.redeemFeeBps)} />
            {(action === "mintLever" || action === "redeemLever") && <Row k="Leverage after" v={snap ? `${fmtLev(snap.leverage)} → ${proj.L !== undefined ? fmtLev(proj.L) : "–"}` : "–"} tone="text-lever" />}
            {(action === "mintStable" || action === "redeemStable" || action === "redeemPair") && <Row k="sUSD backing after" v={snap ? `${Number.isFinite(snap.cr) ? fmtPct(snap.cr, 0) : "∞"} → ${proj.CR !== undefined ? (Number.isFinite(proj.CR) ? fmtPct(proj.CR, 0) : "∞") : "–"}` : "–"} tone="text-stable" />}
            <Row
              k="Min received"
              v={q ? (isMint ? `${fmtNum(q.out * (1 - SLIPPAGE))} ${action === "mintLever" ? meta.leverSymbol : "sUSD"}` : `${fmtNum((q.cOut ?? 0) * (1 - SLIPPAGE))} ${meta.assetSymbol} + ${fmtNum((q.uOut ?? 0) * (1 - SLIPPAGE), 2)} mUSDC`) : "–"}
            />
            <Row k="Slippage guard · deadline" v="0.5% · 20 min" tone="text-muted" />
          </>
        )}
      </div>

      <button className={`${btn} min-h-[40px] w-full`} disabled={disabled} onClick={submit}>
        {busy || exec.pending ? exec.pending ?? "Confirm in wallet…" : label}
      </button>
      {exec.mode === "chain" && isMint && amount && amount > 0n && !insufficient && !blocked && (
        <div className="flex items-center justify-center gap-2 text-2xs text-faint">
          <span className={needsApprove ? "text-ink" : ""}>1 Approve {meta.assetSymbol}</span>
          <span>→</span>
          <span className={!needsApprove ? "text-ink" : ""}>2 {verb}</span>
        </div>
      )}

      {snap && (snap.mintsPaused || snap.mode === "STABILITY" || snap.mode === "UNDERWATER") && (
        <p className="text-xs text-warn">
          {snap.mintsPaused ? "Minting is paused (price breaker or guardian). Closing always works." : snap.mode === "STABILITY" ? "Stability mode: sUSD minting is off and Long 2x is fee-free until backing recovers." : "Underwater: minting is off; sUSD redeems pro rata."}
        </p>
      )}

      <div className="border-t border-line pt-3 text-2xs leading-relaxed text-faint">
        {exec.mode === "simulation" ? (
          "Simulated market: balances and trades live in this browser only. NVDA is the live on-chain market."
        ) : (
          <>
            Wallet needs {meta.assetSymbol} (faucet{!noAsset && user ? <button className="ml-1 text-accent hover:underline disabled:opacity-50" onClick={() => exec.faucet()} disabled={faucetLeft > 0 || !!exec.pending}>{faucetLeft > 0 ? `in ${fmtDuration(faucetLeft)}` : "get more"}</button> : null}) and a little tBNB for gas. <GasHelp />
          </>
        )}
      </div>
    </div>
  );
}

function GasHelp() {
  const { address } = useAccount();
  const bal = useBalance({ address, chainId: bscTestnet.id, query: { enabled: !!address, refetchInterval: 30_000 } });
  const [open, setOpen] = useState(false);
  const [ch, setCh] = useState<{ question: string; token: string; enabled: boolean } | null>(null);
  const [answer, setAnswer] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const low = !!address && bal.data !== undefined && bal.data.value < 2_000_000_000_000_000n;
  const load = () =>
    fetch("/api/drip")
      .then((r) => r.json())
      .then(setCh)
      .catch(() => setCh(null));
  if (!address) return null;
  return (
    <span>
      {low && <span className="text-warn">Your tBNB is low. </span>}
      <button
        className="text-accent hover:underline"
        onClick={() => {
          setOpen((o) => !o);
          if (!ch) void load();
        }}
      >
        Get tBNB
      </button>
      {open && (
        <span className="mt-2 block">
          {ch?.enabled === false ? (
            <span>
              The drip is off here. Use the{" "}
              <a className="link" href="https://www.bnbchain.org/en/testnet-faucet" target="_blank" rel="noreferrer">
                BNB testnet faucet
              </a>
              .
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="num whitespace-nowrap text-ink">{ch?.question ?? "…"}</span>
              <input className="input h-7 py-0 text-xs" value={answer} onChange={(e) => setAnswer(e.target.value)} inputMode="numeric" placeholder="answer" />
              <button
                className="btn btn-sm"
                disabled={!answer || !ch}
                onClick={async () => {
                  setMsg("Sending…");
                  const r = await fetch("/api/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, answer, token: ch!.token }) });
                  const b = await r.json().catch(() => ({}));
                  setMsg(r.ok ? `Sent ${b.amount} tBNB.` : `Not sent: ${b.error ?? r.status}`);
                  setAnswer("");
                  void load();
                }}
              >
                Drip
              </button>
            </span>
          )}
          {msg && <span className="mt-1 block break-all">{msg}</span>}
        </span>
      )}
    </span>
  );
}

function EarnPanel({ d }: { d: PoolDetail }) {
  const meta = d.meta!;
  const s = d.snap;
  const { send, pending } = useTx();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amt, setAmt] = useState("");
  const sp = meta.addresses?.stabilityPool as Address | undefined;
  const params = useReadContract({ address: meta.addresses?.pool, abi: LeveragePoolAbi, functionName: "params", chainId: bscTestnet.id, query: { enabled: !!meta.addresses?.pool && !meta.isDemo, staleTime: 60_000 } });
  const fundingBps = params.data ? Number((params.data as { fundingRateBps: bigint }).fundingRateBps) : undefined;
  const apr = s && s.spDeposits && fundingBps !== undefined ? (fundingBps / 1e4) * (s.S / s.spDeposits) : undefined;
  const parsed = parseAmount(amt, 18);
  const wallet = d.user?.sUSD ?? 0n;
  const dep = d.spUser?.deposit ?? 0;
  const needApprove = mode === "deposit" && parsed !== undefined && (d.user?.sUSDAllowanceSP ?? 0n) < parsed;

  if (meta.isDemo || !sp) {
    return (
      <div className="space-y-2 text-xs text-muted">
        <p>Earn: deposit sUSD in the Stability Pool. It buys stock at a 1% discount when the pool deleverages and earns the funding rate.</p>
        <p className="text-faint">Available on the live NVDA and TSLA markets.</p>
      </div>
    );
  }
  const max = mode === "deposit" ? Number(formatUnits(wallet, 18)) : dep;
  const run = async () => {
    if (!isConnected) return openConnectModal?.();
    if (mode === "deposit") {
      if (!parsed || !meta.addresses?.sUSD) return;
      if (needApprove) {
        await send({ address: meta.addresses.sUSD, abi: erc20Abi, functionName: "approve", args: [sp, MAX_UINT], label: `Approve ${meta.stableSymbol}` });
        d.refetch();
        return;
      }
      const r = await send({ address: sp, abi: StabilityPoolAbi, functionName: "deposit", args: [parsed], label: "Deposit to Stability Pool" });
      if (r) setAmt("");
    } else {
      const r = await send({ address: sp, abi: StabilityPoolAbi, functionName: "withdraw", args: [parsed ?? MAX_UINT], label: "Withdraw from Stability Pool" });
      if (r) setAmt("");
    }
    d.refetch();
  };
  const gains = d.spUser && (d.spUser.assetGain > 0 || d.spUser.stableReward > 0);
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">Earn: deposit sUSD in the Stability Pool. It buys {meta.symbol} at a 1% discount when the pool deleverages and earns the funding rate. Withdraw any time.</p>
      <div className="grid grid-cols-3 gap-2 rounded border border-line px-3 py-2">
        <div>
          <div className="label">APR</div>
          <div className="num text-sm text-good">{apr !== undefined ? fmtPct(apr) : "–"}</div>
        </div>
        <div>
          <div className="label">Pool size</div>
          <div className="num text-sm text-ink">{s?.spDeposits !== undefined ? fmtUsd(s.spDeposits, { compact: true }) : "–"}</div>
        </div>
        <div>
          <div className="label">Yours</div>
          <div className="num text-sm text-stable">{fmtNum(dep, 2)}</div>
        </div>
      </div>
      <Seg className="w-full [&>button]:flex-1" value={mode} onChange={(m) => { setMode(m); setAmt(""); }} items={[{ value: "deposit", label: "Deposit" }, { value: "withdraw", label: "Withdraw" }]} />
      <div>
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted">Amount</span>
          <button className="num text-muted hover:text-ink" onClick={() => setAmt(mode === "deposit" ? formatUnits(wallet, 18) : String(dep))}>
            {mode === "deposit" ? "Wallet" : "Deposited"} <span className="text-ink">{fmtNum(max)}</span> sUSD · MAX
          </button>
        </div>
        <div className="mt-1 flex items-center rounded border border-line bg-surface2 focus-within:border-accent">
          <input className="num w-full bg-transparent px-3 py-2.5 text-base text-ink outline-none placeholder:text-faint" inputMode="decimal" placeholder={mode === "withdraw" ? "all" : "0.00"} value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="sUSD amount" />
          <span className="num shrink-0 pr-3 text-xs text-muted">sUSD</span>
        </div>
      </div>
      <button className="btn-stable min-h-[40px] w-full" disabled={isConnected && (!!pending || (mode === "deposit" && !parsed) || (mode === "withdraw" && dep <= 0))} onClick={run}>
        {pending ?? (!isConnected ? "Connect wallet" : mode === "deposit" ? (needApprove ? "Approve sUSD" : "Deposit sUSD") : parsed ? "Withdraw" : "Withdraw all")}
      </button>
      <div className="rounded border border-line px-3 py-2">
        <Row k={`${meta.assetSymbol} gains`} v={fmtNum(d.spUser?.assetGain ?? 0)} />
        <Row k="sUSD rewards" v={fmtNum(d.spUser?.stableReward ?? 0)} />
        <button className="btn btn-sm mt-2 w-full" disabled={!gains || !!pending} onClick={async () => { await send({ address: sp, abi: StabilityPoolAbi, functionName: "claimGains", label: "Claim gains" }); d.refetch(); }}>
          Claim gains
        </button>
      </div>
      {wallet === 0n && dep === 0 && <p className="text-2xs text-faint">No sUSD yet: mint some on the Stable tab first.</p>}
    </div>
  );
}
