import { getAddress, zeroHash, type Address, type Hex } from "viem";
import { parseAbi } from "viem";
import { atlasMirrorAbi, atlasSingleFeedAbi, ATLAS_SINGLEFEED_UPDATE_TOPIC0 } from "../abi/index.js";
import { mirroredSymbols, oracleFor, testnet } from "../config/deployments.js";
import { alert } from "../lib/alerts.js";
import { hasLogsRpc, publicClient, signer } from "../lib/chains.js";
import { db } from "../lib/db.js";
import { errMsg, logger } from "../lib/log.js";
import { nowSec, rescale } from "../lib/math.js";
import { sendTx } from "../lib/tx.js";
import { SEC, type Job } from "./types.js";

const log = logger("atlas-mirror");

/**
 * atlas-mirror (15 s): copies each new mainnet Atlas SingleFeed round to its AtlasMirror on 97, with the source
 * block and tx hash so every Mirrored event can be paired with the mainnet Atlas update.
 * K_MIRROR is PUSHER on every mirror; the backup cron uses the backup PUSHER key under the same env name.
 */
const SEARCH_BLOCKS = 600n; // ~4.5 min of BSC mainnet blocks at 0.45 s; Atlas heartbeat is 60 s
/** Atlas MultiFeed (mainnet 0xEAcE…, TSLAB id 0x000003a5): fetch(id) -> (price, updatedAt, ?), 18 decimals. */
const atlasMultiFeedAbi = parseAbi(["function fetch(bytes4 id) view returns (uint256 price, uint256 updatedAt, uint256 aux)"]);

function multiFeedId(src: unknown): Hex | undefined {
  const id = (src as { feedId?: unknown } | undefined)?.feedId;
  return typeof id === "string" && /^0x[0-9a-fA-F]{8}$/.test(id) ? (id as Hex) : undefined;
}

const txCache = new Map<string, { block: bigint; tx: Hex }>();

async function findSourceTx(feed: Address, roundId: bigint, updatedAt: bigint): Promise<{ block: bigint; tx: Hex } | undefined> {
  const k = `${feed}:${roundId}`;
  const hit = txCache.get(k);
  if (hit) return hit;
  if (!hasLogsRpc("mainnet")) return undefined;
  const c = publicClient("mainnet", { logs: true });
  try {
    const head = await c.getBlockNumber();
    const logs = await c.getLogs({
      address: feed,
      fromBlock: head > SEARCH_BLOCKS ? head - SEARCH_BLOCKS : 0n,
      toBlock: head,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      topics: [ATLAS_SINGLEFEED_UPDATE_TOPIC0] as any,
    } as Parameters<typeof c.getLogs>[0]);
    if (logs.length === 0) return undefined;
    // The latest update log is the one for the latest round. Confirm by block time when there are several.
    let pick = logs[logs.length - 1];
    if (logs.length > 1) {
      for (const l of [...logs].reverse()) {
        const b = await c.getBlock({ blockNumber: l.blockNumber! });
        if (b.timestamp <= updatedAt + 3n) {
          pick = l;
          break;
        }
      }
    }
    const r = { block: pick.blockNumber!, tx: pick.transactionHash! };
    txCache.set(k, r);
    if (txCache.size > 500) txCache.delete(txCache.keys().next().value!);
    return r;
  } catch (e) {
    log.warn("source tx lookup failed", { feed, error: errMsg(e) });
    return undefined;
  }
}

export interface MirrorResult {
  symbol: string;
  action: "pushed" | "up-to-date" | "skipped" | "failed";
  srcRoundId?: string;
  answer?: string;
  ageSec?: number;
  tx?: Hex;
  reason?: string;
}

