import { serverEnv } from "@/lib/server/env";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// GET /api/atlas/pull?feed=nvdab -> { payloadHex, price, ts, feedId, packages }
// Fetches a signed Atlas pull report (same request as @atlas-oracle/pull-oracle-consumer-sdk HttpTransport:
// POST https://api.atlasoracle.io/report/v1/price/latest with X-API-KEY), assembles extraData
// (payload ‖ signature ‖ magicMarker) and parses the packages for display. The key never leaves the server.
// A tx in pull mode is encodeFunctionData(...) ‖ payloadHex (see BUILD_NOTES "## app").

const MAGIC = 28822;
const KNOWN_FEEDS = new Set(["nvdab", "tslab"]);
const PKG = 20;

function strip(h: string) {
  return h.startsWith("0x") ? h.slice(2) : h;
}

function parse(extra: string) {
  const hex = strip(extra);
  const bytes = Buffer.from(hex, "hex");
  let o = bytes.length - 2;
  if (o < 66 || bytes.readUInt16BE(o) !== MAGIC) throw new Error("bad magic marker");
  o -= 65; // signature
  o -= 1;
  const count = bytes[o];
  const packages: { feedId: string; price: number; ts: number }[] = [];
  for (let i = 0; i < count; i++) {
    o -= PKG;
    const p = bytes.subarray(o, o + PKG);
    const feedId = p.readUInt32BE(0).toString();
    const raw = BigInt(`0x${p.subarray(4, 14).toString("hex")}`);
    const ts = Number(BigInt(`0x${p.subarray(14, 20).toString("hex")}`));
    packages.push({ feedId, price: Number(raw) / 1e18, ts });
  }
  return packages;
}

export async function GET(req: Request) {
  const rl = rateLimit(`atlas:${clientIp(req)}`, 20, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const feed = (new URL(req.url).searchParams.get("feed") ?? "nvdab").toLowerCase();
  const feedId = serverEnv.atlasFeedIds()[feed];
  const key = serverEnv.atlasKey();
  // Not configured (no API key, or no feed id for a known stock): answer 200 with nulls so the UI shows its
  // "not configured" state instead of the browser logging a failed request on every 30 s refetch.
  if (!feedId && !KNOWN_FEEDS.has(feed)) return Response.json({ error: "unknown_feed" }, { status: 400 });
  if (!feedId || !key) {
    return Response.json(
      { feed, feedId: feedId ?? null, configured: false, payloadHex: null, price: null, ts: null, packages: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const res = await fetch("https://api.atlasoracle.io/report/v1/price/latest", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": key },
      body: JSON.stringify({ signed: true, feedIds: [feedId] }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return Response.json({ error: `atlas_http_${res.status}` }, { status: 502 });
    const json = (await res.json()) as { status?: { error_code?: string | number; error_message?: string }; data?: { payload: string; signature: string; magicMarker: string } };
    if (json.status && String(json.status.error_code) !== "0") {
      return Response.json({ error: "atlas_error", message: json.status.error_message }, { status: 502 });
    }
    if (!json.data) return Response.json({ error: "atlas_empty" }, { status: 502 });
    const payloadHex = `0x${strip(json.data.payload)}${strip(json.data.signature)}${strip(json.data.magicMarker)}`;
    const packages = parse(payloadHex);
    const mine = packages.find((p) => p.feedId === feedId) ?? packages[0];
    return Response.json(
      { feed, feedId, payloadHex, price: mine?.price ?? null, ts: mine?.ts ?? null, packages },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ error: "atlas_unreachable", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
