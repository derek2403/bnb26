// SplitStock Pool Launch helpers shared by register-splitstock.js and lifecycle-splitstock.js.
// Reads addresses ONLY from deployments/<chainId>.json (see deployments/SCHEMA.md); the fork-deploy output
// (fork-deployment.json) is used for the fork-owned token impl / bondingV1 preset id and as a cross-check.
// Writes: the `openfour` block of deployments/<chainId>.json and out/<slug>-registration.json.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { REGISTRY_ABI, FEE_ROUTER_ABI, loadJson, writeJson, registrationPath, patchWorkbenchFork } = require("./demo");
const { KIND, isReuse, lookupModule, moduleKeyFromSource, startupRoot } = require("./preset");

const FORBIDDEN_CHAIN_IDS = new Set([56, 4663]);
/// Shared OpenFour testnet deployment (source of the fork). Never write to it.
const SHARED_OPENFOUR = new Set(
  [
    "0xE5014c0616e528B0ABF7CC120A58032c1FbE7060", // registry
    "0xd6DAC7815A3B007822E0829bcDB3f193041285Db", // core
    "0x5BEA99298A6E731897ef2516EafC1f0289e0cc87", // feeRouter
    "0xdECbE01E91A3c0Abf841d3E32c1587a3b62E38c6", // tools
  ].map((a) => a.toLowerCase()),
);

const CORE_ABI = [
  "function createToken(bytes createArgs, bytes signature) payable returns (address)",
  "function buy(address token, uint256 amount, uint256 maxQuotePayAmount, uint256 options, bytes proof) payable",
  "function sell(address token, uint256 amount, uint256 minQuoteRecvAmount, uint256 options, bytes proof)",
  "function migrate(address token)",
  "function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)",
  "function wrappedNative() view returns (address)",
  "function signer() view returns (address)",
  "function registry() view returns (address)",
  "function feeRouter() view returns (address)",
  "event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)",
  "event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)",
  "event MigrateExecuted(uint256 indexed presetId, address indexed caller, address indexed token, address vault, address migrateModule, bytes8 migrateTagId, uint256 totalRaised, uint256 remainingForSale, bytes32 hookDataHash, uint8 migratedDataVersion, bytes encodedMigratedData)",
];

const TOOLS_ABI = [
  "function estimateBuy(address token,address trader,uint256 amount,uint256 options,bytes proof) returns (tuple(uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))",
  "function estimateSell(address token,address trader,uint256 amount,uint256 options,bytes proof) returns (tuple(uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))",
];

const FEE_ROUTER_FULL_ABI = [
  ...FEE_ROUTER_ABI,
  "function feeConfig() view returns (uint16 protocolFeeBps, uint16 developerFeePoolBps, uint16 maxProtocolDevFeeBps, uint16 maxTaxBps, uint8 maxTaxTiers, uint256 partnerProtocolShareBps, uint256 placeholder2, uint256 placeholder3, uint256 placeholder4, uint256 placeholder5, uint256 placeholder6)",
  "function partnerOf(address token) view returns (address)",
  "function devFeePending(address quoteAsset, address author) view returns (uint256)",
  "function partnerFeePending(address quoteAsset, address partner) view returns (uint256)",
];

const POOL_FACTORY_ABI = [
  "function isAdmin(address who) view returns (bool)",
  "function isCreator(address who) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function poolInfo(address pool) view returns (tuple(address pool,address sUSD,address xToken,address stabilityPool,address asset,address feed,address router,bytes32 assetId,string symbol,address creator,uint8 kind,uint256 createdAt))",
];

// contracts/src/periphery/CreatorRegistrar.sol (holds REGISTRAR_ROLE on PoolFactory)
const CREATOR_REGISTRAR_ABI = [
  "function openFourPresetAllowed(address core, uint256 presetId) view returns (bool)",
  "function openFourModuleOf(address core, address token) view returns (uint256 presetId, address module)",
  "function registerOpenFourToken(address core, address token) returns (address migrateModule)",
];

