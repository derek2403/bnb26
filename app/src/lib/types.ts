import type { Address, Hex } from "viem";

export const MODES = ["UNSEEDED", "NORMAL", "STABILITY", "UNDERWATER", "NO_PRICE"] as const;
export type ModeName = (typeof MODES)[number];
export const RISK_SOURCES = ["RULE", "AGENT", "FALLBACK"] as const;
export type RiskSourceName = (typeof RISK_SOURCES)[number];

/** Display-model of one pool. Real pools convert ILeveragePool.PoolState into this; demo pools simulate it.
 *  All USD values are plain numbers (display only). */
export type PoolSnapshot = {
  C: number; // asset units
  U: number; // USD (mUSDC)
  S: number; // sUSD supply
  X: number; // x supply
  price: number; // USD per asset unit
  priceUpdatedAt: number; // unix seconds
  priceAge: number; // seconds
  priceFresh: boolean;
  feedHalted: boolean;
  V: number;
  E: number;
  xNav: number;
  leverage: number; // Infinity when E <= 0 and C > 0
  cr: number; // Infinity when S == 0
  mode: ModeName;
  marketOpen: boolean;
  gapGuard: boolean;
  mintsPaused: boolean;
  triggerLev: number;
  targetLev: number;
  lowerTriggerLev: number;
  maxMintLev: number;
  stableMintFeeBps: number;
  leverMintFeeBps: number;
  redeemFeeBps: number;
  stabilityRedeemFeeBps: number;
  stabilityCR: number;
  /** Mint fee base from the RiskOracle (open-market vs closed-market), when known. */
  openFeeBps?: number;
  closedFeeBps?: number;
  riskSource: RiskSourceName;
  snapshotId: number;
  /** StabilityPool total deposits (sUSD) and backstop buffer (USD), when known. */
  spDeposits?: number;
  backstopUsd?: number;
  nextOpen?: number;
  nextClose?: number;
};

export type PoolSource = "flap" | "four" | "scenario" | "sandbox" | "dev" | "demo";

export type PoolMeta = {
  id: string;
  symbol: string; // NVDA
  name: string; // NVIDIA
  source: PoolSource;
  /** Label shown in the "Opened by" column. */
  launchpad: string;
  isDemo: boolean;
  assetSymbol: string; // tNVDA
  stableSymbol: string; // sUSD-NVDA
  leverSymbol: string; // xNVDA
  addresses?: {
    pool: Address;
    asset?: Address;
    usdc?: Address;
    sUSD?: Address;
    xToken?: Address;
    stabilityPool?: Address;
    feed?: Address;
    openedBy?: Address;
    /** Insurance vault of the Flap launch that opened this pool, when it is not the one in deployments. */
    backstopVault?: Address;
  };
  /** Set on a market opened by a launch created from the Launch a market form: the launcher contract. */
  launcher?: Address;
  assetId?: Hex;
  openTx?: Hex;
  /** Atlas pull feed key for /api/atlas/pull (e.g. "nvdab"), when one exists. */
  pullFeed?: string;
};

export type UserBalances = {
  asset: bigint;
  sUSD: bigint;
  x: bigint;
  usdc: bigint;
  assetAllowance: bigint;
  sUSDAllowanceSP?: bigint;
  native?: bigint;
  lastFaucetAt?: number;
  faucetCooldown?: number;
};

export type ActionName = "mintStable" | "mintLever" | "redeemStable" | "redeemLever" | "redeemPair";

export type Quote = {
  out: number; // main output in display units (sUSD, x, or USD value for redeems)
  feeBps: number;
  cOut?: number;
  uOut?: number;
  sBurned?: number;
  xBurned?: number;
  error?: string;
  /** Raw on-chain preview outputs (real pools only), used to derive minOut. */
  raw?: { out?: bigint; cOut?: bigint; uOut?: bigint; sBurned?: bigint; xBurned?: bigint };
};