export async function mirrorOnce(dryRun = false): Promise<MirrorResult[]> {
  const d = testnet();
  const out: MirrorResult[] = [];
  if (!d) return [{ symbol: "*", action: "skipped", reason: "no testnet deployments" }];
  const main = publicClient("mainnet");
  const test = publicClient("testnet");
  const s = signer("mirror");
  for (const symbol of mirroredSymbols(d)) {
    const o = oracleFor(d, symbol)!;
    const mirror = o.mirror!;
    const feed = o.atlasSource?.feed;
    if (!feed) {
      out.push({ symbol, action: "skipped", reason: "no atlasSource.feed" });
      continue;
    }
    try {
      const feedId = multiFeedId(o.atlasSource);
      const [src, srcDec, mDec] = await Promise.all([
        feedId
          ? main
              .readContract({ address: feed, abi: atlasMultiFeedAbi, functionName: "fetch", args: [feedId] })
              .then(([price, ts]) => [ts, BigInt(price), ts, ts] as const)
          : main.readContract({ address: feed, abi: atlasSingleFeedAbi, functionName: "latestRoundData" }),
        main.readContract({ address: feed, abi: atlasSingleFeedAbi, functionName: "decimals" }),
        test.readContract({ address: mirror, abi: atlasMirrorAbi, functionName: "decimals" }),
      ]);
      const [srcRoundId, answer, startedAt, updatedAt] = src;
      const ageSec = nowSec() - Number(updatedAt);
      if (ageSec > 600) void alert(`atlas-stale-${symbol}`, `Atlas ${symbol} feed ${feed} is ${ageSec}s old`);
      let last: { id: bigint; updatedAt: bigint } | undefined;
      try {
        const [lid, round] = await test.readContract({ address: mirror, abi: atlasMirrorAbi, functionName: "latestRound" });
        last = { id: BigInt(lid), updatedAt: BigInt(round.srcUpdatedAt) };
      } catch {
        last = undefined; // no data yet
      }
      // The mainnet NVDAB SingleFeed reports roundId 1 on every update and the MultiFeed has no round id at all, so
      // the mirror (strictly increasing ids) is keyed by the source updatedAt whenever the source id does not move.
      const roundId = BigInt(srcRoundId) > (last?.id ?? 0n) ? BigInt(srcRoundId) : BigInt(updatedAt);
      if (last && last.id > 0n && (roundId <= last.id || updatedAt <= last.updatedAt)) {
        out.push({ symbol, action: "up-to-date", srcRoundId: roundId.toString(), ageSec });
        continue;
      }
      if (answer <= 0n) {
        out.push({ symbol, action: "skipped", reason: "non-positive source answer" });
        continue;
      }
      if (!s) {
        out.push({ symbol, action: "skipped", reason: "MIRROR_PRIVATE_KEY not set" });
        continue;
      }
      const srcTx = await findSourceTx(getAddress(feed), BigInt(roundId), updatedAt);
      const scaled = rescale(answer, Number(srcDec), Number(mDec));
      const r = await sendTx(
        s,
        "atlas-mirror",
        {
          address: mirror,
          abi: atlasMirrorAbi,
          functionName: "push",
          args: [scaled, roundId, startedAt, updatedAt, srcTx?.block ?? 0n, srcTx?.tx ?? zeroHash],
        },
        { dryRun, note: { symbol, srcFeed: feed } },
      );
      const sql = db();
      if (sql && !dryRun)
        await sql`insert into mirror_pushes (asset, mirror, src_feed, src_round_id, answer, src_updated_at, src_block, src_tx_hash, tx_hash, status, error)
                  values (${symbol}, ${mirror}, ${feed}, ${roundId.toString()}, ${scaled.toString()}, ${Number(updatedAt)}, ${srcTx ? Number(srcTx.block) : null},
                          ${srcTx?.tx ?? null}, ${r.hash ?? null}, ${r.ok ? "pushed" : "failed"}, ${r.ok ? null : (r.revert ?? r.error ?? null)})`;
      if (r.ok) {
        try {
          const halted = await test.readContract({ address: mirror, abi: atlasMirrorAbi, functionName: "halted" });
          if (halted) void alert(`mirror-halted-${symbol}`, `AtlasMirror ${symbol} is HALTED after round ${roundId} (mints paused; redeems open)`);
        } catch {
          /* informational */
        }
      }
      out.push({ symbol, action: r.ok ? "pushed" : "failed", srcRoundId: roundId.toString(), answer: scaled.toString(), ageSec, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) });
    } catch (e) {
      out.push({ symbol, action: "failed", reason: errMsg(e) });
    }
  }
  return out;
}

export const atlasMirrorJob: Job = {
  name: "mirror",
  everyMs: 15 * SEC,
  run: (ctx) => mirrorOnce(ctx.dryRun),
};
