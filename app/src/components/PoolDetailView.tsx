"use client";
import Link from "next/link";
import { useDemoExecutor, useRealExecutor } from "@/hooks/useExecutor";
import { useAtlasPull } from "@/hooks/useAtlasPull";
import { EXPECTED_REAL, useNow, usePool } from "@/hooks/usePools";
import { fmtBps, fmtLev, fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { nyseStatus } from "@/lib/nyse";
import type { PoolMeta } from "@/lib/types";
import { ActionPanel } from "./ActionPanel";
import { Addr, Card, CrGauge, Empty, KV, LaunchpadBadge, LeverageGauge, MarketPill, ModePill, PriceChip, SplitBar, Stat, marketFeeBps } from "./ui";
import { STOCK_NAMES } from "@/config/demoPools";

function NotOpenYet({ id, searching }: { id: string; searching: boolean }) {
  const e = EXPECTED_REAL.find((x) => x.id === id)!;
  const flap = e.kind === "flap";
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Link href="/pools" className="hover:text-ink">Pools</Link> <span>/</span> <span>{e.symbol}</span>
      </div>
      <div className="card flex flex-col items-start gap-3 border-dashed sm:flex-row sm:items-center">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {STOCK_NAMES[e.symbol]} <span className="text-muted">· {e.symbol} pool</span>
            </h1>
            <span className="pill border-warn/40 text-warn">{searching ? "Looking on-chain…" : "Launching soon"}</span>
            <LaunchpadBadge label={flap ? "Flap" : "Four.meme"} short />
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            {flap
              ? "This pool opens when the SPLIT crowdfund on Flap fills: the 7777 token launches, and Open pool turns the raise into the pool's first-loss xNVDA."
              : "This pool opens when a meme raised in tTSLA sells out on our Four.meme (OpenFour) launchpad: graduation creates the TSLA pool and pairs the meme with sUSD."}
          </p>
        </div>
        <Link href={e.href} className="btn-primary shrink-0">
          {flap ? "Go to the Flap launch →" : "Go to the memes →"}
        </Link>
      </div>
    </div>
  );
}