const MIGRATE_ABI = [
  "function previewGraduation(address token) view returns (tuple(bool initialized,bool migrated,bool conditionsMet,bool healthy,bool forced,bool canMigrate,bool hasCreatorRole,bool feedFresh,bool mintsPaused,bool breakerOk,uint256 conditionsMetAt,uint256 forceAt,uint256 endTime,uint256 totalRaised,uint256 quoteToUse,uint256 seedAmount,uint256 mintAmount,uint256 price,uint256 priceAge,uint256 mintValueUsd,uint256 minSusdOut,string reason))",
  "function lastGraduation() view returns (tuple(uint8 branch,address pair,address pool,address sUSD,address xToken,address stabilityPool,uint256 quoteUsed,uint256 tokenUsed,uint256 seedAmount,uint256 mintAmount,uint256 sUSDMinted,uint256 xToTreasury,uint256 leftoverToTreasury,uint256 liquidity,uint256 price,uint256 timestamp))",
  "function fallbackPair() view returns (address)",
  "function fallbackPairGuarded() view returns (bool)",
  "function descriptor() view returns (bytes8 tagId, string tag, string version)",
  "event PoolGraduated(address indexed token, address indexed pool, address indexed pair, address sUSD, address xToken, uint256 seedAmount, uint256 mintAmount, uint256 sUSDMinted, uint256 xToTreasury, uint256 leftoverToTreasury, uint256 liquidity, uint256 price)",
  "event FloorFallback(address indexed token, address indexed pair, uint256 quoteUsed, uint256 tokenUsed, uint256 liquidity, bytes reason)",
];

const CREATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CREATOR_ROLE"));

function repoRoot() {
  return path.resolve(startupRoot(), "../..");
}

function deploymentsPath(chainId) {
  if (process.env.DEPLOYMENTS_JSON) return path.resolve(process.env.DEPLOYMENTS_JSON);
  return path.join(repoRoot(), "deployments", `${Number(chainId)}.json`);
}

function loadDeployments(chainId) {
  const file = deploymentsPath(chainId);
  if (!fs.existsSync(file)) return { file, data: { chainId: Number(chainId) } };
  return { file, data: loadJson(file) };
}

/// Read-modify-write of deployments/<chainId>.json. Only `fn` decides what changes; everything else is kept.
function updateDeployments(chainId, fn) {
  const { file, data } = loadDeployments(chainId);
  const next = fn(data) || data;
  next.chainId = Number(chainId);
  next.updatedAt = new Date().toISOString();
  writeJson(file, next);
  return file;
}

function getPath(obj, dotted) {
  return String(dotted)
    .split(".")
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

const ENV_OVERRIDES = {
  "tokens.tTSLA": "STOCK_TOKEN",
  "core.poolFactory": "POOL_FACTORY",
  "oracles.TSLA.mirror": "STOCK_FEED",
  "oracles.TSLA.scenarioFeed": "SCENARIO_FEED",
  "dex.router": "POOL_ROUTER",
  "openfour.backstopTreasury": "BACKSTOP_TREASURY",
};
const OPTIONAL_PLACEHOLDERS = new Set(["oracles.TSLA.scenarioFeed"]);

/// Replaces every "FROM_DEPLOYMENTS:<dotted.path>" string with the address from deployments json (or env override).
function resolvePlaceholders(value, deployments) {
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, deployments));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, deployments)]));
  }
  if (typeof value === "string" && value.startsWith("FROM_DEPLOYMENTS:")) {
    const key = value.slice("FROM_DEPLOYMENTS:".length);
    const env = ENV_OVERRIDES[key] && process.env[ENV_OVERRIDES[key]];
    const found = env || getPath(deployments, key);
    if (!found || found === ethers.ZeroAddress) {
      if (OPTIONAL_PLACEHOLDERS.has(key)) return ethers.ZeroAddress;
      throw new Error(
        `deployments json has no ${key}${ENV_OVERRIDES[key] ? ` (or set ${ENV_OVERRIDES[key]})` : ""}. Deploy that component first.`,
      );
    }
    return ethers.getAddress(found);
  }
  return value;
}

