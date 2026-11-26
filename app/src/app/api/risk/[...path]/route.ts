import { joinPath, proxyServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const search = new URL(req.url).search;
  return proxyServices(req, `risk/${joinPath(path, search)}`, 30);
}
