import "server-only";
import type { Address, Hex } from "viem";

// In-memory records of signed create requests and created tokens (per server instance). Best-effort mirrored
// to the services API (POST /openfour/records), which is the durable store. The UI lists tokens from these
// records plus deployments.openfour.tokens and checks each with Core.tokens(); it never scans logs.
export type SignedRequest = { requestId: string; caller: Address; name: string; symbol: string; createArgsHash: Hex; signedAt: number };
export type TokenRecord = { token: Address; creator: Address; name: string; symbol: string; requestId: string; txHash: Hex; createdAt: number };

const g = globalThis as unknown as { __ofStore?: { requests: Map<string, SignedRequest>; tokens: Map<string, TokenRecord>; perWallet: Map<string, number[]> } };
g.__ofStore ??= { requests: new Map(), tokens: new Map(), perWallet: new Map() };
export const ofStore = g.__ofStore;

/** Max creates per wallet per rolling day. */
export const PER_WALLET_DAILY = 3;

export function walletCount(caller: string): number {
  const day = Date.now() - 86_400_000;
  const list = (ofStore.perWallet.get(caller.toLowerCase()) ?? []).filter((t) => t > day);
  ofStore.perWallet.set(caller.toLowerCase(), list);
  return list.length;
}

export function bumpWallet(caller: string) {
  const list = ofStore.perWallet.get(caller.toLowerCase()) ?? [];
  list.push(Date.now());
  ofStore.perWallet.set(caller.toLowerCase(), list);
}