/// Swap the live feed for the ScenarioFeed (FEED=scenario) in a resolved create block.
function applyFeedChoice(create, deployments) {
  if (String(process.env.FEED || "").toLowerCase() !== "scenario") return create;
  const sf = process.env.SCENARIO_FEED || getPath(deployments, "oracles.TSLA.scenarioFeed");
  if (!sf) throw new Error("FEED=scenario but deployments json has no oracles.TSLA.scenarioFeed");
  return { ...create, migrate: { ...create.migrate, feed: ethers.getAddress(sf) } };
}

function tryLoadForkJson() {
  const candidates = [];
  if (process.env.FORK_JSON && process.env.FORK_JSON.trim()) {
    const raw = process.env.FORK_JSON.trim();
    candidates.push(path.resolve(raw), path.resolve(startupRoot(), raw), path.resolve(startupRoot(), "..", raw));
  }
  candidates.push(
    path.resolve(startupRoot(), "../fork-deploy/out/fork-deployment.json"),
    path.resolve(startupRoot(), "../workbench/data/fork.json"),
  );
  for (const file of candidates) {
    if (fs.existsSync(file)) return { fork: loadJson(file), path: file };
  }
  return { fork: null, path: null };
}

function txOverrides(chainId, extra = {}) {
  const base = Number(chainId) === 97 ? { gasPrice: BigInt(process.env.GAS_PRICE_WEI || "100000000") } : {};
  return { ...base, ...extra };
}

/// Connects to OUR fork: refuses mainnets and the shared OpenFour testnet set; requires Registry.owner == signer.
async function connectSplitFork(hre, { requireCoreSigner = true } = {}) {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY (openfour/.env or openfour/startup/.env).");
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  if (FORBIDDEN_CHAIN_IDS.has(chainId)) {
    throw new Error(`chainId ${chainId} is a mainnet. SplitStock OpenFour scripts run only on our BSC testnet fork.`);
  }
  const { file: deploymentsFile, data: deployments } = loadDeployments(chainId);
  const { fork, path: forkPath } = tryLoadForkJson();
  const of = deployments.openfour || {};
  const pick = (key) => of[key] || fork?.addresses?.[key];
  const addresses = {
    registry: pick("registry"),
    core: pick("core"),
    tools: pick("tools"),
    feeRouter: pick("feeRouter"),
  };
  if (!addresses.registry) {
    throw new Error(`No OpenFour registry: set openfour.registry in ${deploymentsFile} or run openfour/fork-deploy (npm run fork).`);
  }
  for (const [k, v] of Object.entries(addresses)) {
    if (v && SHARED_OPENFOUR.has(String(v).toLowerCase())) {
      throw new Error(`${k} ${v} is the shared OpenFour testnet deployment. Use our own fork (openfour/fork-deploy).`);
    }
  }
  if (fork) {
    if (Number(fork.chainId) && Number(fork.chainId) !== chainId) {
      throw new Error(`fork json chainId ${fork.chainId} != network ${chainId}`);
    }
    const fr = String(fork.addresses?.registry || "").toLowerCase();
    if (fr && fr !== String(addresses.registry).toLowerCase()) {
      throw new Error(`deployments openfour.registry ${addresses.registry} != fork json registry ${fork.addresses.registry}`);
    }
  }

  const registry = await hre.ethers.getContractAt(REGISTRY_ABI, addresses.registry, signer);
  const owner = await registry.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Registry.owner is ${owner}, not ${signer.address}. Only write to a Registry we own.`);
  }
  addresses.core = addresses.core || (await registry.openFourCore());
  addresses.tools = addresses.tools || (await registry.openFourTool());
  const core = await hre.ethers.getContractAt(CORE_ABI, addresses.core, signer);
  if (!addresses.feeRouter) {
    try {
      addresses.feeRouter = await core.feeRouter();
    } catch {
      /* optional */
    }
  }
  const tools = await hre.ethers.getContractAt(TOOLS_ABI, addresses.tools, signer);
  const coreSigner = await core.signer();
  if (requireCoreSigner && coreSigner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Core.signer is ${coreSigner}, not ${signer.address}. Switch Core.signer back to the deployer before running these scripts.`);
  }
  for (const [k, v] of Object.entries(addresses)) {
    if (v && SHARED_OPENFOUR.has(String(v).toLowerCase())) {
      throw new Error(`${k} ${v} is the shared OpenFour testnet deployment.`);
    }
  }
  return {
    signer,
    chainId,
    overrides: txOverrides(chainId),
    registry,
    core,
    tools,
    addresses,
    fork,
    forkPath,
    deployments,
    deploymentsFile,
  };
}

