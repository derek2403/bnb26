import { decodeEventLog, getAddress, isHex, type Address, type Hex } from "viem";
import { OpenFourCoreAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { testnetClient } from "@/lib/server/chain";
import { ofStore, type TokenRecord } from "@/lib/server/ofStore";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";
import { servicesJson } from "@/lib/server/services";

export const dynamic = "force-dynamic";

type Row = { token: Address; poolId?: string; name?: string; symbol?: string; creator?: Address; source: "deployments" | "signed" | "services" };

// GET: tokens from deployments.openfour.tokens + sign-route records (memory and services). The page verifies
// each with Core.tokens(token).exists; nothing scans logs.
export async function GET() {
  const rows = new Map<string, Row>();
  for (const t of deployments97.openfour.tokens) rows.set(t.token.toLowerCase(), { token: t.token, poolId: t.poolId, source: "deployments" });
  const remote = await servicesJson<{ tokens?: TokenRecord[] }>("openfour/tokens", { revalidate: 30 });
  for (const t of remote?.tokens ?? []) if (!rows.has(t.token.toLowerCase())) rows.set(t.token.toLowerCase(), { ...t, source: "services" });
  for (const t of ofStore.tokens.values()) if (!rows.has(t.token.toLowerCase())) rows.set(t.token.toLowerCase(), { ...t, source: "signed" });
  return Response.json({ tokens: [...rows.values()] }, { headers: { "cache-control": "no-store" } });
}

// POST { txHash }: after createToken, record the token from its receipt (TokenCreated on our fork Core, with a
// requestId this route signed).
export async function POST(req: Request) {
  const rl = rateLimit(`oftok:${clientIp(req)}`, 20, 3600);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const core = addr(deployments97.openfour.core);
  if (!core) return Response.json({ error: "openfour_not_configured" }, { status: 503 });
  let txHash: string | undefined;
  try {
    txHash = (await req.json()).txHash;
  } catch {
    /* empty */
  }
  if (!txHash || !isHex(txHash) || txHash.length !== 66) return Response.json({ error: "invalid_tx_hash" }, { status: 400 });
  const receipt = await testnetClient.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
  if (!receipt || receipt.status !== "success") return Response.json({ error: "receipt_not_found" }, { status: 404 });
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(core)) continue;
    try {
      const ev = decodeEventLog({ abi: OpenFourCoreAbi, data: log.data, topics: log.topics });
      if (ev.eventName !== "TokenCreated") continue;
      const a = ev.args;
      // A requestId signed by another server instance is still accepted: the event comes from our own Core.
      const rid = a.requestId.toString();
      const rec: TokenRecord = { token: a.token, creator: a.creator, name: a.name, symbol: a.symbol, requestId: rid, txHash: txHash as Hex, createdAt: Date.now() };
      ofStore.tokens.set(a.token.toLowerCase(), rec);
      void servicesJson("openfour/records", { method: "POST", body: JSON.stringify({ type: "created", ...rec }) });
      return Response.json({ ok: true, token: rec });
    } catch {
      /* not this event */
    }
  }
  return Response.json({ error: "token_created_not_in_receipt" }, { status: 404 });
}
