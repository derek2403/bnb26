import type { Hex } from "viem";
import { env } from "../config/env.js";
import { alert } from "./alerts.js";
import { hashBytes } from "./canonical.js";
import { noteCredits, noteRateLimited } from "./governor.js";
import { appendLog, storeRaw } from "./hashlog.js";
import { errMsg, logger } from "./log.js";
import { num, toMs } from "./math.js";

const log = logger("cmc");

/**
 * Keyed CoinMarketCap Pro REST client.
 *  - The key goes ONLY in the X-CMC_PRO_API_KEY header (never a query param, so logged URLs never hold it).
 *  - The keyless public-api prefix is refused (calls there are not attributable to our key).
 *  - bodyHash = keccak256(raw response bytes, exactly as received). The bytes are stored in raw_bodies.
 *  - status.error_code arrives as the string "0" on DEX endpoints and the integer 0 on key/info: both mean OK.
 *  - status.timestamp may be ISO or epoch ms/seconds; normalised to ms.
 *  - Every call is appended to the hash-chained log with endpoint, params, http, cmc ts, credit_count, elapsed, bodyHash.
 */
export interface CmcStatus {
  errorCode: number; // normalised: 0 = ok
  errorMessage?: string;
  creditCount: number;
  timestampMs?: number;
  elapsed?: number;
}

export interface CmcResult<T = unknown> {
  ok: boolean;
  http: number;
  endpoint: string;
  params: Record<string, string>;
  status: CmcStatus;
  data: T | undefined;
  json: unknown;
  bodyHash: Hex;
  logSeq?: number;
  elapsedMs: number;
}

export function normaliseErrorCode(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : -1;
}

export function parseStatus(json: unknown): CmcStatus {
  const s = (json && typeof json === "object" ? (json as Record<string, unknown>).status : undefined) as Record<string, unknown> | undefined;
  return {
    errorCode: normaliseErrorCode(s?.error_code),
    errorMessage: typeof s?.error_message === "string" && s.error_message ? s.error_message : undefined,
    creditCount: num(s?.credit_count) ?? 0,
    timestampMs: toMs(s?.timestamp),
    elapsed: num(s?.elapsed),
  };
}

export function assertKeyedPath(path: string) {
  // public-api-check: allow (this is the guard itself)
  if (path.includes("/public-api")) throw new Error("CMC keyless /public-api paths are forbidden; use the keyed Pro API");
  if (!path.startsWith("/")) throw new Error("CMC path must start with /");
}

