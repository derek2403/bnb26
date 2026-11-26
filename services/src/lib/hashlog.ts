import { concat, keccak256, toBytes, type Hex } from "viem";
import type postgres from "postgres";
import { canonicalJSON, toJsonValue } from "./canonical.js";
import { db, type Sql } from "./db.js";
import { merkleProof, merkleRoot, type ProofStep } from "./merkle.js";

/**
 * Hash-chained verifiable log.
 *
 *   entry      = { seq, ts, service, kind, endpoint, params, http, cmcTs, creditCount, elapsedMs, bodyHash, txHash, chainId, data }
 *                (fields with no value are omitted, never null; ts is an ISO-8601 UTC string with ms)
 *   entryHash  = keccak256( prevHash ‖ utf8(canonicalJSON(entry)) )      prevHash of seq 0 = 0x00…00 (32 bytes)
 *
 * Merkle roots over entryHash for [fromSeq, toSeq] are anchored on LogAnchor (97 hourly, 56 daily).
 * seq is global across services (keeper, agent, api) and allocated under a Postgres advisory lock.
 */
export const GENESIS: Hex = `0x${"00".repeat(32)}`;
const LOCK_KEY = 0x5e1f_57c0; // pg_advisory_xact_lock key for appends

export interface LogInput {
  service: string;
  kind: "cmc" | "mcp" | "tx" | "snapshot" | "agent" | "mirror" | "anchor" | "note";
  endpoint?: string;
  params?: unknown;
  http?: number;
  cmcTs?: number;
  creditCount?: number;
  elapsedMs?: number;
  bodyHash?: Hex;
  txHash?: Hex;
  chainId?: number;
  data?: unknown;
}

export interface LogEntry extends LogInput {
  seq: number;
  ts: string;
}

export interface StoredEntry extends LogEntry {
  prevHash: Hex;
  entryHash: Hex;
}

export function entryBody(e: LogEntry): Record<string, unknown> {
  const o: Record<string, unknown> = { seq: e.seq, ts: e.ts, service: e.service, kind: e.kind };
  const opt = ["endpoint", "params", "http", "cmcTs", "creditCount", "elapsedMs", "bodyHash", "txHash", "chainId", "data"] as const;
  for (const k of opt) {
    const v = e[k];
    if (v !== undefined && v !== null) o[k] = toJsonValue(v);
  }
  return o;
}

export function computeEntryHash(prevHash: Hex, e: LogEntry): Hex {
  return keccak256(concat([toBytes(prevHash), toBytes(canonicalJSON(entryBody(e)))]));
}

// In-memory chain when there is no database (backup cron). Not anchorable, but keeps the same API.
const mem: StoredEntry[] = [];

export async function appendLog(input: LogInput): Promise<StoredEntry> {
  const sql = db();
  const ts = new Date().toISOString();
  if (!sql) {
    const prev = mem.at(-1);
    const e: LogEntry = { ...input, seq: prev ? prev.seq + 1 : 0, ts };
    const prevHash = prev?.entryHash ?? GENESIS;
    const stored = { ...e, prevHash, entryHash: computeEntryHash(prevHash, e) };
    mem.push(stored);
    if (mem.length > 5000) mem.shift();
    return stored;
  }
  return (await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    const last = await tx<{ seq: bigint; entry_hash: string }[]>`select seq, entry_hash from log_entries order by seq desc limit 1`;
    const seq = last[0] ? Number(last[0].seq) + 1 : 0;
    const prevHash = (last[0]?.entry_hash as Hex | undefined) ?? GENESIS;
    const e: LogEntry = { ...input, seq, ts };
    const entryHash = computeEntryHash(prevHash, e);
    const body = entryBody(e);
    await tx`insert into log_entries (seq, ts, service, kind, endpoint, params, http, cmc_ts, credit_count, elapsed_ms,
                                      body_hash, tx_hash, chain_id, data, prev_hash, entry_hash)
             values (${seq}, ${ts}, ${e.service}, ${e.kind}, ${e.endpoint ?? null},
                     ${body.params === undefined ? null : tx.json(body.params as postgres.JSONValue)},
                     ${e.http ?? null}, ${e.cmcTs ?? null}, ${e.creditCount ?? null}, ${e.elapsedMs ?? null},
                     ${e.bodyHash ?? null}, ${e.txHash ?? null}, ${e.chainId ?? null},
                     ${body.data === undefined ? null : tx.json(body.data as postgres.JSONValue)},
                     ${prevHash}, ${entryHash})`;
    return { ...e, prevHash, entryHash };
  })) as StoredEntry;
}

