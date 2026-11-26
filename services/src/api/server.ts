import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Hex } from "viem";
import { z } from "zod";
import { env } from "../config/env.js";
import { mainnet, testnet } from "../config/deployments.js";
import { registrationJson } from "../agent/erc8004.js";
import { runStewardAll } from "../agent/steward.js";
import { runBacktest } from "../backtest/backtest.js";
import { db } from "../lib/db.js";
import { governorState } from "../lib/governor.js";
import { entriesRange, latestSeq, loadRaw, verifyChain } from "../lib/hashlog.js";
import { merkleProof, merkleRoot } from "../lib/merkle.js";
import { errMsg, logger } from "../lib/log.js";
import { jobStatuses, runJobOnce } from "../lib/scheduler.js";
import { dbSource, verifySnapshot } from "../lib/verify.js";
import { selectJobs } from "../jobs/index.js";
import { EVENT_KINDS } from "../jobs/indexer.js";
import { walletBalances } from "../jobs/health.js";
import { readState } from "./state.js";

const log = logger("api");

/**
 * Services API (Fastify). Reads are public and rate-limited (the Next.js app proxies them with 10–60 s caching);
 * every write route needs `Authorization: Bearer <KEEPER_TOKEN>`. Nothing here ever returns a secret.
 */
function replacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

function cached<T>(ttlMs: number, fn: (key: string) => Promise<T>) {
  const m = new Map<string, { at: number; v: Promise<T> }>();
  return (key = "") => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v;
    const v = fn(key).catch((e) => {
      m.delete(key);
      throw e;
    });
    m.set(key, { at: Date.now(), v });
    if (m.size > 500) m.delete(m.keys().next().value!);
    return v;
  };
}

function requireToken(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = env().KEEPER_TOKEN;
  if (!token) {
    void reply.code(503).send({ error: "writes disabled: KEEPER_TOKEN not configured" });
    return false;
  }
  const h = req.headers.authorization ?? "";
  const given = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    void reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

const hashParam = z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
const intQ = (def: number, maxV: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Math.min(maxV, Math.max(0, Number.parseInt(v, 10) || 0))));

