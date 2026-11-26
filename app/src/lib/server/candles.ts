import "server-only";
import { demoPool, REFERENCE_FALLBACK } from "@/config/demoPools";
import { deployments97, MAINNET_EXTERNAL } from "@/config/deployments";
import { aggregate, BARS, INTERVAL_SEC, parseCmcCandles, syntheticCandles, type Candle, type CandleResponse, type Interval } from "@/lib/candles";
import { getDemoPrices } from "./cmc";
import { serverEnv } from "./env";

// Candles for the trade chart. Real markets: CMC DEX k-lines of the tokenized stock on BSC mainnet (NVDA -> NVDAB,
// TSLA -> TSLAB). Key server-side in the X-CMC_PRO_API_KEY header, responses cached (1h 5 min, 4h 15 min,
// 1d 60 min) so page views do not spend credits. Demo markets and any CMC failure: deterministic synthetic bars
// anchored to the live price.

const TTL_MS: Record<Interval, number> = { "1h": 5 * 60_000, "4h": 15 * 60_000, "1d": 60 * 60_000 };
const FAIL_TTL_MS = 5 * 60_000;
/** CMC ids of the tokenized stocks (services/src/config/assets.ts). */
const CMC_IDS: Record<string, number> = { NVDA: 40215, TSLA: 40214 };

type Entry = { at: number; ttl: number; candles: Candle[] | null; note?: string };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const tokens = new Map<string, { at: number; token: string | null }>();

const EXPECTED_SYMBOL: Record<string, string> = { "nvda-flap": "NVDA", "tsla-four": "TSLA" };

export function symbolForPool(id: string): { symbol: string; demo: boolean } | undefined {
  const d = demoPool(id);
  if (d) return { symbol: d.symbol, demo: true };
  const p = deployments97.pools.find((x) => x.id === id);
  if (p) return { symbol: p.symbol, demo: false };
  if (EXPECTED_SYMBOL[id]) return { symbol: EXPECTED_SYMBOL[id], demo: false };
  // A market opened by a user-created Flap launch: "<symbol>-<first 6 hex of the pool>" (usePools launchMarketId).
  const m = /^([a-z]{2,6})-[0-9a-f]{6}$/.exec(id);
  if (m && CMC_IDS[m[1].toUpperCase()]) return { symbol: m[1].toUpperCase(), demo: false };
  return undefined;
}

