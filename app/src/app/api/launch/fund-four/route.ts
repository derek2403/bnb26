import { createWalletClient, erc20Abi, fallback, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { OpenFourCoreAbi, OpenFourToolsAbi, OpenFourVaultAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { testnetClient } from "@/lib/server/chain";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// Demo funding for the TSLA Market launch on OpenFour (Four.meme's launch framework), testnet only, signed by the
// server-only SANDBOX_OPERATOR_KEY: POST {} buys everything left for sale, which sells the launch out and
// graduates it in the same transaction (the migrate module opens the TSLA market).

const CORE = addr(deployments97.openfour.core);
const TOOLS = addr(deployments97.openfour.tools);
const TTSLA = addr(deployments97.tokens.tTSLA);
const TOKEN = addr(deployments97.openfour.tokens?.find((t) => !t.hidden && t.poolId === "tsla-four")?.token);

const key = () => {
  const v = process.env.SANDBOX_OPERATOR_KEY?.trim();
  return v ? ((v.startsWith("0x") ? v : `0x${v}`) as Hex) : undefined;
};
const rpcs = () => (process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);
const g = globalThis as unknown as { __sandboxLock?: Promise<unknown> };
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__sandboxLock ?? Promise.resolve()).then(fn, fn);
  g.__sandboxLock = run.catch(() => undefined);
  return run;
}

export async function POST(req: Request) {
  const rl = rateLimit(`fundfour:${clientIp(req)}`, 10, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const k = key();
  if (!k || !CORE || !TOOLS || !TTSLA || !TOKEN) return Response.json({ ok: false, error: "operator_not_configured" }, { status: 503 });
  const pc = testnetClient;
  const account = privateKeyToAccount(k);
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: fallback(rpcs().map((u) => http(u))) });
  const txs: Hex[] = [];
  const steps: string[] = [];
  const send = async (p: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }, gas?: bigint) => {
    await pc.simulateContract({ ...p, account } as never);
    const hash = await wallet.writeContract({ ...p, gas: gas ?? ((await pc.estimateContractGas({ ...p, account } as never)) * 14n) / 10n, gasPrice: await pc.getGasPrice(), type: "legacy" } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    txs.push(hash);
    if (r.status !== "success") throw new Error(`${p.functionName} reverted`);
  };
  try {
    await locked(async () => {
      const info = (await pc.readContract({ address: CORE, abi: OpenFourCoreAbi, functionName: "tokens", args: [TOKEN] })) as readonly unknown[];
      const vault = info[10] as Address;
      const left = (await pc.readContract({ address: vault, abi: OpenFourVaultAbi, functionName: "remainingForSale" })) as bigint;
      if (left === 0n) {
        steps.push("the launch is already sold out");
        return;
      }
      const { result } = await pc.simulateContract({ address: TOOLS, abi: OpenFourToolsAbi, functionName: "estimateBuy", args: [TOKEN, account.address, left, 0n, "0x"], account });
      const pays = (result as { userPays: bigint }).userPays;
      const maxPay = (pays * 10_100n) / 10_000n;
      const allowance = (await pc.readContract({ address: TTSLA, abi: erc20Abi, functionName: "allowance", args: [account.address, CORE] })) as bigint;
      if (allowance < maxPay) await send({ address: TTSLA, abi: erc20Abi, functionName: "approve", args: [CORE, maxPay] });
      // The sell-out buy also runs graduation (about 6M gas; wallets under-estimate it), so send a fixed 15M.
      await send({ address: CORE, abi: OpenFourCoreAbi, functionName: "buy", args: [TOKEN, left, maxPay, 0n, "0x"] }, 15_000_000n);
      steps.push(`bought the last ${(Number(left) / 1e18).toLocaleString("en-US")} TSLAM for ${(Number(pays) / 1e18).toFixed(3)} tTSLA: the launch sold out and graduated, opening the TSLA market`);
    });
    return Response.json({ ok: true, txs, steps }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "failed";
    return Response.json({ ok: false, error: msg, txs, steps }, { status: 500 });
  }
}
