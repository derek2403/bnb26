// Typed loader for deployments/<chainId>.json (the only address book; see deployments/SCHEMA.md).
// scripts/sync-deployments.mjs copies the files into src/generated before dev/build, or writes an empty
// example so the app still builds. Every field is optional here: the UI degrades to "awaiting deployment".
import raw97 from "@/generated/deployments.97.json";
import raw56 from "@/generated/deployments.56.json";
import { isAddress, type Address, type Hex } from "viem";

export type PoolKind = "flap" | "four" | "scenario" | "dev";

export type DeployedPool = {
  id: string;
  symbol: string;
  assetId?: Hex;
  kind: PoolKind;
  pool: Address;
  sUSD?: Address;
  xToken?: Address;
  stabilityPool?: Address;
  feed?: Address;
  openedBy?: Address;
  openTx?: Hex;
};

export type OracleEntry = {
  mirror?: Address;
  scenarioFeed?: Address;
  pullAdapter?: Address;
  atlasSource?: { chainId: number; feed: Address };
};

export type FlapLauncherEntry = {
  launcher: Address;
  token?: Address;
  vault?: Address;
  poolId?: string;
  /** Optional: Flap TaxProcessor for the token (dispatch()). Not in SCHEMA.md yet; read when present. */
  taxProcessor?: Address;
};

export type Deployments = {
  chainId: number;
  updatedAt?: string | null;
  deployer?: Address | null;
  tokens: Partial<Record<"tNVDA" | "tTSLA" | "mUSDC" | "WBNB", Address>> & Record<string, Address | undefined>;
  core: Partial<
    Record<
      | "poolFactory"
      | "poolLogic"
      | "riskOracle"
      | "marketCalendar"
      | "logAnchor"
      | "sandboxFactory"
      | "creatorRegistrar"
      | "timelock"
      | "guardian",
      Address
    >
  >;
  oracles: Record<string, OracleEntry | Address | undefined> & { atlasBnbUsd?: Address };
  pools: DeployedPool[];
  dex: { router?: Address; factory?: Address; mockRouter?: Address; pairs?: Record<string, Address> };
  flap: {
    portal?: Address;
    guardian?: Address;
    v2Router?: Address;
    /** Immutable SplitStockConfig: the pool target fixed for this factory pair. */
    config?: Address;
    /** Always the zero address since the config became immutable (kept for older files). */
    configAdmin?: Address;
    launcherFactory?: Address;
    vaultFactory?: Address;
    launchers: FlapLauncherEntry[];
  };
  openfour: {
    registry?: Address;
    core?: Address;
    tools?: Address;
    feeRouter?: Address;
    presetId?: string | number;
    migrateModule?: Address;
    customDataModule?: Address;
    validator?: Address;
    backstopTreasury?: Address;
    /** Optional override of the quote asset the preset requires (defaults to tokens.tTSLA). */
    quoteAsset?: Address;
    tokens: { token: Address; poolId?: string }[];
  };
  mainnet: { atlasCmcAnchor?: Address; nvdabLens?: Address; [k: string]: Address | undefined };
  erc8004: { identity?: Address; reputation?: Address; agentId?: number | string | null };
  _example?: boolean;
};

function clean<T extends object>(x: unknown, fallback: T): T {
  return x && typeof x === "object" ? ({ ...fallback, ...(x as object) } as T) : fallback;
}

function normalize(raw: unknown, chainId: number): Deployments {
  const r = (raw ?? {}) as Record<string, unknown>;
  const flap = clean(r.flap, { launchers: [] as FlapLauncherEntry[] });
  const openfour = clean(r.openfour, { tokens: [] as { token: Address; poolId?: string }[] });
  const pools = Array.isArray(r.pools)
    ? (r.pools as DeployedPool[]).filter((p) => p && typeof p.id === "string" && isAddress(p.pool ?? ""))
    : [];
  return {
    chainId: typeof r.chainId === "number" ? r.chainId : chainId,
    updatedAt: (r.updatedAt as string) ?? null,
    deployer: (r.deployer as Address) ?? null,
    tokens: clean(r.tokens, {}),
    core: clean(r.core, {}),
    oracles: clean(r.oracles, {}),
    pools,
    dex: clean(r.dex, {}),
    flap: { ...flap, launchers: Array.isArray(flap.launchers) ? flap.launchers.filter((l) => isAddress(l?.launcher ?? "")) : [] },
    openfour: {
      ...openfour,
      tokens: Array.isArray(openfour.tokens) ? openfour.tokens.filter((t) => isAddress(t?.token ?? "")) : [],
    },
    mainnet: clean(r.mainnet, {}),
    erc8004: clean(r.erc8004, {}),
    _example: Boolean(r._example),
  };
}

export const deployments97: Deployments = normalize(raw97, 97);
export const deployments56: Deployments = normalize(raw56, 56);

export const isDeployed = !deployments97._example && Boolean(deployments97.core.poolFactory);

/** A valid non-zero address or undefined. */
export function addr(a: unknown): Address | undefined {
  return typeof a === "string" && isAddress(a) && !/^0x0{40}$/i.test(a) ? (a as Address) : undefined;
}

export function oracleFor(symbol: string): OracleEntry | undefined {
  const o = deployments97.oracles[symbol];
  return o && typeof o === "object" ? (o as OracleEntry) : undefined;
}

export function assetTokenFor(symbol: string): Address | undefined {
  return addr(deployments97.tokens[`t${symbol}`]);
}

export function launcherForPool(poolId: string): FlapLauncherEntry | undefined {
  return deployments97.flap.launchers.find((l) => l.poolId === poolId) ?? deployments97.flap.launchers[0];
}

export function realPools(): DeployedPool[] {
  return deployments97.pools.filter((p) => p.kind === "flap" || p.kind === "four");
}

export function scenarioPool(): DeployedPool | undefined {
  return deployments97.pools.find((p) => p.kind === "scenario");
}

/** External, verified mainnet addresses (SCHEMA.md). Used read-only. */
export const MAINNET_EXTERNAL = {
  NVDAB: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
  atlasNvdabFeed: "0xf25af12920d408baf6211e9e90eda89df3d8ccda",
  pcsV3NvdabUsdt: "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c",
  erc8004Identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  erc8004Reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
} as const satisfies Record<string, Address>;

export const TESTNET_EXTERNAL = {
  atlasBnbUsd: "0x3957d289ee9c38272377786787ea34f9dd29788d",
  flapPortal: "0x000042108465206185A077Edc3F3fd2b49060000",
  flapV2Router: "0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3",
  erc8004Identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  erc8004Reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
} as const satisfies Record<string, Address>;
