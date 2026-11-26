"use client";
import Link from "next/link";
import { bscTestnet } from "viem/chains";
import { useReadContracts } from "wagmi";
import { OpenFourCoreAbi, OpenFourVaultAbi } from "@/abi";
import { OF, PHASES, PHASE_MIGRATED, useOfTokens } from "@/hooks/useOpenFour";
import { fmtNum, short } from "@/lib/format";

type TokenInfo = { name: string; symbol: string; vault: `0x${string}`; raiseAmount: bigint; exists: boolean; migrateModule: `0x${string}`; quoteAsset: `0x${string}` };

export default function MemesPage() {
  const list = useOfTokens();
  const tokens = list.data ?? [];
  const infos = useReadContracts({
    allowFailure: true,
    query: { enabled: !!OF.core && tokens.length > 0, refetchInterval: 15_000 },
    contracts: tokens.map((t) => ({ address: OF.core!, abi: OpenFourCoreAbi, functionName: "tokens" as const, args: [t.token] as const, chainId: bscTestnet.id })),
  });
  const decoded = (infos.data ?? []).map((r) => {
    if (r.status !== "success") return undefined;
    const v = r.result as unknown as readonly unknown[];
    return { name: v[4], symbol: v[5], raiseAmount: v[8], quoteAsset: v[9], vault: v[10], migrateModule: v[13], exists: v[17] } as TokenInfo;
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
  const quoteOk = (d?: TokenInfo) => !d || !OF.quoteAsset || !d.quoteAsset || d.quoteAsset.toLowerCase() === OF.quoteAsset.toLowerCase();
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="of-title">Memes raised in tokenized Tesla</h1>
          <p className="of-lede" style={{ marginBottom: 0 }}>
            A fair-launch meme on Four.meme (our OpenFour fork), raised in tTSLA. When it sells out, graduation opens a new SplitStock TSLA pool: half the raise becomes the pool&apos;s first-loss xTSLA, and the other half mints sUSD, so the meme trades against a dollar.
          </p>
        </div>
        <Link href="/memes/new" className="of-btn of-btn-primary">Create a meme</Link>
      </div>
      {!OF.core && <div className="of-panel">The OpenFour fork is not deployed yet (deployments/97.json openfour.core).</div>}
      <div className="of-grid of-grid-2">
        {tokens.map((t, i) => {
          const d = decoded[i];
          let raised: bigint | undefined;
          let phase: number | undefined;
          if (d?.exists) {
            const a = vaults.data?.[vi++];
            const b = vaults.data?.[vi++];
            raised = a?.status === "success" ? (a.result as bigint) : undefined;
            phase = b?.status === "success" ? Number(b.result) : undefined;
          }
          if (!quoteOk(d)) return null;
          const pct = raised !== undefined && d?.raiseAmount ? Math.min(100, Number((raised * 10000n) / (d.raiseAmount || 1n)) / 100) : 0;
          return (
            <Link key={t.token} href={`/memes/${t.token}`} className="of-panel of-panel-brand" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--of-text)", fontWeight: 700 }}>
                <span>{d?.name ?? t.name ?? short(t.token)} <span style={{ color: "var(--of-muted)", fontWeight: 500 }}>${d?.symbol ?? t.symbol ?? ""}</span></span>
                <span style={{ fontSize: 12, color: phase === PHASE_MIGRATED ? "var(--of-brand)" : "var(--of-muted)" }}>{d?.exists === false ? "not on Core" : phase !== undefined ? PHASES[phase] ?? `phase ${phase}` : "…"}</span>
              </div>
              <div style={{ marginTop: 10, height: 6, borderRadius: 4, background: "var(--of-border)" }}>
                <div style={{ width: `${pct}%`, height: 6, borderRadius: 4, background: "var(--of-brand-gradient)" }} />
              </div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                {raised !== undefined ? `${fmtNum(Number(raised) / 1e18)} / ${fmtNum(Number(d?.raiseAmount ?? 0n) / 1e18)} tTSLA raised (${pct.toFixed(0)}%)` : "reading vault…"}
              </div>
              {phase === PHASE_MIGRATED && (
                <div style={{ marginTop: 8, fontSize: 13, color: "var(--of-brand)", fontWeight: 600 }}>Graduated · TSLA pool opened</div>
              )}
            </Link>
          );
        })}
      </div>
      {OF.core && tokens.length === 0 && !list.isLoading && <div className="of-panel">No memes yet. Create the first one.</div>}

      <section className="of-panel" style={{ marginTop: 16 }}>
        <div style={{ color: "var(--of-text)", fontWeight: 700, marginBottom: 6 }}>Compared with Four.meme&apos;s stock4TaxV1</div>
        <div className="of-grid of-grid-2" style={{ fontSize: 13 }}>
          <div>
            <b style={{ color: "var(--of-text)" }}>stock4TaxV1</b>: graduation liquidity is meme/stock. Its dollar value moves 1:1 with the stock, so a stock drawdown drains the meme&apos;s liquidity in USD terms.
          </div>
          <div>
            <b style={{ color: "var(--of-brand)" }}>SplitStock Pool Launch</b>: graduation liquidity is meme/sUSD (dollar-quoted). The stock exposure sits in the new pool&apos;s first-loss xTSLA, and preset fees fund that pool&apos;s backstop. This is not a price floor: the pool&apos;s sell zone can still sell stock.
          </div>
        </div>
      </section>
    </>
  );
}
