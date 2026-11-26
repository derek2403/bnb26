import { bsc, bscTestnet } from "viem/chains";
import { fallback, http, type Transport } from "viem";

export const WRITE_CHAIN = bscTestnet; // every write goes to BSC testnet (97)
export const READ_ONLY_CHAIN = bsc; // mainnet (56): anchor, lens, ERC-8004 reads only

// Public RPC URLs only (no keys). Override with NEXT_PUBLIC_BSC_TESTNET_RPCS / NEXT_PUBLIC_BSC_MAINNET_RPCS
// (comma-separated). Keyed RPCs stay server-side (BSC_TESTNET_RPC / BSC_MAINNET_RPC).
const list = (v: string | undefined, d: string[]) =>
  v && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : d;

export const TESTNET_RPCS = list(process.env.NEXT_PUBLIC_BSC_TESTNET_RPCS, [
  "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
  "https://bsc-testnet-rpc.publicnode.com",
]);
export const MAINNET_RPCS = list(process.env.NEXT_PUBLIC_BSC_MAINNET_RPCS, [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-rpc.publicnode.com",
]);

export const transports: Record<number, Transport> = {
  [bscTestnet.id]: fallback(TESTNET_RPCS.map((u) => http(u, { batch: true }))),
  [bsc.id]: fallback(MAINNET_RPCS.map((u) => http(u, { batch: true }))),
};

export function explorer(chainId: number = bscTestnet.id) {
  return chainId === bsc.id ? "https://bscscan.com" : "https://testnet.bscscan.com";
}
export const txUrl = (hash: string, chainId?: number) => `${explorer(chainId)}/tx/${hash}`;
export const addressUrl = (a: string, chainId?: number) => `${explorer(chainId)}/address/${a}`;
export const tokenUrl = (a: string, chainId?: number) => `${explorer(chainId)}/token/${a}`;
