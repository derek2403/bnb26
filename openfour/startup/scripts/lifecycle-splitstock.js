// Full "SplitStock Pool Launch" lifecycle on OUR fork: create (tTSLA quote) -> buy -> sell -> buy to sell-out,
// which auto-migrates: PoolFactory.createPool(tTSLA, TSLA feed) -> seed(half, BackstopTreasury) ->
// mintStable(half) -> meme/sUSD PCS v2 LP to 0xdead (or the meme/tTSLA fallback + FloorFallback).
// Reads results back and writes the `openfour` block (tokens[]) and `pools[]` of deployments/<chainId>.json.
//
//   npx hardhat run scripts/lifecycle-splitstock.js --network bsctestnet
//
// env (all optional):
//   TOKEN_NAME / TOKEN_SYMBOL    meme name (no real brand names)
//   DURATION                     launch seconds (default from preset, >= validator minDuration; never 0)
//   FEED=scenario                graduate against oracles.TSLA.scenarioFeed instead of the live mirror
//   GRANT_CREATOR=0              do NOT grant PoolFactory CREATOR_ROLE to the migrate clone (demo: deferral, then the
//                                forced meme/tTSLA fallback once the grace window passes)
//   PARTNER=0                    create without BackstopTreasury as partner
//   TRADE_FEE_BPS=<n>            override the FairLaunch buy/sell fee (default preset 50, to the BackstopTreasury)
//   SELL_OUT=0                   stop after buy + sell (no graduation)
//   BUY_AMOUNT / SELL_AMOUNT     meme amounts for the first buy / the sell (default preset loop); SELL=0 skips the sell
//   WAIT_FORCE=1                 if graduation was deferred, wait for forceAt then call Core.migrate
//   POOL_ID                      slug for deployments pools[] (default tsla-four)
//   GAS_LIMIT                    gas limit for create / sell-out / migrate (default preset loop.gasLimit)
const path = require("path");
const { loadPreset, presetAmounts } = require("./lib/preset");
const { loadRegistration, outDir, signCreate, writeJson, appendWorkbenchToken } = require("./lib/demo");
const { encodeCreateParams, fetchPresetSchemas, flattenCreateForm, readBaseField } = require("./lib/schema");
const {
  CREATOR_REGISTRAR_ABI,
  CREATOR_ROLE,
  ERC20_FULL_ABI,
  FEE_ROUTER_FULL_ABI,
  MIGRATE_ABI,
  PAIR_ABI,
  POOL_ABI,
  POOL_FACTORY_ABI,
  VAULT_FULL_ABI,
  applyFeedChoice,
  bigintReplacer,
  connectSplitFork,
  getPath,
  resolvePlaceholders,
  updateDeployments,
  waitOk,
} = require("./lib/splitstock");

const SLUG = "splitstock-pool";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const PHASE = ["Created", "Trading", "MigratePending", "Migrated", "Terminal", "SoldOut"];

function log(label, obj) {
  console.log(`${label}: ${JSON.stringify(obj, bigintReplacer, 2)}`);
}

function encodeCreateArgs(ethers, { requestId, presetId, validTimestamp, createFee, quoteAsset, partner, form, schemas }) {
  const params = encodeCreateParams(form, schemas);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(uint256 requestId,uint256 presetId,uint256 validTimestamp,uint256 createFee,uint256 presaleQuote,bool antiSniperEnabled,address partner,tuple(string name,string symbol,string tokenUri,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,bytes32 tokenSalt,bytes tokenParams,bytes vaultParams,bytes curveParams,bytes tradeParams,bytes migrateParams,bytes customDataParams) initParams)",
    ],
    [[
      requestId,
      presetId,
      validTimestamp,
      createFee,
      0n,
      false, // anti-sniper off (it adds up to a 100% surcharge on early blocks)
      partner,
      [
        form.name || "",
        form.symbol || "",
        form.tokenUri || "",
        readBaseField(form, "maxSupply", 18),
        readBaseField(form, "saleAmount", 18),
        readBaseField(form, "raiseAmount", 18),
        quoteAsset,
        ethers.ZeroHash,
        params.tokenParams,
        params.vaultParams,
        params.curveParams,
        params.tradeParams,
        params.migrateParams,
        params.customDataParams,
      ],
    ]],
  );
}

