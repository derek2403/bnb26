// Demo pools: NOT on-chain. Prices come from real CMC tokenized-stock quotes (server route /api/demo-prices,
// key held server-side), pool state is simulated deterministically per pool (src/lib/demo.ts). They render
// in exactly the same list and detail layout as the real pools; their action panel runs a local simulation.
export type DemoPoolDef = {
  id: string;
  symbol: string;
  name: string;
  /** Symbol sent to CMC /v5/real-world-assets/quotes/latest. */
  cmcSymbol: string;
  /** Used when CMC is unavailable (no key, error, rate limit). Approximate, labelled "fallback" in the API. */
  fallbackPrice: number;
  /** Shape of the simulated pool. */
  tvlUsd: number;
  baseLeverage: number;
  /** Launchpad badge shown in the list ("Opened by Flap" / "Opened by Four.meme"). */
  launchpad: "flap" | "four";
};

export const DEMO_POOLS: DemoPoolDef[] = [
  { id: "aapl", symbol: "AAPL", name: "Apple", cmcSymbol: "AAPL", fallbackPrice: 232, tvlUsd: 2_400_000, baseLeverage: 1.95, launchpad: "flap" },
  { id: "msft", symbol: "MSFT", name: "Microsoft", cmcSymbol: "MSFT", fallbackPrice: 470, tvlUsd: 1_850_000, baseLeverage: 2.05, launchpad: "four" },
  { id: "googl", symbol: "GOOGL", name: "Alphabet", cmcSymbol: "GOOGL", fallbackPrice: 205, tvlUsd: 1_320_000, baseLeverage: 1.88, launchpad: "flap" },
  { id: "amzn", symbol: "AMZN", name: "Amazon", cmcSymbol: "AMZN", fallbackPrice: 228, tvlUsd: 1_120_000, baseLeverage: 2.12, launchpad: "four" },
  { id: "meta", symbol: "META", name: "Meta Platforms", cmcSymbol: "META", fallbackPrice: 690, tvlUsd: 960_000, baseLeverage: 2.18, launchpad: "flap" },
  { id: "avgo", symbol: "AVGO", name: "Broadcom", cmcSymbol: "AVGO", fallbackPrice: 330, tvlUsd: 740_000, baseLeverage: 1.92, launchpad: "four" },
  { id: "nflx", symbol: "NFLX", name: "Netflix", cmcSymbol: "NFLX", fallbackPrice: 1150, tvlUsd: 610_000, baseLeverage: 2.02, launchpad: "flap" },
  { id: "coin", symbol: "COIN", name: "Coinbase", cmcSymbol: "COIN", fallbackPrice: 320, tvlUsd: 540_000, baseLeverage: 1.78, launchpad: "four" },
  { id: "mstr", symbol: "MSTR", name: "Strategy", cmcSymbol: "MSTR", fallbackPrice: 380, tvlUsd: 470_000, baseLeverage: 1.72, launchpad: "four" },
  { id: "amd", symbol: "AMD", name: "AMD", cmcSymbol: "AMD", fallbackPrice: 170, tvlUsd: 830_000, baseLeverage: 2.08, launchpad: "flap" },
];

/** Reference symbols also quoted by /api/demo-prices (shown next to the real pools, never used on-chain). */
export const REFERENCE_SYMBOLS = ["NVDA", "TSLA"] as const;
export const REFERENCE_FALLBACK: Record<string, number> = { NVDA: 180, TSLA: 420 };

export const STOCK_NAMES: Record<string, string> = {
  NVDA: "NVIDIA",
  TSLA: "Tesla",
  ...Object.fromEntries(DEMO_POOLS.map((d) => [d.symbol, d.name])),
};

export function demoPool(id: string): DemoPoolDef | undefined {
  return DEMO_POOLS.find((d) => d.id === id);
}
