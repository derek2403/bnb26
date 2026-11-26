import { formatEther, type Address } from "viem";
import { env, roleKey, type KeyRole } from "../config/env.js";
import { alert } from "../lib/alerts.js";
import { ROLE_CHAIN, publicClient, signer } from "../lib/chains.js";
import { errMsg } from "../lib/log.js";
import { MIN, type Job } from "./types.js";

/** health (10 min): role wallet gas balances (alerts below LOW_BALANCE_WEI). Addresses only, never keys. */
export interface WalletInfo {
  role: KeyRole;
  chain: string;
  address?: Address;
  balance?: string;
  low?: boolean;
  error?: string;
}

let cached: { at: number; wallets: WalletInfo[] } | undefined;

export async function walletBalances(maxAgeMs = 60_000): Promise<WalletInfo[]> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.wallets;
  const low = BigInt(env().LOW_BALANCE_WEI);
  const roles = Object.keys(ROLE_CHAIN) as KeyRole[];
  const wallets: WalletInfo[] = [];
  for (const role of roles) {
    const kind = ROLE_CHAIN[role];
    if (!roleKey(role)) {
      wallets.push({ role, chain: kind });
      continue;
    }
    const s = signer(role);
    if (!s) continue;
    try {
      const b = await publicClient(kind).getBalance({ address: s.account.address });
      wallets.push({ role, chain: kind, address: s.account.address, balance: formatEther(b), low: b < low });
    } catch (e) {
      wallets.push({ role, chain: kind, address: s.account.address, error: errMsg(e) });
    }
  }
  cached = { at: Date.now(), wallets };
  return wallets;
}

export const healthJob: Job = {
  name: "health",
  everyMs: 10 * MIN,
  run: async () => {
    const w = await walletBalances(0);
    for (const x of w) if (x.low) void alert(`low-balance-${x.role}`, `${x.role} wallet ${x.address} on ${x.chain} is low: ${x.balance} BNB`, 6 * 60 * MIN);
    return w;
  },
};
