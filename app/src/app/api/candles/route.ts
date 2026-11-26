import { isInterval } from "@/lib/candles";
import { candlesFor } from "@/lib/server/candles";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// GET /api/candles?id=<poolId>&interval=1h|4h|1d[&anchor=<live price>]
//  -> { id, symbol, interval, source: "cmc" | "synthetic" | "simulated", token?, note?, candles: [{t,o,h,l,c,v}] }
// `anchor` (the live Atlas price the page already shows) is only used for the synthetic fallback.
export async function GET(req: Request) {
  const rl = rateLimit(`candles:${clientIp(req)}`, 90, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const q = new URL(req.url).searchParams;
  const id = (q.get("id") ?? "").toLowerCase();
  const interval = q.get("interval") ?? "1h";
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return Response.json({ error: "invalid_id" }, { status: 400 });
  if (!isInterval(interval)) return Response.json({ error: "invalid_interval", allowed: ["1h", "4h", "1d"] }, { status: 400 });
  const anchor = Number(q.get("anchor"));
  const data = await candlesFor(id, interval, Number.isFinite(anchor) && anchor > 0 && anchor < 1e7 ? anchor : undefined);
  if (!data) return Response.json({ error: "unknown_market" }, { status: 404 });
  return Response.json(data, { headers: { "cache-control": data.source === "cmc" ? "public, s-maxage=120, stale-while-revalidate=300" : "no-store" } });
}
