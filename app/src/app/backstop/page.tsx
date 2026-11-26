"use client";
import { useState } from "react";
import { bscTestnet } from "viem/chains";
import { formatUnits, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { BackstopTreasuryAbi, BackstopVaultAbi, LeveragePoolAbi, StabilityPoolAbi, erc20Abi } from "@/abi";
import { addr, deployments97, launcherForPool } from "@/config/deployments";
import { useRealMetas, usePool } from "@/hooks/usePools";
import { useTx } from "@/hooks/useTx";
import { fmtNum, fmtPct, fmtUsd, MAX_UINT, parseAmount } from "@/lib/format";
import type { PoolMeta } from "@/lib/types";
import { Addr, Card, Empty, KV, NavLinkCard, PageHeader, Stat, Tabs } from "@/components/ui";

export default function BackstopPage() {
  const { real } = useRealMetas();
  const [picked, setId] = useState("");
  const id = picked || real[0]?.id || "";
  const meta = real.find((r) => r.id === id);
  return (
    <>
      <PageHeader
        title="Backstop"
        lede="Losses are absorbed in a fixed order: sell and buy zones, then the Stability Pool, then the launch-funded backstop (BackstopVault for Flap, BackstopTreasury for OpenFour), then a pro-rata haircut on sUSD."
        right={real.length > 1 ? <Tabs value={id} onChange={setId} items={real.map((r) => ({ value: r.id, label: `${r.symbol} · ${r.launchpad}` }))} /> : undefined}
      />
      <Waterfall />
      {meta ? (
        <BackstopFor meta={meta} />
      ) : (
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <NavLinkCard href="/launch" title="Flap crowdfund" body="The SPLIT raise seeds the NVDA pool's BackstopVault; half of all trading tax keeps funding it." tone="lever" />
          <NavLinkCard href="/memes" title="Four.meme graduation" body="Preset fees route through the FeeRouter into the BackstopTreasury of the TSLA pool." tone="stable" />
        </div>
      )}
    </>
  );
}

function Waterfall() {
  const steps = [
    ["1", "Sell / buy zone", "rebalance() swaps stock and mUSDC on PancakeSwap to pull leverage back to target."],
    ["2", "Stability Pool", "sUSD depositors buy stock at a 1% discount when the market is closed or a swap would slip. They earn the funding rate."],
    ["3", "Launch backstop", "cover(pool) while CR < 1: swaps launch-tax BNB (Flap) or preset fees (OpenFour) to mUSDC and donates it, capped at the deficit."],
    ["4", "Pro-rata", "If V ≤ S after all of that, sUSD redeems pro rata. xSTOCK has absorbed every loss before this point."],
  ];
  return (
    <div className="grid gap-3 md:grid-cols-4">
      {steps.map(([n, t, b]) => (
        <div key={n} className="card relative">
          <div className="num text-xs text-faint">step {n}</div>
          <div className="mt-1 text-sm font-semibold text-ink">{t}</div>
          <div className="mt-1 text-xs text-muted">{b}</div>
        </div>
      ))}
    </div>
  );
}

function BackstopFor({ meta }: { meta: PoolMeta }) {
  const d = usePool(meta.id);
  const { send, pending } = useTx();
  const a = meta.addresses!;
  const vault = meta.source === "flap" ? addr(launcherForPool(meta.id)?.vault) : undefined;
  const treasury = meta.source === "four" ? addr(deployments97.openfour.backstopTreasury) : undefined;
  const [amt, setAmt] = useState("");
  const dummy = { address: a.pool, abi: LeveragePoolAbi, functionName: "factory" } as const;
  const reads = useReadContracts({
    allowFailure: true,
    query: { refetchInterval: 10_000 },
    contracts: [
      { address: a.pool, abi: LeveragePoolAbi, functionName: "params", chainId: bscTestnet.id },
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "bufferBnb", chainId: bscTestnet.id } : dummy,
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "totalDefendedUsd", chainId: bscTestnet.id } : dummy,
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "canCover", args: [a.pool], chainId: bscTestnet.id } : dummy,
      vault ? { address: vault, abi: BackstopVaultAbi, functionName: "xHeld", chainId: bscTestnet.id } : dummy,
      treasury ? { address: treasury, abi: BackstopTreasuryAbi, functionName: "totalDefendedUsd", chainId: bscTestnet.id } : dummy,
      treasury ? { address: treasury, abi: BackstopTreasuryAbi, functionName: "canCover", args: [a.pool], chainId: bscTestnet.id } : dummy,
      treasury ? { address: treasury, abi: BackstopTreasuryAbi, functionName: "xHeld", args: [a.pool], chainId: bscTestnet.id } : dummy,
    ],
  });
  const r = reads.data;
  const get = <T,>(i: number) => (r?.[i]?.status === "success" ? (r[i].result as T) : undefined);
  const params = get<{ fundingRateBps: bigint }>(0);
  const s = d.snap;
  const apr = s && s.spDeposits && params ? (Number(params.fundingRateBps) / 1e4) * (s.S / s.spDeposits) : undefined;
  const canCover = vault ? get<boolean>(3) : get<boolean>(6);
  const defended = vault ? get<bigint>(2) : get<bigint>(5);
  const xHeld = vault ? get<bigint>(4) : get<bigint>(7);
  const sp = a.stabilityPool as Address | undefined;
  const parsed = parseAmount(amt, 18);
  const needApprove = parsed !== undefined && (d.user?.sUSDAllowanceSP ?? 0n) < parsed;

  if (!s) return <div className="mt-5"><Empty>Reading {meta.symbol} pool…</Empty></div>;
  return (
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <Card title={`Stability Pool · ${meta.stableSymbol}`} right={<Addr a={sp} />}>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Deposits" value={fmtUsd(s.spDeposits ?? 0, { compact: true })} tone="stable" />
          <Stat label="Share of sUSD" value={s.S > 0 && s.spDeposits !== undefined ? fmtPct(s.spDeposits / s.S) : "–"} />
          <Stat label="Funding APR" value={apr !== undefined ? fmtPct(apr) : "–"} sub="paid in sUSD" tone="good" />
        </div>
        {d.spUser && (
          <div className="mt-4 rounded-lg bg-surface2 px-3 py-2">
            <KV k="Your deposit" v={`${fmtNum(d.spUser.deposit)} sUSD`} />
            <KV k="Stock gains" v={`${fmtNum(d.spUser.assetGain)} ${meta.assetSymbol}`} />
            <KV k="sUSD rewards" v={fmtNum(d.spUser.stableReward)} />
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <input className="input" placeholder="sUSD amount" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
          <button className="btn btn-sm whitespace-nowrap" onClick={() => d.user && setAmt(formatUnits(d.user.sUSD, 18))}>Max</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="btn-stable btn-sm"
            disabled={!sp || !parsed || !!pending}
            onClick={async () => {
              if (!sp || !parsed || !a.sUSD) return;
              if (needApprove) await send({ address: a.sUSD, abi: erc20Abi, functionName: "approve", args: [sp, MAX_UINT], label: `Approve ${meta.stableSymbol}` });
              await send({ address: sp, abi: StabilityPoolAbi, functionName: "deposit", args: [parsed], label: "Deposit to Stability Pool" });
              d.refetch();
            }}
          >
            {needApprove ? "Approve + deposit" : "Deposit"}
          </button>
          <button className="btn btn-sm" disabled={!sp || !!pending} onClick={async () => { await send({ address: sp!, abi: StabilityPoolAbi, functionName: "withdraw", args: [parsed ?? MAX_UINT], label: "Withdraw from Stability Pool" }); d.refetch(); }}>
            {parsed ? "Withdraw" : "Withdraw all"}
          </button>
          <button className="btn btn-sm" disabled={!sp || !!pending} onClick={async () => { await send({ address: sp!, abi: StabilityPoolAbi, functionName: "claimGains", label: "Claim gains" }); d.refetch(); }}>
            Claim gains
          </button>
        </div>
        <p className="mt-2 text-[11px] text-faint">Withdrawals are never blocked. Deposits shrink only when they absorb a sell at a discount, and you receive the stock in exchange.</p>
      </Card>

      <Card title={vault ? "BackstopVault (Flap launch tax)" : "BackstopTreasury (OpenFour preset fees)"} right={<Addr a={vault ?? treasury} />}>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Buffer" value={s.backstopUsd !== undefined ? fmtUsd(s.backstopUsd, { compact: true }) : "–"} sub={vault && get<bigint>(1) !== undefined ? `${fmtNum(Number(get<bigint>(1)) / 1e18)} tBNB @ Atlas BNB/USD` : undefined} />
          <Stat label="Coverage of sUSD" value={s.backstopUsd !== undefined && s.S > 0 ? fmtPct(s.backstopUsd / s.S, 2) : "–"} />
          <Stat label="Total defended" value={defended !== undefined ? fmtUsd(Number(defended) / 1e18, { compact: true }) : "–"} />
        </div>
        <KV k={`First-loss ${meta.leverSymbol} locked`} v={xHeld !== undefined ? fmtNum(Number(xHeld) / 1e18) : "–"} />
        <KV k="Pool CR now" v={Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞"} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn-lever btn-sm"
            disabled={!canCover || !!pending}
            title={canCover ? "Permissionless: anyone can run it while CR < 1" : "Only callable while the pool's CR is below 1"}
            onClick={() => send({ address: (vault ?? treasury)!, abi: vault ? BackstopVaultAbi : BackstopTreasuryAbi, functionName: "cover", args: [a.pool], label: "cover()" }).then(() => d.refetch())}
          >
            cover({meta.symbol} pool)
          </button>
          {treasury && (
            <button className="btn btn-sm" disabled={!!pending} onClick={() => send({ address: treasury, abi: BackstopTreasuryAbi, functionName: "sweep", label: "Sweep preset fees" })}>
              sweep() fees
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-faint">{canCover ? "cover() can run now." : "cover() is idle: the pool is solvent (CR ≥ 100%)."} Spend is capped at the deficit S − V and per epoch.</p>
      </Card>
    </div>
  );
}
