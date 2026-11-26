import { decodeEventLog, type Abi, type Address, type Log } from "viem";
import type postgres from "postgres";
import {
  atlasCmcAnchorAbi,
  atlasMirrorAbi,
  backstopTreasuryAbi,
  backstopVaultAbi,
  logAnchorAbi,
  leveragePoolAbi,
  openFourCoreAbi,
  poolFactoryAbi,
  riskOracleAbi,
  sandboxFactoryAbi,
  splitLauncherAbi,
  splitPoolMigrateModuleAbi,
  stabilityPoolAbi,
} from "../abi/index.js";
import { env } from "../config/env.js";
import { mainnet, testnet } from "../config/deployments.js";
import { toJsonValue } from "../lib/canonical.js";
import { hasLogsRpc, publicClient, type ChainKind } from "../lib/chains.js";
import { requireDb } from "../lib/db.js";
import { errMsg, logger } from "../lib/log.js";
import { listPools } from "../lib/pools.js";
import { SEC, type Job } from "./types.js";

const log = logger("indexer");

/**
 * indexer (stream, 10 s tick): events from 97 and 56 into Postgres so the browser never scans logs
 * (public mainnet RPCs reject eth_getLogs). Uses the keyed *_LOGS_RPC endpoints.
 * Kinds served by GET /events/:kind: mirror | risk | agent | pool | zone | launch | openfour | anchor | backstop |
 * factory | stability | cmcAnchor | sandbox | other.
 */
interface Watch {
  address: Address;
  label: string;
  kind: string;
  abi: Abi | readonly unknown[];
}

const NAME_KIND: Record<string, string> = {
  AgentProposal: "agent",
  ParamsApplied: "agent",
  Vetoed: "agent",
  ProposalCancelled: "agent",
  AgentRevoked: "agent",
  AgentRestored: "agent",
  AgentIdSet: "agent",
  SellZone: "zone",
  BuyZone: "zone",
  Donated: "backstop",
  Defended: "backstop",
  BufferValued: "backstop",
};

export const EVENT_KINDS = ["mirror", "risk", "agent", "pool", "zone", "launch", "openfour", "anchor", "backstop", "factory", "stability", "cmcAnchor", "sandbox", "other"] as const;

async function watches(kind: ChainKind): Promise<Watch[]> {
  const w: Watch[] = [];
  const add = (address: Address | undefined, label: string, k: string, abi: Abi | readonly unknown[]) => {
    if (address && !w.some((x) => x.address.toLowerCase() === address.toLowerCase())) w.push({ address, label, kind: k, abi });
  };
  if (kind === "testnet") {
    const d = testnet();
    if (!d) return w;
    add(d.core.riskOracle, "riskOracle", "risk", riskOracleAbi);
    add(d.core.poolFactory, "poolFactory", "factory", poolFactoryAbi);
    add(d.core.logAnchor, "logAnchor", "anchor", logAnchorAbi);
    add(d.core.sandboxFactory, "sandboxFactory", "sandbox", sandboxFactoryAbi);
    for (const [sym, o] of Object.entries(d.oracles ?? {})) if (o && typeof o === "object") add((o as { mirror?: Address }).mirror, `mirror:${sym}`, "mirror", atlasMirrorAbi);
    for (const p of await listPools({ includeFactory: true })) {
      add(p.address, `pool:${p.id}`, "pool", leveragePoolAbi);
      add(p.stabilityPool, `stability:${p.id}`, "stability", stabilityPoolAbi);
    }
    for (const l of d.flap?.launchers ?? []) {
      add(l.launcher, "splitLauncher", "launch", splitLauncherAbi);
      add(l.vault, "backstopVault", "backstop", backstopVaultAbi);
    }
    add(d.openfour?.core, "openfourCore", "openfour", openFourCoreAbi);
    add(d.openfour?.migrateModule, "splitPoolMigrateModule", "openfour", splitPoolMigrateModuleAbi);
    add(d.openfour?.backstopTreasury, "backstopTreasury", "backstop", backstopTreasuryAbi);
  } else {
    const d = mainnet();
    if (!d) return w;
    add(d.core.riskOracle, "riskOracle56", "risk", riskOracleAbi);
    add(d.core.logAnchor, "logAnchor56", "anchor", logAnchorAbi);
    add(d.mainnet?.atlasCmcAnchor, "atlasCmcAnchor", "cmcAnchor", atlasCmcAnchorAbi);
  }
  return w;
}

const blockTimes = new Map<string, bigint>();

