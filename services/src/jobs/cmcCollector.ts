import type postgres from "postgres";
import { cmcAsset, type CmcAsset } from "../config/assets.js";
import { env } from "../config/env.js";
import { riskSymbols, testnet } from "../config/deployments.js";
import { marketCalendarAbi } from "../abi/index.js";
import { toJsonValue } from "../lib/canonical.js";
import {
  cmcGet,
  parseCandles,
  parseDexPrice,
  parseFearGreed,
  parseInfoIds,
  parseKeyInfo,
  parsePools,
  parseQuotePrice,
  parseQuotesHistorical,
  parseRwa,
  type Candle,
  type CmcResult,
} from "../lib/cmc.js";
import { publicClient } from "../lib/chains.js";
import { db, kvGet, kvSet } from "../lib/db.js";
import { allow, creditsUsedToday, governorState, noteKeyInfo, type Priority } from "../lib/governor.js";
import { errMsg, logger } from "../lib/log.js";
import { HOUR, MIN, SEC, type Job } from "./types.js";

const log = logger("cmc-collector");

/**
 * cmc-collector: the endpoint table from the plan, each with its cadence, priority and est. credits.
 *
 *  task         endpoint                                          cadence                 effect
 *  dex_price    /v1/dex/token/price?platform=bsc&address=<tok>    6 min (others 12 min)   refPrice (breaker); `l` -> maxSellChunk
 *  kline        /v1/k-line/candles?platform=bsc&address=<tok>&interval=1h   hourly        σ -> trigger
 *  quotes       /v3/cryptocurrency/quotes/latest?id=40215[,40214] 15 min                  second reference (median)
 *  rwa          /v5/real-world-assets/quotes/latest?rwa_id=2     15 min open / 1 h closed  premiumBps -> open fee
 *  pools        /v1/dex/token/pools?platform=bsc&address=<tok>    hourly                  liquidity cross-check; Four.Meme pools evidence
 *  quotes_hist  /v3/cryptocurrency/quotes/historical?id=…         daily                   σ backfill / backtest
 *  backtest     /v1/k-line/candles … limit=720                    daily                   30-day backtest candles
 *  info         /v2/cryptocurrency/info?address=<tok>             startup (≤ daily)       resolve ids
 *  fear_greed   /v3/fear-and-greed/latest                         3 h                     agent input only
 *  key_info     /v1/key/info                                      hourly (0 credits)      usage proof + governor
 *
 *  /v2/cryptocurrency/ohlcv/historical is NOT used: error 1006 on the free plan.
 */
export type CmcKind = "dex_price" | "kline" | "quotes" | "rwa" | "pools" | "quotes_hist" | "backtest" | "info" | "fear_greed" | "key_info";

export interface Latest {
  kind: CmcKind;
  key: string;
  parsed: Record<string, unknown>;
  bodyHash: string;
  logSeq?: number;
  cmcTs?: number;
  fetchedAt: string;
}

const memLatest = new Map<string, Latest>();

async function saveLatest(kind: CmcKind, key: string, r: CmcResult, parsed: Record<string, unknown>) {
  const l: Latest = { kind, key, parsed, bodyHash: r.bodyHash, logSeq: r.logSeq, cmcTs: r.status.timestampMs, fetchedAt: new Date().toISOString() };
  memLatest.set(`${kind}:${key}`, l);
  const sql = db();
  if (!sql) return;
  await sql`insert into cmc_latest (kind, key, parsed, body_hash, log_seq, cmc_ts, fetched_at)
            values (${kind}, ${key}, ${sql.json(toJsonValue(parsed) as postgres.JSONValue)}, ${r.bodyHash}, ${r.logSeq ?? null}, ${r.status.timestampMs ?? null}, now())
            on conflict (kind, key) do update set parsed = excluded.parsed, body_hash = excluded.body_hash, log_seq = excluded.log_seq,
              cmc_ts = excluded.cmc_ts, fetched_at = excluded.fetched_at`;
}

