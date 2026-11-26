import { proxyServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return proxyServices(req, "cmc/usage", 60);
}
