import { createWalletClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, erc20Abi, fallback, getAddress, http, isAddress, parseAbi, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { OpenFourCoreAbi, OpenFourToolsAbi, OpenFourVaultAbi } from "@/abi";
import { addr, deployments97 } from "@/config/deployments";
import { CREATE_ARGS_PARAMS, createDigest } from "@/lib/openfour";
import { testnetClient } from "@/lib/server/chain";
import { clientIp, rateLimit, tooMany } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

// Demo operator for TSLA Market launches on OpenFour (Four.meme's launch framework), testnet only, signed by the
// server-only SANDBOX_OPERATOR_KEY (it is also Core.signer of our OpenFour fork, so it can authorise creates):
//   POST { action: "create" }  create a new TSLA Market launch token with MORE's pool-launch preset. The create
//                              arguments are copied from the first TSLA Market launch; only the request id and the
//                              validity time change. Then let its graduation module open a pool (CreatorRegistrar).
//   POST { token }             buy everything left for sale. That sells the launch out and graduates it in the same
//                              transaction: the migrate module opens a new TSLA market.
//   POST {}                    same as { token } for the first TSLA Market launch (kept for older clients).

const CORE = addr(deployments97.openfour.core);
const TOOLS = addr(deployments97.openfour.tools);
const TTSLA = addr(deployments97.tokens.tTSLA);
const REGISTRAR = addr(deployments97.core.creatorRegistrar);
const POOL_FACTORY = addr(deployments97.core.poolFactory);
const FIRST = deployments97.openfour.tokens?.find((t) => !t.hidden && t.poolId === "tsla-four");
const TOKEN = addr(FIRST?.token);
const TEMPLATE_TX = (FIRST as { createTx?: string } | undefined)?.createTx as Hex | undefined;
const PRESET = deployments97.openfour.presetId;

const extraAbi = parseAbi([
  "function registerOpenFourToken(address core, address token)",
  "function isCreator(address who) view returns (bool)",
  "function lastGraduation() view returns ((uint8 branch, address pair, address pool, address sUSD, address xToken, address stabilityPool, uint256 quoteUsed, uint256 tokenUsed, uint256 seedAmount, uint256 mintAmount) g)",
]);

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
  let body: { action?: string; token?: string } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    /* empty body: the first launch */
  }
  if (body.token !== undefined && !isAddress(body.token)) return Response.json({ ok: false, error: "invalid_token" }, { status: 400 });

  const pc = testnetClient;
  const account = privateKeyToAccount(k);
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
  const info = async (token: Address) => {
    const t = (await pc.readContract({ address: CORE, abi: OpenFourCoreAbi, functionName: "tokens", args: [token] })) as readonly unknown[];
    return { presetId: t[2] as bigint, raise: t[8] as bigint, vault: t[10] as Address, migrate: t[13] as Address, exists: t[17] as boolean };
  };
  // The graduation module (a per-token clone) must be a pool creator before it can open the market. Permissionless.
  const register = async (token: Address, migrate: Address) => {
    if (!REGISTRAR || !POOL_FACTORY) return;
    const ok = (await pc.readContract({ address: POOL_FACTORY, abi: extraAbi, functionName: "isCreator", args: [migrate] })) as boolean;
    if (!ok) await send({ address: REGISTRAR, abi: extraAbi, functionName: "registerOpenFourToken", args: [CORE, token] });
  };

  try {
    const out = await locked(async () => {
      if (body.action === "create") {
        if (!TEMPLATE_TX) throw new Error("no template launch in deployments");
        const tpl = await pc.getTransaction({ hash: TEMPLATE_TX });
        const { args } = decodeFunctionData({ abi: OpenFourCoreAbi, data: tpl.input });
        const [a] = decodeAbiParameters(CREATE_ARGS_PARAMS, (args as readonly Hex[])[0]);
        const now = BigInt(Math.floor(Date.now() / 1000));
        const requestId = now * 1000n + BigInt(Math.floor(Math.random() * 1000));
        const createArgs = encodeAbiParameters(CREATE_ARGS_PARAMS, [{ ...a, requestId, validTimestamp: now + 1800n }]);
        const signature = await account.signMessage({ message: { raw: createDigest(bscTestnet.id, account.address, createArgs) } });
        const r = await send({ address: CORE, abi: OpenFourCoreAbi, functionName: "createToken", args: [createArgs, signature], value: a.createFee }, 15_000_000n);
        const ev = parseEventLogs({ abi: OpenFourCoreAbi, logs: r.logs, eventName: "TokenCreated", strict: false })[0];
        const e = (ev?.args ?? {}) as { token?: Address; vault?: Address; migrateModule?: Address };
        if (!e.token || !e.migrateModule) throw new Error("the launch was created but its address was not found in the receipt");
        steps.push(`created the ${a.initParams.name} launch on Four.meme (OpenFour)`);
        await register(e.token, e.migrateModule);
        return { token: e.token, vault: e.vault, migrateModule: e.migrateModule, name: a.initParams.name, symbol: a.initParams.symbol, raise: a.initParams.raiseAmount.toString(), tx: r.transactionHash };
      }

      const token = body.token ? getAddress(body.token) : TOKEN;
      const t = await info(token);
      if (!t.exists || PRESET === undefined || t.presetId !== BigInt(PRESET)) throw new Error("not a MORE market launch");
      const left = (await pc.readContract({ address: t.vault, abi: OpenFourVaultAbi, functionName: "remainingForSale" })) as bigint;
      if (left === 0n) steps.push("the launch is already sold out");
      else {
        await register(token, t.migrate);
        const { result } = await pc.simulateContract({ address: TOOLS, abi: OpenFourToolsAbi, functionName: "estimateBuy", args: [token, account.address, left, 0n, "0x"], account });
        const pays = (result as { userPays: bigint }).userPays;
        const maxPay = (pays * 10_100n) / 10_000n;
        const have = (await pc.readContract({ address: TTSLA, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (have < maxPay) throw new Error(`the funding wallet holds ${(Number(have) / 1e18).toFixed(2)} tTSLA, the raise needs ${(Number(maxPay) / 1e18).toFixed(2)}`);
        const allowance = (await pc.readContract({ address: TTSLA, abi: erc20Abi, functionName: "allowance", args: [account.address, CORE] })) as bigint;
        if (allowance < maxPay) await send({ address: TTSLA, abi: erc20Abi, functionName: "approve", args: [CORE, maxPay] });
        // The sell-out buy also runs graduation (about 6M gas; wallets under-estimate it), so send a fixed 15M.
        await send({ address: CORE, abi: OpenFourCoreAbi, functionName: "buy", args: [token, left, maxPay, 0n, "0x"] }, 15_000_000n);
        steps.push(`funded ${(Number(pays) / 1e18).toFixed(3)} tTSLA: the launch sold out and graduated, opening the TSLA market`);
      }
      const grad = (await pc.readContract({ address: t.migrate, abi: extraAbi, functionName: "lastGraduation" }).catch(() => undefined)) as { pool: Address } | undefined;
      return { token, pool: grad && grad.pool !== zeroAddress ? grad.pool : undefined };
    });
    return Response.json({ ok: true, txs, steps, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "failed";
    return Response.json({ ok: false, error: msg, txs, steps }, { status: 500 });
  }
}
