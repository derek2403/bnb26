import { getDemoPrices } from "@/lib/server/cmc";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getDemoPrices();
  return Response.json(data, { headers: { "cache-control": "public, s-maxage=600, stale-while-revalidate=1200" } });
}
