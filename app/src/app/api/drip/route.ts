import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { createWalletClient, fallback, formatEther, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { serverEnv } from "@/lib/server/env";
import { testnetClient } from "@/lib/server/chain";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// Testnet gas drip: 0.005 tBNB (DRIP_AMOUNT_WEI) once per wallet per day, behind a server-issued arithmetic
// challenge (HMAC-signed, expires in 5 minutes). GET -> { question, token }; POST { address, answer, token }.
// TODO: swap the challenge for Turnstile/hCaptcha if abuse shows up.

const g = globalThis as unknown as { __drip?: Map<string, number> };
g.__drip ??= new Map();
const lastDrip = g.__drip;

function sign(payload: string) {
  return createHmac("sha256", serverEnv.dripSecret()).update(payload).digest("hex");
}

export async function GET() {
  const a = randomInt(2, 20);
  const b = randomInt(2, 20);
  const exp = Date.now() + 5 * 60_000;
  const payload = `${a + b}.${exp}`;
  return Response.json({ question: `${a} + ${b} = ?`, token: `${exp}.${sign(payload)}`, enabled: Boolean(serverEnv.dripKey()) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = rateLimit(`drip:${clientIp(req)}`, 3, 86_400);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const key = serverEnv.dripKey();
  if (!key) return Response.json({ error: "drip_not_configured" }, { status: 503 });
  let body: { address?: string; answer?: string | number; token?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.address || !isAddress(body.address)) return Response.json({ error: "invalid_address" }, { status: 400 });
  const [expStr, mac] = String(body.token ?? "").split(".");
  const exp = Number(expStr);
  if (!exp || exp < Date.now() || !mac) return Response.json({ error: "challenge_expired" }, { status: 400 });
  const expected = Buffer.from(sign(`${Number(body.answer)}.${exp}`), "hex");
  const given = Buffer.from(mac, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return Response.json({ error: "wrong_answer" }, { status: 400 });

  const to = getAddress(body.address);
  const last = lastDrip.get(to) ?? 0;
  if (Date.now() - last < 86_400_000) return Response.json({ error: "already_dripped_today" }, { status: 429 });

  const balance = await testnetClient.getBalance({ address: to }).catch(() => 0n);
  if (balance >= serverEnv.dripAmountWei() * 4n) return Response.json({ error: "balance_sufficient", balance: formatEther(balance) }, { status: 400 });

  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain: bscTestnet,
    transport: fallback(serverEnv.testnetRpc().split(",").map((u) => http(u.trim()))),
  });
  lastDrip.set(to, Date.now());
  try {
    const hash = await wallet.sendTransaction({ to, value: serverEnv.dripAmountWei() });
    return Response.json({ ok: true, hash, amount: formatEther(serverEnv.dripAmountWei()) });
  } catch (e) {
    lastDrip.delete(to);
    return Response.json({ error: "send_failed", message: e instanceof Error ? e.message.slice(0, 200) : "unknown" }, { status: 502 });
  }
}