async function waitOk(txPromise, label) {
  const tx = await txPromise;
  const rec = await tx.wait();
  if (!rec || rec.status !== 1) throw new Error(`${label} failed`);
  return rec;
}

/// Same semantics as scripts/register.js resolveSlot, with the module metadata author as a parameter.
async function resolveSlot(hre, ctx, config, slot, spec, author) {
  const { registry, overrides, fork } = ctx;
  const kind = KIND[slot];
  const name = spec.contract || spec.keySource || slot;
  if (isReuse(spec)) {
    const found = await lookupModule(registry, spec, slot, fork);
    if (found) {
      return { name, keySource: found.source, moduleKey: found.moduleKey, implementation: found.implementation, kind, reused: true };
    }
    if (!spec.contract) throw new Error(`${slot}: nothing to reuse for ${spec.keySource || slot}`);
    console.warn(`${slot}: reuse missed ${spec.keySource || slot}; deploying ${spec.contract}`);
  }
  if (!spec.contract || !spec.keySource) throw new Error(`modules.${slot} needs contract + keySource`);
  const moduleKey = moduleKeyFromSource(spec.keySource);
  const deployed = await hre.ethers.deployContract(spec.contract, [], overrides);
  await deployed.waitForDeployment();
  const implementation = await deployed.getAddress();
  const rec = await waitOk(
    registry.upsertModule(
      moduleKey,
      implementation,
      kind,
      {
        moduleId: moduleKey,
        version: config.version || "1.0.0",
        name,
        description: `${config.name} ${name}`,
        author,
        feeShareBps: 0,
      },
      true,
      overrides,
    ),
    `upsertModule ${name}`,
  );
  return { name, keySource: spec.keySource, moduleKey, implementation, kind, reused: false, txHash: rec.hash };
}

async function resolveTokenImpl(hre, ctx, config) {
  const { registry, overrides, fork } = ctx;
  const spec = config.tokenImpl || { reuse: "fork" };
  if (isReuse(spec) || !spec.contract) {
    const bondingId = process.env.BONDING_PRESET_ID || fork?.presets?.bondingV1 || ctx.deployments?.openfour?.bondingPresetId;
    if (bondingId) {
      const bonding = await registry.getPreset(bondingId);
      const impl = await registry.getTokenImpl(bonding.tokenImplId);
      if (impl.implementation && impl.implementation !== ethers.ZeroAddress) {
        return { tokenImplId: bonding.tokenImplId, implementation: impl.implementation, reused: true };
      }
    }
    console.warn("no fork bondingV1 preset found; deploying OpenFourToken as token.standard.splitstock");
  }
  const contract = spec.contract || "OpenFourToken";
  const tokenImplId = moduleKeyFromSource(spec.keySource || "token.standard.splitstock");
  const deployed = await hre.ethers.deployContract(contract, [], overrides);
  await deployed.waitForDeployment();
  const implementation = await deployed.getAddress();
  const rec = await waitOk(
    registry.upsertTokenImpl(tokenImplId, implementation, config.version || "1.0.0", overrides),
    "upsertTokenImpl",
  );
  return { tokenImplId, implementation, reused: false, txHash: rec.hash };
}

