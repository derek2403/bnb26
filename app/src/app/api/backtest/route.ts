import { proxyServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const search = new URL(req.url).search;
  return proxyServices(req, `backtest${search}`, 600, 30);
}