export async function getLatest(kind: CmcKind, key: string): Promise<Latest | undefined> {
  const sql = db();
  if (!sql) return memLatest.get(`${kind}:${key}`);
  const rows = await sql<{ parsed: Record<string, unknown>; body_hash: string; log_seq: bigint | null; cmc_ts: bigint | null; fetched_at: Date }[]>`
    select parsed, body_hash, log_seq, cmc_ts, fetched_at from cmc_latest where kind = ${kind} and key = ${key}`;
  const r = rows[0];
  if (!r) return undefined;
  return {
    kind,
    key,
    parsed: r.parsed,
    bodyHash: r.body_hash,
    logSeq: r.log_seq === null ? undefined : Number(r.log_seq),
    cmcTs: r.cmc_ts === null ? undefined : Number(r.cmc_ts),
    fetchedAt: r.fetched_at.toISOString(),
  };
}

export async function allLatest(): Promise<Latest[]> {
  const sql = db();
  if (!sql) return [...memLatest.values()];
  const rows = await sql<{ kind: CmcKind; key: string; parsed: Record<string, unknown>; body_hash: string; log_seq: bigint | null; cmc_ts: bigint | null; fetched_at: Date }[]>`
    select * from cmc_latest order by kind, key`;
  return rows.map((r) => ({
    kind: r.kind,
    key: r.key,
    parsed: r.parsed,
    bodyHash: r.body_hash,
    logSeq: r.log_seq === null ? undefined : Number(r.log_seq),
    cmcTs: r.cmc_ts === null ? undefined : Number(r.cmc_ts),
    fetchedAt: r.fetched_at.toISOString(),
  }));
}

