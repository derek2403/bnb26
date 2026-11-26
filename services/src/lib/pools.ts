import type { Address } from "viem";
import { poolFactoryAbi } from "../abi/index.js";
import { env } from "../config/env.js";
import { testnet } from "../config/deployments.js";
import { publicClient } from "./chains.js";
import { logger, errMsg } from "./log.js";

const log = logger("pools");

export const POOL_KIND = ["LIVE", "SCENARIO", "SANDBOX", "DEV"] as const;
export const POOL_MODE = ["UNSEEDED", "NORMAL", "STABILITY", "UNDERWATER", "NO_PRICE"] as const;

export interface PoolRef {
  address: Address;
  id: string; // deployments slug, or "factory:<index>"
  symbol: string;
  kind: string; // LIVE | SCENARIO | SANDBOX | DEV
  sUSD?: Address;
  xToken?: Address;
  stabilityPool?: Address;
  asset?: Address;
  router?: Address;
  creator?: Address;
}

let cache: { at: number; pools: PoolRef[] } | undefined;

/** deployments.pools plus (REBALANCE_FACTORY_POOLS) every pool the PoolFactory knows, sandboxes included. */
export async function listPools(opts: { includeFactory?: boolean } = {}): Promise<PoolRef[]> {
  const includeFactory = opts.includeFactory ?? env().REBALANCE_FACTORY_POOLS;
  if (cache && Date.now() - cache.at < 60_000 && includeFactory) return cache.pools;
  const d = testnet();
  const out = new Map<string, PoolRef>();
  for (const p of d?.pools ?? []) {
    if (!p.pool) continue;
    out.set(p.pool.toLowerCase(), {
      address: p.pool,
      id: p.id,
      symbol: p.symbol,
      kind: (p.kind ?? "").toLowerCase() === "scenario" ? "SCENARIO" : (p.kind ?? "").toLowerCase() === "dev" ? "DEV" : "LIVE",
      sUSD: p.sUSD,
      xToken: p.xToken,
      stabilityPool: p.stabilityPool,
    });
  }
  const factory = d?.core.poolFactory;
  if (includeFactory && factory) {
    try {
      const c = publicClient("testnet");
      const n = await c.readContract({ address: factory, abi: poolFactoryAbi, functionName: "poolCount" });
      const idx = Array.from({ length: Number(n) }, (_, i) => BigInt(i));
      const addrs = await Promise.all(idx.map((i) => c.readContract({ address: factory, abi: poolFactoryAbi, functionName: "poolAt", args: [i] })));
      const infos = await Promise.all(addrs.map((a) => c.readContract({ address: factory, abi: poolFactoryAbi, functionName: "poolInfo", args: [a] })));
      infos.forEach((info, i) => {
        const key = info.pool.toLowerCase();
        const prev = out.get(key);
        out.set(key, {
          address: info.pool,
          id: prev?.id ?? `factory:${i}`,
          symbol: info.symbol,
          kind: POOL_KIND[Number(info.kind)] ?? "DEV",
          sUSD: info.sUSD,
          xToken: info.xToken,
          stabilityPool: info.stabilityPool,
          asset: info.asset,
          router: info.router,
          creator: info.creator,
        });
      });
    } catch (e) {
      log.warn("factory enumeration failed", { error: errMsg(e) });
    }
  }
  const pools = [...out.values()];
  if (includeFactory) cache = { at: Date.now(), pools };
  return pools;
}