/// Copies the fork's bondingV1 preset fee config onto `presetId` when ours is inactive/zero. Returns both reads.
async function ensurePresetFeeConfig(hre, ctx, presetId) {
  const { addresses, signer, overrides, fork } = ctx;
  if (!addresses.feeRouter) return { skipped: "no feeRouter" };
  const fr = await hre.ethers.getContractAt(FEE_ROUTER_FULL_ABI, addresses.feeRouter, signer);
  const out = {};
  try {
    const g = await fr.feeConfig();
    out.feeConfig = {
      protocolFeeBps: Number(g.protocolFeeBps),
      developerFeePoolBps: Number(g.developerFeePoolBps),
      maxProtocolDevFeeBps: Number(g.maxProtocolDevFeeBps),
      maxTaxBps: Number(g.maxTaxBps),
      maxTaxTiers: Number(g.maxTaxTiers),
      partnerProtocolShareBps: g.partnerProtocolShareBps.toString(),
    };
  } catch (err) {
    out.feeConfigError = err.shortMessage || err.message;
  }
  const read = async (id) => {
    const c = await fr.presetFeeConfig(id);
    return {
      protocolFeeBps: c.protocolFeeBps,
      developerFeePoolBps: c.developerFeePoolBps,
      maxProtocolDevFeeBps: c.maxProtocolDevFeeBps,
      maxTaxBps: c.maxTaxBps,
      maxTaxTiers: c.maxTaxTiers,
      active: c.active,
      partnerProtocolShareBps: c.partnerProtocolShareBps,
    };
  };
  try {
    let cur = await read(presetId);
    if (!cur.active) {
      const srcId = process.env.FEE_SOURCE_PRESET_ID || fork?.presets?.bondingV1;
      if (srcId) {
        const src = await read(srcId);
        if (src.active) {
          const rec = await waitOk(fr.setPresetFeeConfig(presetId, src, overrides), "setPresetFeeConfig");
          out.setPresetFeeConfigTx = rec.hash;
          cur = await read(presetId);
        }
      }
    }
    out.presetFeeConfig = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  } catch (err) {
    out.presetFeeConfigError = err.shortMessage || err.message;
  }
  return out;
}

