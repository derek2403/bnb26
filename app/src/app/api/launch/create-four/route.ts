import {
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  fallback,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { CreatorRegistrarAbi, OpenFourCoreAbi, OpenFourToolsAbi, OpenFourVaultAbi, PoolFactoryAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { CREATE_ARGS_PARAMS, createDigest } from "@/lib/openfour";
import { testnetClient } from "@/lib/server/chain";
import { serverEnv } from "@/lib/server/env";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Demo launch on OpenFour (Four.meme's launch framework), testnet only. One POST does the whole launch:
//   1. create a new "TSLA Market" launch token. The create arguments are copied from the first TSLA Market launch
//      (same preset and modules), with a new request id, deadline, name and symbol. Core.signer signs them
//      (OF_UI_SIGNER_PRIVATE_KEY) for the operator, which sends the transaction.
//   2. register the launch's migrate module, so graduation may open a pool (CreatorRegistrar, permissionless).
//   3. buy the whole sale with the operator's tTSLA. The sell-out buy also graduates the launch, and graduation
//      opens a new TSLA market on MORE.
// Both keys are server-only. The stock is fixed to TSLA because the preset raises tTSLA.

const CHAIN_ID = 97;
const CORE = addr(deployments97.openfour.core);
const TOOLS = addr(deployments97.openfour.tools);
const TTSLA = addr(deployments97.tokens.tTSLA);
const REGISTRAR = addr(deployments97.core.creatorRegistrar);
const TEMPLATE_TX = (deployments97.openfour.tokens as unknown as { poolId?: string; hidden?: boolean; createTx?: Hex }[] | undefined)?.find((t) => !t.hidden && t.poolId === "tsla-four")?.createTx;
const createAbi = parseAbi(["function createToken(bytes createArgs, bytes signature) payable returns (address)"]);

const opKey = () => {
  const v = process.env.SANDBOX_OPERATOR_KEY?.trim();
  return v ? ((v.startsWith("0x") ? v : `0x${v}`) as Hex) : undefined;
};
const rpcs = () => (process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);

// Shared with /api/sandbox and /api/launch/fund: the operator key signs one transaction at a time.
const g = globalThis as unknown as { __sandboxLock?: Promise<unknown> };
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__sandboxLock ?? Promise.resolve()).then(fn, fn);
  g.__sandboxLock = run.catch(() => undefined);
  return run;
}

export async function POST(req: Request) {
  const rl = rateLimit(`createfour:${clientIp(req)}`, 6, 600);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const k = opKey();
  const rawSigner = serverEnv.ofSignerKey();
  if (!k || !CORE || !TOOLS || !TTSLA || !REGISTRAR || !TEMPLATE_TX) {
    return Response.json({ ok: false, error: "The Four.meme launch is not configured on this server." }, { status: 503 });
  }
  const pc = testnetClient;
  const account = privateKeyToAccount(k);
  // Core.signer can change. Read it from the chain and sign with the server key that matches it.
  const want = ((await pc.readContract({ address: CORE, abi: parseAbi(["function signer() view returns (address)"]), functionName: "signer" })) as Address).toLowerCase();
  const other = rawSigner ? privateKeyToAccount((rawSigner.startsWith("0x") ? rawSigner : `0x${rawSigner}`) as Hex) : undefined;
  const signer = [account, other].find((a) => a && a.address.toLowerCase() === want);
  if (!signer) return Response.json({ ok: false, error: "No server key matches the Four.meme signer." }, { status: 503 });
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: fallback(rpcs().map((u) => http(u))) });
  const txs: Hex[] = [];
  const steps: string[] = [];
  const send = async (p: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint }, gas?: bigint) => {
    await pc.simulateContract({ ...p, account } as never);
    const hash = await wallet.writeContract({ ...p, gas: gas ?? ((await pc.estimateContractGas({ ...p, account } as never)) * 14n) / 10n, gasPrice: await pc.getGasPrice(), type: "legacy" } as never);
    const r = await pc.waitForTransactionReceipt({ hash });
    txs.push(hash);
    if (r.status !== "success") throw new Error(`${p.functionName} reverted`);
    return r;
  };

  try {
    const out = await locked(async () => {
      // 1. Create: copy the first launch's arguments.
      const first = await pc.getTransaction({ hash: TEMPLATE_TX });
      const { args } = decodeFunctionData({ abi: createAbi, data: first.input });
      const [base] = decodeAbiParameters(CREATE_ARGS_PARAMS, args[0] as Hex);
      const n = Math.floor(Date.now() / 1000) % 100000;
      const name = `TSLA Market ${n}`;
      const symbol = `TSLAM${n}`;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const createArgs = encodeAbiParameters(CREATE_ARGS_PARAMS, [
        { ...base, requestId: BigInt(Date.now()) * 1000n + BigInt(n % 1000), validTimestamp: now + 3600n, initParams: { ...base.initParams, name, symbol } },
      ]);
      const signature = await signer.signMessage({ message: { raw: createDigest(CHAIN_ID, account.address, createArgs) } });
      const created = await send({ address: CORE, abi: createAbi, functionName: "createToken", args: [createArgs, signature], value: base.createFee }, 15_000_000n);
      const ev = parseEventLogs({ abi: OpenFourCoreAbi, logs: created.logs, eventName: "TokenCreated" as never })[0] as unknown as { args: { token: Address } } | undefined;
      if (!ev) throw new Error("the launch was created, but its token was not found");
      const token = ev.args.token;
      steps.push(`created the launch ${name}`);

      // 2. Let this launch open a pool when it graduates.
      await send({ address: REGISTRAR, abi: CreatorRegistrarAbi, functionName: "registerOpenFourToken", args: [CORE, token] });
      steps.push("registered it with MORE");

      // 3. Buy the whole sale. The sell-out buy runs graduation, which opens the market.
      const info = (await pc.readContract({ address: CORE, abi: OpenFourCoreAbi, functionName: "tokens", args: [token] })) as readonly unknown[];
      const vault = info[10] as Address;
      const left = (await pc.readContract({ address: vault, abi: OpenFourVaultAbi, functionName: "remainingForSale" })) as bigint;
      const { result } = await pc.simulateContract({ address: TOOLS, abi: OpenFourToolsAbi, functionName: "estimateBuy", args: [token, account.address, left, 0n, "0x"], account });
      const pays = (result as { userPays: bigint }).userPays;
      const maxPay = (pays * 10_100n) / 10_000n;
      const bal = (await pc.readContract({ address: TTSLA, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
      if (bal < maxPay) throw new Error(`the server wallet has ${(Number(bal) / 1e18).toFixed(2)} tTSLA and needs ${(Number(maxPay) / 1e18).toFixed(2)}`);
      const allowance = (await pc.readContract({ address: TTSLA, abi: erc20Abi, functionName: "allowance", args: [account.address, CORE] })) as bigint;
      if (allowance < maxPay) await send({ address: TTSLA, abi: erc20Abi, functionName: "approve", args: [CORE, maxPay] });
      const bought = await send({ address: CORE, abi: OpenFourCoreAbi, functionName: "buy", args: [token, left, maxPay, 0n, "0x"] }, 15_000_000n);
      const pc2 = parseEventLogs({ abi: PoolFactoryAbi, logs: bought.logs, eventName: "PoolCreated" as never })[0] as unknown as { args: { pool: Address } } | undefined;
      steps.push(`funded it with ${(Number(pays) / 1e18).toFixed(2)} tTSLA: it sold out and graduated`);
      if (pc2) steps.push("the new TSLA market is open on MORE");
      return { token, name, symbol, pool: pc2?.args.pool ?? null };
    });
    return Response.json({ ok: true, ...out, txs, steps }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : "the launch failed";
    return Response.json({ ok: false, error: msg.slice(0, 300), txs, steps }, { status: 500 });
  }
}