interface Row {
  seq: bigint;
  ts: Date;
  service: string;
  kind: string;
  endpoint: string | null;
  params: unknown;
  http: number | null;
  cmc_ts: bigint | null;
  credit_count: number | null;
  elapsed_ms: number | null;
  body_hash: string | null;
  tx_hash: string | null;
  chain_id: number | null;
  data: unknown;
  prev_hash: string;
  entry_hash: string;
}

export function rowToEntry(r: Row): StoredEntry {
  const e: StoredEntry = {
    seq: Number(r.seq),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    service: r.service,
    kind: r.kind as LogInput["kind"],
    prevHash: r.prev_hash as Hex,
    entryHash: r.entry_hash as Hex,
  };
  if (r.endpoint !== null) e.endpoint = r.endpoint;
  if (r.params !== null) e.params = r.params;
  if (r.http !== null) e.http = r.http;
  if (r.cmc_ts !== null) e.cmcTs = Number(r.cmc_ts);
  if (r.credit_count !== null) e.creditCount = r.credit_count;
  if (r.elapsed_ms !== null) e.elapsedMs = r.elapsed_ms;
  if (r.body_hash !== null) e.bodyHash = r.body_hash as Hex;
  if (r.tx_hash !== null) e.txHash = r.tx_hash as Hex;
  if (r.chain_id !== null) e.chainId = r.chain_id;
  if (r.data !== null) e.data = r.data;
  return e;
}

export async function entriesRange(fromSeq: number, toSeq: number, sql: Sql | null = db()): Promise<StoredEntry[]> {
  if (!sql) return mem.filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
  const rows = await sql<Row[]>`select * from log_entries where seq between ${fromSeq} and ${toSeq} order by seq asc`;
  return rows.map(rowToEntry);
}

export async function latestSeq(sql: Sql | null = db()): Promise<number | null> {
  if (!sql) return mem.at(-1)?.seq ?? null;
  const r = await sql<{ seq: bigint | null }[]>`select max(seq) as seq from log_entries`;
  return r[0]?.seq === null || r[0]?.seq === undefined ? null : Number(r[0].seq);
}

export async function entryBySeq(seq: number): Promise<StoredEntry | undefined> {
  return (await entriesRange(seq, seq))[0];
}

/** Recomputes the chain for a range. Returns the first bad seq, or null when every link and hash holds. */
export function verifyChain(entries: StoredEntry[], prevOfFirst?: Hex): number | null {
  let prev = prevOfFirst ?? entries[0]?.prevHash;
  for (const e of entries) {
    if (prev && e.prevHash.toLowerCase() !== prev.toLowerCase()) return e.seq;
    if (computeEntryHash(e.prevHash, e).toLowerCase() !== e.entryHash.toLowerCase()) return e.seq;
    prev = e.entryHash;
  }
  return null;
}

export async function rangeRoot(fromSeq: number, toSeq: number): Promise<{ root: Hex; count: number; entries: StoredEntry[] }> {
  const entries = await entriesRange(fromSeq, toSeq);
  if (entries.length !== toSeq - fromSeq + 1) throw new Error(`log range ${fromSeq}..${toSeq} has gaps (${entries.length} rows)`);
  const bad = verifyChain(entries);
  if (bad !== null) throw new Error(`log chain broken at seq ${bad}`);
  return { root: merkleRoot(entries.map((e) => e.entryHash)), count: entries.length, entries };
}

export async function proofFor(seq: number, fromSeq: number, toSeq: number): Promise<{ root: Hex; leaf: Hex; proof: ProofStep[] }> {
  const { root, entries } = await rangeRoot(fromSeq, toSeq);
  const idx = seq - fromSeq;
  return { root, leaf: entries[idx].entryHash, proof: merkleProof(entries.map((e) => e.entryHash), idx) };
}

/** Raw bodies are addressed by keccak256(bytes) and stored exactly as hashed. */
export async function storeRaw(hash: Hex, kind: string, body: Uint8Array | string, contentType = "application/json"): Promise<void> {
  const sql = db();
  if (!sql) return;
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  await sql`insert into raw_bodies (hash, kind, content_type, body) values (${hash.toLowerCase()}, ${kind}, ${contentType}, ${buf})
            on conflict (hash) do nothing`;
}

export async function loadRaw(hash: string): Promise<{ body: Buffer; contentType: string; kind: string } | undefined> {
  const sql = db();
  if (!sql) return undefined;
  const r = await sql<{ body: Buffer; content_type: string; kind: string }[]>`select body, content_type, kind from raw_bodies where hash = ${hash.toLowerCase()}`;
  return r[0] ? { body: r[0].body, contentType: r[0].content_type, kind: r[0].kind } : undefined;
}
