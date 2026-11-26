import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { env } from "./env.js";

/**
 * Loader for deployments/<chainId>.json (see deployments/SCHEMA.md, the ONLY address book).
 * Every field is optional so that a partially deployed chain still loads; callers check what they need.
 * Unknown extra fields are kept (passthrough) so other components can add sections without breaking us.
 */
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((a) => getAddress(a) as Address);
/** A "0x…" placeholder or empty string from the schema template reads as missing. */
const optAddr = z
  .union([addr, z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (getAddress(v) as Address) : undefined));
const optHex = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? (v as Hex) : undefined));

const oracleEntry = z
  .object({
    mirror: optAddr,
    scenarioFeed: optAddr,
    pullAdapter: optAddr,
    atlasSource: z
      .object({ chainId: z.number().optional(), feed: optAddr })
      .passthrough()
      .optional(),
  })
  .passthrough();

const poolEntry = z
  .object({
    id: z.string(),
    symbol: z.string(),
    assetId: optHex,
    kind: z.string().optional(), // flap | four | scenario | dev
    pool: optAddr,
    sUSD: optAddr,
    xToken: optAddr,
    stabilityPool: optAddr,
    feed: optAddr,
    openedBy: optAddr,
    openTx: optHex,
  })
  .passthrough();

const schema = z
  .object({
    chainId: z.number(),
    updatedAt: z.string().optional(),
    deployer: optAddr,
    tokens: z.record(z.string(), optAddr).optional().default({}),
    core: z
      .object({
        poolFactory: optAddr,
        poolLogic: optAddr,
        riskOracle: optAddr,
        marketCalendar: optAddr,
        logAnchor: optAddr,
        sandboxFactory: optAddr,
        creatorRegistrar: optAddr,
        timelock: optAddr,
        guardian: optAddr,
      })
      .passthrough()
      .prefault({}),
    oracles: z
      .record(z.string(), z.union([oracleEntry, z.string(), z.null()]))
      .optional()
      .default({}),
    pools: z.array(poolEntry).optional().default([]),
    dex: z
      .object({
        router: optAddr,
        factory: optAddr,
        mockRouter: optAddr,
        pairs: z.record(z.string(), optAddr).optional().default({}),
      })
      .passthrough()
      .prefault({}),
    flap: z
      .object({
        portal: optAddr,
        guardian: optAddr,
        v2Router: optAddr,
        launcherFactory: optAddr,
        vaultFactory: optAddr,
        launchers: z
          .array(
            z
              .object({
                launcher: optAddr,
                token: optAddr,
                vault: optAddr,
                taxProcessor: optAddr, // optional; else read from the token
                poolId: z.string().nullish(),
              })
              .passthrough(),
          )
          .optional()
          .default([]),
      })
      .passthrough()
      .optional(),
    openfour: z
      .object({
        registry: optAddr,
        core: optAddr,
        tools: optAddr,
        feeRouter: optAddr,
        presetId: z.union([z.string(), z.number(), z.null()]).optional(),
        migrateModule: optAddr,
        customDataModule: optAddr,
        validator: optAddr,
        backstopTreasury: optAddr,
        tokens: z
          .array(z.object({ token: optAddr, poolId: z.string().nullish(), migrateModule: optAddr }).passthrough())
          .optional()
          .default([]),
      })
      .passthrough()
      .optional(),
    mainnet: z
      .object({ atlasCmcAnchor: optAddr, nvdabLens: optAddr })
      .passthrough()
      .optional(),
    /** 56.json: external (not ours) addresses, e.g. { "NVDAB": "0x02fc…", "TSLAB": "0x…", "atlasNVDAB": "0xf25a…" } */
    external: z.record(z.string(), z.union([z.string(), z.null(), z.record(z.string(), z.unknown())])).optional(),
    erc8004: z
      .object({
        identity: optAddr,
        reputation: optAddr,
        validation: optAddr,
        agentId: z.union([z.string(), z.number(), z.null()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Deployments = z.infer<typeof schema>;
export type PoolEntry = z.infer<typeof poolEntry>;
export type OracleEntry = z.infer<typeof oracleEntry>;

const here = dirname(fileURLToPath(import.meta.url));

export function deploymentsDir(): string {
  const e = env().DEPLOYMENTS_DIR;
  if (e) return resolve(e);
  // src/config -> services -> repo root; dist/config -> services -> repo root
  const candidates = [resolve(here, "..", "..", "..", "deployments"), resolve(process.cwd(), "deployments"), resolve(process.cwd(), "..", "deployments")];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

const cache = new Map<number, { mtimeMs: number; value: Deployments | null }>();

/** Reads deployments/<chainId>.json, re-reading when the file changes. Returns null when absent. */
export function loadDeployments(chainId: number): Deployments | null {
  const p = join(deploymentsDir(), `${chainId}.json`);
  if (!existsSync(p)) return null;
  const mtimeMs = statSync(p).mtimeMs;
  const hit = cache.get(chainId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`deployments/${chainId}.json invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  cache.set(chainId, { mtimeMs, value: parsed.data });
  return parsed.data;
}

export function testnet(): Deployments | null {
  return loadDeployments(env().CHAIN_ID);
}

export function mainnet(): Deployments | null {
  return loadDeployments(env().MAINNET_CHAIN_ID);
}

export function assetIdOf(symbol: string): Hex {
  return keccak256(toBytes(symbol));
}

export function oracleFor(d: Deployments | null, symbol: string): OracleEntry | undefined {
  const o = d?.oracles?.[symbol];
  return o && typeof o === "object" ? (o as OracleEntry) : undefined;
}

/** Symbols with a mirror on the testnet (the assets the keeper serves). */
export function mirroredSymbols(d: Deployments | null): string[] {
  if (!d) return [];
  return Object.entries(d.oracles ?? {})
    .filter(([, v]) => v && typeof v === "object" && (v as OracleEntry).mirror)
    .map(([k]) => k);
}

/** Symbols the keeper posts CMC snapshots for: every symbol with a pool or a mirror. */
export function riskSymbols(d: Deployments | null): string[] {
  const s = new Set<string>(mirroredSymbols(d));
  for (const p of d?.pools ?? []) s.add(p.symbol);
  return [...s];
}

/** external.<key> from 56.json, as an address (accepts a string or { address }). */
export function externalAddress(d: Deployments | null, key: string): Address | undefined {
  const v = d?.external?.[key];
  const s = typeof v === "string" ? v : v && typeof v === "object" ? (v as Record<string, unknown>).address : undefined;
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s) ? (getAddress(s) as Address) : undefined;
}

export function agentIdFrom(d: Deployments | null): bigint | undefined {
  const override = env().AGENT_ID;
  const v = override ?? d?.erc8004?.agentId;
  if (v === null || v === undefined || v === "") return undefined;
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
}
