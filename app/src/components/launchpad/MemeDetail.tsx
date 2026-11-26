"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CreatorRegistrarAbi, MockERC20PermitAbi, OpenFourCoreAbi, OpenFourCoreExtraAbi, OpenFourToolsAbi, OpenFourVaultAbi, SplitPoolMigrateModuleAbi, erc20Abi } from "@/abi";
import { addressUrl } from "@/config/chains";
import { deployments97 } from "@/config/deployments";
import { OF, PHASES, PHASE_MIGRATED } from "@/hooks/useOpenFour";
import { useNow } from "@/hooks/usePools";
import { describeError, useTx } from "@/hooks/useTx";
import { fmtDuration, fmtNum, MAX_UINT, parseAmount, short } from "@/lib/format";
import { Seg } from "../ui";

type Preview = {
  initialized: boolean; migrated: boolean; conditionsMet: boolean; healthy: boolean; forced: boolean; canMigrate: boolean; hasCreatorRole: boolean;
  feedFresh: boolean; mintsPaused: boolean; breakerOk: boolean; conditionsMetAt: bigint; forceAt: bigint; endTime: bigint; totalRaised: bigint;
  quoteToUse: bigint; seedAmount: bigint; mintAmount: bigint; price: bigint; priceAge: bigint; mintValueUsd: bigint; minSusdOut: bigint; reason: string;
};
type Graduation = { branch: number; pair: Address; pool: Address; sUSD: Address; xToken: Address; stabilityPool: Address; seedAmount: bigint; mintAmount: bigint; sUSDMinted: bigint; xToTreasury: bigint; liquidity: bigint; price: bigint; timestamp: bigint };
type Estimate = { curveQuote: bigint; totalFee: bigint; userPays: bigint; userReceives: bigint; tokenAmount: bigint; executionPrice: bigint };

const n18 = (v?: bigint, d = 18) => (v === undefined ? 0 : Number(formatUnits(v, d)));
const ZERO = "0x0000000000000000000000000000000000000000";

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className={`num w-3 ${ok ? "text-good" : "text-bad"}`}>{ok ? "✓" : "✕"}</span>
      <span className={ok ? "text-ink" : "text-muted"}>{label}</span>
    </div>
  );
}