async function blockTime(kind: ChainKind, n: bigint): Promise<bigint | undefined> {
  const k = `${kind}:${n}`;
  const hit = blockTimes.get(k);
  if (hit !== undefined) return hit;
  try {
    const b = await publicClient(kind).getBlock({ blockNumber: n });
    blockTimes.set(k, b.timestamp);
    if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value!);
    return b.timestamp;
  } catch {
    return undefined;
  }
}

async function indexChain(kind: ChainKind, maxRanges = 5) {
  const sql = requireDb();
  const e = env();
  const chainId = kind === "testnet" ? e.CHAIN_ID : e.MAINNET_CHAIN_ID;
  const ws = await watches(kind);
  if (ws.length === 0) return { chainId, skipped: "nothing to watch" };
  const c = publicClient(kind, { logs: true });
  const head = (await c.getBlockNumber()) - 2n;
  const cur = await sql<{ last_block: bigint }[]>`select last_block from indexer_cursors where chain_id = ${chainId} and name = 'all'`;
  const startEnv = kind === "testnet" ? e.INDEXER_START_BLOCK_97 : e.INDEXER_START_BLOCK_56;
  let from = cur[0] ? BigInt(cur[0].last_block) + 1n : startEnv ? BigInt(startEnv) : head - 5000n;
  if (from < 0n) from = 0n;
  const byAddr = new Map(ws.map((w) => [w.address.toLowerCase(), w]));
  let inserted = 0;
  let ranges = 0;
  while (from <= head && ranges < maxRanges) {
    const to = from + BigInt(e.INDEXER_MAX_RANGE) - 1n > head ? head : from + BigInt(e.INDEXER_MAX_RANGE) - 1n;
    // Public RPCs cap eth_getLogs addresses (publicnode: 10 per call), so query the watch list in batches.
    const logs: Log[] = [];
    const addrs = ws.map((w) => w.address);
    for (let i = 0; i < addrs.length; i += e.INDEXER_MAX_ADDRESSES) {
      const batch = addrs.slice(i, i + e.INDEXER_MAX_ADDRESSES);
      logs.push(...((await c.getLogs({ address: batch, fromBlock: from, toBlock: to } as Parameters<typeof c.getLogs>[0])) as Log[]));
    }
    logs.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
    const rows: Record<string, unknown>[] = [];
    for (const l of logs) {
      const w = byAddr.get(l.address.toLowerCase());
      if (!w || l.transactionHash === null || l.logIndex === null || l.blockNumber === null) continue;
      let name: string | null = null;
      let args: unknown = null;
      try {
        const dec = decodeEventLog({ abi: w.abi as Abi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
        name = dec.eventName ?? null;
        args = toJsonValue(dec.args ?? null);
      } catch {
        args = toJsonValue({ data: l.data, topics: l.topics });
      }
      rows.push({
        chain_id: chainId,
        block_number: Number(l.blockNumber),
        block_time: Number((await blockTime(kind, l.blockNumber)) ?? 0n) || null,
        tx_hash: l.transactionHash,
        log_index: l.logIndex,
        address: l.address.toLowerCase(),
        contract: w.label,
        kind: (name && NAME_KIND[name]) || w.kind,
        name,
        args: sql.json(args as postgres.JSONValue),
        topic0: l.topics[0] ?? null,
      });
    }
    await sql.begin(async (tx) => {
      if (rows.length)
        await tx`insert into events ${sql(rows as Record<string, postgres.SerializableParameter>[], "chain_id", "block_number", "block_time", "tx_hash", "log_index", "address", "contract", "kind", "name", "args", "topic0")}
                 on conflict (chain_id, tx_hash, log_index) do nothing`;
      await tx`insert into indexer_cursors (chain_id, name, last_block, updated_at) values (${chainId}, 'all', ${Number(to)}, now())
               on conflict (chain_id, name) do update set last_block = excluded.last_block, updated_at = now()`;
    });
    inserted += rows.length;
    ranges++;
    from = to + 1n;
  }
  return { chainId, head: head.toString(), behind: (head - from + 1n).toString(), inserted, watching: ws.length };
}

export async function indexOnce() {
  const out: unknown[] = [];
  for (const kind of ["testnet", "mainnet"] as ChainKind[]) {
    if (kind === "mainnet" && !hasLogsRpc("mainnet")) {
      out.push({ chain: "mainnet", skipped: "BSC_MAINNET_LOGS_RPC not set (public RPCs reject eth_getLogs)" });
      continue;
    }
    try {
      out.push(await indexChain(kind));
    } catch (e) {
      log.warn("index failed", { kind, error: errMsg(e) });
      out.push({ chain: kind, error: errMsg(e) });
    }
  }
  return out;
}

export const indexerJob: Job = { name: "indexer", everyMs: 10 * SEC, needsDb: true, run: () => indexOnce() };