export function PoolDetailView({ id, override, hideTrade = false }: { id: string; override?: PoolMeta; hideTrade?: boolean }) {
  const d = usePool(id, override);
  const real = useRealExecutor(d);
  const demo = useDemoExecutor(d);
  const pull = useAtlasPull(d.meta?.pullFeed);
  const now = useNow(1000);

  if (!d.meta) {
    if (EXPECTED_REAL.some((x) => x.id === id)) return <NotOpenYet id={id} searching={d.discovering} />;
    return <Empty>Unknown pool “{id}”. <Link className="link" href="/pools">Back to pools</Link></Empty>;
  }
  const m = d.meta;
  const s = d.snap;
  const exec = m.isDemo ? demo : real;
  const cal = s?.nextOpen || s?.nextClose ? { nextOpen: s.nextOpen, nextClose: s.nextClose } : nyseStatus(now);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <Link href="/pools" className="hover:text-ink">Pools</Link> <span>/</span> <span>{m.symbol}</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            {m.name} <span className="text-muted">· {m.symbol} pool</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {m.source === "flap" || m.source === "four" || m.isDemo ? (
              m.source === "flap" ? (
                <Link href="/launch"><LaunchpadBadge label={m.launchpad} /></Link>
              ) : m.source === "four" ? (
                <Link href="/memes"><LaunchpadBadge label={m.launchpad} /></Link>
              ) : (
                <LaunchpadBadge label={m.launchpad} />
              )
            ) : (
              <span className="pill">{m.launchpad}</span>
            )}
            {s && <PriceChip snap={s} pull={pull.data ? { price: pull.data.price, ts: pull.data.ts } : null} source={m.source === "sandbox" || m.source === "scenario" ? "Scenario feed" : m.isDemo ? "CMC" : "Atlas"} />}
            {s && <MarketPill open={s.marketOpen} gapGuard={s.gapGuard} nextOpen={cal.nextOpen} nextClose={cal.nextClose} now={now} feeBps={marketFeeBps(s)} />}
            {s && <ModePill mode={s.mode} />}
            {s && <span className="pill" title="Where the risk limits come from: RULE = CMC snapshot, AGENT = AI steward (tighter only), FALLBACK = defaults">limits {s.riskSource}{s.snapshotId ? ` · CMC #${s.snapshotId}` : ""}</span>}
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            {s ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
                <Stat label="Pool value V" value={fmtUsd(s.V, { compact: true })} sub={`${fmtNum(s.C)} ${m.assetSymbol} + ${fmtUsd(s.U, { compact: true })}`} />
                <Stat label={`${m.stableSymbol} supply`} value={fmtUsd(s.S, { compact: true })} tone="stable" sub="$1 claim each" />
                <Stat label="xSTOCK equity E" value={fmtUsd(s.E, { compact: true })} tone="lever" sub={`${fmtNum(s.X)} ${m.leverSymbol}`} />
                <Stat label={`${m.leverSymbol} NAV`} value={fmtUsd(s.xNav, { digits: 4 })} tone="lever" />
                <Stat label="Leverage L" value={fmtLev(s.leverage)} tone="lever" />
                <Stat label="Collateral ratio" value={Number.isFinite(s.cr) ? fmtPct(s.cr, 0) : "∞"} tone="stable" />
              </div>
            ) : (
              <div className="py-6 text-center text-sm text-muted">{d.loading ? "Reading pool.state()…" : "Pool state unavailable (RPC or deployment)."}</div>
            )}
          </Card>

          {s && (
            <div className="grid gap-5 md:grid-cols-2">
              <Card>
                <LeverageGauge snap={s} />
                <div className="mt-5">
                  <CrGauge snap={s} />
                </div>
              </Card>
              <Card title="Who owns the pool">
                <SplitBar snap={s} />
                <div className="mt-4 grid grid-cols-2 gap-x-6 text-sm">
                  <KV k="Stock held C·P" v={fmtUsd(s.C * s.price, { compact: true })} />
                  <KV k="mUSDC held U" v={fmtUsd(s.U, { compact: true })} />
                  <KV k="Stability Pool" v={s.spDeposits !== undefined ? fmtUsd(s.spDeposits, { compact: true }) : "–"} />
                  <KV k="Backstop buffer" v={s.backstopUsd !== undefined ? fmtUsd(s.backstopUsd, { compact: true }) : "–"} />
                </div>
                <p className="mt-3 text-xs text-muted">
                  Loss order: sell/buy zones → Stability Pool → {m.source === "four" ? "BackstopTreasury" : "BackstopVault"} → pro-rata haircut on sUSD.
                </p>
              </Card>
            </div>
          )}

          {s && (
            <div className="grid gap-5 md:grid-cols-2">
              <Card title="Risk parameters (effective)">
                <KV k="Sell-zone trigger" v={fmtLev(s.triggerLev)} />
                <KV k="Target leverage" v={fmtLev(s.targetLev)} />
                <KV k="Buy-zone trigger" v={fmtLev(s.lowerTriggerLev)} />
                <KV k="Mint sUSD cap" v={fmtLev(s.maxMintLev)} />
                <KV k="Gap guard" v={s.gapGuard ? "active" : "off"} />
                <KV k="Source" v={`${s.riskSource}${s.snapshotId ? ` · snapshot #${s.snapshotId}` : ""}`} />
              </Card>
              <Card title="Fees now">
                <KV k={`Mint ${m.stableSymbol}`} v={fmtBps(s.stableMintFeeBps)} />
                <KV k={`Mint ${m.leverSymbol}`} v={fmtBps(s.leverMintFeeBps)} />
                <KV k="Redeem (sUSD, x, pair)" v={fmtBps(s.redeemFeeBps)} />
                <KV k="Redeem x in stability mode" v={fmtBps(s.stabilityRedeemFeeBps)} />
                <p className="mt-2 text-xs text-muted">Mint fees move with leverage and with NYSE hours (closed-market fee from the RiskOracle).</p>
              </Card>
            </div>
          )}

          {!m.isDemo && m.addresses && (
            <Card title="Contracts (BSC testnet)">
              <div className="grid gap-x-6 sm:grid-cols-2">
                <KV k="LeveragePool" v={<Addr a={m.addresses.pool} />} />
                <KV k={m.stableSymbol} v={<Addr a={m.addresses.sUSD} />} />
                <KV k={m.leverSymbol} v={<Addr a={m.addresses.xToken} />} />
                <KV k="StabilityPool" v={<Addr a={m.addresses.stabilityPool} />} />
                <KV k={m.assetSymbol} v={<Addr a={m.addresses.asset} />} />
                <KV k="Price feed" v={<Addr a={m.addresses.feed} />} />
                {m.addresses.openedBy && <KV k="Opened by" v={<Addr a={m.addresses.openedBy} />} />}
              </div>
            </Card>
          )}
        </div>

        {!hideTrade && (
          <div className="space-y-5">
            <ActionPanel meta={m} snap={s} user={d.user} exec={exec} />
            {d.user && (
              <Card title="Your balances">
                <KV k={m.assetSymbol} v={fmtNum(Number(d.user.asset) / 10 ** d.decimals.asset)} />
                <KV k={<span className="text-stable">{m.stableSymbol}</span>} v={fmtNum(Number(d.user.sUSD) / 1e18)} />
                <KV k={<span className="text-lever">{m.leverSymbol}</span>} v={fmtNum(Number(d.user.x) / 1e18)} />
                <KV k="mUSDC" v={fmtNum(Number(d.user.usdc) / 10 ** d.decimals.usdc)} />
                {s && (
                  <KV k="Position value" v={fmtUsd((Number(d.user.sUSD) / 1e18) * Math.min(1, Number.isFinite(s.cr) ? s.cr : 1) + (Number(d.user.x) / 1e18) * s.xNav)} />
                )}
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
