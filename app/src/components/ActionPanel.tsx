"use client";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import type { Executor } from "@/hooks/useExecutor";
import { fmtBps, fmtNum, fmtUsd, nowSec, parseAmount, fmtDuration } from "@/lib/format";
import type { ActionName, PoolMeta, PoolSnapshot, Quote, UserBalances } from "@/lib/types";
import { Tabs } from "./ui";

// Demo order (docs/DEMO.md scene 3): mint xSTOCK first, then sUSD.
const actionsFor = (m: PoolMeta): { value: ActionName; label: string }[] => [
  { value: "mintLever", label: `Mint ${m.leverSymbol}` },
  { value: "mintStable", label: "Mint sUSD" },
  { value: "redeemStable", label: "Redeem sUSD" },
  { value: "redeemLever", label: `Redeem ${m.leverSymbol}` },
  { value: "redeemPair", label: "Pair" },
];

export function ActionPanel({ meta, snap, user, exec }: { meta: PoolMeta; snap: PoolSnapshot | null; user: UserBalances | null; exec: Executor }) {
  const [action, setAction] = useState<ActionName>("mintLever");
  const ACTIONS = useMemo(() => actionsFor(meta), [meta]);
  const [input, setInput] = useState("");
  const [permit, setPermit] = useState(false);
  const [q, setQ] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const dec = exec.inputDecimals(action);
  const amount = parseAmount(input, dec);

  const balance = useMemo(() => {
    if (!user) return undefined;
    if (action === "mintStable" || action === "mintLever") return user.asset;
    if (action === "redeemLever") return user.x;
    return user.sUSD;
  }, [user, action]);
  const unit = action === "mintStable" || action === "mintLever" ? meta.assetSymbol : action === "redeemLever" ? meta.leverSymbol : meta.stableSymbol;
  const outUnit = action === "mintStable" ? meta.stableSymbol : action === "mintLever" ? meta.leverSymbol : "value";

  useEffect(() => {
    let live = true;
    setQ(null);
    if (!amount || amount <= 0n) return;
    const t = setTimeout(async () => {
      const r = await exec.quote(action, amount);
      if (live) setQ(r);
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, input, exec.mode, snap?.snapshotId, snap?.price]);

  const insufficient = balance !== undefined && amount !== undefined && amount > balance;
  const needsApprove = amount !== undefined && !permit && exec.needsApproval(action, amount);
  const disabledReason = !snap
    ? "Loading pool…"
    : exec.mode === "chain" && !user
      ? "Connect a wallet"
      : !amount || amount <= 0n
        ? "Enter an amount"
        : insufficient
          ? `Not enough ${unit}`
          : q?.error
            ? "Blocked (see above)"
            : null;

  const submit = async () => {
    if (!amount) return;
    setBusy(true);
    try {
      if (needsApprove) {
        await exec.approve(amount);
        return;
      }
      const quote = q ?? (await exec.quote(action, amount));
      const ok = await exec.run(action, amount, quote, { permit });
      if (ok) setInput("");
    } finally {
      setBusy(false);
    }
  };

  const faucetLeft = user?.lastFaucetAt && user.faucetCooldown ? user.lastFaucetAt + user.faucetCooldown - nowSec() : 0;
  const isMint = action === "mintStable" || action === "mintLever";
  const tone = action === "mintStable" || action === "redeemStable" ? "btn-stable" : action === "redeemPair" ? "btn-primary" : "btn-lever";

  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="card-title">Trade</h2>
        {exec.mode === "simulation" && <span className="pill">local simulation</span>}
      </div>
      {exec.mode === "chain" && user && user.asset === 0n && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-stable/30 bg-stable-soft/40 px-3 py-2 text-xs">
          <span className="text-ink">You hold no {meta.assetSymbol} yet.</span>
          <button className="btn-stable btn-sm" onClick={() => exec.faucet()} disabled={faucetLeft > 0 || !!exec.pending}>
            {faucetLeft > 0 ? `Faucet in ${fmtDuration(faucetLeft)}` : `Get test ${meta.assetSymbol}`}
          </button>
        </div>
      )}
      <Tabs value={action} onChange={(v) => { setAction(v); setInput(""); }} items={ACTIONS} />

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-xs text-muted">
          <span>Amount ({unit})</span>
          {balance !== undefined && (
            <button className="num hover:text-ink" onClick={() => setInput(formatUnits(balance, dec))}>
              Balance {fmtNum(Number(formatUnits(balance, dec)))} · Max
            </button>
          )}
        </div>
        <input className="input mt-1" inputMode="decimal" placeholder="0.0" value={input} onChange={(e) => setInput(e.target.value)} />
      </div>

      <div className="mt-3 space-y-1 rounded-lg bg-surface2 px-3 py-2 text-xs">
        {q && !q.error ? (
          <>
            {isMint ? (
              <div className="flex justify-between">
                <span className="text-muted">You receive</span>
                <span className="num text-ink">
                  ≈ {fmtNum(q.out)} {outUnit}
                </span>
              </div>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted">You receive</span>
                  <span className="num text-ink">
                    {fmtNum(q.cOut ?? 0)} {meta.assetSymbol} + {fmtNum(q.uOut ?? 0)} mUSDC
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Value</span>
                  <span className="num text-ink">≈ {fmtUsd(q.out)}</span>
                </div>
                {action === "redeemPair" && (
                  <div className="flex justify-between">
                    <span className="text-muted">Burns</span>
                    <span className="num text-ink">
                      {fmtNum(q.sBurned ?? 0)} sUSD + {fmtNum(q.xBurned ?? 0)} x
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between">
              <span className="text-muted">Fee</span>
              <span className="num text-ink">{fmtBps(q.feeBps)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Slippage guard</span>
              <span className="num text-ink">0.5%</span>
            </div>
          </>
        ) : q?.error ? (
          <div className="text-bad">Blocked: {q.error}</div>
        ) : (
          <div className="text-faint">
            Fee now: mint sUSD {fmtBps(snap?.stableMintFeeBps)} · mint x {fmtBps(snap?.leverMintFeeBps)} · redeem {fmtBps(snap?.redeemFeeBps)}
          </div>
        )}
      </div>

      {isMint && exec.supportsPermit && (
        <label className="mt-3 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={permit} onChange={(e) => setPermit(e.target.checked)} />
          Use EIP-2612 permit (one transaction, no separate approve)
        </label>
      )}

      <button className={`${tone} mt-4 w-full`} disabled={!!disabledReason || busy || !!exec.pending} onClick={submit}>
        {busy || exec.pending ? exec.pending ?? "Working…" : disabledReason ?? (needsApprove ? `Approve ${meta.assetSymbol}` : ACTIONS.find((a) => a.value === action)!.label)}
      </button>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-xs text-muted">Need test {meta.assetSymbol}?</span>
        <button className="btn btn-sm" onClick={() => exec.faucet()} disabled={faucetLeft > 0}>
          {faucetLeft > 0 ? `Faucet in ${fmtDuration(faucetLeft)}` : `Faucet ${meta.assetSymbol}`}
        </button>
      </div>
      {action === "redeemPair" && (
        <p className="mt-2 text-[11px] text-faint">Pair redeem burns sUSD and x in the pool&apos;s current ratio for a pro-rata share of reserves. No oracle, never paused.</p>
      )}
      {snap && (snap.mintsPaused || snap.mode === "STABILITY" || snap.mode === "UNDERWATER") && (
        <p className="mt-2 text-[11px] text-warn">
          {snap.mintsPaused ? "Mints are paused (breaker, halt or Guardian). Redeems keep working." : snap.mode === "STABILITY" ? "Stability mode: sUSD mints are off, x mint fee is 0." : "Underwater: mints are off, sUSD redeems pro rata."}
        </p>
      )}
    </section>
  );
}
