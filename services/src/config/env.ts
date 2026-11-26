import { z } from "zod";

/**
 * Every environment variable the services read. Secrets stay server-side; nothing here is ever sent to a
 * browser. Names are mirrored in /.env.example. Role keys are optional: a job whose key is missing logs a
 * warning and skips its writes (reads still run), so a partial deployment still serves the API.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());
const opt = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
/** string with a default; an empty string (e.g. an unset CI secret) also means "use the default". */
const strDef = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));
const hexKey = opt.refine((v) => v === undefined || /^0x[0-9a-fA-F]{64}$/.test(v), "must be a 0x-prefixed 32-byte hex key");

const schema = z.object({
  NODE_ENV: strDef("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),

  // ---- chains
  CHAIN_ID: int(97), // the testnet the pools live on
  MAINNET_CHAIN_ID: int(56),
  BSC_TESTNET_RPC: strDef("https://data-seed-prebsc-1-s1.bnbchain.org:8545"), // comma-separated = fallback list
  BSC_MAINNET_RPC: strDef("https://bsc-dataseed.bnbchain.org"),
  /** Keyed mainnet RPC that allows eth_getLogs (public BSC RPCs block it). Used for the Atlas update tx lookup + indexer. */
  BSC_MAINNET_LOGS_RPC: opt,
  /** Keyed testnet RPC for eth_getLogs (indexer). Defaults to BSC_TESTNET_RPC. */
  BSC_TESTNET_LOGS_RPC: opt,
  DEPLOYMENTS_DIR: opt, // default: <repo>/deployments

  // ---- role keys (one role each, never reused across chains)
  MIRROR_PRIVATE_KEY: hexKey, // K_MIRROR: AtlasMirror PUSHER (backup cron uses the backup key under the same name)
  RISK97_PRIVATE_KEY: hexKey, // K_RISK97: RiskOracle(97) POSTER
  RISK56_PRIVATE_KEY: hexKey, // K_RISK56: RiskOracle56 POSTER + AtlasCmcAnchor keeper (mainnet)
  AGENT_PRIVATE_KEY: hexKey, // K_AGENT: RiskOracle PROPOSER + ERC-8004 agent wallet (testnet)
  AGENT56_PRIVATE_KEY: hexKey, // ERC-8004 agent identity owner/wallet on mainnet (never the testnet agent key)
  OPS_PRIVATE_KEY: hexKey, // K_OPS: no roles (rebalance, accrue, dispatch, sweep, cover, migrate, arb)
  ANCHOR_PRIVATE_KEY: hexKey, // K_ANCHOR: LogAnchor(97) ANCHOR_ROLE
  ANCHOR56_PRIVATE_KEY: hexKey, // LogAnchor(56) ANCHOR_ROLE (mainnet key)
  EVALUATOR_PRIVATE_KEY: hexKey, // ERC-8004 feedback (separate from the agent owner)
  MAINNET_PRIVATE_KEY: hexKey, // mainnet fallback for RISK56 / ANCHOR56 when those are unset
  /** Legacy single testnet key. Only used as a fallback for testnet role keys when KEY_FALLBACK=keeper. */
  KEEPER_PRIVATE_KEY: hexKey,
  KEY_FALLBACK: z.enum(["none", "keeper"]).optional().default("none"),

  // ---- data providers
  CMC_API_KEY: opt,
  CMC_MCP_API_KEY: opt, // defaults to CMC_API_KEY
  CMC_BASE_URL: strDef("https://pro-api.coinmarketcap.com"),
  CMC_MCP_URL: strDef("https://mcp.coinmarketcap.com/mcp"),
  CMC_DAILY_CREDIT_BUDGET: int(415),
  CMC_MONTHLY_CREDIT_LIMIT: int(15000),
  ATLAS_API_KEY: opt, // pull API (served by app/, listed here only so health can report it)

  // ---- LLM (OpenAI-compatible endpoint; default Phala Private AI, TEE-attested)
  PHALA_AI_API_KEY: opt,
  LLM_API_KEY: opt, // alias accepted for PHALA_AI_API_KEY
  ANTHROPIC_API_KEY: opt, // unused since the switch to Phala; kept so old .env files still parse
  LLM_BASE_URL: strDef("https://inference.phala.com/v1"),
  AGENT_MODEL: strDef("openai/gpt-oss-120b"),
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().default("high"),
  AGENT_MAX_TOKENS: int(8000), // LLM completion budget incl. reasoning tokens (gpt-oss: 2000 truncates)
  AGENT_INTERVAL_SEC: int(3600),
  AGENT_DRY_RUN: bool(false), // gather + decide + validate, but never send propose()
  AGENT_ID: opt, // ERC-8004 agentId override (else deployments erc8004.agentId)
  AGENT_MCP_TOOLS: opt, // JSON override of the MCP tool plan, see agent/mcp.ts

  // ---- API
  API_HOST: strDef("0.0.0.0"),
  API_PORT: int(8080),
  KEEPER_TOKEN: opt, // bearer token for every write route
  PUBLIC_BASE_URL: strDef("http://localhost:8080"), // used in rationaleURI + agentURI
  CORS_ORIGINS: strDef("*"),
  SERVE_RAW_BODIES: bool(true), // serve raw CMC bodies (judging window only; CMC terms may limit redistribution)

  // ---- storage
  DATABASE_URL: strDef("postgres://splitstock:splitstock@localhost:5432/splitstock"),
  DB_DISABLED: bool(false), // backup cron: no Postgres; jobs that need history skip, chain-only jobs still run
  CMC_MCP_CREDITS_PER_CALL: int(1), // [UNVERIFIED] estimate until reconciled against /v1/key/info

  // ---- alerts
  TELEGRAM_BOT_TOKEN: opt,
  TELEGRAM_CHAT_ID: opt,
  LOW_BALANCE_WEI: strDef("20000000000000000"), // 0.02 BNB

  // ---- job tuning
  FLAP_DISPATCH: bool(true), // backstop-ops calls Flap TaxProcessor.dispatch() each tick; false = leave it to a person
  REBALANCE_FACTORY_POOLS: bool(true), // also rebalance every PoolFactory pool (sandboxes), not just deployments.pools
  ARB_ENABLED: bool(true), // nudge tSTOCK/mUSDC toward the mirror before LIVE rebalances
  ARB_THRESHOLD_BPS: int(50),
  MAINNET_ENABLED: bool(true), // RiskOracle56 + AtlasCmcAnchor + LogAnchor56 writes
  INDEXER_START_BLOCK_97: opt,
  INDEXER_START_BLOCK_56: opt,
  INDEXER_MAX_RANGE: int(2000),
  INDEXER_MAX_ADDRESSES: int(10), // addresses per eth_getLogs call (bsc-testnet-rpc.publicnode.com allows 10)
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests / CLI overrides. */
export function resetEnvCache() {
  cached = undefined;
}

export function llmKey(): string | undefined {
  const e = env();
  return e.PHALA_AI_API_KEY ?? e.LLM_API_KEY;
}

export function mcpKey(): string | undefined {
  const e = env();
  return e.CMC_MCP_API_KEY ?? e.CMC_API_KEY;
}

export type KeyRole = "mirror" | "risk97" | "risk56" | "agent" | "agent56" | "ops" | "anchor" | "anchor56" | "evaluator";

/** Resolve a role key. Testnet roles may fall back to KEEPER_PRIVATE_KEY only when KEY_FALLBACK=keeper. */
export function roleKey(role: KeyRole): `0x${string}` | undefined {
  const e = env();
  const testnetFallback = e.KEY_FALLBACK === "keeper" ? e.KEEPER_PRIVATE_KEY : undefined;
  const k = (() => {
    switch (role) {
      case "mirror":
        return e.MIRROR_PRIVATE_KEY ?? testnetFallback;
      case "risk97":
        return e.RISK97_PRIVATE_KEY ?? testnetFallback;
      case "agent":
        return e.AGENT_PRIVATE_KEY ?? testnetFallback;
      case "ops":
        return e.OPS_PRIVATE_KEY ?? testnetFallback;
      case "anchor":
        return e.ANCHOR_PRIVATE_KEY ?? testnetFallback;
      case "evaluator":
        return e.EVALUATOR_PRIVATE_KEY;
      case "risk56":
        return e.RISK56_PRIVATE_KEY ?? e.MAINNET_PRIVATE_KEY; // never the testnet key
      case "anchor56":
        return e.ANCHOR56_PRIVATE_KEY ?? e.MAINNET_PRIVATE_KEY;
      case "agent56":
        return e.AGENT56_PRIVATE_KEY;
    }
  })();
  return k as `0x${string}` | undefined;
}