/// Registers one preset JSON on our fork. `author` is the preset author (dev-fee recipient).
async function registerPreset(hre, ctx, { config, slug, presetPath, author, validatorArgs, presetIdEnv }) {
  const { registry, overrides, signer, addresses } = ctx;
  const modules = config.modules || {};
  const slots = {};
  const implementations = {};
  const moduleKeys = {};
  const developerModules = [];
  for (const slot of ["token", "vault", "curve", "trade", "migrate", "customData"]) {
    const spec = modules[slot];
    if (!spec) {
      if (slot === "customData") continue;
      throw new Error(`modules.${slot} is required in ${presetPath}`);
    }
    const r = await resolveSlot(hre, ctx, config, slot, spec, signer.address);
    slots[slot] = r;
    implementations[r.name] = r.implementation;
    moduleKeys[r.name] = { keySource: r.keySource, moduleKey: r.moduleKey };
    if (!r.reused) {
      developerModules.push({ keySource: r.keySource, moduleKey: r.moduleKey, implementation: r.implementation, kind: r.kind, name: r.name, txHash: r.txHash });
    }
    console.log(`${r.reused ? "reused" : "registered"} ${r.keySource} -> ${r.implementation}`);
  }

  const vspec = typeof config.validator === "string" ? { contract: config.validator, args: [] } : config.validator || {};
  if (!vspec.contract) throw new Error("validator.contract is required");
  const validator = await hre.ethers.deployContract(vspec.contract, validatorArgs || vspec.args || [], overrides);
  await validator.waitForDeployment();
  const validatorAddress = await validator.getAddress();
  implementations[vspec.contract] = validatorAddress;

  const tokenImpl = await resolveTokenImpl(hre, ctx, config);
  const outFile = registrationPath(slug);
  const existing = fs.existsSync(outFile) ? loadJson(outFile) : null;
  const presetId = BigInt(presetIdEnv || existing?.presetId || Date.now());

  const preset = {
    id: presetId,
    name: config.name,
    description: config.description || "",
    version: config.version || "1.0.0",
    active: true,
    createEnabled: true,
    validator: validatorAddress,
    tokenModuleId: slots.token.moduleKey,
    vaultModuleId: slots.vault.moduleKey,
    curveModuleId: slots.curve.moduleKey,
    tradeModuleId: slots.trade.moduleKey,
    migrateModuleId: slots.migrate.moduleKey,
    tokenImplId: tokenImpl.tokenImplId,
    customDataId: slots.customData?.moduleKey || ethers.ZeroHash,
    author,
  };
  const presetRec = await waitOk(registry.upsertPreset(preset, overrides), "upsertPreset");
  const onChain = await registry.getPreset(presetId);
  if (!onChain.active || !onChain.createEnabled) throw new Error(`${config.name} preset not active/createEnabled`);
  if (onChain.author.toLowerCase() !== author.toLowerCase()) throw new Error(`preset author ${onChain.author} != ${author}`);
  const fees = await ensurePresetFeeConfig(hre, ctx, presetId);

  const out = {
    slug,
    presetPath,
    network: hre.network.name,
    chainId: ctx.chainId,
    registeredAt: new Date().toISOString(),
    deployer: signer.address,
    forkPath: ctx.forkPath,
    registry: addresses.registry,
    core: addresses.core,
    presetId: presetId.toString(),
    author,
    validator: validatorAddress,
    validatorArgs: validatorArgs || vspec.args || [],
    tokenImplId: tokenImpl.tokenImplId,
    tokenImpl: tokenImpl.implementation,
    implementations,
    moduleKeys,
    slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { keySource: v.keySource, moduleKey: v.moduleKey, implementation: v.implementation, reused: v.reused }])),
    developerModules,
    presetTx: presetRec.hash,
    fees,
  };
  writeJson(outFile, out);
  if (ctx.forkPath) {
    patchWorkbenchFork(ctx.forkPath, { developerModules, preset: { id: presetId.toString(), name: config.name, txHash: presetRec.hash } });
  }
  return { out, outFile };
}

function bigintReplacer(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

module.exports = {
  CORE_ABI,
  CREATOR_REGISTRAR_ABI,
  CREATOR_ROLE,
  ERC20_FULL_ABI: [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address owner) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function faucet() returns (uint256)",
    "function mint(address to, uint256 amount)",
  ],
  FEE_ROUTER_FULL_ABI,
  MIGRATE_ABI,
  PAIR_ABI: [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
  ],
  POOL_FACTORY_ABI,
  POOL_ABI: [
    "function state() view returns (tuple(uint256 C,uint256 U,uint256 S,uint256 X,uint256 price,uint256 priceUpdatedAt,uint256 priceAge,bool priceFresh,bool feedHalted,uint256 V,int256 E,uint256 xNav,uint256 leverage,uint256 collateralRatio,uint8 mode,bool marketOpen,bool gapGuard,bool mintsPaused,uint256 triggerLev,uint256 targetLev,uint256 lowerTriggerLev,uint256 maxMintLev,uint256 stableMintFeeBps,uint256 leverMintFeeBps,uint8 riskSource,uint256 snapshotId))",
    "function isDonor(address who) view returns (bool)",
    "function creator() view returns (address)",
  ],
  VAULT_FULL_ABI: [
    "function remainingForSale() view returns (uint256)",
    "function totalRaised() view returns (uint256)",
    "function phase() view returns (uint8)",
    "function quoteAsset() view returns (address)",
    "function isSoldOut() view returns (bool)",
    "function soldAmount() view returns (uint256)",
  ],
  applyFeedChoice,
  bigintReplacer,
  connectSplitFork,
  deploymentsPath,
  getPath,
  loadDeployments,
  registerPreset,
  repoRoot,
  resolvePlaceholders,
  txOverrides,
  updateDeployments,
  waitOk,
};
