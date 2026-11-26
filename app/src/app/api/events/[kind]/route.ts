import { proxyServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

// Mirrors services EVENT_KINDS (services/src/jobs/indexer.ts) plus "all".
const KINDS = new Set(["all", "mirror", "risk", "agent", "pool", "zone", "launch", "openfour", "anchor", "backstop", "factory", "stability", "cmcAnchor", "sandbox", "other"]);

export async function GET(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  if (!KINDS.has(kind)) return Response.json({ error: "unknown_kind", kinds: [...KINDS] }, { status: 400 });
  const search = new URL(req.url).search;
  return proxyServices(req, `events/${kind}${search}`, 15);
}