function assetOverride(symbol: string): string | undefined {
  const raw = process.env.CMC_ASSETS;
  if (!raw) return undefined;
  try {
    const t = (JSON.parse(raw) as Record<string, { token?: string }>)[symbol]?.token;
    return t && /^0x[0-9a-fA-F]{40}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

async function cmcJson(path: string, params: Record<string, string | number>): Promise<unknown> {
  const key = serverEnv.cmcKey();
  if (!key) throw new Error("CMC_API_KEY not set");
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${serverEnv.cmcBase()}${path}?${qs}`, {
    headers: { "X-CMC_PRO_API_KEY": key, accept: "application/json" }, // header only, never a query param
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
  const json = (await res.json()) as { status?: { error_code?: number | string; error_message?: string }; data?: unknown };
  if (json.status && Number(json.status.error_code ?? 0) !== 0) throw new Error(`CMC error ${json.status.error_code}: ${json.status.error_message ?? ""}`.trim());
  return json.data;
}

/** BSC mainnet address of the tokenized stock: NVDAB is a verified constant; TSLAB comes from CMC_ASSETS or
 *  /v2/cryptocurrency/info (its BNB Smart Chain contract), cached for a day. */
async function tokenFor(symbol: string): Promise<string | null> {
  const o = assetOverride(symbol);
  if (o) return o;
  if (symbol === "NVDA") return MAINNET_EXTERNAL.NVDAB;
  const id = CMC_IDS[symbol];
  if (!id) return null;
  const hit = tokens.get(symbol);
  if (hit && Date.now() - hit.at < (hit.token ? 86_400_000 : 3_600_000)) return hit.token;
  let token: string | null = null;
  try {
    const data = (await cmcJson("/v2/cryptocurrency/info", { id })) as Record<string, unknown> | undefined;
    const item = data?.[String(id)];
    const it = (Array.isArray(item) ? item[0] : item) as { contract_address?: { contract_address?: string; platform?: { name?: string; coin?: { symbol?: string } } }[]; platform?: { token_address?: string; name?: string } } | undefined;
    const bsc = it?.contract_address?.find((c) => /bnb|bsc|binance/i.test(`${c.platform?.name ?? ""} ${c.platform?.coin?.symbol ?? ""}`));
    const cand = bsc?.contract_address ?? (/bnb|bsc|binance/i.test(it?.platform?.name ?? "") ? it?.platform?.token_address : undefined);
    token = cand && /^0x[0-9a-fA-F]{40}$/.test(cand) ? cand : null;
  } catch {
    token = null;
  }
  tokens.set(symbol, { at: Date.now(), token });
  return token;
}

async function fetchKlines(token: string, interval: Interval): Promise<Entry> {
  const params = { platform: "bsc", address: token, interval, limit: BARS[interval] };
  try {
    const c = parseCmcCandles(await cmcJson("/v1/k-line/candles", params));
    if (c.length >= 10) return { at: Date.now(), ttl: TTL_MS[interval], candles: c.slice(-BARS[interval]) };
    if (interval === "1h") return { at: Date.now(), ttl: FAIL_TTL_MS, candles: null, note: "CMC returned too few candles" };
  } catch (e) {
    if (interval === "1h") return { at: Date.now(), ttl: FAIL_TTL_MS, candles: null, note: e instanceof Error ? e.message : String(e) };
  }
  // 4h / 1d not served: build them from 1h bars.
  const hourly = await cached(token, "1h");
  if (!hourly.candles) return { ...hourly, ttl: FAIL_TTL_MS };
  return { at: Date.now(), ttl: TTL_MS[interval], candles: aggregate(hourly.candles, INTERVAL_SEC[interval]) };
}

async function cached(token: string, interval: Interval): Promise<Entry> {
  const key = `${token.toLowerCase()}:${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit;
  let p = inflight.get(key);
  if (!p) {
    p = fetchKlines(token, interval)
      .then((e) => {
        cache.set(key, e);
        return e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export async function candlesFor(id: string, interval: Interval, anchorHint?: number): Promise<CandleResponse | null> {
  const s = symbolForPool(id);
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  if (s.demo) {
    const def = demoPool(id)!;
    const prices = await getDemoPrices();
    const anchor = anchorHint && anchorHint > 0 ? anchorHint : prices.prices[def.symbol]?.price ?? def.fallbackPrice;
    return { id, symbol: s.symbol, interval, source: "simulated", candles: syntheticCandles(id, interval, anchor, now, BARS[interval], def.tvlUsd / 8) };
  }
  let note: string | undefined;
  const token = await tokenFor(s.symbol);
  if (token && serverEnv.cmcKey()) {
    const e = await cached(token, interval);
    if (e.candles) return { id, symbol: s.symbol, interval, source: "cmc", token, candles: e.candles };
    note = e.note;
  } else note = !serverEnv.cmcKey() ? "CMC_API_KEY not set" : `no BSC token address for ${s.symbol}B`;
  let anchor = anchorHint && anchorHint > 0 ? anchorHint : undefined;
  if (!anchor) anchor = (await getDemoPrices()).prices[s.symbol]?.price ?? REFERENCE_FALLBACK[s.symbol] ?? 100;
  return { id, symbol: s.symbol, interval, source: "synthetic", note, token: token ?? undefined, candles: syntheticCandles(`${s.symbol}-real`, interval, anchor, now) };
}