export async function cmcGet<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined>,
  opts: { service?: string } = {},
): Promise<CmcResult<T>> {
  assertKeyedPath(path);
  const e = env();
  const key = e.CMC_API_KEY;
  if (!key) throw new Error("CMC_API_KEY is not set");
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") clean[k] = String(v);
  const qs = new URLSearchParams(clean).toString();
  const url = `${e.CMC_BASE_URL.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
  const t0 = Date.now();
  let http = 0;
  let bytes = new Uint8Array();
  try {
    const res = await fetch(url, {
      headers: { "X-CMC_PRO_API_KEY": key, Accept: "application/json", "Accept-Encoding": "deflate, gzip" },
      signal: AbortSignal.timeout(20_000),
    });
    http = res.status;
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    log.warn("cmc fetch failed", { path, error: errMsg(err) });
    const bodyHash = hashBytes(bytes);
    try {
      await appendLog({ service: opts.service ?? "cmc", kind: "cmc", endpoint: path, params: clean, http: 0, elapsedMs, bodyHash, data: { error: errMsg(err) } });
    } catch {
      /* logging must not mask the fetch error */
    }
    return { ok: false, http: 0, endpoint: path, params: clean, status: { errorCode: -1, errorMessage: errMsg(err), creditCount: 0 }, data: undefined, json: undefined, bodyHash, elapsedMs };
  }
  const elapsedMs = Date.now() - t0;
  const bodyHash = hashBytes(bytes);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    json = undefined;
  }
  const status = parseStatus(json);
  const ok = http === 200 && status.errorCode === 0 && json !== undefined;
  noteCredits(status.creditCount);
  if (http === 429) {
    noteRateLimited(60_000);
    void alert("cmc-429", `CMC 429 on ${path} (code ${status.errorCode}): ${status.errorMessage ?? ""}`);
  }
  await storeRaw(bodyHash, "cmc", bytes, "application/json");
  let logSeq: number | undefined;
  try {
    const entry = await appendLog({
      service: opts.service ?? "cmc",
      kind: "cmc",
      endpoint: path,
      params: clean,
      http,
      cmcTs: status.timestampMs,
      creditCount: status.creditCount,
      elapsedMs,
      bodyHash,
      data: ok ? undefined : { errorCode: status.errorCode, errorMessage: status.errorMessage },
    });
    logSeq = entry.seq;
  } catch (err) {
    log.warn("hash-log append failed", { error: errMsg(err) });
  }
  if (!ok) log.warn("cmc error", { path, http, code: status.errorCode, message: status.errorMessage });
  const data = json && typeof json === "object" ? ((json as Record<string, unknown>).data as T) : undefined;
  return { ok, http, endpoint: path, params: clean, status, data, json, bodyHash, logSeq, elapsedMs };
}

// ------------------------------------------------------------------ tolerant parsers
// Field shapes below come from the live calls on 26 Nov (dex price `p`, `l`, `v24h`) and the docs; the rest are
// parsed defensively because their exact shape is [UNVERIFIED] on the free plan.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** /v1/dex/token/price -> { price, liquidityUsd, volume24h } */
export function parseDexPrice(data: unknown): { price?: number; liquidityUsd?: number; volume24h?: number } {
  const d = first(data);
  if (!isObj(d)) return {};
  return { price: num(d.p ?? d.price), liquidityUsd: num(d.l ?? d.liquidity), volume24h: num(d.v24h ?? d.volume24h) };
}

export interface Candle {
  ts: number; // seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** /v1/k-line/candles -> candles sorted by time. Docs: each candle is [open, high, low, close, volume, timestamp, traders]. */
export function parseCandles(data: unknown): Candle[] {
  const list = Array.isArray(data) ? data : isObj(data) ? ((data.candles ?? data.list ?? data.items ?? []) as unknown[]) : [];
  const out: Candle[] = [];
  for (const c of list) {
    if (Array.isArray(c)) {
      const ts = toMs(c[5]);
      const close = num(c[3]);
      if (ts !== undefined && close !== undefined)
        out.push({ ts: Math.floor(ts / 1000), o: num(c[0]) ?? close, h: num(c[1]) ?? close, l: num(c[2]) ?? close, c: close, v: num(c[4]) ?? 0 });
    } else if (isObj(c)) {
      const ts = toMs(c.timestamp ?? c.ts ?? c.t ?? c.time);
      const close = num(c.close ?? c.c);
      if (ts !== undefined && close !== undefined)
        out.push({ ts: Math.floor(ts / 1000), o: num(c.open ?? c.o) ?? close, h: num(c.high ?? c.h) ?? close, l: num(c.low ?? c.l) ?? close, c: close, v: num(c.volume ?? c.v) ?? 0 });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Finds the USD price of a CMC id in /v3/cryptocurrency/quotes/latest (v2 map shape or v3 list shape). */
export function parseQuotePrice(data: unknown, id: number): { price?: number; lastUpdatedMs?: number } {
  let item: unknown;
  if (Array.isArray(data)) item = data.find((x) => isObj(x) && Number(x.id) === id);
  else if (isObj(data)) item = first(data[String(id)]) ?? data;
  if (!isObj(item)) return {};
  const q = item.quote;
  let usd: unknown;
  if (Array.isArray(q)) usd = q.find((x) => isObj(x) && (x.symbol === "USD" || Number(x.id) === 2781)) ?? q[0];
  else if (isObj(q)) usd = q.USD ?? q["2781"] ?? Object.values(q)[0];
  if (!isObj(usd)) return {};
  return { price: num(usd.price), lastUpdatedMs: toMs(usd.last_updated ?? usd.lastUpdated) };
}

/**
 * /v5/real-world-assets/quotes/latest?rwa_id=… [UNVERIFIED shape] -> underlying price and the tokenized
 * price of `cryptoId` (or the average tokenized price). premiumBps = (underlying − tokenized) / tokenized.
 */
export function parseRwa(data: unknown, cryptoId: number): { underlying?: number; tokenized?: number; averageTokenized?: number; premiumBps?: number; marketStatus?: string } {
  const d = first(isObj(data) && !("price" in data) && !("quote" in data) ? (Object.values(data)[0] ?? data) : data);
  if (!isObj(d)) return {};
  const quote = isObj(d.quote) ? (d.quote as Obj) : undefined;
  const qUsd = quote && isObj(quote.USD) ? (quote.USD as Obj) : quote;
  const underlying = num(d.price ?? d.underlying_price ?? qUsd?.price ?? (isObj(d.tradfi) ? (d.tradfi as Obj).price : undefined));
  const averageTokenized = num(d.average_tokenized_price ?? qUsd?.average_tokenized_price);
  const tokens = (d.tokens ?? d.underlying_tokens ?? d.onchain_tokens ?? d.tokenized_assets) as unknown;
  let tokenized: number | undefined;
  if (Array.isArray(tokens)) {
    const t = tokens.find((x) => isObj(x) && Number(x.crypto_id ?? x.id) === cryptoId);
    if (isObj(t)) tokenized = num(t.price ?? (isObj(t.quote) ? ((t.quote as Obj).USD as Obj | undefined)?.price : undefined));
  }
  const ref = tokenized ?? averageTokenized;
  const premiumBps = underlying !== undefined && ref ? Math.round(((underlying - ref) / ref) * 10_000) : undefined;
  const marketStatus = typeof d.market_status === "string" ? d.market_status : typeof d.session === "string" ? d.session : undefined;
  return { underlying, tokenized, averageTokenized, premiumBps, marketStatus };
}

/** /v1/dex/token/pools -> total liquidity across pools plus the pool list (pairs, dex names). */
export function parsePools(data: unknown): { totalLiquidityUsd: number; pools: { address?: string; dex?: string; liquidityUsd?: number; quote?: string }[] } {
  const list = Array.isArray(data) ? data : isObj(data) ? ((data.pools ?? data.list ?? data.items ?? []) as unknown[]) : [];
  const pools = list.filter(isObj).map((p) => ({
    address: typeof (p.address ?? p.pa ?? p.pool) === "string" ? String(p.address ?? p.pa ?? p.pool) : undefined,
    dex: typeof (p.dex ?? p.exn ?? p.dexName) === "string" ? String(p.dex ?? p.exn ?? p.dexName) : undefined,
    liquidityUsd: num(p.liquidity ?? p.l ?? p.liq ?? p.liquidityUsd),
    quote: typeof (p.quoteSymbol ?? p.qs ?? p.t1s) === "string" ? String(p.quoteSymbol ?? p.qs ?? p.t1s) : undefined,
  }));
  return { totalLiquidityUsd: pools.reduce((a, p) => a + (p.liquidityUsd ?? 0), 0), pools };
}

export function parseFearGreed(data: unknown): { value?: number; classification?: string; updateTimeMs?: number } {
  const d = first(data);
  if (!isObj(d)) return {};
  return { value: num(d.value), classification: typeof d.value_classification === "string" ? d.value_classification : undefined, updateTimeMs: toMs(d.update_time ?? d.timestamp) };
}

export function parseKeyInfo(data: unknown): {
  creditLimitMonthly?: number;
  rateLimitMinute?: number;
  creditsUsedDay?: number;
  creditsUsedMonth?: number;
  creditsLeftMonth?: number;
} {
  if (!isObj(data)) return {};
  const plan = isObj(data.plan) ? data.plan : {};
  const usage = isObj(data.usage) ? data.usage : {};
  const day = isObj(usage.current_day) ? usage.current_day : {};
  const month = isObj(usage.current_month) ? usage.current_month : {};
  return {
    creditLimitMonthly: num(plan.credit_limit_monthly),
    rateLimitMinute: num(plan.rate_limit_minute),
    creditsUsedDay: num(day.credits_used),
    creditsUsedMonth: num(month.credits_used),
    creditsLeftMonth: num(month.credits_left),
  };
}

export function parseInfoIds(data: unknown): { id: number; symbol?: string; name?: string }[] {
  if (!isObj(data)) return [];
  const out: { id: number; symbol?: string; name?: string }[] = [];
  for (const v of Object.values(data)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isObj(item) && num(item.id) !== undefined) out.push({ id: Number(item.id), symbol: item.symbol as string | undefined, name: item.name as string | undefined });
    }
  }
  return out;
}

/** /v3/cryptocurrency/quotes/historical -> [{ts, price}] for one id. */
export function parseQuotesHistorical(data: unknown, id: number): { ts: number; price: number }[] {
  let item: unknown = data;
  if (Array.isArray(data)) item = data.find((x) => isObj(x) && Number(x.id) === id) ?? data[0];
  else if (isObj(data) && data[String(id)]) item = first(data[String(id)]);
  const quotes = isObj(item) ? (item.quotes as unknown) : undefined;
  if (!Array.isArray(quotes)) return [];
  const out: { ts: number; price: number }[] = [];
  for (const q of quotes) {
    if (!isObj(q)) continue;
    const quote = q.quote;
    const usd = Array.isArray(quote) ? quote[0] : isObj(quote) ? (quote.USD ?? Object.values(quote)[0]) : undefined;
    const ts = toMs(q.timestamp ?? (isObj(usd) ? usd.timestamp : undefined));
    const price = isObj(usd) ? num(usd.price) : undefined;
    if (ts !== undefined && price !== undefined) out.push({ ts: Math.floor(ts / 1000), price });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
