import "server-only";
import { DEMO_POOLS, REFERENCE_FALLBACK, REFERENCE_SYMBOLS } from "@/config/demoPools";
import { serverEnv } from "./env";

export type DemoPrice = { price: number; change24h?: number; source: "cmc" | "fallback" };
export type DemoPrices = { prices: Record<string, DemoPrice>; source: "cmc" | "fallback" | "mixed"; updatedAt: number; note?: string };

let cache: { at: number; data: DemoPrices } | null = null;
let inflight: Promise<DemoPrices> | null = null;

function fallback(note?: string): DemoPrices {
  const prices: Record<string, DemoPrice> = {};
  for (const d of DEMO_POOLS) prices[d.symbol] = { price: d.fallbackPrice, source: "fallback" };
  for (const s of REFERENCE_SYMBOLS) prices[s] = { price: REFERENCE_FALLBACK[s], source: "fallback" };
  return { prices, source: "fallback", updatedAt: Math.floor(Date.now() / 1000), note };
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** [UNVERIFIED response shape] Accept data as an array or an object keyed by id/symbol; read the aggregate price
 *  from quote.USD.price, price, average_tokenized_price or quote.USD.average_tokenized_price. */
function extract(json: unknown): Record<string, { price: number; change24h?: number }> {
  const out: Record<string, { price: number; change24h?: number }> = {};
  const data = (json as { data?: unknown })?.data;
  const items: unknown[] = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data as object).flat() : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const sym = String(o.symbol ?? o.underlying_symbol ?? o.ticker ?? "").toUpperCase();
    if (!sym) continue;
    const q = (o.quote as Record<string, Record<string, unknown>> | undefined)?.USD ?? (o.quote as Record<string, unknown> | undefined);
    const price =
      num(q?.price) ?? num(o.price) ?? num(o.average_tokenized_price) ?? num(q?.average_tokenized_price) ?? num((o.aggregate as Record<string, unknown>)?.price);
    if (!price) continue;
    const change = Number(q?.percent_change_24h ?? o.percent_change_24h);
    out[sym] = { price, change24h: Number.isFinite(change) ? change : undefined };
  }
  return out;
}

async function load(): Promise<DemoPrices> {
  const key = serverEnv.cmcKey();
  if (!key) return fallback("CMC_API_KEY not set");
  const symbols = [...DEMO_POOLS.map((d) => d.cmcSymbol), ...REFERENCE_SYMBOLS].join(",");
  try {
    const res = await fetch(`${serverEnv.cmcBase()}/v5/real-world-assets/quotes/latest?symbol=${encodeURIComponent(symbols)}`, {
      headers: { "X-CMC_PRO_API_KEY": key, accept: "application/json" }, // header only, never ?CMC_PRO_API_KEY=
      next: { revalidate: serverEnv.demoPricesTtl() },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fallback(`CMC HTTP ${res.status}`);
    const got = extract(await res.json());
    const base = fallback();
    let hits = 0;
    for (const d of DEMO_POOLS) {
      const g = got[d.cmcSymbol.toUpperCase()];
      if (g) {
        base.prices[d.symbol] = { ...g, source: "cmc" };
        hits++;
      }
    }
    for (const s of REFERENCE_SYMBOLS) {
      const g = got[s];
      if (g) base.prices[s] = { ...g, source: "cmc" };
    }
    base.source = hits === DEMO_POOLS.length ? "cmc" : hits > 0 ? "mixed" : "fallback";
    base.note = hits === 0 ? "CMC response had no usable prices" : undefined;
    return base;
  } catch {
    return fallback("CMC unreachable");
  }
}

/** Cached 10 minutes (DEMO_PRICES_TTL_SEC) in memory and in the Next data cache. Page views never hit CMC. */
export async function getDemoPrices(): Promise<DemoPrices> {
  const ttl = serverEnv.demoPricesTtl() * 1000;
  if (cache && Date.now() - cache.at < ttl) return cache.data;
  if (!inflight) {
    inflight = load()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
