"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatUnits, isAddress, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { CreatorRegistrarAbi, OpenFourCoreAbi, OpenFourCoreExtraAbi, OpenFourToolsAbi, OpenFourVaultAbi, SplitPoolMigrateModuleAbi, erc20Abi } from "@/abi";
import { addressUrl } from "@/config/chains";
import { deployments97 } from "@/config/deployments";
import { OF, PHASES } from "@/hooks/useOpenFour";
import { useNow } from "@/hooks/usePools";
import { describeError, useTx } from "@/hooks/useTx";
import { fmtDuration, fmtNum, MAX_UINT, parseAmount, short } from "@/lib/format";

type Preview = {
  initialized: boolean; migrated: boolean; conditionsMet: boolean; healthy: boolean; forced: boolean; canMigrate: boolean; hasCreatorRole: boolean;
  feedFresh: boolean; mintsPaused: boolean; breakerOk: boolean; conditionsMetAt: bigint; forceAt: bigint; endTime: bigint; totalRaised: bigint;
  quoteToUse: bigint; seedAmount: bigint; mintAmount: bigint; price: bigint; priceAge: bigint; mintValueUsd: bigint; minSusdOut: bigint; reason: string;
};
type Graduation = { branch: number; pair: Address; pool: Address; sUSD: Address; xToken: Address; stabilityPool: Address; seedAmount: bigint; mintAmount: bigint; sUSDMinted: bigint; xToTreasury: bigint; liquidity: bigint; price: bigint; timestamp: bigint };
type Estimate = { curveQuote: bigint; totalFee: bigint; userPays: bigint; userReceives: bigint; tokenAmount: bigint; executionPrice: bigint };

const n18 = (v?: bigint, d = 18) => (v === undefined ? 0 : Number(formatUnits(v, d)));

