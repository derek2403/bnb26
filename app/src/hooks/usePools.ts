"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContracts } from "wagmi";
import { bscTestnet } from "viem/chains";
import type { Address, ContractFunctionParameters } from "viem";
import { keccak256, toBytes, zeroAddress } from "viem";
import { AtlasMirrorAbi, BackstopTreasuryAbi, BackstopVaultAbi, LeveragePoolAbi, MarketCalendarAbi, MockERC20PermitAbi, PoolFactoryAbi, SplitLauncherAbi, StabilityPoolAbi, erc20Abi } from "@/abi";
import { addr, deployments97, launcherForPool, oracleFor, type DeployedPool } from "@/config/deployments";
import { DEMO_POOLS, STOCK_NAMES, demoPool } from "@/config/demoPools";
import { demoState } from "@/lib/demo";
import { toNum } from "@/lib/format";
import { toSnapshot, type SimState } from "@/lib/sim";
import { MODES, RISK_SOURCES, type PoolMeta, type PoolSnapshot, type UserBalances } from "@/lib/types";
import { useDemoWallet } from "@/components/DemoWallet";
import type { DemoPrices } from "@/lib/server/cmc";

export const REFRESH_MS = 10_000;

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useDemoPrices() {
  return useQuery({
    queryKey: ["demo-prices"],
    queryFn: async (): Promise<DemoPrices> => {
      const r = await fetch("/api/demo-prices");
      if (!r.ok) throw new Error(`demo-prices ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}

// ------------------------------------------------------------------ metas

const LAUNCHPAD: Record<string, string> = { flap: "Flap", four: "Four.meme", scenario: "Scenario", dev: "Dev", sandbox: "Sandbox" };

export function metaFromDeployed(p: DeployedPool): PoolMeta {
  const asset = addr(deployments97.tokens[`t${p.symbol}`]);
  return {
    id: p.id,
    symbol: p.symbol,
    name: STOCK_NAMES[p.symbol] ?? p.symbol,
    source: p.kind,
    launchpad: LAUNCHPAD[p.kind] ?? p.kind,
    isDemo: false,
    assetSymbol: `t${p.symbol}`,
    stableSymbol: `sUSD-${p.symbol}`,
    leverSymbol: `x${p.symbol}`,
    addresses: {
      pool: p.pool,
      asset,
      usdc: addr(deployments97.tokens.mUSDC),
      sUSD: addr(p.sUSD),
      xToken: addr(p.xToken),
      stabilityPool: addr(p.stabilityPool),
      feed: addr(p.feed) ?? addr(oracleFor(p.symbol)?.mirror),
      openedBy: addr(p.openedBy),
    },
    assetId: p.assetId,
    openTx: p.openTx,
    pullFeed: p.symbol === "NVDA" ? "nvdab" : undefined,
  };
}

export function metaForSandbox(pool: Address, feed: Address, symbol = "NVDA"): PoolMeta {
  return {
    ...metaFromDeployed({ id: "sandbox", symbol, kind: "dev", pool, feed }),
    id: "sandbox",
    source: "sandbox",
    launchpad: "Sandbox",
  };
}

function demoMeta(id: string): PoolMeta | undefined {
  const d = demoPool(id);
  if (!d) return undefined;
  return {
    id: d.id,
    symbol: d.symbol,
    name: d.name,
    source: "demo",
    launchpad: d.launchpad === "flap" ? "Flap" : "Four.meme",
    isDemo: true,
    assetSymbol: `t${d.symbol}`,
    stableSymbol: `sUSD-${d.symbol}`,
    leverSymbol: `x${d.symbol}`,
  };
}

/** The two real launches the plan defines. Shown as "awaiting launch" until deployments has them. */
export const EXPECTED_REAL = [
  { id: "nvda-flap", symbol: "NVDA", kind: "flap" as const, href: "/launch" },
  { id: "tsla-four", symbol: "TSLA", kind: "four" as const, href: "/memes" },
];

export function listMetas(): { real: PoolMeta[]; pending: typeof EXPECTED_REAL; demo: PoolMeta[] } {
  const real = deployments97.pools.filter((p) => (p.kind === "flap" || p.kind === "four") && !p.hidden).map(metaFromDeployed);
  const pending = EXPECTED_REAL.filter((e) => !real.some((r) => r.symbol === e.symbol && r.source === e.kind));
  const demo = DEMO_POOLS.map((d) => demoMeta(d.id)!).filter(Boolean);
  return { real, pending, demo };
}

export function findMeta(id: string): PoolMeta | undefined {
  const dep = deployments97.pools.find((p) => p.id === id);
  if (dep) return metaFromDeployed(dep);
  return demoMeta(id);
}

// ------------------------------------------------------------------ live discovery
// deployments/97.json is copied into the build, so a pool opened live during the demo (SplitLauncher.openPool(),
// or a Four.meme graduation) is not in it yet. These reads find the two real pools on-chain instead:
// PoolFactory.poolsByAsset(keccak256(SYM)) -> poolInfo(pool), keeping kind LIVE (0). NVDA prefers the pool the
// Flap launcher opened (SplitLauncher.pool()); TSLA takes the newest LIVE TSLA pool. deployments always wins.

type PoolInfoResult = { pool: Address; sUSD: Address; xToken: Address; stabilityPool: Address; asset: Address; feed: Address; router: Address; assetId: `0x${string}`; symbol: string; creator: Address; kind: number; createdAt: bigint };

export function useDiscoveredPools(): { metas: PoolMeta[]; loading: boolean } {
  const factory = addr(deployments97.core.poolFactory);
  const launcher = addr(launcherForPool("nvda-flap")?.launcher);
  const need = EXPECTED_REAL.filter((e) => !deployments97.pools.some((p) => p.id === e.id));
  const enabled = !!factory && need.length > 0;
  const stage1 = useReadContracts({
    allowFailure: true,
    query: { enabled, refetchInterval: 15_000 },
    contracts: [
      ...need.map((e) => ({ address: factory!, abi: PoolFactoryAbi, functionName: "poolsByAsset" as const, args: [keccak256(toBytes(e.symbol))] as const, chainId: bscTestnet.id })),
      ...(launcher ? [{ address: launcher, abi: SplitLauncherAbi, functionName: "pool" as const, chainId: bscTestnet.id }] : []),
    ] as ContractFunctionParameters[],
  });
  const lists = need.map((_, i) => {
    const r = stage1.data?.[i];
    return r?.status === "success" ? ((r.result as readonly Address[]) ?? []) : [];
  });
  const launcherPool = launcher ? (stage1.data?.[need.length]?.status === "success" ? (stage1.data[need.length].result as Address) : undefined) : undefined;
  const candidates = useMemo(() => {
    // Pools already in deployments (including hidden rehearsal launches) are never "discovered" as the headline
    // pool: before the live GOBLIN graduation, the newest LIVE TSLA pool would otherwise be the rehearsal one.
    const known = new Set(deployments97.pools.map((p) => p.pool.toLowerCase()));
    const all = lists.flat().filter((a) => !known.has(a.toLowerCase()));
    if (launcherPool && launcherPool !== zeroAddress && !all.some((a) => a.toLowerCase() === launcherPool.toLowerCase())) all.push(launcherPool);
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(lists), launcherPool]);
  const stage2 = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && candidates.length > 0, refetchInterval: 30_000 },
    contracts: candidates.map((p) => ({ address: factory!, abi: PoolFactoryAbi, functionName: "poolInfo" as const, args: [p] as const, chainId: bscTestnet.id })),
  });
  const metas = useMemo(() => {
    const infos = (stage2.data ?? []).map((r) => (r.status === "success" ? (r.result as unknown as PoolInfoResult) : undefined)).filter((x): x is PoolInfoResult => !!x && x.pool !== zeroAddress);
    const out: PoolMeta[] = [];
    for (const e of need) {
      const live = infos.filter((i) => i.kind === 0 && i.symbol === e.symbol);
      let pick: PoolInfoResult | undefined;
      if (e.kind === "flap") pick = live.find((i) => launcherPool && i.pool.toLowerCase() === launcherPool.toLowerCase()) ?? live.find((i) => launcher && i.creator.toLowerCase() === launcher.toLowerCase());
      else pick = [...live].filter((i) => !launcher || i.creator.toLowerCase() !== launcher.toLowerCase()).sort((a, b) => Number(b.createdAt - a.createdAt))[0];
      if (!pick) continue;
      out.push(metaFromDeployed({ id: e.id, symbol: e.symbol, kind: e.kind, pool: pick.pool, sUSD: pick.sUSD, xToken: pick.xToken, stabilityPool: pick.stabilityPool, feed: pick.feed, openedBy: pick.creator, assetId: pick.assetId }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage2.data, launcherPool, launcher]);
  return { metas, loading: enabled && (stage1.isLoading || stage2.isLoading) };
}

/** Real pools: deployments first, then the ones discovered on-chain. */
export function useRealMetas(): { real: PoolMeta[]; pending: typeof EXPECTED_REAL; loading: boolean } {
  const base = useMemo(() => listMetas().real, []);
  const disc = useDiscoveredPools();
  const real = useMemo(() => [...base, ...disc.metas.filter((m) => !base.some((b) => b.id === m.id))], [base, disc.metas]);
  const pending = EXPECTED_REAL.filter((e) => !real.some((r) => r.id === e.id || (r.symbol === e.symbol && r.source === e.kind)));
  return { real, pending, loading: disc.loading };
}

// ------------------------------------------------------------------ on-chain -> snapshot

type PoolStateResult = {
  C: bigint; U: bigint; S: bigint; X: bigint; price: bigint; priceUpdatedAt: bigint; priceAge: bigint; priceFresh: boolean; feedHalted: boolean;
  V: bigint; E: bigint; xNav: bigint; leverage: bigint; collateralRatio: bigint; mode: number; marketOpen: boolean; gapGuard: boolean; mintsPaused: boolean;
  triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxMintLev: bigint; stableMintFeeBps: bigint; leverMintFeeBps: bigint; riskSource: number; snapshotId: bigint;
};
type PoolParamsResult = { redeemFeeBps: bigint; stabilityRedeemFeeBps: bigint; stabilityCR: bigint; [k: string]: bigint };

export function snapshotFromChain(st: PoolStateResult, opts: { assetDecimals?: number; usdcDecimals?: number; params?: PoolParamsResult; spDeposits?: bigint; backstopUsd?: bigint; nextOpen?: bigint; nextClose?: bigint }): PoolSnapshot {
  const ad = opts.assetDecimals ?? 18;
  const ud = opts.usdcDecimals ?? 18;
  const E = st.E < 0n ? -toNum(-st.E) : toNum(st.E);
  const big = (v?: bigint) => (v === undefined || v >= 2n ** 255n ? undefined : Number(v));
  return {
    C: toNum(st.C, ad),
    U: toNum(st.U, ud),
    S: toNum(st.S),
    X: toNum(st.X),
    price: toNum(st.price),
    priceUpdatedAt: Number(st.priceUpdatedAt),
    priceAge: Number(st.priceAge),
    priceFresh: st.priceFresh,
    feedHalted: st.feedHalted,
    V: toNum(st.V),
    E,
    xNav: toNum(st.xNav),
    leverage: toNum(st.leverage),
    cr: toNum(st.collateralRatio),
    mode: MODES[st.mode] ?? "NORMAL",
    marketOpen: st.marketOpen,
    gapGuard: st.gapGuard,
    mintsPaused: st.mintsPaused,
    triggerLev: toNum(st.triggerLev),
    targetLev: toNum(st.targetLev),
    lowerTriggerLev: toNum(st.lowerTriggerLev),
    maxMintLev: toNum(st.maxMintLev),
    stableMintFeeBps: Number(st.stableMintFeeBps),
    leverMintFeeBps: Number(st.leverMintFeeBps),
    redeemFeeBps: Number(opts.params?.redeemFeeBps ?? 20n),
    stabilityRedeemFeeBps: Number(opts.params?.stabilityRedeemFeeBps ?? 100n),
    stabilityCR: opts.params ? toNum(opts.params.stabilityCR) : 1.3,
    riskSource: RISK_SOURCES[st.riskSource] ?? "FALLBACK",
    snapshotId: Number(st.snapshotId),
    spDeposits: opts.spDeposits !== undefined ? toNum(opts.spDeposits) : undefined,
    backstopUsd: opts.backstopUsd !== undefined ? toNum(opts.backstopUsd) : undefined,
    nextOpen: big(opts.nextOpen),
    nextClose: big(opts.nextClose),
  };
}

function backstopContract(meta: PoolMeta): ContractFunctionParameters | null {
  if (meta.source === "flap") {
    const v = addr(launcherForPool(meta.id)?.vault);
    if (v) return { address: v, abi: BackstopVaultAbi, functionName: "bufferUsd" };
  }
  if (meta.source === "four") {
    const t = addr(deployments97.openfour.backstopTreasury);
    if (t) return { address: t, abi: BackstopTreasuryAbi, functionName: "bufferUsd" };
  }
  return null;
}

/** Fixed-length read list per pool (9 entries) so results can be sliced positionally. */
function poolReads(meta: PoolMeta, now: bigint): ContractFunctionParameters[] {
  const a = meta.addresses!;
  const cal = addr(deployments97.core.marketCalendar);
  const dummy = { address: a.pool, abi: LeveragePoolAbi, functionName: "factory" } as ContractFunctionParameters;
  return [
    { address: a.pool, abi: LeveragePoolAbi, functionName: "state" },
    { address: a.pool, abi: LeveragePoolAbi, functionName: "params" },
    a.asset ? { address: a.asset, abi: erc20Abi, functionName: "decimals" } : dummy,
    a.usdc ? { address: a.usdc, abi: erc20Abi, functionName: "decimals" } : dummy,
    a.stabilityPool ? { address: a.stabilityPool, abi: StabilityPoolAbi, functionName: "totalDeposits" } : dummy,
    backstopContract(meta) ?? dummy,
    cal ? { address: cal, abi: MarketCalendarAbi, functionName: "nextOpen", args: [now] } : dummy,
    cal ? { address: cal, abi: MarketCalendarAbi, functionName: "nextClose", args: [now] } : dummy,
    { address: a.pool, abi: LeveragePoolAbi, functionName: "currentRisk" },
  ];
}
const READS_PER_POOL = 9;

type R = { status: "success" | "failure"; result?: unknown } | undefined;
const ok = <T,>(r: R, check?: (v: unknown) => boolean): T | undefined =>
  r?.status === "success" && (!check || check(r.result)) ? (r.result as T) : undefined;
const isNum = (v: unknown) => typeof v === "number" || typeof v === "bigint";

function decodePoolReads(rs: R[], meta: PoolMeta): PoolSnapshot | null {
  const st = ok<PoolStateResult>(rs[0], (v) => !!v && typeof v === "object" && "V" in (v as object));
  if (!st) return null;
  const risk = ok<readonly [{ openFeeBps: bigint; closedFeeBps: bigint }, bigint]>(rs[8], (v) => Array.isArray(v));
  const snap = snapshotFromChain(st, {
    params: ok<PoolParamsResult>(rs[1], (v) => !!v && typeof v === "object" && "stabilityCR" in (v as object)),
    assetDecimals: meta.addresses?.asset ? Number(ok<number>(rs[2], isNum) ?? 18) : 18,
    usdcDecimals: meta.addresses?.usdc ? Number(ok<number>(rs[3], isNum) ?? 18) : 18,
    spDeposits: meta.addresses?.stabilityPool ? ok<bigint>(rs[4], (v) => typeof v === "bigint") : undefined,
    backstopUsd: backstopContract(meta) ? ok<bigint>(rs[5], (v) => typeof v === "bigint") : undefined,
    nextOpen: ok<bigint>(rs[6], (v) => typeof v === "bigint"),
    nextClose: ok<bigint>(rs[7], (v) => typeof v === "bigint"),
  });
  if (risk) {
    snap.openFeeBps = Number(risk[0].openFeeBps);
    snap.closedFeeBps = Number(risk[0].closedFeeBps);
  }
  return snap;
}

// ------------------------------------------------------------------ list

export type PoolRow = { meta: PoolMeta; snap: PoolSnapshot | null; loading: boolean; priceSource?: "cmc" | "fallback" };

export function usePoolList(): { rows: PoolRow[]; pending: typeof EXPECTED_REAL; pricesSource?: string; discovering: boolean } {
  const demo = useMemo(() => listMetas().demo, []);
  const { real, pending, loading: discovering } = useRealMetas();
  const now = useNow(REFRESH_MS);
  const nowBig = BigInt(Math.floor(now / 60) * 60);
  const contracts = useMemo(() => real.flatMap((m) => poolReads(m, nowBig)), [real, nowBig]);
  const reads = useReadContracts({ contracts, allowFailure: true, query: { enabled: contracts.length > 0, refetchInterval: REFRESH_MS } });
  const prices = useDemoPrices();
  const wallet = useDemoWallet();

  const rows: PoolRow[] = [
    ...real.map((meta, i) => ({
      meta,
      snap: reads.data ? decodePoolReads(reads.data.slice(i * READS_PER_POOL, (i + 1) * READS_PER_POOL) as R[], meta) : null,
      loading: reads.isLoading,
    })),
    ...demo.map((meta) => {
      const def = demoPool(meta.id)!;
      const p = prices.data?.prices[def.symbol];
      const snap = toSnapshot(demoState(def, p?.price ?? def.fallbackPrice, now, wallet.overlay(def.id)), now);
      return { meta, snap: prices.isLoading ? null : snap, loading: prices.isLoading, priceSource: p?.source };
    }),
  ];
  return { rows, pending, pricesSource: prices.data?.source, discovering };
}

// ------------------------------------------------------------------ detail

export type PoolDetail = {
  meta: PoolMeta | undefined;
  snap: PoolSnapshot | null;
  user: UserBalances | null;
  decimals: { asset: number; usdc: number };
  loading: boolean;
  refetch: () => void;
  mirror?: { answer: number; srcUpdatedAt: number; pushedAt: number; srcTxHash?: string } | null;
  spUser?: { deposit: number; assetGain: number; stableReward: number } | null;
  /** Demo pools only: the simulated state the action panel runs against. */
  sim?: SimState;
};

export function usePool(id: string, override?: PoolMeta): PoolDetail & { discovering: boolean } {
  const disc = useDiscoveredPools();
  const discovered = disc.metas.find((m) => m.id === id);
  const meta = useMemo(() => override ?? findMeta(id) ?? discovered, [id, override, discovered]);
  const { address } = useAccount();
  const now = useNow(REFRESH_MS);
  const nowBig = BigInt(Math.floor(now / 60) * 60);
  const prices = useDemoPrices();
  const wallet = useDemoWallet();
  const isReal = !!meta && !meta.isDemo && !!meta.addresses?.pool;

  const contracts = useMemo((): ContractFunctionParameters[] => {
    if (!isReal || !meta) return [];
    const a = meta.addresses!;
    const base = poolReads(meta, nowBig);
    const dummy = base[0];
    const mirror = addr(oracleFor(meta.symbol)?.mirror);
    const u = address;
    return [
      ...base,
      u && a.asset ? { address: a.asset, abi: erc20Abi, functionName: "balanceOf", args: [u] } : dummy,
      u && a.sUSD ? { address: a.sUSD, abi: erc20Abi, functionName: "balanceOf", args: [u] } : dummy,
      u && a.xToken ? { address: a.xToken, abi: erc20Abi, functionName: "balanceOf", args: [u] } : dummy,
      u && a.usdc ? { address: a.usdc, abi: erc20Abi, functionName: "balanceOf", args: [u] } : dummy,
      u && a.asset ? { address: a.asset, abi: erc20Abi, functionName: "allowance", args: [u, a.pool] } : dummy,
      u && a.sUSD && a.stabilityPool ? { address: a.sUSD, abi: erc20Abi, functionName: "allowance", args: [u, a.stabilityPool] } : dummy,
      u && a.asset ? { address: a.asset, abi: MockERC20PermitAbi, functionName: "lastFaucetAt", args: [u] } : dummy,
      a.asset ? { address: a.asset, abi: MockERC20PermitAbi, functionName: "faucetCooldown" } : dummy,
      mirror && meta.source !== "sandbox" ? { address: mirror, abi: AtlasMirrorAbi, functionName: "latestRound" } : dummy,
      u && a.stabilityPool ? { address: a.stabilityPool, abi: StabilityPoolAbi, functionName: "depositOf", args: [u] } : dummy,
      u && a.stabilityPool ? { address: a.stabilityPool, abi: StabilityPoolAbi, functionName: "gainsOf", args: [u] } : dummy,
    ];
  }, [isReal, meta, address, nowBig]);

  const reads = useReadContracts({ contracts, allowFailure: true, query: { enabled: contracts.length > 0, refetchInterval: REFRESH_MS } });

  if (!meta) return { meta, snap: null, user: null, decimals: { asset: 18, usdc: 18 }, loading: disc.loading, refetch: () => {}, discovering: disc.loading };

  if (meta.isDemo) {
    const def = demoPool(meta.id)!;
    const p = prices.data?.prices[def.symbol];
    const sim = demoState(def, p?.price ?? def.fallbackPrice, now, wallet.overlay(def.id));
    const snap = toSnapshot(sim, now);
    const b = wallet.balances(def.id);
    const w = (n: number) => BigInt(Math.floor(n * 1e6)) * 10n ** 12n;
    return {
      meta,
      snap: prices.isLoading ? null : snap,
      user: { asset: w(b.asset), sUSD: w(b.sUSD), x: w(b.x), usdc: w(b.usdc), assetAllowance: 2n ** 255n, sUSDAllowanceSP: 2n ** 255n },
      decimals: { asset: 18, usdc: 18 },
      loading: prices.isLoading,
      refetch: () => {},
      mirror: null,
      spUser: null,
      sim,
      discovering: false,
    };
  }

  const rs = (reads.data ?? []) as R[];
  const snap = rs.length ? decodePoolReads(rs.slice(0, READS_PER_POOL), meta) : null;
  const ad = meta.addresses?.asset ? Number(ok<number>(rs[2], isNum) ?? 18) : 18;
  const ud = meta.addresses?.usdc ? Number(ok<number>(rs[3], isNum) ?? 18) : 18;
  const big = (i: number) => ok<bigint>(rs[i], (v) => typeof v === "bigint") ?? 0n;
  const user: UserBalances | null = address
    ? {
        asset: big(9),
        sUSD: big(10),
        x: big(11),
        usdc: big(12),
        assetAllowance: big(13),
        sUSDAllowanceSP: big(14),
        lastFaucetAt: Number(big(15)),
        faucetCooldown: Number(big(16)),
      }
    : null;
  const lr = ok<readonly [bigint, { answer: bigint; srcUpdatedAt: bigint; pushedAt: bigint; srcTxHash: string }]>(rs[17], (v) => Array.isArray(v));
  const gains = ok<readonly [bigint, bigint]>(rs[19], (v) => Array.isArray(v));
  return {
    meta,
    snap,
    user,
    decimals: { asset: ad, usdc: ud },
    loading: reads.isLoading,
    refetch: () => void reads.refetch(),
    mirror: lr ? { answer: toNum(lr[1].answer), srcUpdatedAt: Number(lr[1].srcUpdatedAt), pushedAt: Number(lr[1].pushedAt), srcTxHash: lr[1].srcTxHash } : null,
    discovering: false,
    spUser: address && meta.addresses?.stabilityPool ? { deposit: toNum(big(18)), assetGain: toNum(gains?.[0] ?? 0n, ad), stableReward: toNum(gains?.[1] ?? 0n) } : null,
  };
}

export const WRITE_CHAIN_ID = bscTestnet.id;
