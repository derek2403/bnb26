import { createWalletClient, erc20Abi, fallback, http, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { LeveragePoolAbi, SandboxFactoryAbi, ScenarioFeedAbi, StabilityPoolAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { testnetClient } from "@/lib/server/chain";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// Demo sandbox operator (testnet only). SANDBOX_OPERATOR_KEY is a server-only testnet key that owns one private
// sandbox market (SandboxFactory.create) and is the only account that can move its price.
//   GET  -> { enabled, operator }
//   POST { action: "setup" }              open the sandbox, mint sUSD up to ~2x, stake all sUSD
//   POST { action: "move", bps: ±N }      set the price to anchor*(1+bps), then rebalance if a zone is executable
//   POST { action: "live" }               reset the price to the live Atlas price
// Only these fixed actions on the operator's own sandbox are possible; the key never leaves the server.

const MOVES = new Set([1000, -1000, -2000]);
const FACTORY = addr(deployments97.core.sandboxFactory);
const TNVDA = addr(deployments97.tokens.tNVDA);

const key = () => {
  const v = process.env.SANDBOX_OPERATOR_KEY?.trim();
  return v ? ((v.startsWith("0x") ? v : `0x${v}`) as Hex) : undefined;
};
const rpcs = () => (process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);

const g = globalThis as unknown as { __sandboxLock?: Promise<unknown> };
/** One action at a time: the operator key signs sequential transactions. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__sandboxLock ?? Promise.resolve()).then(fn, fn);
  g.__sandboxLock = run.catch(() => undefined);
  return run;
}

export async function GET() {
  const k = key();
  return Response.json({ enabled: !!k && !!FACTORY, operator: k ? privateKeyToAccount(k).address : null }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = rateLimit(`sandbox:${clientIp(req)}`, 40, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const k = key();
  if (!k || !FACTORY || !TNVDA) return Response.json({ error: "sandbox_operator_not_configured" }, { status: 503 });
  let body: { action?: string; bps?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "setup" && action !== "move" && action !== "live") return Response.json({ error: "invalid_action" }, { status: 400 });
  if (action === "move" && !MOVES.has(Number(body.bps))) return Response.json({ error: "invalid_move", allowed: [...MOVES] }, { status: 400 });

  const account = privateKeyToAccount(k);
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: fallback(rpcs().map((u) => http(u))) });
  const pc = testnetClient;
  const txs: Hex[] = [];
  const write = async (p: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => {
    const gas = await pc.estimateContractGas({ ...p, account } as never);
    const hash = await wallet.writeContract({ ...p, gas: (gas * 13n) / 10n, gasPrice: await pc.getGasPrice(), type: "legacy" } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    txs.push(hash);
    if (r.status !== "success") throw new Error(`${p.functionName} reverted`);
    return r;
  };
  const sandbox = async () => {
    const sb = (await pc.readContract({ address: FACTORY, abi: SandboxFactoryAbi, functionName: "sandboxOf", args: [account.address] })) as { pool: Address; feed: Address };
    return sb.pool === zeroAddress ? null : sb;
  };

  try {
    const out = await locked(async () => {
      let sb = await sandbox();
      if (action === "setup") {
        const steps: string[] = [];
        if (!sb) {
          await write({ address: FACTORY, abi: SandboxFactoryAbi, functionName: "create" });
          steps.push("opened the sandbox market");
          sb = await sandbox();
        }
        if (!sb) throw new Error("sandbox not found after create");
        const pool = sb.pool;
        const [sUSD, sp] = (await Promise.all([
          pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "sUSD" }),
          pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "stabilityPool" }),
        ])) as [Address, Address];
        const max = (await pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "maxMintStable" })) as bigint;
        const amt = (max * 97n) / 100n;
        const have = (await pc.readContract({ address: TNVDA, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (amt > 10n ** 16n && have >= amt) {
          await write({ address: TNVDA, abi: erc20Abi, functionName: "approve", args: [pool, amt] });
          await write({ address: pool, abi: LeveragePoolAbi, functionName: "mintStable", args: [amt, 0n, BigInt(Math.floor(Date.now() / 1000) + 1200)] });
          steps.push("minted sUSD until leverage is about 2x");
        }
        const bal = (await pc.readContract({ address: sUSD, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (bal > 0n) {
          await write({ address: sUSD, abi: erc20Abi, functionName: "approve", args: [sp, bal] });
          await write({ address: sp, abi: StabilityPoolAbi, functionName: "deposit", args: [bal] });
          steps.push(`staked ${(Number(bal) / 1e18).toFixed(2)} sUSD`);
        }
        return { steps };
      }
      if (!sb) throw new Error("sandbox not set up yet");
      if (action === "live") {
        await write({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "reset" });
        return {};
      }
      const anchor = (await pc.readContract({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "anchor" })) as bigint;
      const dec = Number(await pc.readContract({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "decimals" }));
      const target = (anchor * BigInt(10000 + Number(body.bps))) / 10000n;
      const r1 = await write({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "setPrice", args: [target] });
      const price = Number(target) / 10 ** dec;
      let pv: { zone: number; executable: boolean } | null = null;
      for (let i = 0; i < 4 && !pv; i++) {
        try {
          pv = (await pc.readContract({ address: sb.pool, abi: LeveragePoolAbi, functionName: "previewRebalance", blockNumber: r1.blockNumber })) as { zone: number; executable: boolean };
        } catch {
          await new Promise((res) => setTimeout(res, 800));
        }
      }
      if (!pv || pv.zone === 0 || !pv.executable) return { price };
      const r2 = await write({ address: sb.pool, abi: LeveragePoolAbi, functionName: "rebalance" });
      const ev = parseEventLogs({ abi: LeveragePoolAbi, logs: r2.logs, strict: false }).find((e) => e.eventName === "SellZone" || e.eventName === "BuyZone");
      const a = (ev?.args ?? {}) as { levBefore?: bigint; levAfter?: bigint; sold?: bigint; out?: bigint; route?: number };
      const n = (v?: bigint) => (v === undefined ? undefined : Number(v) / 1e18);
      return { price, zone: { kind: pv.zone === 1 ? "sell" : "buy", levBefore: n(a.levBefore), levAfter: n(a.levAfter), sold: n(a.sold), out: n(a.out), toStakers: Number(a.route) === 1 } };
    });
    return Response.json({ ok: true, txs, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "failed";
    return Response.json({ ok: false, error: msg, txs }, { status: 500 });
  }
}