export default function MemeTokenPage() {
  const params = useParams<{ token: string }>();
  const token = (params?.token ?? "") as Address;
  const valid = isAddress(token);
  const { address } = useAccount();
  const client = usePublicClient({ chainId: bscTestnet.id });
  const { send, pending } = useTx();
  const now = useNow(1000);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [est, setEst] = useState<{ e?: Estimate; err?: string } | null>(null);

  const info = useReadContracts({
    allowFailure: true,
    query: { enabled: valid && !!OF.core, refetchInterval: 10_000 },
    contracts: [{ address: OF.core!, abi: OpenFourCoreAbi, functionName: "tokens", args: [token], chainId: bscTestnet.id }],
  });
  const t = info.data?.[0]?.status === "success" ? (info.data[0].result as unknown as readonly unknown[]) : undefined;
  const name = t?.[4] as string | undefined;
  const symbol = t?.[5] as string | undefined;
  const raiseAmount = t?.[8] as bigint | undefined;
  const quote = t?.[9] as Address | undefined;
  const vault = t?.[10] as Address | undefined;
  const module = t?.[13] as Address | undefined;
  const exists = t?.[17] as boolean | undefined;

  const u = address ?? "0x0000000000000000000000000000000000000000";
  const live = useReadContracts({
    allowFailure: true,
    query: { enabled: !!vault && !!module && !!quote, refetchInterval: 10_000 },
    contracts: [
      { address: vault!, abi: OpenFourVaultAbi, functionName: "totalRaised", chainId: bscTestnet.id },
      { address: vault!, abi: OpenFourVaultAbi, functionName: "remainingForSale", chainId: bscTestnet.id },
      { address: vault!, abi: OpenFourVaultAbi, functionName: "phase", chainId: bscTestnet.id },
      { address: module!, abi: SplitPoolMigrateModuleAbi, functionName: "previewGraduation", args: [token], chainId: bscTestnet.id },
      { address: module!, abi: SplitPoolMigrateModuleAbi, functionName: "lastGraduation", chainId: bscTestnet.id },
      { address: quote!, abi: erc20Abi, functionName: "decimals", chainId: bscTestnet.id },
      { address: quote!, abi: erc20Abi, functionName: "balanceOf", args: [u], chainId: bscTestnet.id },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [u], chainId: bscTestnet.id },
      { address: quote!, abi: erc20Abi, functionName: "allowance", args: [u, OF.core ?? u], chainId: bscTestnet.id },
      { address: token, abi: erc20Abi, functionName: "allowance", args: [u, OF.core ?? u], chainId: bscTestnet.id },
    ],
  });
  const L = live.data;
  const g = <T,>(i: number) => (L?.[i]?.status === "success" ? (L[i].result as T) : undefined);
  const totalRaised = g<bigint>(0);
  const remaining = g<bigint>(1);
  const phase = g<number>(2);
  const pv = g<Preview>(3);
  const grad = g<Graduation>(4);
  const qd = Number(g<number>(5) ?? 18);
  const quoteBal = g<bigint>(6) ?? 0n;
  const tokenBal = g<bigint>(7) ?? 0n;
  const quoteAllow = g<bigint>(8) ?? 0n;
  const tokenAllow = g<bigint>(9) ?? 0n;
  const amount = parseAmount(amt, 18); // buy/sell amounts are meme token units

  useEffect(() => {
    let live = true;
    setEst(null);
    if (!client || !OF.tools || !amount || amount <= 0n) return;
    const tm = setTimeout(async () => {
      try {
        const { result } = await client.simulateContract({
          address: OF.tools!,
          abi: OpenFourToolsAbi,
          functionName: side === "buy" ? "estimateBuy" : "estimateSell",
          args: [token, address ?? "0x000000000000000000000000000000000000dEaD", amount, 0n, "0x"],
          account: address ?? "0x000000000000000000000000000000000000dEaD",
        });
        if (live) setEst({ e: result as Estimate });
      } catch (e) {
        if (live) setEst({ err: describeError(e) });
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(tm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amt, side, client, address, token]);

  if (!valid) return <div className="of-panel">Not a token address.</div>;
  if (!OF.core) return <div className="of-panel">The OpenFour fork is not deployed yet.</div>;

  const pct = totalRaised !== undefined && raiseAmount ? Math.min(100, Number((totalRaised * 10000n) / (raiseAmount || 1n)) / 100) : 0;
  const migrated = pv?.migrated || phase === 2;
  const tradeNeedsApprove = side === "buy" ? (est?.e ? quoteAllow < est.e.userPays : false) : amount !== undefined && tokenAllow < amount;
  const graduatedPool = grad && grad.pool && grad.pool !== "0x0000000000000000000000000000000000000000" ? grad.pool : undefined;
  const registrar = deployments97.core.creatorRegistrar;
  const poolId = deployments97.pools.find((p) => graduatedPool && p.pool.toLowerCase() === graduatedPool.toLowerCase())?.id;

  const trade = async () => {
    if (!amount || !est?.e) return;
    if (tradeNeedsApprove) {
      await send({ address: side === "buy" ? quote! : token, abi: erc20Abi, functionName: "approve", args: [OF.core!, MAX_UINT], label: `Approve ${side === "buy" ? "tTSLA" : symbol}` });
      void live.refetch();
      return;
    }
    if (side === "buy") {
      const maxPay = (est.e.userPays * 10_100n) / 10_000n; // 1% slippage
      await send({ address: OF.core!, abi: OpenFourCoreAbi, functionName: "buy", args: [token, amount, maxPay, 0n, "0x" as Hex], label: `Buy ${symbol}` });
    } else {
      const minRecv = (est.e.userReceives * 9_900n) / 10_000n;
      await send({ address: OF.core!, abi: OpenFourCoreAbi, functionName: "sell", args: [token, amount, minRecv, 0n, "0x" as Hex], label: `Sell ${symbol}` });
    }
    setAmt("");
    void live.refetch();
  };

  return (
    <>
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        <Link href="/memes">← All memes</Link>
      </div>
      <h1 className="of-title">
        {name ?? short(token)} <span style={{ color: "var(--of-muted)" }}>${symbol ?? ""}</span>
      </h1>
      <p className="of-lede">
        <a href={addressUrl(token)} target="_blank" rel="noreferrer">{token}</a> · {exists === false ? "not registered on our Core" : phase !== undefined ? PHASES[phase] ?? `phase ${phase}` : "…"}
      </p>
      <div className="of-grid of-grid-2">
        <section className="of-panel of-panel-brand">
          <div style={{ color: "var(--of-text)", fontWeight: 700 }}>Raise</div>
          <div style={{ marginTop: 10, height: 8, borderRadius: 4, background: "var(--of-border)" }}>
            <div style={{ width: `${pct}%`, height: 8, borderRadius: 4, background: "var(--of-brand-gradient)" }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {fmtNum(n18(totalRaised, qd))} / {fmtNum(n18(raiseAmount, qd))} tTSLA ({pct.toFixed(1)}%) · {fmtNum(n18(remaining))} {symbol} left for sale
          </div>

          {!migrated && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", gap: 8 }}>
                {(["buy", "sell"] as const).map((s) => (
                  <button key={s} className={`of-btn ${side === s ? "of-btn-primary" : ""}`} onClick={() => { setSide(s); setAmt(""); }}>
                    {s === "buy" ? "Buy" : "Sell"}
                  </button>
                ))}
              </div>
              <label className="of-label" style={{ marginTop: 12 }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>Amount of {symbol ?? "token"} · balance {fmtNum(n18(tokenBal))} {symbol} / {fmtNum(n18(quoteBal, qd))} tTSLA</span>
                  {side === "buy" && remaining !== undefined && remaining > 0n && (
                    <button type="button" className="of-btn" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setAmt(formatUnits(remaining, 18))}>
                      Buy remaining {fmtNum(n18(remaining))}
                    </button>
                  )}
                </span>
                <input className="of-input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" />
              </label>
              {side === "buy" && remaining !== undefined && amount !== undefined && amount >= remaining && remaining > 0n && (
                <div style={{ fontSize: 12, marginTop: 6, color: "var(--of-brand)" }}>This buy sells the meme out: graduation opens the TSLA pool.</div>
              )}
              <div style={{ fontSize: 13, marginTop: 8, minHeight: 20 }}>
                {est?.err ? <span style={{ color: "var(--of-danger)" }}>{est.err}</span> : est?.e ? (
                  side === "buy" ? `You pay ≈ ${fmtNum(n18(est.e.userPays, qd))} tTSLA (fee ${fmtNum(n18(est.e.totalFee, qd))})` : `You receive ≈ ${fmtNum(n18(est.e.userReceives, qd))} tTSLA (fee ${fmtNum(n18(est.e.totalFee, qd))})`
                ) : null}
              </div>
              <button className="of-btn of-btn-primary" style={{ marginTop: 10, width: "100%" }} disabled={!address || !est?.e || !!pending} onClick={trade}>
                {!address ? "Connect a wallet" : pending ?? (tradeNeedsApprove ? `Approve ${side === "buy" ? "tTSLA" : symbol}` : side === "buy" ? "Buy" : "Sell")}
              </button>
            </div>
          )}
        </section>

        <section className="of-panel">
          <div style={{ color: "var(--of-text)", fontWeight: 700 }}>Graduation into a SplitStock TSLA pool</div>
          {migrated && grad ? (
            <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.7 }}>
              {grad.branch === 1 && (
                <Link href={`/pools/${poolId ?? "tsla-four"}`} className="of-btn of-btn-primary" style={{ display: "flex", justifyContent: "space-between", width: "100%", marginBottom: 12 }}>
                  <span>TSLA pool opened</span>
                  <span>View pool →</span>
                </Link>
              )}
              <div>Branch: {grad.branch === 1 ? "pool launch (meme/sUSD)" : grad.branch === 2 ? "fallback (meme/tTSLA)" : String(grad.branch)}</div>
              {graduatedPool && <div>Pool: <a href={addressUrl(graduatedPool)} target="_blank" rel="noreferrer">{short(graduatedPool)}</a>{poolId && <> · <Link href={`/pools/${poolId}`}>open pool page →</Link></>}</div>}
              <div>Pair: <a href={addressUrl(grad.pair)} target="_blank" rel="noreferrer">{short(grad.pair)}</a> (LP sent to 0xdead)</div>
              <div>First-loss seed: {fmtNum(n18(grad.seedAmount, qd))} tTSLA → {fmtNum(n18(grad.xToTreasury))} xTSLA to the BackstopTreasury</div>
              <div>Minted: {fmtNum(n18(grad.sUSDMinted))} sUSD-TSLA paired with the meme</div>
            </div>
          ) : pv ? (
            <div style={{ fontSize: 13, marginTop: 10 }}>
              <Check ok={pv.conditionsMet} label="Conditions met (sold out, soft cap or expiry)" />
              <Check ok={pv.feedFresh} label="TSLA price fresh" />
              <Check ok={!pv.mintsPaused} label="Pool mints not paused" />
              <Check ok={pv.breakerOk} label="CMC deviation breaker OK" />
              <Check ok={pv.hasCreatorRole} label="Module holds PoolFactory CREATOR_ROLE" />
              {!pv.hasCreatorRole && registrar && (
                <button
                  className="of-btn"
                  style={{ marginTop: 8, width: "100%" }}
                  disabled={!!pending}
                  onClick={() =>
                    send({
                      address: registrar,
                      abi: CreatorRegistrarAbi,
                      functionName: "registerOpenFourToken",
                      args: [OF.core!, token],
                      label: "Register CREATOR_ROLE",
                    }).then(() => live.refetch())
                  }
                >
                  Register CREATOR_ROLE (permissionless CreatorRegistrar)
                </button>
              )}
              <div style={{ marginTop: 8 }}>
                Plan: {fmtNum(n18(pv.seedAmount, qd))} tTSLA to seed() (first-loss xTSLA) + {fmtNum(n18(pv.mintAmount, qd))} tTSLA to mintStable (min {fmtNum(n18(pv.minSusdOut))} sUSD)
              </div>
              {pv.forceAt > 0n && !pv.canMigrate && <div>Forced migration (fallback) in {fmtDuration(Number(pv.forceAt) - now)}</div>}
              {pv.reason && <div style={{ color: "var(--of-warn)", marginTop: 4 }}>{pv.reason}</div>}
              <button
                className="of-btn of-btn-primary"
                style={{ marginTop: 12, width: "100%" }}
                disabled={!pv.canMigrate || !!pending}
                onClick={() => send({ address: OF.core!, abi: OpenFourCoreExtraAbi, functionName: "migrate", args: [token], label: "Graduate now" }).then(() => live.refetch())}
              >
                {pv.canMigrate ? "Graduate now" : "Not ready to graduate"}
              </button>
              <p style={{ fontSize: 12, marginTop: 8 }}>Anyone can call Core.migrate once the module says canMigrate; the keeper also polls it every minute.</p>
            </div>
          ) : (
            <div style={{ fontSize: 13, marginTop: 10 }}>Reading previewGraduation()…</div>
          )}
        </section>
      </div>
    </>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ color: ok ? "var(--of-brand)" : "var(--of-danger)" }}>{ok ? "✓" : "✕"}</span>
      <span>{label}</span>
    </div>
  );
}
