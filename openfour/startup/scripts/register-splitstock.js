// Registers the "SplitStock Pool Launch" preset on OUR OpenFour fork (BSC testnet, chainId 97).
//
//   1. FairLaunch baseline (presets/fairlaunch.json): token/vault from the fork, FairLaunch curve/trade/migrate/data.
//      Skipped when out/fairlaunch-registration.json already exists (SKIP_BASELINE=0 forces it, SKIP_BASELINE=1 skips).
//   2. presets/splitstock-pool.json: reuses token/vault/curve/trade, deploys SplitPoolMigrateModule +
//      SplitPoolCustomDataModule + SplitPoolPresetValidator, upserts the preset with author = BackstopTreasury.
//   3. Writes the `openfour` block of deployments/<chainId>.json and out/splitstock-pool-registration.json.
//
// Addresses come from deployments/<chainId>.json (openfour.registry/core/tools/feeRouter, tokens.tTSLA,
// core.poolFactory, oracles.TSLA.mirror/scenarioFeed, dex.router, openfour.backstopTreasury), falling back to
// openfour/fork-deploy/out/fork-deployment.json for the OpenFour set. Refuses chainId 56 / 4663 and the shared
// OpenFour testnet Core. Never touches a Registry we do not own.
//
//   npx hardhat run scripts/register-splitstock.js --network bsctestnet
//   env: DEPLOYER_PRIVATE_KEY, PRESET_ID (optional, stable id), BACKSTOP_TREASURY / STOCK_TOKEN / POOL_FACTORY /
//        STOCK_FEED / SCENARIO_FEED / POOL_ROUTER (optional overrides), SKIP_BASELINE, FORK_JSON, DEPLOYMENTS_JSON
const fs = require("fs");
const { loadPreset } = require("./lib/preset");
const { loadJson, registrationPath } = require("./lib/demo");
const {
  bigintReplacer,
  connectSplitFork,
  getPath,
  registerPreset,
  resolvePlaceholders,
  updateDeployments,
} = require("./lib/splitstock");

const SLUG = "splitstock-pool";

async function main() {
  const hre = require("hardhat");
  const ctx = await connectSplitFork(hre);
  const { deployments, chainId, addresses, signer } = ctx;
  console.log(`network ${hre.network.name} (${chainId}) deployer ${signer.address} registry ${addresses.registry}`);

  // ---------------------------------------------------------------- 1. FairLaunch baseline
  const baselineFile = registrationPath("fairlaunch");
  let baseline = fs.existsSync(baselineFile) ? loadJson(baselineFile) : null;
  const skip = process.env.SKIP_BASELINE;
  const sameRegistry = baseline && String(baseline.registry).toLowerCase() === String(addresses.registry).toLowerCase();
  if (skip !== "1" && (skip === "0" || !sameRegistry)) {
    const fl = loadPreset("fairlaunch");
    const { out } = await registerPreset(hre, ctx, {
      config: fl.preset,
      slug: "fairlaunch",
      presetPath: fl.path,
      author: signer.address,
      validatorArgs: fl.preset.validator?.args || [],
      presetIdEnv: process.env.BASELINE_PRESET_ID,
    });
    baseline = out;
    console.log(`FairLaunch baseline preset ${out.presetId}`);
  } else {
    console.log(`FairLaunch baseline: ${baseline ? `kept preset ${baseline.presetId}` : "skipped"}`);
  }

  // ---------------------------------------------------------------- 2. SplitStock Pool Launch
  const { preset: raw, path: presetPath } = loadPreset(SLUG);
  const treasury = resolvePlaceholders("FROM_DEPLOYMENTS:openfour.backstopTreasury", deployments);
  const existingFile = registrationPath(SLUG);
  const existing = fs.existsSync(existingFile) ? loadJson(existingFile) : null;
  const presetId = String(
    process.env.PRESET_ID
      || (existing && String(existing.registry).toLowerCase() === String(addresses.registry).toLowerCase() ? existing.presetId : "")
      || Date.now(),
  );

  const args = resolvePlaceholders(raw.validator.args, deployments);
  args[0].expectedPresetId = presetId;
  const config = { ...raw, validator: { ...raw.validator, args } };

  const { out, outFile } = await registerPreset(hre, ctx, {
    config,
    slug: SLUG,
    presetPath,
    author: treasury,
    validatorArgs: args,
    presetIdEnv: presetId,
  });

  // ---------------------------------------------------------------- 3. deployments/<chainId>.json
  const file = updateDeployments(chainId, (d) => {
    const prev = d.openfour || {};
    d.openfour = {
      ...prev,
      registry: addresses.registry,
      core: addresses.core,
      tools: addresses.tools,
      feeRouter: addresses.feeRouter || prev.feeRouter || null,
      presetId: out.presetId,
      migrateModule: out.slots.migrate.implementation,
      customDataModule: out.slots.customData.implementation,
      validator: out.validator,
      backstopTreasury: treasury,
      baselinePresetId: baseline?.presetId || prev.baselinePresetId || null,
      migrateModuleKey: out.slots.migrate.moduleKey,
      customDataModuleKey: out.slots.customData.moduleKey,
      migrateTag: "module.migrate.splitstock_pool",
      customDataTag: "module.data.splitstock_pool",
      presetTx: out.presetTx,
      stock: getPath(d, "tokens.tTSLA") || null,
      tokens: Array.isArray(prev.tokens) ? prev.tokens : [],
    };
    return d;
  });

  console.log(
    JSON.stringify(
      {
        preset: SLUG,
        presetId: out.presetId,
        author: treasury,
        validator: out.validator,
        migrateModuleImpl: out.slots.migrate.implementation,
        customDataModuleImpl: out.slots.customData.implementation,
        fees: out.fees,
        registration: outFile,
        deployments: file,
        next: `npx hardhat run scripts/lifecycle-splitstock.js --network ${hre.network.name}`,
      },
      bigintReplacer,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
