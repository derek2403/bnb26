import { getAddress, type Address } from "viem";
import { z } from "zod";
import { externalAddress, mainnet } from "./deployments.js";

/**
 * CMC identifiers per asset symbol. Token addresses come from deployments/56.json `mainnet.<sym>b` (the deploy
 * script writes `mainnet.nvdab`), then `external.<SYM>B`; the
 * defaults below are the external, verified mainnet facts from the plan (26 Nov 2026 live reads), used only
 * when 56.json does not list them yet. Override everything with CMC_ASSETS (JSON) if needed.
 *
 *   NVDA: NVDAB BEP-20 0x02fca66c1d1afb4e2a7884261eb00f63598a7436, CMC id 40215, RWA rwa_id 2 (docs example; [UNVERIFIED] by /map)
 *   TSLA: TSLAB CMC id 40214 (Atlas feed list). Token address and rwa_id [UNVERIFIED]: set external.TSLAB in 56.json.
 */
export interface CmcAsset {
  symbol: string; // pool symbol: NVDA, TSLA
  cmcId: number; // /v3/cryptocurrency/quotes/latest id (the tokenized stock, e.g. NVDAB)
  rwaId?: number; // /v5/real-world-assets/quotes/latest rwa_id (the underlying)
  token?: Address; // BSC mainnet token address for /v1/dex/token/price and /v1/k-line/candles
  primary: boolean; // primary asset gets the full endpoint set; others the cheap subset
}

const DEFAULTS: Record<string, Omit<CmcAsset, "token"> & { token?: string }> = {
  NVDA: { symbol: "NVDA", cmcId: 40215, rwaId: 2, token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", primary: true },
  TSLA: { symbol: "TSLA", cmcId: 40214, primary: false },
};

const overrideSchema = z.record(
  z.string(),
  z.object({ cmcId: z.number().int(), rwaId: z.number().int().optional(), token: z.string().optional(), primary: z.boolean().optional() }),
);

export function cmcAsset(symbol: string): CmcAsset | undefined {
  let base = DEFAULTS[symbol] ? { ...DEFAULTS[symbol] } : undefined;
  const raw = process.env.CMC_ASSETS;
  if (raw) {
    const o = overrideSchema.safeParse(JSON.parse(raw));
    if (o.success && o.data[symbol]) base = { symbol, primary: false, ...base, ...o.data[symbol] };
  }
  if (!base) return undefined;
  const m = mainnet();
  const mv = (m?.mainnet as Record<string, unknown> | undefined)?.[`${symbol.toLowerCase()}b`];
  const fromMainnet = typeof mv === "string" && /^0x[0-9a-fA-F]{40}$/.test(mv) ? (getAddress(mv) as Address) : undefined;
  const fromDeploy = fromMainnet ?? externalAddress(m, `${symbol}B`);
  const tok = fromDeploy ?? (base.token ? (getAddress(base.token) as Address) : undefined);
  return { symbol, cmcId: base.cmcId, rwaId: base.rwaId, token: tok, primary: base.primary ?? false };
}