async function snapshotVault(hre, vaultAddress) {
  const v = await hre.ethers.getContractAt(VAULT_FULL_ABI, vaultAddress);
  const phase = Number(await v.phase());
  return {
    phase,
    phaseName: PHASE[phase],
    remainingForSale: await v.remainingForSale(),
    totalRaised: await v.totalRaised(),
    soldOut: await v.isSoldOut(),
  };
}

async function readPreview(migrate, token) {
  try {
    const p = await migrate.previewGraduation(token);
    return {
      conditionsMet: p.conditionsMet,
      healthy: p.healthy,
      forced: p.forced,
      canMigrate: p.canMigrate,
      hasCreatorRole: p.hasCreatorRole,
      feedFresh: p.feedFresh,
      mintsPaused: p.mintsPaused,
      breakerOk: p.breakerOk,
      conditionsMetAt: p.conditionsMetAt,
      forceAt: p.forceAt,
      endTime: p.endTime,
      quoteToUse: p.quoteToUse,
      seedAmount: p.seedAmount,
      mintAmount: p.mintAmount,
      price: p.price,
      priceAge: p.priceAge,
      minSusdOut: p.minSusdOut,
      reason: p.reason,
    };
  } catch (err) {
    return { error: err.shortMessage || err.message };
  }
}

async function ensureStock(hre, stock, owner, need, overrides) {
  let bal = await stock.balanceOf(owner);
  if (bal >= need) return bal;
  for (let i = 0; i < 20 && bal < need; i++) {
    try {
      await waitOk(stock.faucet(overrides), "faucet");
    } catch {
      break;
    }
    bal = await stock.balanceOf(owner);
  }
  if (bal < need) {
    try {
      await waitOk(stock.mint(owner, need - bal, overrides), "mint");
      bal = await stock.balanceOf(owner);
    } catch {
      /* not a minter */
    }
  }
  if (bal < need) {
    throw new Error(`stock balance ${bal} < needed ${need}. Fund the deployer with tTSLA (faucet / MINTER_ROLE) first.`);
  }
  return bal;
}

async function buy(hre, ctx, token, amount, gasLimit) {
  const { core, tools, signer, overrides } = ctx;
  const est = await tools.estimateBuy.staticCall(token, signer.address, amount, 0n, "0x");
  const maxPay = (est.userPays * 10100n) / 10000n + 1n;
  const opts = gasLimit ? { ...overrides, gasLimit } : overrides;
  const rec = await waitOk(core.buy(token, amount, maxPay, 0n, "0x", opts), "buy");
  return { rec, est };
}

function parseLogs(iface, rec, address) {
  const out = [];
  for (const l of rec.logs || []) {
    if (address && l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const p = iface.parseLog(l);
      if (p) out.push(p);
    } catch {
      /* other contract */
    }
  }
  return out;
}

