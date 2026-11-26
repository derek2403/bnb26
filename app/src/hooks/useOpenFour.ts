"use client";
import { useQuery } from "@tanstack/react-query";
import { addr, deployments97 } from "@/config/deployments";

export const OF = {
  core: addr(deployments97.openfour.core),
  tools: addr(deployments97.openfour.tools),
  presetId: deployments97.openfour.presetId !== undefined && deployments97.openfour.presetId !== null ? BigInt(deployments97.openfour.presetId) : undefined,
  quoteAsset: addr(deployments97.openfour.quoteAsset) ?? addr(deployments97.tokens.tTSLA),
  treasury: addr(deployments97.openfour.backstopTreasury),
};

export type OfTokenRow = { token: `0x${string}`; poolId?: string; name?: string; symbol?: string; creator?: `0x${string}`; source: string };

export function useOfTokens() {
  return useQuery({
    queryKey: ["of-tokens"],
    refetchInterval: 30_000,
    queryFn: async (): Promise<OfTokenRow[]> => {
      const r = await fetch("/api/openfour/tokens");
      if (!r.ok) return [];
      return ((await r.json()) as { tokens: OfTokenRow[] }).tokens ?? [];
    },
  });
}

// Same order as OpenFourTypes.Phase { Created, Trading, MigratePending, Migrated, Terminal, SoldOut }.
export const PHASES = ["Created", "Trading", "Graduating", "Graduated", "Closed", "Sold out"];
/** OpenFourTypes.Phase.Migrated: the meme graduated and its migrate module opened the pool. */
export const PHASE_MIGRATED = 3;
