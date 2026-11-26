"use client";
import { useQuery } from "@tanstack/react-query";

export type AtlasPull = { feed: string; feedId: string; payloadHex: `0x${string}`; price: number | null; ts: number | null };

/** Signed Atlas pull report via our server route (key server-side). Refreshed every 30 s. */
export function useAtlasPull(feed?: string) {
  return useQuery({
    queryKey: ["atlas-pull", feed],
    enabled: !!feed,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async (): Promise<AtlasPull | null> => {
      const r = await fetch(`/api/atlas/pull?feed=${feed}`);
      if (!r.ok) return null;
      const j = (await r.json()) as Partial<AtlasPull> & { configured?: boolean };
      // configured:false = no Atlas API key / feed id on the server: no signed report to use.
      return j.payloadHex ? (j as AtlasPull) : null;
    },
  });
}