async function readPair(hre, pairAddr, memeAddr) {
  const pair = await hre.ethers.getContractAt(PAIR_ABI, pairAddr);
  const [token0, token1, reserves, lpSupply, lpDead] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
    pair.totalSupply(),
    pair.balanceOf(DEAD),
  ]);
  const memeIs0 = token0.toLowerCase() === memeAddr.toLowerCase();
  return {
    pair: pairAddr,
    token0,
    token1,
    reserve0: reserves.reserve0,
    reserve1: reserves.reserve1,
    memeReserve: memeIs0 ? reserves.reserve0 : reserves.reserve1,
    quoteReserve: memeIs0 ? reserves.reserve1 : reserves.reserve0,
    lpTotalSupply: lpSupply,
    lpAtDead: lpDead,
  };
}

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;
  const ctx = await connectSplitFork(hre);
  const { signer, chainId, core, addresses, deployments, overrides } = ctx;
  const { preset } = loadPreset(SLUG);
  const { registration } = loadRegistration(SLUG);
  if (String(registration.registry).toLowerCase() !== String(addresses.registry).toLowerCase()) {
    throw new Error("out/splitstock-pool-registration.json is for another Registry. Run register-splitstock.js first.");
  }
  const presetId = BigInt(process.env.PRESET_ID || registration.presetId);
  const gasLimit = BigInt(process.env.GAS_LIMIT || preset.loop?.gasLimit || 15_000_000);

  // ------------------------------------------------------------ create params
  let create = resolvePlaceholders(preset.create, deployments);
  create = applyFeedChoice(create, deployments);
  const stockAddr = create.migrate.stockAsset;
  const treasury = create.migrate.backstopTreasury;
  const feeOverride = process.env.TRADE_FEE_BPS;
  const form = flattenCreateForm(create, {
    name: process.env.TOKEN_NAME,
    symbol: process.env.TOKEN_SYMBOL,
    duration: process.env.DURATION,
    buyFeeBps: feeOverride,
    sellFeeBps: feeOverride,
  });
  const amounts = presetAmounts(preset);
  // Demo prep: BUY_AMOUNT / SELL_AMOUNT (meme tokens, decimal) override the preset loop, e.g. BUY_AMOUNT=720000 SELL=0
  // SELL_OUT=0 leaves a launch ~90% sold so one live buy sells it out (and graduates) during the recording.
  if (process.env.BUY_AMOUNT) amounts.buyAmount = ethers.parseUnits(String(process.env.BUY_AMOUNT), 18);
  if (process.env.SELL_AMOUNT) amounts.sellAmount = ethers.parseUnits(String(process.env.SELL_AMOUNT), 18);
  const schemas = await fetchPresetSchemas(ctx.tools, presetId);
  if (schemas.migrate.params.length !== 14 || schemas.migrate.params[9].name !== "stockSymbol") {
    throw new Error(`preset ${presetId} migrate schema is not SplitPoolMigrateModule's`);
  }

  // ------------------------------------------------------------ funds
  const stock = await ethers.getContractAt(ERC20_FULL_ABI, stockAddr, signer);
  const raise = readBaseField(form, "raiseAmount", 18);
  const need = (raise * 12n) / 10n + amounts.buyAmount / 1000n;
  await ensureStock(hre, stock, signer.address, need, overrides);
  const coreAddr = await core.getAddress();
  if ((await stock.allowance(signer.address, coreAddr)) < need) {
    await waitOk(stock.approve(coreAddr, ethers.MaxUint256, overrides), "approve stock");
  }

  // ------------------------------------------------------------ create
  const now = BigInt(Math.floor(Date.now() / 1000));
  const usePartner = process.env.PARTNER !== "0";
  let createArgs;
  let signature;
  let partner = usePartner ? treasury : ethers.ZeroAddress;
  for (const attempt of usePartner ? [treasury, ethers.ZeroAddress] : [ethers.ZeroAddress]) {
    partner = attempt;
    createArgs = encodeCreateArgs(ethers, {
      requestId: BigInt(process.env.REQUEST_ID || Date.now()),
      presetId,
      validTimestamp: now + 3600n,
      createFee: BigInt(process.env.CREATE_FEE || "0"),
      quoteAsset: stockAddr,
      partner,
      form,
      schemas,
    });
    ({ signature } = await signCreate(signer, chainId, createArgs));
    try {
      await core.createToken.staticCall(createArgs, signature, { ...overrides, gasLimit, value: BigInt(process.env.CREATE_FEE || "0") });
      break;
    } catch (err) {
      const msg = err.shortMessage || err.message;
      if (attempt !== ethers.ZeroAddress) {
        console.warn(`createToken precheck with partner=${attempt} failed (${msg}); retrying without partner`);
        continue;
      }
      throw new Error(`createToken precheck failed: ${msg}`);
    }
  }
  const createRec = await waitOk(
    core.createToken(createArgs, signature, { ...overrides, gasLimit, value: BigInt(process.env.CREATE_FEE || "0") }),
    "createToken",
  );
  const created = parseLogs(core.interface, createRec, coreAddr).find((p) => p.name === "TokenCreated");
  if (!created) throw new Error("TokenCreated not found");
  const tokenAddr = created.args.token;
  const rt = await core.tokens(tokenAddr);
  const migrateAddr = rt.migrateModule;
  const migrate = await ethers.getContractAt(MIGRATE_ABI, migrateAddr, signer);
  const meme = await ethers.getContractAt(ERC20_FULL_ABI, tokenAddr, signer);
  log("created", {
    token: tokenAddr,
    tx: createRec.hash,
    partner,
    vault: rt.vault,
    migrateModule: migrateAddr,
    customData: rt.customData,
    fallbackPair: await migrate.fallbackPair(),
    fallbackPairGuarded: await migrate.fallbackPairGuarded(),
    descriptor: await migrate.descriptor(),
  });
  appendWorkbenchToken({
    tokenAddress: tokenAddr,
    name: form.name,
    symbol: form.symbol,
    presetId: presetId.toString(),
    presetName: preset.name,
    creator: signer.address,
    txHash: createRec.hash,
    chainId,
    quoteAsset: stockAddr,
    createdAt: new Date().toISOString(),
  });

  // ------------------------------------------------------------ CREATOR_ROLE for this clone
  const factory = await ethers.getContractAt(POOL_FACTORY_ABI, create.migrate.poolFactory, signer);
  let grantTx = null;
  if (process.env.GRANT_CREATOR !== "0") {
    const has = await factory.isCreator(migrateAddr);
    if (!has) {
      // Preferred: the permissionless CreatorRegistrar (core.creatorRegistrar), allowlisted for this Core + preset
      // by contracts/script/ConfigureRegistrar.s.sol. Works after the Timelock handoff. Fallback: direct admin grant.
      const registrarAddr = getPath(deployments, "core.creatorRegistrar");
      let registrar = null;
      if (registrarAddr && /^0x[0-9a-fA-F]{40}$/.test(registrarAddr) && BigInt(registrarAddr) !== 0n) {
        registrar = await ethers.getContractAt(CREATOR_REGISTRAR_ABI, registrarAddr, signer);
      }
      const allowed = registrar
        ? await registrar.openFourPresetAllowed(addresses.core, presetId).catch(() => false)
        : false;
      if (allowed) {
        const rec = await waitOk(registrar.registerOpenFourToken(addresses.core, tokenAddr, overrides), "registerOpenFourToken");
        grantTx = rec.hash;
      } else if (await factory.isAdmin(signer.address)) {
        const rec = await waitOk(factory.grantRole(CREATOR_ROLE, migrateAddr, overrides), "grantRole CREATOR_ROLE");
        grantTx = rec.hash;
      } else {
        console.warn("no CREATOR_ROLE path: run contracts/script/ConfigureRegistrar.s.sol, or have the Timelock grant CREATOR_ROLE to " + migrateAddr);
      }
    }
  }
  log("creatorRole", { migrateModule: migrateAddr, isCreator: await factory.isCreator(migrateAddr), grantTx });

  // ------------------------------------------------------------ buy / sell
  const b1 = await buy(hre, ctx, tokenAddr, amounts.buyAmount);
  log("buy", { tx: b1.rec.hash, amount: amounts.buyAmount, userPays: b1.est.userPays, vault: await snapshotVault(hre, rt.vault) });

  let sellTx = null;
  if (process.env.SELL !== "0" && preset.loop?.sell !== false && amounts.sellAmount > 0n) {
    const bal = await meme.balanceOf(signer.address);
    const amt = bal < amounts.sellAmount ? bal : amounts.sellAmount;
    if ((await meme.allowance(signer.address, coreAddr)) < amt) {
      await waitOk(meme.approve(coreAddr, ethers.MaxUint256, overrides), "approve meme");
    }
    const est = await ctx.tools.estimateSell.staticCall(tokenAddr, signer.address, amt, 0n, "0x");
    const minOut = (est.userReceives * 9900n) / 10000n;
    const rec = await waitOk(core.sell(tokenAddr, amt, minOut, 0n, "0x", overrides), "sell");
    sellTx = rec.hash;
    log("sell", { tx: sellTx, amount: amt, userReceives: est.userReceives, vault: await snapshotVault(hre, rt.vault) });
  }

  log("preview before sell-out", await readPreview(migrate, tokenAddr));

  // ------------------------------------------------------------ sell-out (auto-migrates when healthy)
  let migrateRec = null;
  if (process.env.SELL_OUT !== "0" && preset.loop?.sellOut !== false) {
    const vault = await ethers.getContractAt(VAULT_FULL_ABI, rt.vault);
    const remaining = await vault.remainingForSale();
    const b2 = await buy(hre, ctx, tokenAddr, remaining, gasLimit);
    log("sell-out buy", { tx: b2.rec.hash, amount: remaining, gasUsed: b2.rec.gasUsed, vault: await snapshotVault(hre, rt.vault) });
    if (parseLogs(core.interface, b2.rec, coreAddr).some((p) => p.name === "MigrateExecuted")) migrateRec = b2.rec;
  }

  let snap = await snapshotVault(hre, rt.vault);
  if (!migrateRec && snap.phaseName !== "Migrated") {
    const pv = await readPreview(migrate, tokenAddr);
    log("graduation deferred", pv);
    if (process.env.WAIT_FORCE === "1" && pv.conditionsMet && !pv.canMigrate && pv.forceAt) {
      const waitS = Number(pv.forceAt) - Math.floor(Date.now() / 1000) + 15;
      if (waitS > 0) {
        console.log(`waiting ${waitS}s for forceAt ${pv.forceAt}`);
        await new Promise((r) => setTimeout(r, waitS * 1000));
      }
    }
    if (process.env.WAIT_FORCE === "1" || pv.canMigrate) {
      migrateRec = await waitOk(core.migrate(tokenAddr, { ...overrides, gasLimit }), "core.migrate");
    }
    snap = await snapshotVault(hre, rt.vault);
  }

  // ------------------------------------------------------------ read results
  const result = {
    preset: SLUG,
    presetId: presetId.toString(),
    chainId,
    token: tokenAddr,
    name: form.name,
    symbol: form.symbol,
    vault: rt.vault,
    migrateModule: migrateAddr,
    customData: rt.customData,
    createTx: createRec.hash,
    buyTx: b1.rec.hash,
    sellTx,
    migrateTx: migrateRec?.hash || null,
    phase: snap.phaseName,
  };
  if (migrateRec) {
    const mig = parseLogs(core.interface, migrateRec, coreAddr).find((p) => p.name === "MigrateExecuted");
    const modLogs = parseLogs(migrate.interface, migrateRec, migrateAddr);
    const version = Number(mig.args.migratedDataVersion);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    result.migratedDataVersion = version;
    result.encodedMigratedData = mig.args.encodedMigratedData;
    if (version === 1) {
      const [pair, sUSD, pool] = coder.decode(["address", "address", "address"], mig.args.encodedMigratedData);
      Object.assign(result, { branch: "pool", pair, sUSD, pool });
    } else if (version === 2) {
      const [pair, quote] = coder.decode(["address", "address"], mig.args.encodedMigratedData);
      Object.assign(result, { branch: "fallback", pair, quote });
    } else {
      result.branch = "none";
    }
    const g = await migrate.lastGraduation();
    result.graduation = {
      branch: Number(g.branch),
      quoteUsed: g.quoteUsed,
      tokenUsed: g.tokenUsed,
      seedAmount: g.seedAmount,
      mintAmount: g.mintAmount,
      sUSDMinted: g.sUSDMinted,
      xToTreasury: g.xToTreasury,
      leftoverToTreasury: g.leftoverToTreasury,
      liquidity: g.liquidity,
      price: g.price,
    };
    result.events = modLogs.map((p) => ({
      name: p.name,
      args: Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name, p.args[i]])),
    }));
    if (result.pair) result.pairState = await readPair(hre, result.pair, tokenAddr);
    if (result.branch === "pool") {
      const pool = await ethers.getContractAt(POOL_ABI, result.pool);
      const st = await pool.state();
      const info = await factory.poolInfo(result.pool);
      const xTok = await ethers.getContractAt(ERC20_FULL_ABI, info.xToken);
      result.xToken = info.xToken;
      result.stabilityPool = info.stabilityPool;
      result.poolState = {
        C: st.C,
        S: st.S,
        X: st.X,
        price: st.price,
        V: st.V,
        E: st.E,
        leverage: st.leverage,
        collateralRatio: st.collateralRatio,
        mode: Number(st.mode),
        marketOpen: st.marketOpen,
      };
      result.treasury = {
        address: treasury,
        xBalance: await xTok.balanceOf(treasury),
        isDonor: await pool.isDonor(treasury),
      };
      result.poolCreator = await pool.creator();
    }
    result.moduleStockBalance = await stock.balanceOf(migrateAddr);
  }
  if (addresses.feeRouter) {
    try {
      const fr = await ethers.getContractAt(FEE_ROUTER_FULL_ABI, addresses.feeRouter);
      result.fees = {
        partnerOf: await fr.partnerOf(tokenAddr),
        devFeePending: await fr.devFeePending(stockAddr, treasury),
        partnerFeePending: await fr.partnerFeePending(stockAddr, treasury),
      };
    } catch (err) {
      result.fees = { error: err.shortMessage || err.message };
    }
  }

  // ------------------------------------------------------------ deployments/<chainId>.json
  const basePoolId = process.env.POOL_ID || "tsla-four";
  let poolId = null;
  const file = updateDeployments(chainId, (d) => {
    d.openfour = d.openfour || {};
    d.pools = Array.isArray(d.pools) ? d.pools : [];
    if (result.branch === "pool") {
      poolId = basePoolId;
      for (let n = 2; d.pools.some((p) => p.id === poolId && String(p.pool).toLowerCase() !== String(result.pool).toLowerCase()); n++) {
        poolId = `${basePoolId}-${n}`;
      }
      const row = {
        id: poolId,
        symbol: create.migrate.stockSymbol,
        assetId: ethers.keccak256(ethers.toUtf8Bytes(create.migrate.stockSymbol)),
        kind: "four",
        pool: result.pool,
        sUSD: result.sUSD,
        xToken: result.xToken,
        stabilityPool: result.stabilityPool,
        feed: create.migrate.feed,
        openedBy: migrateAddr,
        openTx: result.migrateTx,
      };
      d.pools = [...d.pools.filter((p) => p.id !== poolId), row];
    }
    const tokens = Array.isArray(d.openfour.tokens) ? d.openfour.tokens : [];
    const tokenRow = {
      token: tokenAddr,
      poolId,
      name: form.name,
      symbol: form.symbol,
      presetId: presetId.toString(),
      vault: rt.vault,
      migrateModule: migrateAddr,
      customData: rt.customData,
      branch: result.branch || null,
      pair: result.pair || null,
      phase: result.phase,
      createTx: result.createTx,
      migrateTx: result.migrateTx,
    };
    d.openfour.tokens = [...tokens.filter((t) => String(t.token).toLowerCase() !== tokenAddr.toLowerCase()), tokenRow];
    d.openfour.backstopTreasury = d.openfour.backstopTreasury || treasury;
    return d;
  });
  result.poolId = poolId;
  result.deployments = file;
  const outFile = path.join(outDir(), `${SLUG}-lifecycle-${tokenAddr.slice(2, 10).toLowerCase()}.json`);
  writeJson(outFile, result);
  log("result", { ...result, written: outFile });
  if (getPath(deployments, "openfour.registry") == null) {
    console.warn("deployments openfour.registry was empty; run register-splitstock.js to record the fork addresses.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
