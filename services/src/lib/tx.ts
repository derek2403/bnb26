import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { appendLog } from "./hashlog.js";
import type { Signer } from "./chains.js";
import { errMsg, logger } from "./log.js";

const log = logger("tx");

const accountQueue = new Map<string, Promise<void>>();

/** Legacy gas price for BSC testnet sends: TESTNET_GAS_PRICE_WEI, default 0.1 gwei (the chain's floor). */
function testnetGasPrice(): bigint {
  const v = process.env.TESTNET_GAS_PRICE_WEI;
  return v && /^[0-9]+$/.test(v) ? BigInt(v) : 100_000_000n;
}

export interface CallSpec {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas?: bigint;
}

export interface SimResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  revert?: string; // decoded custom error / reason name
}

/** Decoded revert name (custom error or Error(string)) when available. */
export function revertName(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      if (r.data?.errorName) return `${r.data.errorName}(${(r.data.args ?? []).map((a) => String(a)).join(",")})`;
      if (r.reason) return r.reason;
    }
  }
  return undefined;
}

/** eth_call from the signer's account. Never throws. */
export async function simulate(s: Signer | { account?: { address: Address }; public: Signer["public"] }, c: CallSpec): Promise<SimResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (s.public as any).simulateContract({
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args ?? [],
      value: c.value,
      account: s.account,
    });
    return { ok: true, result: r.result };
  } catch (e) {
    return { ok: false, error: errMsg(e), revert: revertName(e) };
  }
}

export interface SendResult {
  ok: boolean;
  hash?: Hex;
  receipt?: TransactionReceipt;
  result?: unknown;
  error?: string;
  revert?: string;
  simulatedOnly?: boolean;
}

/**
 * Simulate, then send, then wait for the receipt. Every sent tx gets a hash-log entry (kind "tx").
 * A failed simulation sends nothing. `dryRun` stops after the simulation.
 */
export async function sendTx(s: Signer, service: string, c: CallSpec, opts: { dryRun?: boolean; timeoutMs?: number; note?: unknown } = {}): Promise<SendResult> {
  const sim = await simulate(s, c);
  if (!sim.ok) {
    log.debug("simulation failed", { service, fn: c.functionName, to: c.address, revert: sim.revert, error: sim.error });
    return { ok: false, error: sim.error, revert: sim.revert };
  }
  if (opts.dryRun) return { ok: true, simulatedOnly: true, result: sim.result };
  // Every role may share one key (KEY_FALLBACK=keeper), and jobs run concurrently: serialize send + receipt per
  // account so two jobs never race for the same nonce.
  const key = `${s.wallet.chain.id}:${s.account.address.toLowerCase()}`;
  const prev = accountQueue.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  accountQueue.set(key, tail);
  await prev;
  let hash: Hex;
  let receipt: TransactionReceipt | undefined;
  try {
    try {
      // BSC testnet (97) rejects txs below the 0.1 gwei floor; viem's EIP-1559 estimate can land under it.
      const gasOpts = s.wallet.chain.id === 97 ? { type: "legacy" as const, gasPrice: testnetGasPrice() } : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash = await (s.wallet as any).writeContract({
        address: c.address,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args ?? [],
        value: c.value,
        gas: c.gas,
        account: s.account,
        chain: s.wallet.chain,
        ...gasOpts,
      });
    } catch (e) {
      log.warn("send failed", { service, fn: c.functionName, to: c.address, error: errMsg(e) });
      return { ok: false, error: errMsg(e), revert: revertName(e) };
    }
    try {
      receipt = await s.public.waitForTransactionReceipt({ hash, timeout: opts.timeoutMs ?? 90_000 });
    } catch (e) {
      log.warn("receipt wait failed", { service, hash, error: errMsg(e) });
    }
  } finally {
    release();
    if (accountQueue.get(key) === tail) accountQueue.delete(key);
  }
  const ok = receipt?.status === "success";
  try {
    await appendLog({
      service,
      kind: "tx",
      endpoint: c.functionName,
      txHash: hash,
      chainId: s.wallet.chain.id,
      data: {
        to: c.address,
        from: s.account.address,
        status: receipt?.status ?? "pending",
        block: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed,
        note: opts.note,
      },
    });
  } catch (e) {
    log.warn("hash-log append failed", { error: errMsg(e) });
  }
  log.info("tx", { service, fn: c.functionName, to: c.address, hash, status: receipt?.status ?? "pending" });
  return { ok, hash, receipt, result: sim.result, error: ok ? undefined : `tx ${receipt?.status ?? "pending"}` };
}
