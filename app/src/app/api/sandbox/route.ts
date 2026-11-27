import { createWalletClient, erc20Abi, fallback, http, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { LeveragePoolAbi, SandboxFactoryAbi, ScenarioFeedAbi, StabilityPoolAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { testnetClient } from "@/lib/server/chain";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Demo sandbox operator (testnet only). SANDBOX_OPERATOR_KEY is a server-only testnet key that owns one private
// sandbox market (SandboxFactory.create) and is the only account that can move its price.
//   GET  -> { enabled, operator }
//   POST { action: "setup" }              open the sandbox, mint sUSD up to ~2x, stake all sUSD
//   POST { action: "move", bps: ±N }      set the price to anchor*(1+bps), then rebalance if a zone is executable
//   POST { action: "live" }               reset the price to the live Atlas price
// Only these fixed actions on the operator's own sandbox are possible; the key never leaves the server.

const MOVES = new Set([5000, 1000, -1000, -2000, -5000]);
// MarketFactory: the same as SandboxFactory, but a wallet can open a new sandbox any time. sandboxOf returns the newest.
const FACTORY = addr(deployments97.core.marketFactoryNVDA) ?? addr(deployments97.core.sandboxFactory);
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
  if (action !== "setup" && action !== "move" && action !== "live" && action !== "reset") return Response.json({ error: "invalid_action" }, { status: 400 });
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

  // Brings the stable side back: the operator deposits NVDA, mints sUSD up to the pool's mint limit (about 2x)
  // and stakes it. It works only near the live price, because the pool blocks mints when the price is far from
  // the CoinMarketCap reference.
  const refill = async (pool: Address, steps: string[]) => {
        const [sUSD, sp] = (await Promise.all([
      pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "sUSD" }),
      pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "stabilityPool" }),
    ])) as [Address, Address];
    // A slow RPC node can answer 0 for a pool that was opened one block ago. Ask again a few times.
    let max = 0n;
    for (let i = 0; i < 4 && max === 0n; i++) {
      if (i > 0) await new Promise((res) => setTimeout(res, 2000));
      max = (await pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "maxMintStable" }).catch(() => 0n)) as bigint;
    }
    const amt = (max * 97n) / 100n;
    const have = (await pc.readContract({ address: TNVDA, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
    if (amt > 10n ** 16n && have >= amt) {
      await write({ address: TNVDA, abi: erc20Abi, functionName: "approve", args: [pool, amt] });
      await write({ address: pool, abi: LeveragePoolAbi, functionName: "mintStable", args: [amt, 0n, BigInt(Math.floor(Date.now() / 1000) + 1200)] });
      steps.push("minted sUSD until leverage is about 2x");
    }
    // The sUSD is NOT staked. With an empty insurance pool, the pool sells NVDA on the exchange route, so the vault
    // receives dollars (vault money) and can buy NVDA back when the price rises.
    void sUSD;
    void sp;
  };

  try {
    const out = await locked(async () => {
      let sb = await sandbox();
      if (action === "setup" || action === "reset") {
        const steps: string[] = [];
        // "reset" always opens a new pool. Use it after a move that emptied the leveraged side.
        if (!sb || action === "reset") {
          await write({ address: FACTORY, abi: SandboxFactoryAbi, functionName: "create" });
          steps.push("opened the sandbox market");
          sb = await sandbox();
        }
        if (!sb) throw new Error("sandbox not found after create");
        await refill(sb.pool, steps);
        return { steps };
      }
      if (!sb) throw new Error("sandbox not set up yet");
      if (action === "live") {
        await write({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "reset" });
        // After big moves the pool can be far below its band. New stable deposits bring the leverage back.
        const steps: string[] = [];
        await refill(sb.pool, steps).catch(() => undefined);
        return { steps };
      }
      const anchor = (await pc.readContract({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "anchor" })) as bigint;
      const dec = Number(await pc.readContract({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "decimals" }));
      // A real price does not jump 50% in one block. A big move runs in steps of 10%, and the pool rebalances at
      // each step, the same as a keeper does while the price falls. One jump of -50% at 2x leaves nothing to sell.
      const bps = Number(body.bps);
      const steps = Math.abs(bps) > 2000 ? [2000, 3500, 5000].map((x) => Math.sign(bps) * x) : [bps];
      const n = (v?: bigint) => (v === undefined ? undefined : Number(v) / 1e18);
      type Zone = { kind: "sell" | "buy"; levBefore?: number; levAfter?: number; sold?: number; out?: number; toStakers?: boolean };
      let price = 0;
      let zone: Zone | undefined;
      let sales = 0;
      let soldTotal = 0;
      let outTotal = 0;
      for (const b of steps) {
        const target = (anchor * BigInt(10000 + b)) / 10000n;
        const r1 = await write({ address: sb.feed, abi: ScenarioFeedAbi, functionName: "setPrice", args: [target] });
        price = Number(target) / 10 ** dec;
        type Pv = { zone: number; executable: boolean; cooldownLeft: bigint };
        const preview = async (block?: bigint): Promise<Pv | null> => {
          for (let i = 0; i < 4; i++) {
            try {
              return (await pc.readContract({ address: sb.pool, abi: LeveragePoolAbi, functionName: "previewRebalance", ...(block ? { blockNumber: block } : {}) })) as Pv;
            } catch {
              await new Promise((res) => setTimeout(res, 800));
            }
          }
          return null;
        };
        let pv = await preview(r1.blockNumber);
        if (!pv || pv.zone === 0) {
          // A slow RPC node can answer with the state before the price change. Ask one more time.
          await new Promise((res) => setTimeout(res, 2500));
          pv = await preview();
        }
        if (!pv || pv.zone === 0) continue;
        // The exchange route allows one sale every 30 seconds.
        if (pv.cooldownLeft > 0n) {
          await new Promise((res) => setTimeout(res, (Number(pv!.cooldownLeft) + 3) * 1000));
          pv = await preview();
          if (!pv || pv.zone === 0) continue;
        }
        let r2;
        try {
          r2 = await write({ address: sb.pool, abi: LeveragePoolAbi, functionName: "rebalance" });
        } catch (e) {
          // Rebalance is open to all. If a keeper did it first, the zone is now empty and the step is complete.
          const again = await preview();
          if (again && again.zone === 0) {
            sales += 1;
            zone = { kind: pv.zone === 1 ? "sell" : "buy", levBefore: zone?.levBefore, levAfter: undefined, toStakers: false };
            continue;
          }
          throw e;
        }
        const ev = parseEventLogs({ abi: LeveragePoolAbi, logs: r2.logs, strict: false }).find((e) => e.eventName === "SellZone" || e.eventName === "BuyZone");
        const a = (ev?.args ?? {}) as { levBefore?: bigint; levAfter?: bigint; sold?: bigint; out?: bigint; route?: number };
        sales += 1;
        soldTotal += n(a.sold) ?? 0;
        outTotal += n(a.out) ?? 0;
        zone = { kind: pv.zone === 1 ? "sell" : "buy", levBefore: zone?.levBefore ?? n(a.levBefore), levAfter: n(a.levAfter), sold: soldTotal, out: outTotal, toStakers: Number(a.route) === 1 };
      }
      return { price, zone, rebalances: sales, priceSteps: steps.length };
    });
    return Response.json({ ok: true, txs, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "failed";
    return Response.json({ ok: false, error: msg, txs }, { status: 500 });
  }
}
