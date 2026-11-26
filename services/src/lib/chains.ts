import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import { env, roleKey, type KeyRole } from "../config/env.js";

export type ChainKind = "testnet" | "mainnet";

function urls(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function transportFor(list: string): Transport {
  const u = urls(list);
  const ts = u.map((x) => http(x, { timeout: 15_000, retryCount: 1, batch: { wait: 10 } }));
  return ts.length === 1 ? ts[0] : fallback(ts, { rank: false });
}

export function chainFor(kind: ChainKind): Chain {
  return kind === "testnet" ? { ...bscTestnet, id: env().CHAIN_ID } : { ...bsc, id: env().MAINNET_CHAIN_ID };
}

export function chainKindOf(chainId: number): ChainKind {
  return chainId === env().MAINNET_CHAIN_ID ? "mainnet" : "testnet";
}

const pubCache = new Map<string, PublicClient>();

/** Read client. `logs: true` returns the keyed RPC that allows eth_getLogs (public BSC RPCs reject it). */
export function publicClient(kind: ChainKind, opts: { logs?: boolean } = {}): PublicClient {
  const e = env();
  const key = `${kind}:${opts.logs ? "logs" : "rpc"}`;
  const hit = pubCache.get(key);
  if (hit) return hit;
  const rpc =
    kind === "testnet"
      ? opts.logs
        ? (e.BSC_TESTNET_LOGS_RPC ?? e.BSC_TESTNET_RPC)
        : e.BSC_TESTNET_RPC
      : opts.logs
        ? (e.BSC_MAINNET_LOGS_RPC ?? e.BSC_MAINNET_RPC)
        : e.BSC_MAINNET_RPC;
  const c = createPublicClient({ chain: chainFor(kind), transport: transportFor(rpc), batch: { multicall: { wait: 16 } } }) as PublicClient;
  pubCache.set(key, c);
  return c;
}

export function hasLogsRpc(kind: ChainKind): boolean {
  return kind === "testnet" ? true : Boolean(env().BSC_MAINNET_LOGS_RPC);
}

/** Role -> chain. Mainnet roles never sign on the testnet and vice versa. */
export const ROLE_CHAIN: Record<KeyRole, ChainKind> = {
  mirror: "testnet",
  risk97: "testnet",
  agent: "testnet",
  ops: "testnet",
  anchor: "testnet",
  evaluator: "testnet",
  risk56: "mainnet",
  anchor56: "mainnet",
  agent56: "mainnet",
};

export interface Signer {
  role: KeyRole;
  kind: ChainKind;
  account: Account;
  wallet: WalletClient<Transport, Chain, Account>;
  public: PublicClient;
}

const signerCache = new Map<string, Signer | null>();

/** Signer for a role key, or null when the key is not configured (the job then skips its writes). */
export function signer(role: KeyRole, kindOverride?: ChainKind): Signer | null {
  const kind = kindOverride ?? ROLE_CHAIN[role];
  const cacheKey = `${role}:${kind}`;
  if (signerCache.has(cacheKey)) return signerCache.get(cacheKey)!;
  const pk = roleKey(role);
  if (!pk) {
    signerCache.set(cacheKey, null);
    return null;
  }
  const account = privateKeyToAccount(pk);
  const e = env();
  const wallet = createWalletClient({
    account,
    chain: chainFor(kind),
    transport: transportFor(kind === "testnet" ? e.BSC_TESTNET_RPC : e.BSC_MAINNET_RPC),
  });
  const s: Signer = { role, kind, account, wallet, public: publicClient(kind) };
  signerCache.set(cacheKey, s);
  return s;
}
