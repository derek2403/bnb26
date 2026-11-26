"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { keccak256, toBytes, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { useReadContract, useReadContracts } from "wagmi";
import { MarketCalendarAbi, RiskOracleAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import type { CandleResponse, Interval } from "@/lib/candles";
import { nyseStatus } from "@/lib/nyse";
import type { PoolSnapshot } from "@/lib/types";

export async function fetchCandles(id: string, interval: Interval, anchor?: number): Promise<CandleResponse> {
  const p = new URLSearchParams({ id, interval });
  if (anchor && anchor > 0) p.set("anchor", anchor.toFixed(4));
  const r = await fetch(`/api/candles?${p}`);
  if (!r.ok) throw new Error(`candles ${r.status}`);
  return r.json();
}

export const candlesRefetch = (data: CandleResponse | undefined) => (data?.source === "cmc" ? 5 * 60_000 : 60_000);

/** Candles from /api/candles. `anchor` (live price) is read once per fetch, so price ticks do not refetch. */
export function useCandles(id: string | undefined, interval: Interval, anchor?: number) {
  const a = useRef(anchor);
  a.current = anchor;
  // Wait (briefly) for the live price so a synthetic fallback is anchored to it, not to a reference quote.
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return useQuery({
    queryKey: ["candles", id, interval],
    enabled: !!id && (anchor !== undefined || late),
    staleTime: 60_000,
    refetchInterval: (q) => candlesRefetch(q.state.data as CandleResponse | undefined),
    queryFn: () => fetchCandles(id!, interval, a.current),
  });
}

export type MarketStatus = { open: boolean; halfDay: boolean; gapGuard: boolean; nextOpen?: number; nextClose?: number; feeBps?: number; label: string; source: "MarketCalendar" | "approx" };

/** NYSE status for a market from the on-chain MarketCalendar (holidays, early closes): the pool's own view for
 *  live pools, the calendar's isOpen() for demo markets, a local NYSE-hours approximation if neither loads.
 *  Half day = today's session is shorter than 6h. */
export function useMarketStatus(snap: PoolSnapshot | null | undefined, now: number, onChain: boolean): MarketStatus {
  const cal = addr(deployments97.core.marketCalendar);
  const nowBig = BigInt(Math.floor(now / 60) * 60);
  const reads = useReadContracts({
    allowFailure: true,
    query: { enabled: !!cal, staleTime: 60_000 },
    contracts: cal
      ? [
          { address: cal, abi: MarketCalendarAbi, functionName: "dayIndexOf", args: [nowBig], chainId: bscTestnet.id },
          { address: cal, abi: MarketCalendarAbi, functionName: "isOpen", args: [nowBig], chainId: bscTestnet.id },
        ]
      : [],
  });
  const dayIdx = reads.data?.[0]?.status === "success" ? (reads.data[0].result as bigint) : undefined;
  const calOpen = reads.data?.[1]?.status === "success" ? (reads.data[1].result as boolean) : undefined;
  const sess = useReadContract({ address: cal, abi: MarketCalendarAbi, functionName: "sessionOf", args: [dayIdx ?? 0n], chainId: bscTestnet.id, query: { enabled: !!cal && dayIdx !== undefined, staleTime: 300_000 } });
  const s = sess.data as readonly [bigint, bigint] | undefined;
  const sessionLen = s && s[0] > 0n ? Number(s[1] - s[0]) : undefined;
  const halfDay = sessionLen !== undefined && sessionLen < 6 * 3600;
  const approx = nyseStatus(now);
  const open = onChain && snap ? snap.marketOpen : calOpen ?? snap?.marketOpen ?? approx.open;
  const gapGuard = snap?.gapGuard ?? false;
  const feeBps = snap ? ((open ? snap.openFeeBps : snap.closedFeeBps) ?? snap.stableMintFeeBps) : undefined;
  const label = open ? (halfDay ? "NYSE half day" : "NYSE open") : gapGuard ? "Pre-open guard" : "NYSE closed";
  return { open, halfDay, gapGuard, nextOpen: snap?.nextOpen ?? approx.nextOpen, nextClose: snap?.nextClose ?? (open && s && s[1] > 0n ? Number(s[1]) : approx.nextClose), feeBps, label, source: cal ? "MarketCalendar" : "approx" };
}

type RiskParams = { triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxDevBps: bigint; openFeeBps: bigint; closedFeeBps: bigint; gapGuardSec: bigint; maxSellChunkUsd: bigint };
type RiskView = { params: RiskParams; source: number; refPrice: bigint; refTs: bigint; snapshotId: bigint; mintsPaused: boolean };
type Snapshot = { refPrice: bigint; volBps: bigint; liqUsd: bigint; premiumBps: bigint; cmcTs: bigint; snapshotId: bigint; responseHash: Hex };
export type AgentParams = { triggerLev: bigint; targetLev: bigint; lowerTriggerLev: bigint; maxDevBps: bigint; closedFeeBps: bigint; gapGuardSec: bigint; horizonSec: bigint };
export type Proposal = { assetId: Hex; params: AgentParams; agentId: bigint; inputsHash: Hex; outputHash: Hex; modelIdHash: Hex; createdAt: bigint; eta: bigint; tightenOnly: boolean; status: number };
export const PROPOSAL_STATUS = ["NONE", "APPLIED", "QUEUED", "EXECUTED", "VETOED", "CANCELLED"] as const;

const w = (v?: bigint) => (v === undefined ? undefined : Number(v) / 1e18);

/** RiskOracle view for one asset: CMC reference, the latest CMC snapshot, rule params and effective limits. */
export function useRisk(symbol: string | undefined) {
  const ro = addr(deployments97.core.riskOracle);
  const assetId = useMemo(() => (symbol ? keccak256(toBytes(symbol)) : undefined), [symbol]);
  const reads = useReadContracts({
    allowFailure: true,
    query: { enabled: !!ro && !!assetId, refetchInterval: 15_000 },
    contracts: assetId && ro
      ? [
          { address: ro, abi: RiskOracleAbi, functionName: "riskView", args: [assetId], chainId: bscTestnet.id },
          { address: ro, abi: RiskOracleAbi, functionName: "latestSnapshot", args: [assetId], chainId: bscTestnet.id },
          { address: ro, abi: RiskOracleAbi, functionName: "ruleParams", args: [assetId], chainId: bscTestnet.id },
        ]
      : [],
  });
  const r = reads.data;
  const view = r?.[0]?.status === "success" ? (r[0].result as RiskView) : undefined;
  const snap = r?.[1]?.status === "success" ? (r[1].result as Snapshot) : undefined;
  const rule = r?.[2]?.status === "success" ? (r[2].result as RiskParams) : undefined;
  return {
    ro,
    assetId,
    loading: reads.isLoading,
    refPrice: w(view?.refPrice),
    refTs: view ? Number(view.refTs) : undefined,
    maxDevBps: view ? Number(view.params.maxDevBps) : undefined,
    source: view?.source,
    snapshotId: view ? Number(view.snapshotId) : undefined,
    mintsPaused: view?.mintsPaused,
    effective: view ? { trigger: w(view.params.triggerLev)!, target: w(view.params.targetLev)!, lower: w(view.params.lowerTriggerLev)!, openFeeBps: Number(view.params.openFeeBps), closedFeeBps: Number(view.params.closedFeeBps), gapGuardSec: Number(view.params.gapGuardSec) } : undefined,
    rule: rule ? { trigger: w(rule.triggerLev)!, target: w(rule.targetLev)!, maxDevBps: Number(rule.maxDevBps), closedFeeBps: Number(rule.closedFeeBps), gapGuardSec: Number(rule.gapGuardSec) } : undefined,
    volBps: snap && snap.snapshotId > 0n ? Number(snap.volBps) : undefined,
    liqUsd: snap && snap.snapshotId > 0n ? w(snap.liqUsd) : undefined,
    premiumBps: snap && snap.snapshotId > 0n ? Number(snap.premiumBps) : undefined,
    cmcTs: snap && snap.snapshotId > 0n ? Number(snap.cmcTs) : undefined,
    responseHash: snap?.responseHash,
    latestSnapshotId: snap?.snapshotId,
  };
}

/** The newest AI agent proposal for an asset among the last 20 on the RiskOracle. */
export function useLatestProposal(symbol: string | undefined) {
  const ro = addr(deployments97.core.riskOracle);
  const count = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "proposalCount", chainId: bscTestnet.id, query: { enabled: !!ro, refetchInterval: 20_000 } });
  const agentIdOnChain = useReadContract({ address: ro, abi: RiskOracleAbi, functionName: "agentId", chainId: bscTestnet.id, query: { enabled: !!ro, staleTime: 600_000 } });
  const n = Number(count.data ?? 0n);
  const ids = useMemo(() => Array.from({ length: Math.min(20, n) }, (_, i) => BigInt(n - i)), [n]);
  const props = useReadContracts({
    allowFailure: true,
    query: { enabled: !!ro && ids.length > 0, refetchInterval: 20_000 },
    contracts: ids.map((id) => ({ address: ro!, abi: RiskOracleAbi, functionName: "proposal" as const, args: [id] as const, chainId: bscTestnet.id })),
  });
  const assetId = symbol ? keccak256(toBytes(symbol)) : undefined;
  let latest: { id: bigint; p: Proposal } | undefined;
  (props.data ?? []).forEach((r, i) => {
    if (latest || r.status !== "success") return;
    const p = r.result as unknown as Proposal;
    if (p.status !== 0 && (!assetId || p.assetId.toLowerCase() === assetId.toLowerCase())) latest = { id: ids[i], p };
  });
  const agentId = agentIdOnChain.data && agentIdOnChain.data > 0n ? agentIdOnChain.data.toString() : deployments97.erc8004.agentId ? String(deployments97.erc8004.agentId) : undefined;
  return { latest, total: n, agentId, loading: count.isLoading || props.isLoading };
}
