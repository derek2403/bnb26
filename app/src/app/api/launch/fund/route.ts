import { createWalletClient, erc20Abi, fallback, getAddress, http, isAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { LeveragePoolAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { testnetClient } from "@/lib/server/chain";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// Demo funding for a Flap market launch (testnet only), signed by the server-only SANDBOX_OPERATOR_KEY:
//   POST { launcher } -> contribute the rest of the raise (this launches the token on Flap), then openPool(),
//   which opens the new market. openPool swaps the seed tBNB to tNVDA on PancakeSwap with an Atlas-priced minimum,
//   so the operator first sells a little tNVDA into the WBNB/tNVDA pair when its price is off.
// Only launchers of our own factory with a raise of at most MAX_RAISE are accepted.

const MAX_RAISE = 6n * 10n ** 18n;
const FACTORY = addr(deployments97.flap.launcherFactory);
const TNVDA = addr(deployments97.tokens.tNVDA);
const WBNB = addr(deployments97.tokens.WBNB);
const ROUTER = addr(deployments97.dex.router);

const launcherAbi = parseAbi([
  "function factory() view returns (address)",
  "function targetRaise() view returns (uint256)",
  "function remaining() view returns (uint256)",
  "function launched() view returns (bool)",
  "function failed() view returns (bool)",
  "function poolOpened() view returns (bool)",
  "function pool() view returns (address)",
  "function seedBalance() view returns (uint256)",
  "function seedMinOut(uint256) view returns (uint256 minOut, uint256 bnbUsd, uint256 assetUsd)",
  "function contribute() payable",
  "function openPool() returns (address)",
]);
const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);

const key = () => {
  const v = process.env.SANDBOX_OPERATOR_KEY?.trim();
  return v ? ((v.startsWith("0x") ? v : `0x${v}`) as Hex) : undefined;
};
const rpcs = () => (process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);

// Shared with /api/sandbox: the operator key signs one transaction at a time.
const g = globalThis as unknown as { __sandboxLock?: Promise<unknown> };
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__sandboxLock ?? Promise.resolve()).then(fn, fn);
  g.__sandboxLock = run.catch(() => undefined);
  return run;
}

export async function POST(req: Request) {
  const rl = rateLimit(`launchfund:${clientIp(req)}`, 10, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const k = key();
  if (!k || !FACTORY || !TNVDA || !WBNB || !ROUTER) return Response.json({ ok: false, error: "operator_not_configured" }, { status: 503 });
  let body: { launcher?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.launcher || !isAddress(body.launcher)) return Response.json({ ok: false, error: "invalid_launcher" }, { status: 400 });
  const launcher = getAddress(body.launcher);
  const pc = testnetClient;
  const account = privateKeyToAccount(k);
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: fallback(rpcs().map((u) => http(u))) });
  const txs: Hex[] = [];
  const steps: string[] = [];
  const read = <T,>(functionName: string, args: readonly unknown[] = []) => pc.readContract({ address: launcher, abi: launcherAbi, functionName, args } as never) as Promise<T>;
  const write = async (p: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) => {
    const gas = await pc.estimateContractGas({ ...p, account } as never);
    const hash = await wallet.writeContract({ ...p, gas: (gas * 14n) / 10n, gasPrice: await pc.getGasPrice(), type: "legacy" } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    txs.push(hash);
    if (r.status !== "success") throw new Error(`${p.functionName} reverted`);
    return r;
  };

  try {
    const out = await locked(async () => {
      const factory = await read<Address>("factory").catch(() => zeroAddress);
      if (factory.toLowerCase() !== FACTORY.toLowerCase()) throw new Error("not a MORE market launch");
      if ((await read<bigint>("targetRaise")) > MAX_RAISE) throw new Error("raise is above the demo funding limit");
      if (await read<boolean>("failed")) throw new Error("this launch has expired");

      if (!(await read<boolean>("launched"))) {
        const left = await read<bigint>("remaining");
        const bal = await pc.getBalance({ address: account.address });
        if (bal < left + 3n * 10n ** 16n) throw new Error(`the funding wallet holds ${(Number(bal) / 1e18).toFixed(2)} tBNB, the raise needs ${(Number(left) / 1e18).toFixed(2)}`);
        await write({ address: launcher, abi: launcherAbi, functionName: "contribute", value: left });
        steps.push(`funded ${(Number(left) / 1e18).toFixed(2)} tBNB: the raise is full and the token launched on Flap`);
      }

      if (!(await read<boolean>("poolOpened"))) {
        const seed = await read<bigint>("seedBalance");
        const [minOut] = await read<readonly [bigint, bigint, bigint]>("seedMinOut", [seed]);
        const quote = async () => ((await pc.readContract({ address: ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [seed, [WBNB, TNVDA]] })) as readonly bigint[])[1];
        let approved = false;
        for (let i = 0; i < 12 && (await quote()) < (minOut * 103n) / 100n; i++) {
          if (!approved) {
            await write({ address: TNVDA, abi: erc20Abi, functionName: "approve", args: [ROUTER, 20n * 10n ** 18n] });
            approved = true;
          }
          await write({ address: ROUTER, abi: routerAbi, functionName: "swapExactTokensForETH", args: [5n * 10n ** 17n, 0n, [TNVDA, WBNB], account.address, BigInt(Math.floor(Date.now() / 1000) + 600)] });
        }
        await write({ address: launcher, abi: launcherAbi, functionName: "openPool" });
        steps.push("opened the market");
      }
      // A new market holds only its first-loss seed (leverage 1x). Mint sUSD against it so it opens at about 2x.
      const pool = await read<Address>("pool");
      const st = (await pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "state" })) as { leverage: bigint };
      if (st.leverage < 18n * 10n ** 17n) {
        const max = (await pc.readContract({ address: pool, abi: LeveragePoolAbi, functionName: "maxMintStable" })) as bigint;
        const amt = (max * 97n) / 100n;
        const have = (await pc.readContract({ address: TNVDA, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (amt > 10n ** 15n && have >= amt) {
          await write({ address: TNVDA, abi: erc20Abi, functionName: "approve", args: [pool, amt] });
          await write({ address: pool, abi: LeveragePoolAbi, functionName: "mintStable", args: [amt, 0n, BigInt(Math.floor(Date.now() / 1000) + 1200)] });
          steps.push("minted sUSD so the market starts at about 2x leverage");
        }
      }
      return { pool };
    });
    return Response.json({ ok: true, txs, steps, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "failed";
    return Response.json({ ok: false, error: msg, txs, steps }, { status: 500 });
  }
}
