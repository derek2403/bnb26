import { createWalletClient, fallback, http, keccak256, parseEther, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { RiskOracleAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { testnetClient } from "@/lib/server/chain";
import { getDemoPrices } from "@/lib/server/cmc";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Testnet only. A pool mints only when the RiskOracle holds a CoinMarketCap reference price for its stock that is
// less than one hour old. The keeper posts that price for NVDA and TSLA. It does not know AAPL.
// This route posts the CoinMarketCap price for AAPL, signed by the server wallet (POSTER_ROLE on the RiskOracle).
// The launch form calls it before it opens an AAPL market.

const RISK = addr(deployments97.core.riskOracle);
const ALLOWED = new Set(["AAPL"]);
const FRESH_SEC = 600; // do not post again when the last price is newer than this

const opKey = () => {
  const v = process.env.SANDBOX_OPERATOR_KEY?.trim();
  return v ? ((v.startsWith("0x") ? v : `0x${v}`) as Hex) : undefined;
};
const rpcs = () => (process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);

// Shared with the other operator routes: the operator key signs one transaction at a time.
const g = globalThis as unknown as { __sandboxLock?: Promise<unknown> };
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__sandboxLock ?? Promise.resolve()).then(fn, fn);
  g.__sandboxLock = run.catch(() => undefined);
  return run;
}

export async function POST(req: Request) {
  const rl = rateLimit(`refprice:${clientIp(req)}`, 20, 600);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const k = opKey();
  if (!k || !RISK) return Response.json({ ok: false, error: "The server wallet is not configured." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { symbol?: string };
  const symbol = String(body.symbol ?? "").toUpperCase();
  if (!ALLOWED.has(symbol)) return Response.json({ ok: false, error: "This stock has no reference price route." }, { status: 400 });

  return locked(async () => {
    try {
      const assetId = keccak256(toBytes(symbol));
      const pc = testnetClient;
      const [prev, block] = await Promise.all([
        pc.readContract({ address: RISK, abi: RiskOracleAbi, functionName: "latestSnapshot", args: [assetId] }) as Promise<{ refPrice: bigint; cmcTs: bigint; snapshotId: bigint }>,
        pc.getBlock(),
      ]);
      const now = block.timestamp;
      if (prev.cmcTs !== 0n && now - prev.cmcTs < BigInt(FRESH_SEC)) {
        return Response.json({ ok: true, posted: false, price: Number(prev.refPrice) / 1e18, ageSec: Number(now - prev.cmcTs) });
      }
      const prices = await getDemoPrices();
      const p = prices.prices[symbol];
      if (!p || p.source !== "cmc") return Response.json({ ok: false, error: "CoinMarketCap did not return a price for this stock." }, { status: 502 });

      const account = privateKeyToAccount(k);
      const wc = createWalletClient({ account, chain: bscTestnet, transport: fallback(rpcs().map((u) => http(u))) });
      const snapshot = {
        refPrice: parseEther(p.price.toFixed(8)),
        volBps: 0n, // unknown: the oracle keeps its rule values
        liqUsd: 0n, // unknown
        premiumBps: 0n,
        cmcTs: now > prev.cmcTs ? now : prev.cmcTs + 1n,
        snapshotId: prev.snapshotId + 1n,
        responseHash: keccak256(toBytes(JSON.stringify({ symbol, price: p.price, updatedAt: prices.updatedAt }))),
      };
      const hash = await wc.writeContract({ address: RISK, abi: RiskOracleAbi, functionName: "post", args: [assetId, snapshot] });
      const r = await pc.waitForTransactionReceipt({ hash });
      if (r.status !== "success") return Response.json({ ok: false, error: "The price transaction reverted.", tx: hash }, { status: 500 });
      return Response.json({ ok: true, posted: true, price: p.price, tx: hash });
    } catch (e) {
      const m = e as { shortMessage?: string; message?: string };
      return Response.json({ ok: false, error: (m.shortMessage ?? m.message ?? "The price was not posted.").slice(0, 240) }, { status: 500 });
    }
  });
}