export async function buildServer() {
  const e = env();
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 64 * 1024 });
  app.setReplySerializer((payload) => JSON.stringify(payload, replacer));
  await app.register(cors, { origin: e.CORS_ORIGINS === "*" ? true : e.CORS_ORIGINS.split(",").map((s) => s.trim()) });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("route error", { error: errMsg(err) });
    void reply.code(status).send({ error: status >= 500 ? "internal error" : errMsg(err) });
  });

  const stateCache = cached(10_000, () => readState());
  const verifyCache = cached(60_000, async (k) => {
    const [tx, chain] = k.split("|");
    return verifySnapshot(tx as Hex, Number(chain), dbSource);
  });
  const backtestCache = cached(10 * 60_000, async (k) => runBacktest({ days: Number(k) || 30 }));

  // ---------------------------------------------------------------- health
  app.get("/healthz", async () => {
    let dbOk = false;
    const sql = db();
    if (sql) {
      try {
        await sql`select 1`;
        dbOk = true;
      } catch {
        dbOk = false;
      }
    }
    const jobs = await jobStatuses().catch(() => []);
    const mirror = jobs.find((j) => j.job === "mirror");
    const keeperOnline = Boolean(mirror?.lastOkAt && Date.now() - Date.parse(mirror.lastOkAt) < 3 * 60_000);
    return {
      ok: true,
      db: sql ? dbOk : "disabled",
      keeperOnline,
      jobs,
      wallets: await walletBalances().catch(() => []),
      governor: await governorState().catch(() => undefined),
      deployments: { testnet: testnet()?.updatedAt ?? null, mainnet: mainnet()?.updatedAt ?? null },
      config: {
        cmcKey: Boolean(e.CMC_API_KEY),
        mcpKey: Boolean(e.CMC_MCP_API_KEY ?? e.CMC_API_KEY),
        llmKey: Boolean(e.PHALA_AI_API_KEY ?? e.LLM_API_KEY),
        atlasKey: Boolean(e.ATLAS_API_KEY),
        mainnetLogsRpc: Boolean(e.BSC_MAINNET_LOGS_RPC),
        agentModel: e.AGENT_MODEL,
      },
    };
  });

  // ---------------------------------------------------------------- state + risk
  app.get("/state", async () => stateCache());

  app.get("/risk/latest", async () => {
    const s = await stateCache();
    return { at: s.at, risk: s.risk, cmc: s.cmc, calendar: s.calendar };
  });

  app.get("/risk/snapshots", async (req) => {
    const q = z.object({ asset: z.string().optional(), chain: z.string().optional(), limit: intQ(100, 1000) }).parse(req.query);
    const sql = db();
    if (!sql) return { snapshots: [] };
    const rows = await sql`select * from risk_snapshots
      where (${q.asset ?? null}::text is null or asset = ${q.asset ?? null})
        and (${q.chain ? Number(q.chain) : null}::int is null or chain_id = ${q.chain ? Number(q.chain) : null})
      order by id desc limit ${q.limit}`;
    return { snapshots: rows };
  });

  app.get("/risk/snapshot/:snapshotId", async (req, reply) => {
    const { snapshotId } = z.object({ snapshotId: z.string().regex(/^\d+$/) }).parse(req.params);
    const sql = db();
    if (!sql) return reply.code(404).send({ error: "no database" });
    const rows = await sql`select * from risk_snapshots where snapshot_id = ${snapshotId} order by id asc`;
    const [entry] = await entriesRange(Number(snapshotId), Number(snapshotId));
    if (!rows.length && !entry) return reply.code(404).send({ error: "unknown snapshot" });
    return { snapshotId, posts: rows, logEntry: entry };
  });

  app.get("/risk/raw/:hash", async (req, reply) => {
    const { hash } = hashParam.parse(req.params);
    if (!e.SERVE_RAW_BODIES) return reply.code(403).send({ error: "raw bodies are not served outside the judging window" });
    const r = await loadRaw(hash);
    if (!r || r.kind !== "cmc") return reply.code(404).send({ error: "unknown body" });
    return reply.header("content-type", r.contentType).header("x-body-hash", hash).send(r.body);
  });

  app.get("/risk/verify/:tx", async (req) => {
    const { tx } = z.object({ tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.params);
    const { chain } = z.object({ chain: z.string().optional() }).parse(req.query);
    return verifyCache(`${tx}|${chain ?? e.CHAIN_ID}`);
  });

  // ---------------------------------------------------------------- agent
  app.get("/agent/proposals", async (req) => {
    const q = z.object({ asset: z.string().optional(), limit: intQ(50, 500) }).parse(req.query);
    const sql = db();
    if (!sql) return { runs: [], events: [] };
    const runs = await sql`select id, asset, started_at, finished_at, model, served_model, inputs_hash, output_hash, model_id_hash, validated,
                                  classification, status, tx_hash, proposal_id, applied, error
                           from agent_runs where (${q.asset ?? null}::text is null or asset = ${q.asset ?? null})
                           order by id desc limit ${q.limit}`;
    const events = await sql`select chain_id, block_number, block_time, tx_hash, log_index, name, args from events
                             where kind = 'agent' order by block_number desc, log_index desc limit ${q.limit * 3}`;
    return { runs, events };
  });

  app.get("/agent/runs/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const sql = db();
    if (!sql) return reply.code(404).send({ error: "no database" });
    const r = await sql`select * from agent_runs where id = ${id}`;
    if (!r.length) return reply.code(404).send({ error: "unknown run" });
    return r[0];
  });

  app.get("/agent/raw/:hash", async (req, reply) => {
    const { hash } = hashParam.parse(req.params);
    const r = await loadRaw(hash);
    if (!r || !["agent_input", "agent_output", "mcp"].includes(r.kind)) return reply.code(404).send({ error: "unknown hash" });
    if (r.kind === "mcp" && !e.SERVE_RAW_BODIES) return reply.code(403).send({ error: "MCP bodies are not served outside the judging window" });
    return reply.header("content-type", r.kind === "agent_input" || r.kind === "mcp" ? "application/json" : "application/json; charset=utf-8").header("x-body-hash", hash).send(r.body);
  });

  app.get("/agent/registration.json", async (req) => {
    const { chain } = z.object({ chain: z.string().optional() }).parse(req.query);
    return registrationJson(Number(chain ?? e.CHAIN_ID));
  });

  app.post("/agent/run", async (req, reply) => {
    if (!requireToken(req, reply)) return reply;
    const b = z.object({ asset: z.string().optional(), dryRun: z.boolean().optional() }).parse(req.body ?? {});
    return { results: await runStewardAll({ dryRun: b.dryRun, assets: b.asset ? [b.asset] : undefined }) };
  });

  // ---------------------------------------------------------------- events
  app.get("/events/:kind", async (req, reply) => {
    const { kind } = z.object({ kind: z.string() }).parse(req.params);
    if (kind !== "all" && !(EVENT_KINDS as readonly string[]).includes(kind)) return reply.code(400).send({ error: `kind must be one of all, ${EVENT_KINDS.join(", ")}` });
    const q = z.object({ chain: z.string().optional(), name: z.string().optional(), contract: z.string().optional(), before: z.string().optional(), limit: intQ(100, 1000) }).parse(req.query);
    const sql = db();
    if (!sql) return { events: [] };
    const chain = q.chain ? Number(q.chain) : null;
    const before = q.before ? Number(q.before) : null;
    const rows = await sql`select chain_id, block_number, block_time, tx_hash, log_index, address, contract, kind, name, args from events
      where (${kind} = 'all' or kind = ${kind})
        and (${chain}::int is null or chain_id = ${chain})
        and (${q.name ?? null}::text is null or name = ${q.name ?? null})
        and (${q.contract ?? null}::text is null or contract = ${q.contract ?? null})
        and (${before}::bigint is null or block_number < ${before})
      order by block_number desc, log_index desc limit ${q.limit}`;
    return { events: rows };
  });

  // ---------------------------------------------------------------- verifiable log
  app.get("/logs/entries", async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), limit: intQ(200, 2000) }).parse(req.query);
    const last = (await latestSeq()) ?? -1;
    const to = q.to !== undefined ? Number(q.to) : last;
    const from = q.from !== undefined ? Number(q.from) : Math.max(0, to - q.limit + 1);
    const capTo = Math.min(to, from + 1999);
    const entries = capTo >= from ? await entriesRange(from, capTo) : [];
    return { latestSeq: last, from, to: capTo, chainOk: verifyChain(entries) === null, entries };
  });

  app.get("/logs/entry/:seq", async (req, reply) => {
    const { seq } = z.object({ seq: z.string().regex(/^\d+$/) }).parse(req.params);
    const [entry] = await entriesRange(Number(seq), Number(seq));
    if (!entry) return reply.code(404).send({ error: "unknown seq" });
    return entry;
  });

  app.get("/logs/raw/:hash", async (req, reply) => {
    const { hash } = hashParam.parse(req.params);
    const r = await loadRaw(hash);
    if (!r) return reply.code(404).send({ error: "unknown hash" });
    if ((r.kind === "cmc" || r.kind === "mcp") && !e.SERVE_RAW_BODIES) return reply.code(403).send({ error: "raw bodies are not served outside the judging window" });
    return reply.header("content-type", r.contentType).header("x-body-hash", hash).send(r.body);
  });

  app.get("/logs/anchors", async () => {
    const sql = db();
    if (!sql) return { anchors: [] };
    return { anchors: await sql`select * from anchors order by id desc limit 500` };
  });

  app.get("/logs/proof/:seq", async (req, reply) => {
    const { seq } = z.object({ seq: z.string().regex(/^\d+$/) }).parse(req.params);
    const n = Number(seq);
    const sql = db();
    if (!sql) return reply.code(404).send({ error: "no database" });
    const a = await sql<{ chain_id: number; root: string; from_seq: bigint; to_seq: bigint; tx_hash: string | null }[]>`
      select chain_id, root, from_seq, to_seq, tx_hash from anchors where status = 'anchored' and from_seq <= ${n} and to_seq >= ${n} order by id desc limit 1`;
    if (!a.length) return reply.code(404).send({ error: "seq not anchored yet" });
    const from = Number(a[0].from_seq);
    const to = Number(a[0].to_seq);
    const entries = await entriesRange(from, to);
    const leaves = entries.map((x) => x.entryHash);
    return {
      seq: n,
      entry: entries[n - from],
      anchor: { chainId: a[0].chain_id, root: a[0].root, fromSeq: from, toSeq: to, tx: a[0].tx_hash },
      recomputedRoot: merkleRoot(leaves),
      proof: merkleProof(leaves, n - from),
      rule: "parent = keccak256(left ‖ right); an odd last node is promoted unchanged; entryHash = keccak256(prevHash ‖ utf8(canonicalJSON(entry)))",
    };
  });

  app.get("/logs/export.jsonl", async (_req, reply) => {
    const last = await latestSeq();
    reply.header("content-type", "application/x-ndjson");
    if (last === null) return reply.send("");
    const lines: string[] = [];
    for (let from = 0; from <= last; from += 2000) {
      for (const en of await entriesRange(from, Math.min(last, from + 1999))) lines.push(JSON.stringify(en, replacer));
    }
    return reply.send(lines.join("\n") + "\n");
  });

  // ---------------------------------------------------------------- CMC usage
  app.get("/cmc/usage", async () => {
    const sql = db();
    const governor = await governorState();
    if (!sql) return { governor };
    const keyInfo = await sql`select ts, body_hash, credits_used_day, credits_used_month, credits_left_month, credit_limit_monthly, rate_limit_minute, summed_credit_count
                              from key_info order by id desc limit 200`;
    const start = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const perEndpoint = await sql`select endpoint, count(*)::int as calls, coalesce(sum(credit_count), 0)::int as credits,
                                         count(*) filter (where http <> 200)::int as errors
                                  from log_entries where kind in ('cmc', 'mcp') and ts >= ${start} group by endpoint order by credits desc`;
    return { governor, today: perEndpoint, keyInfo };
  });

  // ---------------------------------------------------------------- backtest
  app.get("/backtest", async (req) => {
    const q = z.object({ days: intQ(30, 30) }).parse(req.query);
    return backtestCache(String(q.days || 30));
  });

  // ---------------------------------------------------------------- keeper writes
  app.post("/keeper/run", async (req, reply) => {
    if (!requireToken(req, reply)) return reply;
    const b = z.object({ jobs: z.array(z.string()).min(1), dryRun: z.boolean().optional(), force: z.boolean().optional() }).parse(req.body ?? {});
    const jobs = selectJobs(b.jobs);
    const results: Record<string, unknown> = {};
    for (const j of jobs) results[j.name] = await runJobOnce(j, { dryRun: Boolean(b.dryRun), force: Boolean(b.force) });
    return { results };
  });

  return app;
}

export async function startApi(signal?: AbortSignal) {
  const e = env();
  const app = await buildServer();
  await app.listen({ host: e.API_HOST, port: e.API_PORT });
  log.info("api listening", { host: e.API_HOST, port: e.API_PORT });
  signal?.addEventListener("abort", () => void app.close(), { once: true });
  return app;
}
