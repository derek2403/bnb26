"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { bscTestnet } from "viem/chains";
import { useReadContracts } from "wagmi";
import { OpenFourCoreAbi, OpenFourVaultAbi } from "@/abi";
import { OF, PHASES, PHASE_MIGRATED, useOfTokens } from "@/hooks/useOpenFour";
import { usePoolList } from "@/hooks/usePools";
import { fmtLev, fmtNum, fmtUsd, short } from "@/lib/format";
import { Empty, SourceBadge } from "../ui";
import { LaunchMarketForm } from "./LaunchMarketForm";
import { MemeDetail } from "./MemeDetail";

// The NVDA launch token on Flap's testnet site.
const FLAP_NVDA_URL = "https://test.utter.cash/bnb-testnet/0xfc500e99b8befc3c637503469153dfe928977777";

function MoreBadge() {
  return (
    <span className="inline-flex h-7 w-[72px] items-center justify-center rounded border border-line bg-surface" title="Listed on MORE">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logos/more.png" alt="MORE" className="h-[11px] w-auto dark:invert" />
    </span>
  );
}

type TokenInfo = { name: string; symbol: string; vault: Address; raiseAmount: bigint; exists: boolean; quoteAsset: Address };

export function LaunchpadView() {
  const list = useOfTokens();
  const tokens = list.data ?? [];
  const { rows, pending } = usePoolList();
  const nvda = rows.find((r) => r.meta.source === "flap" && r.meta.symbol === "NVDA");
  const tsla = rows.find((r) => r.meta.source === "four" && r.meta.symbol === "TSLA");
  const tslaPending = pending.some((p) => p.symbol === "TSLA");
  // Display-only example of a market that is listed on all three places (no launch exists for it on-chain).
  const aapl = rows.find((r) => r.meta.symbol === "AAPL");
  // Until the Four.meme launch graduates, "Trade TSLA" opens the TSLA market from the list (demo pool state).
  const tslaAny = tsla ?? rows.find((r) => r.meta.symbol === "TSLA");

  const infos = useReadContracts({
    allowFailure: true,
    query: { enabled: !!OF.core && tokens.length > 0, refetchInterval: 15_000 },
    contracts: tokens.map((t) => ({ address: OF.core!, abi: OpenFourCoreAbi, functionName: "tokens" as const, args: [t.token] as const, chainId: bscTestnet.id })),
  });
  const decoded = (infos.data ?? []).map((r) => {
    if (r.status !== "success") return undefined;
    const v = r.result as unknown as readonly unknown[];
    return { name: v[4], symbol: v[5], raiseAmount: v[8], quoteAsset: v[9], vault: v[10], exists: v[17] } as TokenInfo;
  });
  const vaults = useReadContracts({
    allowFailure: true,
    query: { enabled: decoded.some((d) => d?.exists), refetchInterval: 15_000 },
    contracts: decoded.flatMap((d) =>
      d?.exists
        ? [
            { address: d.vault, abi: OpenFourVaultAbi, functionName: "totalRaised" as const, chainId: bscTestnet.id },
            { address: d.vault, abi: OpenFourVaultAbi, functionName: "phase" as const, chainId: bscTestnet.id },
          ]
        : [],
    ),
  });
  let vi = 0;
  const items = tokens
    .map((t, i) => {
      const d = decoded[i];
      let raised: bigint | undefined;
      let phase: number | undefined;
      if (d?.exists) {
        const a = vaults.data?.[vi++];
        const b = vaults.data?.[vi++];
        raised = a?.status === "success" ? (a.result as bigint) : undefined;
        phase = b?.status === "success" ? Number(b.result) : undefined;
      }
      const quoteOk = !d || !OF.quoteAsset || !d.quoteAsset || d.quoteAsset.toLowerCase() === OF.quoteAsset.toLowerCase();
      const pct = raised !== undefined && d?.raiseAmount ? Math.min(100, Number((raised * 10000n) / (d.raiseAmount || 1n)) / 100) : undefined;
      return { token: t.token, name: d?.name ?? t.name ?? short(t.token), symbol: d?.symbol ?? t.symbol ?? "", raised, raise: d?.raiseAmount, phase, pct, ok: quoteOk && d?.exists !== false };
    })
    .filter((x) => x.ok);

  const [sel, setSel] = useState<Address | null>(null);
  // The Four.meme launch panel opens as a pop-up from the TSLA market card.
  const [showFour, setShowFour] = useState(false);
  const fourRef = useRef<HTMLDivElement>(null);
  // Display-only example of an AAPL launch on Four.meme (opens from the AAPL card).
  const [showAapl, setShowAapl] = useState(false);
  const aaplRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = () => setShowFour(true);
    window.addEventListener("more:show-four", open);
    if (window.location.hash === "#four-launches") setShowFour(true);
    return () => {
      window.removeEventListener("more:show-four", open);
    };
  }, []);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("token");
      if (q && /^0x[0-9a-fA-F]{40}$/.test(q)) {
        setSel(q as Address);
        setShowFour(true);
      }
    } catch {
      /* ignore */
    }
  }, []);
  const active = (sel && items.find((i) => i.token.toLowerCase() === sel.toLowerCase())?.token) ?? items.find((i) => i.phase !== PHASE_MIGRATED)?.token ?? items[0]?.token;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-16 pt-5">
      <h1 className="text-lg font-semibold tracking-tight text-ink">Launch a market</h1>
      <p className="mt-0.5 max-w-3xl text-[13px] text-muted">New stock markets on MORE are opened by community launches on Flap or Four.meme. The raise becomes the new market&apos;s first-loss xSTOCK, and the launch&apos;s fees keep funding that market&apos;s insurance vault.</p>

      <LaunchMarketForm />

      <div className="mt-6 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-ink">My markets</h2>
        <span className="text-xs text-faint">Press a market to see its launch</span>
      </div>
      <section className="mt-2 grid gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-2">
        <div className="bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">NVDA market</span>
            <span className="flex items-center gap-1.5">
              <SourceBadge label="Flap" iconOnly />
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">A launch on Flap opened the NVDA pool: its raise seeded the first-loss xNVDA, and the launch keeps funding the pool&apos;s insurance vault.</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="num text-xs text-muted">{nvda?.snap ? `${fmtUsd(nvda.snap.price, { digits: 2 })} · ${fmtLev(nvda.snap.leverage)} · TVL ${fmtUsd(nvda.snap.V, { compact: true })}` : nvda ? "…" : "not open"}</span>
            <span className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
              <a href={FLAP_NVDA_URL} target="_blank" rel="noreferrer" className="btn btn-sm">
                View on Flap
              </a>
            </span>
          </div>
        </div>
        <div className="cursor-pointer bg-surface p-4 transition-colors hover:bg-surface2" role="button" tabIndex={0} onClick={() => setShowFour((v) => !v)} onKeyDown={(e) => e.key === "Enter" && setShowFour((v) => !v)} aria-expanded={showFour}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">TSLA market</span>
            <span className="flex items-center gap-1.5">
              <SourceBadge label="Four.meme" iconOnly />
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">The TSLA Market launch raises tTSLA on Four.meme (our OpenFour preset). When it sells out, graduation opens the TSLA market: half the raise seeds first-loss xTSLA, half mints sUSD, and the launch token trades against a dollar.</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className={`text-xs text-muted ${tsla?.snap ? "num" : ""}`}>{tsla?.snap ? `${fmtUsd(tsla.snap.price, { digits: 2 })} · ${fmtLev(tsla.snap.leverage)} · TVL ${fmtUsd(tsla.snap.V, { compact: true })}` : tslaPending ? "Opens when the launch below graduates" : "…"}</span>
            <span className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
              <a href="https://four.meme/en" target="_blank" rel="noreferrer" className="btn btn-sm" onClick={(e) => e.stopPropagation()}>
                View on Four.meme
              </a>
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={showFour}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFour((v) => !v);
                }}
              >
                Modify {showFour ? "▴" : "▾"}
              </button>
            </span>
          </div>
        </div>
        {showFour && (
          <div ref={fourRef} className="bg-surface p-4 md:col-span-2">
            <div>
              {!OF.core ? (
                <div className="mt-2">
                  <Empty>The Four.meme launchpad is not deployed on this network yet.</Empty>
                </div>
              ) : items.length === 0 ? (
                <div className="mt-2">
                  <Empty>{list.isLoading ? "Loading launches…" : "No launches yet."}</Empty>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
                  <div className="self-start overflow-hidden rounded-card border border-line bg-surface">
                    {items.map((it) => {
                      const on = it.token === active;
                      return (
                        <button key={it.token} onClick={() => setSel(it.token)} className={`block w-full border-b border-line px-3 py-3 text-left last:border-b-0 hover:bg-surface2 ${on ? "bg-surface2" : ""}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13px] font-medium text-ink">
                              {it.name} <span className="num text-xs font-normal text-muted">${it.symbol}</span>
                            </span>
                            <span className={`text-2xs ${it.phase === PHASE_MIGRATED ? "text-good" : "text-muted"}`}>{it.phase !== undefined ? PHASES[it.phase] ?? `phase ${it.phase}` : "…"}</span>
                          </div>
                          <div className="mt-2 h-1 overflow-hidden rounded-sm bg-surface">
                            <div className="h-full bg-accent" style={{ width: `${it.pct ?? 0}%` }} />
                          </div>
                          <div className="num mt-1 text-2xs text-faint">
                            {it.raised !== undefined ? `${fmtNum(Number(it.raised) / 1e18)} / ${fmtNum(Number(it.raise ?? 0n) / 1e18)} tTSLA · ${(it.pct ?? 0).toFixed(0)}%` : "reading…"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="overflow-hidden rounded-card border border-line">{active && <MemeDetail key={active} token={active} />}</div>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">AAPL market</span>
            <span className="flex items-center gap-1.5">
              <MoreBadge />
              <SourceBadge label="Flap" iconOnly />
              <SourceBadge label="Four.meme" iconOnly />
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">One market on all three: listed on MORE, with a launch on Flap and a launch on Four.meme. Both launches fund the same pool&apos;s first-loss xAAPL and its insurance vault.</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="num text-xs text-muted">{aapl?.snap ? `${fmtUsd(aapl.snap.price, { digits: 2 })} · ${fmtLev(aapl.snap.leverage)} · TVL ${fmtUsd(aapl.snap.V, { compact: true })}` : "2.00x · example"}</span>
            <span className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
              <a href={FLAP_NVDA_URL.replace(/0x[0-9a-f]{40}$/i, "")} target="_blank" rel="noreferrer" className="btn btn-sm">
                View on Flap
              </a>
              <a href="https://four.meme/en" target="_blank" rel="noreferrer" className="btn btn-sm" onClick={(e) => e.stopPropagation()}>
                View on Four.meme
              </a>
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={showAapl}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAapl((v) => !v);
                }}
              >
                Modify {showAapl ? "▴" : "▾"}
              </button>
              {aapl && (
                <Link href={`/trade/${aapl.meta.id}`} className="btn-primary btn-sm">
                  Trade AAPL
                </Link>
              )}
            </span>
          </div>
        </div>
        <div className="hidden bg-surface md:block" aria-hidden />
        {showAapl && (
          <div ref={aaplRef} className="bg-surface p-4 md:col-span-2">
            <ExampleFourLaunch />
          </div>
        )}
      </section>
    </div>
  );
}

/** Display-only example: an AAPL Market launch on Four.meme. No contract is behind it. */
function ExampleFourLaunch() {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const checks: [boolean, string][] = [
    [false, "Sold out, soft cap or expiry reached"],
    [true, "AAPL price fresh (Atlas)"],
    [true, "Pool minting not paused"],
    [true, "CMC price check passes"],
    [true, "Launch may open a pool"],
  ];
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <span className="pill">Example</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="self-start overflow-hidden rounded-card border border-line bg-surface">
          <div className="bg-surface2 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-ink">
                AAPL Market <span className="num text-xs font-normal text-muted">$AAPLM</span>
              </span>
              <span className="text-2xs text-muted">Trading</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-sm bg-surface">
              <div className="h-full bg-accent" style={{ width: "60%" }} />
            </div>
            <div className="num mt-1 text-2xs text-faint">2.4 / 4 tAAPL · 60%</div>
          </div>
        </div>
        <div className="grid overflow-hidden rounded-card border border-line bg-surface md:grid-cols-2">
          <div className="p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-base font-semibold text-ink">
                AAPL Market <span className="num text-sm font-normal text-muted">$AAPLM</span>
              </span>
              <span className="num text-xs text-faint">0xA9c1…4f77</span>
            </div>
            <div className="mt-1 text-xs text-muted">Trading · raised in tAAPL</div>
            <div className="mt-3 flex items-baseline justify-between text-xs">
              <span className="text-muted">Raise</span>
              <span className="num text-ink">2.4 / 4 tAAPL · 60.0%</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-sm bg-surface2">
              <div className="h-full bg-accent" style={{ width: "60%" }} />
            </div>
            <div className="num mt-1 text-2xs text-faint">320,000 AAPLM left for sale</div>
            <div className="mt-3 grid grid-cols-2 gap-1 rounded border border-line bg-surface2 p-1 text-xs">
              {(["buy", "sell"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setSide(k)} className={`rounded py-1.5 ${side === k ? "bg-surface font-medium text-ink" : "text-muted"}`}>
                  {k === "buy" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-baseline justify-between text-xs text-muted">
              <span>Amount (AAPLM)</span>
              <span className="num">0 AAPLM · 0 tAAPL</span>
            </div>
            <input className="input mt-1.5" inputMode="decimal" placeholder="0" aria-label="Amount of AAPLM" />
            <button type="button" className="btn-primary mt-4 w-full">
              {side === "buy" ? "Buy AAPLM" : "Sell AAPLM"}
            </button>
            <div className="mt-2 text-2xs text-faint">You need test tAAPL to buy.</div>
          </div>
          <div className="border-t border-line p-4 md:border-l md:border-t-0">
            <div className="text-[13px] font-semibold text-ink">Graduation → AAPL market</div>
            <ul className="mt-2 space-y-1 text-xs">
              {checks.map(([ok, text]) => (
                <li key={text} className="flex items-center gap-2 text-muted">
                  <span className={ok ? "text-good" : "text-bad"}>{ok ? "✓" : "✕"}</span>
                  {text}
                </li>
              ))}
            </ul>
            <div className="mt-3 rounded border border-line px-3 py-2 text-xs text-muted">
              On graduation: <span className="num text-ink">2 tAAPL</span> seeds the pool&apos;s first-loss xAAPL and <span className="num text-ink">2 tAAPL</span> mints sUSD to pair with the launch token.
            </div>
            <div className="mt-3 text-xs text-warn">Launch conditions not met</div>
            <button type="button" className="btn-primary mt-2 w-full opacity-60" disabled>
              Not ready to graduate
            </button>
            <div className="mt-2 text-2xs text-faint">Anyone can graduate once ready; the keeper also checks every minute.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
