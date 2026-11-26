import type { Address } from "viem";
import { logAnchorAbi } from "../abi/index.js";
import { testnet } from "../config/deployments.js";
import { signer, type Signer } from "../lib/chains.js";
import { db } from "../lib/db.js";
import { latestSeq, rangeRoot } from "../lib/hashlog.js";
import { sendTx } from "../lib/tx.js";
import { HOUR, type Job } from "./types.js";

/**
 * log-anchor (hourly on 97; daily on 56 via anchor-mainnet): Merkle root of the hash-chained log over
 * [LogAnchor.nextSeq(), latest seq] -> LogAnchor.anchor(root, fromSeq, toSeq). Ranges are contiguous on-chain.
 * The anchor tx itself is logged afterwards, so it lands in the next range.
 */
export async function anchorRange(s: Signer, anchor: Address, service: string, dryRun: boolean, maxEntries = 50_000) {
  const next = Number(await s.public.readContract({ address: anchor, abi: logAnchorAbi, functionName: "nextSeq" }));
  const last = await latestSeq();
  if (last === null || last < next) return { skipped: "no new log entries", nextSeq: next };
  const to = Math.min(last, next + maxEntries - 1);
  const { root, count } = await rangeRoot(next, to);
  const r = await sendTx(s, service, { address: anchor, abi: logAnchorAbi, functionName: "anchor", args: [root, BigInt(next), BigInt(to)] }, { dryRun, note: { fromSeq: next, toSeq: to } });
  const sql = db();
  if (sql && !dryRun)
    await sql`insert into anchors (chain_id, root, from_seq, to_seq, tx_hash, status)
              values (${s.wallet.chain.id}, ${root}, ${next}, ${to}, ${r.hash ?? null}, ${r.ok ? "anchored" : "failed"})`;
  return { chainId: s.wallet.chain.id, fromSeq: next, toSeq: to, count, root, ok: r.ok, tx: r.hash, reason: r.ok ? undefined : (r.revert ?? r.error) };
}

export async function logAnchorOnce(dryRun = false) {
  const anchor = testnet()?.core.logAnchor;
  if (!anchor) return { skipped: "no core.logAnchor in deployments" };
  const s = signer("anchor");
  if (!s) return { skipped: "ANCHOR_PRIVATE_KEY not set" };
  return anchorRange(s, anchor, "log-anchor", dryRun);
}

export const logAnchorJob: Job = { name: "anchor", everyMs: HOUR, needsDb: true, run: (ctx) => logAnchorOnce(ctx.dryRun) };
