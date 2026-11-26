"use client";
import { useMemo } from "react";
import { erc20Abi, zeroAddress, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { useAccount, useReadContracts } from "wagmi";
import { LeveragePoolAbi, SandboxFactoryAbi, ScenarioFeedAbi, StabilityPoolAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { toNum } from "@/lib/format";
import type { PoolMeta } from "@/lib/types";
import { metaForSandbox } from "./usePools";

export const SANDBOX_FACTORY = addr(deployments97.core.sandboxFactory);
const C = bscTestnet.id;

export type SandboxInfo = {
  loading: boolean;
  exists: boolean;
  pool?: Address;
  feed?: Address;
  createdAt?: number;
  meta?: PoolMeta;
  /** Feed anchor (the live Atlas price captured at create/reset), USD. */
  anchor?: number;
  anchorRaw?: bigint;
  answer?: number;
  feedDecimals: number;
  operator?: Address;
  /** Insurance pool (StabilityPool) totals: sUSD still staked and tNVDA it has received from sell zones. */
  spTotal?: number;
  spAssetHeld?: number;
  /** The sandbox owner (the wallet that staked the sUSD) and its insurance-pool stake. */
  owner?: Address;
  ownerStake?: { deposit: number; assetGain: number; stableReward: number };
  refetch: () => void;
};

/** The connected wallet's private sandbox market (SandboxFactory.create): pool, feed, tokens and insurance-pool totals. */
export function useMySandbox(owner?: Address | null): SandboxInfo {
  const me = useAccount().address;
  const address = owner === undefined ? me : owner ?? undefined;
  const first = useReadContracts({
    allowFailure: true,
    query: { enabled: !!address && !!SANDBOX_FACTORY, refetchInterval: 15_000 },
    contracts: [{ address: SANDBOX_FACTORY!, abi: SandboxFactoryAbi, functionName: "sandboxOf", args: [address ?? zeroAddress], chainId: C }],
  });
  const sb = first.data?.[0]?.status === "success" ? (first.data[0].result as { pool: Address; feed: Address; createdAt: bigint }) : undefined;
  const pool = sb && sb.pool !== zeroAddress ? sb.pool : undefined;
  const feed = sb && sb.feed !== zeroAddress ? sb.feed : undefined;

  const second = useReadContracts({
    allowFailure: true,
    query: { enabled: !!pool && !!feed, refetchInterval: 6_000 },
    contracts: pool && feed
      ? [
          { address: pool, abi: LeveragePoolAbi, functionName: "sUSD", chainId: C },
          { address: pool, abi: LeveragePoolAbi, functionName: "xToken", chainId: C },
          { address: pool, abi: LeveragePoolAbi, functionName: "stabilityPool", chainId: C },
          { address: feed, abi: ScenarioFeedAbi, functionName: "anchor", chainId: C },
          { address: feed, abi: ScenarioFeedAbi, functionName: "answer", chainId: C },
          { address: feed, abi: ScenarioFeedAbi, functionName: "decimals", chainId: C },
          { address: feed, abi: ScenarioFeedAbi, functionName: "operator", chainId: C },
        ]
      : [],
  });
  const at = <T,>(i: number): T | undefined => (second.data?.[i]?.status === "success" ? (second.data[i].result as T) : undefined);
  const sUSD = at<Address>(0);
  const xToken = at<Address>(1);
  const sp = at<Address>(2);
  const anchorRaw = at<bigint>(3);
  const answerRaw = at<bigint>(4);
  const dec = Number(at<number>(5) ?? 8);
  const operator = at<Address>(6);

  const asset = addr(deployments97.tokens.tNVDA);
  const third = useReadContracts({
    allowFailure: true,
    query: { enabled: !!sp && !!asset, refetchInterval: 6_000 },
    contracts:
      sp && asset
        ? [
            { address: sp, abi: StabilityPoolAbi, functionName: "totalDeposits", chainId: C },
            { address: asset, abi: erc20Abi, functionName: "balanceOf", args: [sp], chainId: C },
            { address: sp, abi: StabilityPoolAbi, functionName: "depositOf", args: [address ?? zeroAddress], chainId: C },
            { address: sp, abi: StabilityPoolAbi, functionName: "gainsOf", args: [address ?? zeroAddress], chainId: C },
          ]
        : [],
  });
  const spTotal = third.data?.[0]?.status === "success" ? toNum(third.data[0].result as bigint) : undefined;
  const spAssetHeld = third.data?.[1]?.status === "success" ? toNum(third.data[1].result as bigint) : undefined;

  const ownerDeposit = third.data?.[2]?.status === "success" ? toNum(third.data[2].result as bigint) : undefined;
  const gains = third.data?.[3]?.status === "success" ? (third.data[3].result as readonly [bigint, bigint]) : undefined;

  const meta = useMemo(() => {
    if (!pool || !feed || !sUSD || !xToken || !sp) return undefined;
    const m = metaForSandbox(pool, feed, "NVDA");
    return { ...m, stableSymbol: "sUSD", addresses: { ...m.addresses!, sUSD, xToken, stabilityPool: sp } };
  }, [pool, feed, sUSD, xToken, sp]);

  const scale = 10 ** dec;
  return {
    loading: first.isLoading || (!!pool && second.isLoading),
    exists: !!pool,
    pool,
    feed,
    createdAt: sb ? Number(sb.createdAt) : undefined,
    meta,
    anchor: anchorRaw !== undefined ? Number(anchorRaw) / scale : undefined,
    anchorRaw,
    answer: answerRaw !== undefined ? Number(answerRaw) / scale : undefined,
    feedDecimals: dec,
    operator,
    spTotal,
    spAssetHeld,
    owner: address,
    ownerStake: ownerDeposit !== undefined ? { deposit: ownerDeposit, assetGain: toNum(gains?.[0] ?? 0n), stableReward: toNum(gains?.[1] ?? 0n) } : undefined,
    refetch: () => {
      void first.refetch();
      void second.refetch();
      void third.refetch();
    },
  };
}