async function saveCandles(asset: string, interval: string, candles: Candle[]) {
  const sql = db();
  if (!sql || candles.length === 0) return;
  const rows = candles.map((c) => ({ asset, interval, ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sql`insert into candles ${sql(chunk, "asset", "interval", "ts", "o", "h", "l", "c", "v")}
              on conflict (asset, interval, ts) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`;
  }
}

export async function loadCandles(asset: string, interval = "1h", sinceSec = 0): Promise<Candle[]> {
  const sql = db();
  if (!sql) {
    const m = memLatest.get(`kline:${asset}`);
    return ((m?.parsed.candles as Candle[] | undefined) ?? []).filter((c) => c.ts >= sinceSec);
  }
  const rows = await sql<{ ts: bigint; o: number; h: number; l: number; c: number; v: number }[]>`
    select ts, o, h, l, c, v from candles where asset = ${asset} and interval = ${interval} and ts >= ${sinceSec} order by ts asc`;
  return rows.map((r) => ({ ts: Number(r.ts), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
}

// ------------------------------------------------------------------ market hours (for the RWA cadence)

let marketCache: { at: number; open: boolean } | undefined;
export async function marketOpenNow(): Promise<boolean> {
  if (marketCache && Date.now() - marketCache.at < 60_000) return marketCache.open;
  const cal = testnet()?.core.marketCalendar;
  let open = false;
  if (cal) {
    try {
      open = await publicClient("testnet").readContract({ address: cal, abi: marketCalendarAbi, functionName: "isOpen", args: [BigInt(Math.floor(Date.now() / 1000))] });
    } catch {
      open = false; // a failed calendar read means closed (same rule as the pool)
    }
  }
  marketCache = { at: Date.now(), open };
  return open;
}

// ------------------------------------------------------------------ tasks

interface Task {
  id: string; // kv cadence key
  kind: CmcKind;
  key: string;
  cadenceMs: number | (() => Promise<number>);
  priority: Priority;
  estCredits: number;
  exec: () => Promise<CmcResult | undefined>;
}

function assets(): CmcAsset[] {
  const syms = riskSymbols(testnet());
  const list = (syms.length ? syms : ["NVDA"]).map((s) => cmcAsset(s)).filter((a): a is CmcAsset => Boolean(a));
  return list;
}

function tasks(): Task[] {
  const out: Task[] = [];
  const as = assets();
  for (const a of as) {
    if (a.token) {
      const token = a.token;
      out.push({
        id: `dex_price:${a.symbol}`,
        kind: "dex_price",
        key: a.symbol,
        cadenceMs: a.primary ? 6 * MIN : 12 * MIN,
        priority: "essential",
        estCredits: 1,
        exec: async () => {
          const r = await cmcGet("/v1/dex/token/price", { platform: "bsc", address: token }, { service: "cmc-collector" });
          if (r.ok) await saveLatest("dex_price", a.symbol, r, { ...parseDexPrice(r.data), token });
          return r;
        },
      });
      out.push({
        id: `kline:${a.symbol}`,
        kind: "kline",
        key: a.symbol,
        cadenceMs: HOUR,
        priority: "normal",
        estCredits: 2,
        exec: async () => {
          const r = await cmcGet("/v1/k-line/candles", { platform: "bsc", address: token, interval: "1h", limit: 168 }, { service: "cmc-collector" });
          if (r.ok) {
            const candles = parseCandles(r.data);
            await saveCandles(a.symbol, "1h", candles);
            await saveLatest("kline", a.symbol, r, { count: candles.length, lastTs: candles.at(-1)?.ts, lastClose: candles.at(-1)?.c, candles: db() ? undefined : candles });
          }
          return r;
        },
      });
      if (a.primary) {
        out.push({
          id: `pools:${a.symbol}`,
          kind: "pools",
          key: a.symbol,
          cadenceMs: HOUR,
          priority: "optional",
          estCredits: 1,
          exec: async () => {
            const r = await cmcGet("/v1/dex/token/pools", { platform: "bsc", address: token }, { service: "cmc-collector" });
            if (r.ok) await saveLatest("pools", a.symbol, r, parsePools(r.data));
            return r;
          },
        });
        out.push({
          id: `backtest:${a.symbol}`,
          kind: "backtest",
          key: a.symbol,
          cadenceMs: 24 * HOUR,
          priority: "optional",
          estCredits: 8,
          exec: async () => {
            const r = await cmcGet("/v1/k-line/candles", { platform: "bsc", address: token, interval: "1h", limit: 720 }, { service: "cmc-collector" });
            if (r.ok) {
              const candles = parseCandles(r.data);
              await saveCandles(a.symbol, "1h", candles);
              await saveLatest("backtest", a.symbol, r, { count: candles.length, firstTs: candles[0]?.ts, lastTs: candles.at(-1)?.ts });
            }
            return r;
          },
        });
        out.push({
          id: `info:${a.symbol}`,
          kind: "info",
          key: a.symbol,
          cadenceMs: 24 * HOUR,
          priority: "optional",
          estCredits: 1,
          exec: async () => {
            const r = await cmcGet("/v2/cryptocurrency/info", { address: token }, { service: "cmc-collector" });
            if (r.ok) await saveLatest("info", a.symbol, r, { ids: parseInfoIds(r.data), expectedId: a.cmcId });
            return r;
          },
        });
      }
    }
    if (a.rwaId !== undefined) {
      const rwaId = a.rwaId;
      out.push({
        id: `rwa:${a.symbol}`,
        kind: "rwa",
        key: a.symbol,
        cadenceMs: async () => ((await marketOpenNow()) ? 15 * MIN : HOUR),
        priority: "normal",
        estCredits: 1,
        exec: async () => {
          const r = await cmcGet("/v5/real-world-assets/quotes/latest", { rwa_id: rwaId }, { service: "cmc-collector" });
          if (r.ok) await saveLatest("rwa", a.symbol, r, parseRwa(r.data, a.cmcId));
          return r;
        },
      });
    }
  }
  if (as.length) {
    const ids = as.map((a) => a.cmcId);
    out.push({
      id: "quotes:*",
      kind: "quotes",
      key: "*",
      cadenceMs: 15 * MIN,
      priority: "essential",
      estCredits: 1,
      exec: async () => {
        const r = await cmcGet("/v3/cryptocurrency/quotes/latest", { id: ids.join(",") }, { service: "cmc-collector" });
        if (r.ok) {
          for (const a of as) await saveLatest("quotes", a.symbol, r, { id: a.cmcId, ...parseQuotePrice(r.data, a.cmcId) });
        }
        return r;
      },
    });
    const primary = as.find((a) => a.primary) ?? as[0];
    out.push({
      id: `quotes_hist:${primary.symbol}`,
      kind: "quotes_hist",
      key: primary.symbol,
      cadenceMs: 24 * HOUR,
      priority: "optional",
      estCredits: 1,
      exec: async () => {
        const r = await cmcGet("/v3/cryptocurrency/quotes/historical", { id: primary.cmcId, interval: "1h", count: 96 }, { service: "cmc-collector" });
        if (r.ok) {
          const pts = parseQuotesHistorical(r.data, primary.cmcId);
          await saveLatest("quotes_hist", primary.symbol, r, { count: pts.length, firstTs: pts[0]?.ts, lastTs: pts.at(-1)?.ts });
        }
        return r;
      },
    });
  }
  out.push({
    id: "fear_greed:*",
    kind: "fear_greed",
    key: "*",
    cadenceMs: 3 * HOUR,
    priority: "optional",
    estCredits: 1,
    exec: async () => {
      const r = await cmcGet("/v3/fear-and-greed/latest", {}, { service: "cmc-collector" });
      if (r.ok) await saveLatest("fear_greed", "*", r, parseFearGreed(r.data));
      return r;
    },
  });
  out.push({
    id: "key_info:*",
    kind: "key_info",
    key: "*",
    cadenceMs: HOUR,
    priority: "essential",
    estCredits: 0,
    exec: keyInfoOnce,
  });
  return out;
}

/** /v1/key/info (0 credits): usage proof, reconciled against our own Σ credit_count. */
export async function keyInfoOnce(): Promise<CmcResult> {
  const r = await cmcGet("/v1/key/info", {}, { service: "cmc-collector" });
  if (!r.ok) return r;
  const k = parseKeyInfo(r.data);
  noteKeyInfo(k.creditsLeftMonth);
  const summed = await creditsUsedToday();
  await saveLatest("key_info", "*", r, { ...k, summedCreditCount: summed });
  const sql = db();
  if (sql)
    await sql`insert into key_info (body_hash, credits_used_day, credits_used_month, credits_left_month, credit_limit_monthly, rate_limit_minute, summed_credit_count, raw)
              values (${r.bodyHash}, ${k.creditsUsedDay ?? null}, ${k.creditsUsedMonth ?? null}, ${k.creditsLeftMonth ?? null}, ${k.creditLimitMonthly ?? null},
                      ${k.rateLimitMinute ?? null}, ${summed}, ${sql.json(toJsonValue(r.data ?? null) as postgres.JSONValue)})`;
  return r;
}

export interface CollectorResult {
  ran: { id: string; ok: boolean; http?: number; credits?: number; error?: string }[];
  skipped: { id: string; reason: string }[];
  governor: Awaited<ReturnType<typeof governorState>>;
}

export async function collectOnce(force = false, only?: CmcKind[]): Promise<CollectorResult> {
  const ran: CollectorResult["ran"] = [];
  const skipped: CollectorResult["skipped"] = [];
  if (!env().CMC_API_KEY) {
    return { ran, skipped: [{ id: "*", reason: "CMC_API_KEY not set" }], governor: await governorState() };
  }
  for (const t of tasks()) {
    if (only && !only.includes(t.kind)) continue;
    const g = await governorState();
    const base = typeof t.cadenceMs === "number" ? t.cadenceMs : await t.cadenceMs();
    const mult = t.estCredits === 0 ? 1 : g.multiplier;
    const lastKey = `cmc:last:${t.id}`;
    const last = (await kvGet<number>(lastKey)) ?? 0;
    if (!force && Date.now() - last < base * mult - 5 * SEC) continue;
    const a = await allow(t.estCredits, t.priority);
    if (!a.ok) {
      skipped.push({ id: t.id, reason: a.state.rateLimited ? "rate limited" : `budget ${a.state.mode}` });
      continue;
    }
    try {
      const r = await t.exec();
      await kvSet(lastKey, Date.now());
      ran.push({ id: t.id, ok: Boolean(r?.ok), http: r?.http, credits: r?.status.creditCount, error: r && !r.ok ? (r.status.errorMessage ?? `http ${r.http}`) : undefined });
    } catch (e) {
      ran.push({ id: t.id, ok: false, error: errMsg(e) });
      log.warn("task failed", { task: t.id, error: errMsg(e) });
    }
  }
  return { ran, skipped, governor: await governorState() };
}

export const cmcCollectorJob: Job = {
  name: "cmc",
  everyMs: 30 * SEC, // tick; each endpoint keeps its own cadence (persisted in kv across restarts)
  run: (ctx) => collectOnce(ctx.force),
};