/** One Four.meme (OpenFour fork) launch: raise progress, buy/sell on the curve, graduation into a SplitStock TSLA pool. */
export function MemeDetail({ token }: { token: Address }) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const client = usePublicClient({ chainId: bscTestnet.id });
  const { send, pending } = useTx();
  const now = useNow(1000);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [est, setEst] = useState<{ e?: Estimate; err?: string } | null>(null);

  const info = useReadContracts({
    allowFailure: true,
    query: { enabled: !!OF.core, refetchInterval: 10_000 },
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

  const u = address ?? ZERO;
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
  const amount = parseAmount(amt, 18);

  useEffect(() => {
    let on = true;
    setEst(null);
    if (!client || !OF.tools || !amount || amount <= 0n) return;
    const tm = setTimeout(async () => {
      try {
        const who = address ?? "0x000000000000000000000000000000000000dEaD";
        const { result } = await client.simulateContract({ address: OF.tools!, abi: OpenFourToolsAbi, functionName: side === "buy" ? "estimateBuy" : "estimateSell", args: [token, who, amount, 0n, "0x"], account: who });
        if (on) setEst({ e: result as Estimate });
      } catch (e) {
        if (on) setEst({ err: describeError(e) });
      }
    }, 350);
    return () => {
      on = false;
      clearTimeout(tm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amt, side, client, address, token]);

  const pct = totalRaised !== undefined && raiseAmount ? Math.min(100, Number((totalRaised * 10000n) / (raiseAmount || 1n)) / 100) : 0;
  const migrated = pv?.migrated || phase === PHASE_MIGRATED;
  const needApprove = side === "buy" ? (est?.e ? quoteAllow < est.e.userPays : false) : amount !== undefined && tokenAllow < amount;
  const graduatedPool = grad && grad.pool && grad.pool !== ZERO ? grad.pool : undefined;
  const registrar = deployments97.core.creatorRegistrar;
  const poolId = deployments97.pools.find((p) => graduatedPool && p.pool.toLowerCase() === graduatedPool.toLowerCase())?.id ?? "tsla-four";
  const soldOutBuy = side === "buy" && remaining !== undefined && amount !== undefined && remaining > 0n && amount >= remaining;

  const trade = async () => {
    if (!isConnected) return openConnectModal?.();
    if (!amount || !est?.e) return;
    if (needApprove) {
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
    <div className="grid gap-px bg-line md:grid-cols-2">
      <div className="bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">
            {name ?? short(token)} <span className="num text-sm font-normal text-muted">${symbol ?? ""}</span>
          </h2>
          <a className="num link text-xs" href={addressUrl(token)} target="_blank" rel="noreferrer">
            {short(token)} ↗
          </a>
        </div>
        <div className="mt-1 text-xs text-muted">{exists === false ? "Not registered on the launchpad Core" : phase !== undefined ? PHASES[phase] ?? `phase ${phase}` : "…"} · raised in tTSLA</div>
        <div className="mt-4">
          <div className="flex justify-between text-xs">
            <span className="text-muted">Raise</span>
            <span className="num text-ink">
              {fmtNum(n18(totalRaised, qd))} / {fmtNum(n18(raiseAmount, qd))} tTSLA · {pct.toFixed(1)}%
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-sm bg-surface2">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <div className="num mt-1 text-2xs text-faint">{fmtNum(n18(remaining))} {symbol} left for sale</div>
        </div>

        {!migrated ? (
          <div className="mt-4 space-y-2.5">
            <Seg className="w-full [&>button]:flex-1" value={side} onChange={(v) => { setSide(v); setAmt(""); }} items={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted">Amount ({symbol ?? "token"})</span>
              <span className="num text-muted">
                {fmtNum(n18(tokenBal))} {symbol} · {fmtNum(n18(quoteBal, qd))} tTSLA
              </span>
            </div>
            <div className="flex items-center rounded border border-line bg-surface2 focus-within:border-accent">
              <input className="num w-full bg-transparent px-3 py-2.5 text-base text-ink outline-none placeholder:text-faint" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" aria-label="Meme amount" />
              {side === "buy" && remaining !== undefined && remaining > 0n && (
                <button className="mr-2 shrink-0 rounded border border-line px-2 py-0.5 text-2xs font-medium text-muted hover:text-ink" onClick={() => setAmt(formatUnits(remaining, 18))}>
                  BUY REST
                </button>
              )}
            </div>
            <div className="min-h-[18px] text-xs">
              {est?.err ? (
                <span className="text-bad">{est.err}</span>
              ) : est?.e ? (
                <span className="num text-muted">
                  {side === "buy" ? `You pay ≈ ${fmtNum(n18(est.e.userPays, qd))} tTSLA` : `You receive ≈ ${fmtNum(n18(est.e.userReceives, qd))} tTSLA`} · fee {fmtNum(n18(est.e.totalFee, qd))}
                </span>
              ) : null}
            </div>
            {soldOutBuy && <div className="rounded border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-ink">This buy sells the launch out. Graduation then opens the TSLA market.</div>}
            <button className="btn-primary min-h-[40px] w-full" disabled={isConnected && (!est?.e || !!pending)} onClick={trade}>
              {!isConnected ? "Connect wallet" : pending ?? (needApprove ? `Approve ${side === "buy" ? "tTSLA" : symbol}` : side === "buy" ? `Buy ${symbol ?? ""}` : `Sell ${symbol ?? ""}`)}
            </button>
            {isConnected && quote && (
              <div className="flex items-center justify-between gap-2 text-2xs text-faint">
                <span>{quoteBal === 0n ? "You need test tTSLA to buy." : "Buys are paid in test tTSLA."}</span>
                <button className="text-accent hover:underline disabled:opacity-50" disabled={!!pending} onClick={() => send({ address: quote, abi: MockERC20PermitAbi, functionName: "faucet", label: "Faucet tTSLA" }).then(() => live.refetch())}>
                  Get test tTSLA
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 rounded border border-good/40 bg-good/5 p-3 text-sm text-ink">Graduated: the raise opened a TSLA market.</div>
        )}
      </div>

      <div className="bg-surface p-4">
        <div className="text-[13px] font-semibold text-ink">Graduation → TSLA market</div>
        {migrated && grad ? (
          <div className="mt-3 space-y-2 text-xs">
            {grad.branch === 1 && (
              <Link href={`/trade/${poolId}`} className="btn-accent w-full justify-between">
                <span>TSLA market opened</span>
                <span>Trade →</span>
              </Link>
            )}
            <div className="text-muted">Branch: <span className="text-ink">{grad.branch === 1 ? "pool launch (meme/sUSD)" : grad.branch === 2 ? "fallback (meme/tTSLA)" : String(grad.branch)}</span></div>
            {graduatedPool && <div className="text-muted">Pool <a className="num link" href={addressUrl(graduatedPool)} target="_blank" rel="noreferrer">{short(graduatedPool)}</a></div>}
            <div className="text-muted">Pair <a className="num link" href={addressUrl(grad.pair)} target="_blank" rel="noreferrer">{short(grad.pair)}</a> (LP burned)</div>
            <div className="text-muted">First-loss seed <span className="num text-ink">{fmtNum(n18(grad.seedAmount, qd))} tTSLA → {fmtNum(n18(grad.xToTreasury))} xTSLA</span> to the insurance vault</div>
            <div className="text-muted">Minted <span className="num text-ink">{fmtNum(n18(grad.sUSDMinted))} sUSD-TSLA</span> paired with the meme</div>
          </div>
        ) : pv ? (
          <div className="mt-3">
            <Check ok={pv.conditionsMet} label="Sold out, soft cap or expiry reached" />
            <Check ok={pv.feedFresh} label="TSLA price fresh (Atlas)" />
            <Check ok={!pv.mintsPaused} label="Pool minting not paused" />
            <Check ok={pv.breakerOk} label="CMC price check passes" />
            <Check ok={pv.hasCreatorRole} label="Launch may open a pool" />
            {!pv.hasCreatorRole && registrar && (
              <button className="btn btn-sm mt-2 w-full" disabled={!!pending} onClick={() => send({ address: registrar, abi: CreatorRegistrarAbi, functionName: "registerOpenFourToken", args: [OF.core!, token], label: "Register launch" }).then(() => live.refetch())}>
                Register this launch (permissionless)
              </button>
            )}
            <div className="mt-3 rounded border border-line px-3 py-2 text-xs text-muted">
              On graduation: <span className="num text-ink">{fmtNum(n18(pv.seedAmount, qd))} tTSLA</span> seeds the pool&apos;s first-loss xTSLA and <span className="num text-ink">{fmtNum(n18(pv.mintAmount, qd))} tTSLA</span> mints sUSD (min {fmtNum(n18(pv.minSusdOut))}) to pair with the meme.
            </div>
            {pv.forceAt > 0n && !pv.canMigrate && <div className="mt-2 text-xs text-muted">Forced graduation (fallback) in {fmtDuration(Number(pv.forceAt) - now)}</div>}
            {pv.reason && <div className="mt-2 text-xs text-warn">{pv.reason}</div>}
            <button className="btn-accent mt-3 min-h-[38px] w-full" disabled={!pv.canMigrate || !!pending} onClick={() => send({ address: OF.core!, abi: OpenFourCoreExtraAbi, functionName: "migrate", args: [token], label: "Graduate" }).then(() => live.refetch())}>
              {pv.canMigrate ? "Graduate now" : "Not ready to graduate"}
            </button>
            <p className="mt-2 text-2xs text-faint">Anyone can graduate once ready; the keeper also checks every minute.</p>
          </div>
        ) : (
          <div className="mt-3 text-xs text-muted">Reading graduation status…</div>
        )}
      </div>
    </div>
  );
}
