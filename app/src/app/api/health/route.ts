import { proxyServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

/** services GET /healthz: { keeperOnline, jobs[{job,lastRunAt,lastOkAt,lastErr}], wallets[{role,chain,address,balance,low}], config{...} } */
export async function GET(req: Request) {
  return proxyServices(req, "healthz", 15);
}
