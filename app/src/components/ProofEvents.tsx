"use client";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { bscTestnet } from "viem/chains";
import type { Abi, AbiEvent, Address } from "viem";
import { AtlasMirrorAbi, BackstopTreasuryAbi, BackstopVaultAbi, LeveragePoolAbi, OpenFourCoreAbi, RiskOracleAbi, SplitLauncherAbi } from "@/abi";
import { txUrl } from "@/config/chains";
import { addr, deployments97, oracleFor } from "@/config/deployments";
import { useRealMetas } from "@/hooks/usePools";
import { fmtTime, short } from "@/lib/format";
import { Card, useApi } from "./ui";

// The events that prove the story, newest first: Atlas price mirrored, CMC snapshot posted, AI agent proposal,
// sell zone fired, insurance vault defended a pool, Flap pool opened, Four.meme graduation executed. Source: the
// keeper's indexer when it is up, else a direct eth_getLogs over the latest blocks.
const NAMES = ["Mirrored", "CmcSnapshot", "AgentProposal", "SellZone", "Defended", "PoolOpened", "MigrateExecuted"] as const;
const WHAT: Record<string, string> = {
  Mirrored: "Atlas price mirrored from BSC mainnet",
  CmcSnapshot: "CMC snapshot posted to the RiskOracle",
  AgentProposal: "AI risk agent proposed stricter limits",
  SellZone: "Sell zone sold stock for USDC",
  Defended: "Insurance vault covered a pool shortfall",
  PoolOpened: "Flap launch opened the NVDA pool",
  MigrateExecuted: "Four.meme graduation opened the TSLA pool",
};
const LOOKBACK = 4_000n;

type Row = { name: string; tx: string; block?: bigint; time?: number; contract?: string };
type EventRow = { chain_id?: number; block_number?: string | number; block_time?: string | number; tx_hash?: string; name?: string; contract?: string };
const toSec = (t?: string | number) => (t === undefined ? undefined : typeof t === "number" ? (t > 1e12 ? Math.floor(t / 1000) : t) : Math.floor(Date.parse(t) / 1000));

function eventOf(abi: Abi | readonly unknown[], name: string): AbiEvent | undefined {
  return (abi as readonly { type: string; name?: string }[]).find((x) => x.type === "event" && x.name === name) as AbiEvent | undefined;
}

export function ProofEvents() {
  const client = usePublicClient({ chainId: bscTestnet.id });
  const { real } = useRealMetas();
  const api = useApi<{ events?: EventRow[] }>("/api/events/all?limit=200", 30_000);
  const indexed: Row[] = (api.data?.data?.events ?? [])
    .filter((e) => e.name && (NAMES as readonly string[]).includes(e.name) && e.tx_hash && (e.chain_id ?? 97) === 97)
    .map((e) => ({ name: e.name!, tx: e.tx_hash!, time: toSec(e.block_time), contract: e.contract }));

  const poolAddrs = [...deployments97.pools.map((p) => p.pool), ...real.map((m) => m.addresses?.pool)].filter((a): a is Address => !!a);
  const sources: { address: Address; event: AbiEvent }[] = [];
  const push = (a: Address | undefined, abi: Abi | readonly unknown[], name: string) => {
    const ev = eventOf(abi, name);
    if (a && ev) sources.push({ address: a, event: ev });
  };
  push(addr(oracleFor("NVDA")?.mirror), AtlasMirrorAbi, "Mirrored");
  push(addr(oracleFor("TSLA")?.mirror), AtlasMirrorAbi, "Mirrored");
  push(addr(deployments97.core.riskOracle), RiskOracleAbi, "CmcSnapshot");
  push(addr(deployments97.core.riskOracle), RiskOracleAbi, "AgentProposal");
  for (const l of deployments97.flap.launchers) push(addr(l.vault), BackstopVaultAbi, "Defended");
  push(addr(deployments97.openfour.backstopTreasury), BackstopTreasuryAbi, "Defended");
  for (const p of [...new Set(poolAddrs.map((a) => a.toLowerCase()))]) push(p as Address, LeveragePoolAbi, "SellZone");
  for (const l of deployments97.flap.launchers) push(addr(l.launcher), SplitLauncherAbi, "PoolOpened");
  push(addr(deployments97.openfour.core), OpenFourCoreAbi, "MigrateExecuted");

  const needChain = !api.isLoading && indexed.length === 0 && sources.length > 0;
  const chain = useQuery({
    queryKey: ["proof-logs", sources.map((s) => `${s.address}:${s.event.name}`).join(",")],
    enabled: needChain && !!client,
    refetchInterval: 60_000,
    queryFn: async (): Promise<{ rows: Row[]; from: bigint; error?: string }> => {
      const latest = await client!.getBlockNumber();
      const from = latest > LOOKBACK ? latest - LOOKBACK : 0n;
      const rows: Row[] = [];
      let error: string | undefined;
      await Promise.all(
        sources.map(async (s) => {
          try {
            const logs = await client!.getLogs({ address: s.address, event: s.event, fromBlock: from, toBlock: latest });
            for (const l of logs) rows.push({ name: s.event.name, tx: l.transactionHash ?? "", block: l.blockNumber ?? undefined, contract: s.address });
          } catch (e) {
            error = e instanceof Error ? e.message.split("\n")[0] : String(e);
          }
        }),
      );
      rows.sort((a, b) => Number((b.block ?? 0n) - (a.block ?? 0n)));
      return { rows, from, error };
    },
  });

  // Launch events also live in the address book (openTx / migrateTx), so they show even when the indexer or the
  // eth_getLogs window has not seen them.
  const known: Row[] = [
    ...deployments97.pools.filter((p) => p.kind === "flap" && !p.hidden && p.openTx).map((p) => ({ name: "PoolOpened", tx: p.openTx!, contract: p.openedBy })),
    ...(deployments97.openfour.tokens as { hidden?: boolean; migrateTx?: string | null }[]).filter((t) => !t.hidden && t.migrateTx).map((t) => ({ name: "MigrateExecuted", tx: t.migrateTx!, contract: undefined })),
  ];
  const base = indexed.length ? indexed : chain.data?.rows ?? [];
  const rows = [...base, ...known.filter((k) => !base.some((r) => r.name === k.name))];
  const latestOf = NAMES.map((n) => rows.find((r) => r.name === n));

  return (
    <Card
      title="On-chain events"
      right={<span className="text-xs text-muted">{indexed.length ? "from the keeper's indexer" : chain.data ? `eth_getLogs, last ${LOOKBACK.toString()} blocks` : ""}</span>}
    >
      <ul className="divide-y divide-line">
        {NAMES.map((n, i) => {
          const r = latestOf[i];
          const count = rows.filter((x) => x.name === n).length;
          return (
            <li key={n} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0">
                <span className="num text-[13px] font-medium text-ink">{n}</span>
                <span className="ml-2 text-xs text-muted">{WHAT[n]}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-xs">
                {r ? (
                  <>
                    <span className="text-muted">{r.time ? fmtTime(r.time) : r.block ? `block ${r.block}` : ""}{count > 1 ? ` · ${count} recent` : ""}</span>
                    {r.tx && (
                      <a className="num link" href={txUrl(r.tx)} target="_blank" rel="noreferrer">
                        {short(r.tx)} ↗
                      </a>
                    )}
                  </>
                ) : (
                  <span className="text-faint">{api.isLoading || chain.isLoading ? "Loading…" : "none yet"}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {chain.data?.error && !indexed.length && <p className="mt-2 text-[11px] text-faint">Some log queries failed on the public RPC ({chain.data.error.slice(0, 80)}).</p>}
    </Card>
  );
}
