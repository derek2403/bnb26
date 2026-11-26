"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
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

type TokenInfo = { name: string; symbol: string; vault: Address; raiseAmount: bigint; exists: boolean; quoteAsset: Address };

export function LaunchpadView() {
  const list = useOfTokens();
  const tokens = list.data ?? [];
  const { rows, pending } = usePoolList();
  const nvda = rows.find((r) => r.meta.source === "flap" && r.meta.symbol === "NVDA");
  const tsla = rows.find((r) => r.meta.source === "four" && r.meta.symbol === "TSLA");
  const tslaPending = pending.some((p) => p.symbol === "TSLA");

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
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("token");
      if (q && /^0x[0-9a-fA-F]{40}$/.test(q)) setSel(q as Address);
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

      <section className="mt-4 grid gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-2">
        <div className="bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">NVDA market</span>
            <SourceBadge label="Flap" />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">A launch on Flap opened the NVDA pool: its raise seeded the first-loss xNVDA, and the launch keeps funding the pool&apos;s insurance vault.</p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="num text-xs text-muted">{nvda?.snap ? `${fmtUsd(nvda.snap.price, { digits: 2 })} · ${fmtLev(nvda.snap.leverage)} · TVL ${fmtUsd(nvda.snap.V, { compact: true })}` : nvda ? "…" : "not open"}</span>
            {nvda && (
              <Link href={`/trade/${nvda.meta.id}`} className="btn-primary btn-sm">
                Trade NVDA
              </Link>
            )}
          </div>
        </div>
        <div className="bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">TSLA market</span>
            <SourceBadge label="Four.meme" />
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">The TSLA Market launch raises tTSLA on Four.meme (our OpenFour preset). When it sells out, graduation opens the TSLA market: half the raise seeds first-loss xTSLA, half mints sUSD, and the launch token trades against a dollar.</p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className={`text-xs text-muted ${tsla?.snap ? "num" : ""}`}>{tsla?.snap ? `${fmtUsd(tsla.snap.price, { digits: 2 })} · ${fmtLev(tsla.snap.leverage)} · TVL ${fmtUsd(tsla.snap.V, { compact: true })}` : tslaPending ? "Opens when the launch below graduates" : "…"}</span>
            {tsla ? (
              <Link href={`/trade/${tsla.meta.id}`} className="btn-primary btn-sm">
                Trade TSLA
              </Link>
            ) : (
              <span className="pill border-warn/40 text-warn">Launching</span>
            )}
          </div>
        </div>
      </section>

      <div id="four-launches" className="mt-6 flex scroll-mt-20 items-baseline justify-between">
        <h2 className="text-[13px] font-semibold text-ink">Market launches on Four.meme</h2>
        <span className="text-xs text-faint">Raised in tTSLA · BSC testnet</span>
      </div>
      {!OF.core ? (
        <div className="mt-2">
          <Empty>The Four.meme launchpad is not deployed on this network yet.</Empty>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-2">
          <Empty>{list.isLoading ? "Loading launches…" : "No launches yet."}</Empty>
        </div>
      ) : (
        <div className="mt-2 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
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

      <section className="mt-6 rounded-card border border-line bg-surface p-4 text-xs leading-relaxed text-muted">
        <span className="font-semibold text-ink">How a MORE market launch works.</span> The launch raises the stock token. At graduation half of the raise becomes the new market&apos;s first-loss xSTOCK and half mints sUSD, so the launch token trades against a dollar instead of the stock. The new market then appears on Markets and anyone can trade it.
      </section>
    </div>
  );
}
