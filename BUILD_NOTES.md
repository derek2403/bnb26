> **FROZEN — do not edit (integrators included):** `contracts/src/launch/*`, `contracts/src/flap/*`, `contracts/script/DeployFlap.s.sol` and `contracts/test/fork/FlapLaunchFork.t.sol` are owned by the separate "flap-factory-ready" job. Those factories are about to be deployed and enabled by Flap, and any bytecode change would force a new enable request. If something must change, write it under "Flap change requests" instead.


## flap-ui

**What it is.** Two Flap source packages for the SPLIT "backstop-first crowdfund" launch (Flap -> new SplitStock NVDA pool).

- `flap-ui/launcher/` (`Component.tsx`, `manifest.json`, `i18n.json`; exactly these three files, the checker rejects extras). `schemaVersion 2`, `kind launcher-ui`, `configContract launcher-config-preview/v1`, surfaces `launcher-config` + `launcher-ui`, chainId 97. Exports `LauncherConfig` (create form + review: name, symbol, meta, targetRaise, backstopSeed, sale hours; uses `host.quote`, `host.findSalt`, `host.encode`, `host.submit({kind:"create"})`, `host.checkReceipt`, `host.openLauncher`) and `Launcher` (detail + actions via `host.submit({kind:"action"})`). Inline styles only; i18n en/zh/ko with 126 matching keys.
- `flap-ui/vault/` (`Component.tsx`, `manifest.json`, `VaultABI.ts`, `i18n.json`, en/zh): BackstopVault panel generated with `vault:scaffold` (main branch): risk status, buffer USD, pool CR, total defended, and a permissionless `cover(pool)` button. It is a skeleton until SPLIT exists. Its manifest still holds a placeholder factory `0x2222…` and the public test CA `0xf8ac…7777`.
- `flap-ui/scripts/sync-addresses.mjs`: rewrites the addresses from `deployments/<chainId>.json`. `flap-ui/scripts/build.mjs`: template checks and zip. `flap-ui/package.json` defines the npm scripts.
- Output: `flap-ui/dist/splitstock-launcher.zip`, built with `zip -X -j`, three files at the root.

**Build / run**
```
cd flap-ui
npm run sync                 # after deploy: pull flap.launcherFactory / flap.vaultFactory / SPLIT token from deployments/97.json
npm run setup                # clone template (test/pool-launch-developer-preview + main) into flap-ui/.template and yarn install
npm run build:launcher       # yarn launcher:check-source + tsc --noEmit inside template + zip -> dist/splitstock-launcher.zip
npm run check:vault          # tsc + vault:register + vault:check inside the main template
```
Use `FLAP_LAUNCHER_TEMPLATE_DIR` and `FLAP_VAULT_TEMPLATE_DIR` to point at existing checkouts. Results this phase: launcher check-source passed, typecheck passed and the zip was built; vault tsc and vault:check passed (`package-ready`). `vault:package` needs `vault:e2e` (Playwright), which belongs to the later testing phase. Never zip the vault by hand.

**Env vars.** None at runtime. Build only: `FLAP_LAUNCHER_TEMPLATE_DIR`, `FLAP_VAULT_TEMPLATE_DIR`. No secrets.

**Reads from deployments/97.json.** `flap.launcherFactory` sets the manifest `factoryAddress` and the `splitFactory` constant in Component.tsx. `flap.vaultFactory` sets the `backstopVaultFactory` constant, which is encoded into the config, and the vault manifest binding. `flap.launchers[].token` (the first address ending in 7777) becomes the vault manifest test token. Until the sync runs, the launcher uses placeholders `0x1111…` and `0x2222…`, and `supportsIdentity()` shows "factory mismatch" on a real host.

**Contract interface other components MUST match**

SplitLauncherFactory config (`host.encode`, which must equal the strict decode order and `launcherDataSchema()`):
```
abi.encode(SplitLaunchConfig{ string name; string symbol; string meta; bytes32 salt; uint256 targetRaise;
                              uint256 backstopSeed; uint256 saleDuration /*seconds*/; address vaultFactory })
```
The value is encoded as ONE tuple parameter. If the factory decodes flat fields `(string,string,string,bytes32,uint256,uint256,uint256,address)` instead of a struct, the encodings differ (a tuple holding dynamic fields gets an extra offset word), so `factoryParameters` in `launcher/Component.tsx` must change to match. UI-side bounds: name ≤ 32 B, symbol ≤ 10 B alphanumeric, meta ≤ 512 B, target 0.5–1000 tBNB, 0 < seed ≤ target/2, duration 1–720 h. The factory may be stricter (live floor × 1.1). `valueWei` = `host.quote()` (creation fee); initialize expects SALT_LOCK_FEE per the plan, so confirm with Flap that the Portal forwards quote() to the launcher.

SplitLauncher (instance) getters, zero-arg unless noted. Each must return a single value of exactly the listed type:
- `raised() uint256`, `targetRaise() uint256`, `remaining() uint256`, `saleDeadline() uint256` (unix s), `launched() bool`, `token() address`, `predictedToken() address`, `creator() address`, `pool() address` (SplitStock pool; 0 until openPool), `backstopVault() address`, `backstopBufferUsd() uint256` (USD, 18 dec)
- account-scoped (one `address` arg): `contributions(address) uint256` (wei), `claimable(address) uint256` (token wei), `boosted(address) bool`
- actions (zero-arg): `contribute()` payable, `contributeBoosted()` payable (pulls 100e18 sUSD; the UI tells users to approve in the SplitStock app first, since the host cannot approve), `claim()`, `refund()`, `openPool()` nonpayable
- UI assumptions: filling contribution = `remaining()`, overfill reverts; refund only after the deadline and while not launched; openPool shown when `launched && pool()==0`. Displayed constants: 1,000,000 supply, 500,000 LP, 500,000 crowd (50/50, like Flap's CrowdLauncher; default target 4.7 / seed 0.2 tBNB), 3%/3%, VAULT 5000 / LP 2000 / DEFLATION 3000, 30-day tax, boost 100 sUSD at 1.2x.

BackstopVault (vault UI `VaultABI.ts`). All reads and the write target `context.vaultAddress` only, because the template forbids fixed external targets, so the vault must expose pool state itself:
- `bufferUsd() view returns (uint256)` USD 18 dec (Atlas BNB/USD, 0 or revert when stale is shown as unavailable)
- `pool() view returns (address)` the defended SplitStock pool (0 before openPool)
- `poolCollateralRatio() view returns (uint256)` CR with 1e18 = 100% (from pool.state())
- `totalDefendedUsd() view returns (uint256)` cumulative mUSDC donated, 18 dec
- `cover(address pool)` nonpayable; the UI enables it only when the pool is set and CR < 1e18

**TODOs**
- Once SplitLauncher.sol and BackstopVault.sol land, diff their signatures against the lists above, especially the config tuple vs flat encoding and the `pool`/`poolCollateralRatio`/`totalDefendedUsd` vault getters.
- After deploy: run `npm run sync`, then `npm run build:launcher` again; scaffold-check the vault with the real SPLIT token, run `vault:e2e` / `vault:package` / `vault:verify-package`, and hand both ZIPs to Flap (requested multiplier 5000).
- The token page path `/bnb-testnet/<token>` follows the green-presale example. The vault panel lives on the token's tax-info page (host-owned).

## oracle-scripts

**What it is.** Mainnet/pull oracle contracts, every core deploy script, the shared `deployments/*.json` helper,
BscScan verification and the root `Makefile`. Foundry, `contracts/`, own build dirs `out-scripts/` + `cache-scripts/`
(gitignored).

Files
- `contracts/lib/atlas-pull/`: **vendored, unmodified** `@atlas-oracle/pull-oracle-consumer@1.0.0` `src/` (BUSL-1.1, headers kept, `VENDORED.md`). Obtained from the npm tarball, so no clean-room verifier was needed. Its non-relative imports are resolved by context-scoped remappings added to `contracts/foundry.toml` (`lib/atlas-pull/:base/=…`, `libraries/`, `interfaces/`, `constants/`) plus `atlas-pull/=lib/atlas-pull/src/`.
- `src/oracle/AtlasPullAdapter.sol` (chain 97): inherits `PullOracleConsumerStandard`.
- `src/oracle/AtlasCmcAnchor.sol` (chain 56): keeper-only same-tx Atlas vs CMC anchor.
- `src/oracle/NvdabLens.sol` (chain 56): view-only quote of the PCS v3 NVDAB/USDT pool.
- `script/lib/DeploymentsIO.sol`: base for every script (address book read/write, broadcaster, role-address env). Flap and OpenFour scripts already inherit it.
- `script/lib/CoreHandoff.sol`, `script/lib/IPcsV2.sol`.
- `script/DeployCore.s.sol`, `script/OpenDevPools.s.sol`, `script/HandoffAdmin.s.sol`, `script/DeployMainnet.s.sol`, `script/verify.sh`, `script/Verify.md`.
- `Makefile` (repo root), `.env.example` (all names), `.gitignore` (`out-scripts/`, `cache-scripts/`).

**Build / run**
```
make build                       # forge build --out out-scripts --cache-path cache-scripts (whole project)
make deploy-core                 # 97: core + mocks + pairs -> deployments/97.json (DRY=1 to simulate only)
make open-dev-pools              # 97: nvda-dev, nvda-scenario, tsla-scenario (+ seed) -> pools[]
make deploy-flap                 # 97: FLAP_SCRIPT (default script/DeployFlap.s.sol:DeployFlap, out-flap)
make handoff                     # 97: DEFAULT_ADMIN_ROLE -> Timelock, deployer renounces (do this LAST)
make deploy-mainnet              # 56 -> deployments/56.json
make verify / make verify-mainnet
make script S=script/FlapLaunch.s.sol SIG='fill()'
```
Order on 97: `deploy-core` → keeper pushes the mirrors → `open-dev-pools` (rerun to seed nvda-dev once the mirror is fresh, ≤120 s) → `deploy-flap` / OpenFour → grant CREATOR_ROLE to launchers/module → `handoff`.
Build result this phase: my files compile (`forge build --out out-scripts --cache-path cache-scripts script/*.s.sol src/oracle/*.sol` passes; only lint notes). The full `make build` currently stops at `src/backstop/BackstopTreasury.sol:162` (stack too deep), which belongs to the OpenFour/backstop component. An in-memory `forge script DeployCore` (no RPC, nothing broadcast) ran end to end and wrote a correct file; the scratch output was deleted.

**Env vars** (names in `.env.example`; the Makefile sources `.env` inside the recipe and unsets empty values so `vm.envOr` defaults apply; keys must be 0x-hex).
- Broadcasters: `DEPLOYER_PRIVATE_KEY` (→ `KEEPER_PRIVATE_KEY` → forge default sender), `MAINNET_DEPLOYER_PRIVATE_KEY` (→ `MAINNET_PRIVATE_KEY`). `ETHERSCAN_API_KEY`, `BSC_TESTNET_RPC`, `BSC_MAINNET_RPC`.
- Role holders, each `*_ADDRESS` override → address of the service key → `KEEPER_PRIVATE_KEY` address → deployer: RiskOracle POSTER `RISK_POSTER_ADDRESS`/`RISK97_PRIVATE_KEY`; PROPOSER `AGENT_ADDRESS`/`AGENT_PRIVATE_KEY`; AtlasMirror PUSHER `MIRROR_PUSHER_ADDRESS`/`MIRROR_PRIVATE_KEY` (+ `MIRROR_BACKUP_ADDRESS`/`MIRROR_BACKUP_PRIVATE_KEY`); LogAnchor ANCHOR `ANCHOR_ADDRESS`/`ANCHOR_PRIVATE_KEY`; ScenarioFeed operator `SCENARIO_OPERATOR_ADDRESS`/`OPS_PRIVATE_KEY` (→ deployer); `GUARDIAN_ADDRESS` (→ deployer; set a 2-of-3 Safe before judging). Mainnet: `MAINNET_KEEPER_ADDRESS`/`RISK56_PRIVATE_KEY` (AtlasCmcAnchor KEEPER + RiskOracle56 POSTER), `ANCHOR56_ADDRESS`/`ANCHOR56_PRIVATE_KEY`, `MAINNET_GUARDIAN_ADDRESS`, `AGENT56_ADDRESS`.
- DeployCore tunables: `HANDOFF_ADMIN` (default false = deferred), `TIMELOCK_DELAY` (86400), `TIMELOCK_PROPOSER` (deployer), `TIMELOCK_EXECUTOR` (0x0 = open), `NVDA_PRICE_E18` (150e18), `TSLA_PRICE_E18` (400e18), `BNB_PRICE_E18` (554.69e18), `MUSDC_DECIMALS` (18), faucets, `ATLAS_*` sources and pull feed ids, `ATLAS_PULL_SIGNER` (dev only), sandbox amounts, `SKIP_DEX`, pair sizes, `POOL_LOGIC`, `FRESH_DEPLOYMENTS_FILE`, `DEPLOYMENTS_DIR`. OpenDevPools: `DEV_SEED_TNVDA` (20e18), `SCENARIO_SEED_TNVDA` (50e18), `SCENARIO_SEED_TTSLA` (20e18), `DEV_SEED_RECIPIENT`, `DEV_POOL_USE_MOCK_ROUTER`.

**What DeployCore deploys and wires (SPEC.md §14.1)**
tNVDA / tTSLA / mUSDC (`MockERC20Permit`, 18 dec by default) · LeveragePool, SplitToken, StabilityPool and ScenarioFeed implementations · PoolLogic (linked by forge; its address is read out of the LeveragePool runtime code) · MarketCalendar · RiskOracle (`configureAsset` NVDA and TSLA with the §7.9 config; POSTER, PROPOSER, GUARDIAN) · LogAnchor (ANCHOR) · AtlasMirror NVDA (src 56 `0xf25Af…`, 18 dec) and TSLA (src 56 MultiFeed `0xEAcE…`, feedId `0x000003a5`), PUSHER + GUARDIAN · AtlasPullAdapter per asset · canonical ScenarioFeed clone per asset (operator, `publicSetter=false`, anchored at the configured price) · MockRouter (MINTER on the three mocks) · PoolFactory (`PoolMath.defaultParams()`, GUARDIAN) · SandboxFactory for NVDA (CREATOR on PoolFactory, AUTHORIZER on MockRouter, MINTER on tNVDA) · TimelockController (self-administered) · PCS v2 pairs tNVDA/mUSDC, tTSLA/mUSDC (configured prices), WBNB/mUSDC (BNB price), WBNB/tNVDA (native tBNB from the deployer, defaults 0.15 + 0.1). No pool is opened. sUSD/mUSDC is not seeded (it needs sUSD from a pool; see TODO).
Handoff covers PoolFactory, RiskOracle, MarketCalendar, LogAnchor, both mirrors, MockRouter and the three mocks; the deployer keeps MINTER on the mocks and every non-admin role. `EXTRA_HANDOFF_TARGETS` adds more.

**deployments JSON written** (SCHEMA.md layout; extra keys are additive)
- 97.json: the whole file, `pools: []` and placeholder `flap` / `openfour` (zero addresses, `presetId: null`, empty arrays) so later scripts can `vm.writeJson(value, path, ".flap.x")`. On a re-run over an existing file, only chainId, deployer, tokens, core, oracles, dex, updatedAt are replaced and `pools` is reset; flap / openfour / erc8004 are kept (a warning says they point at the old core). `erc8004.agentId` is preserved. Extras: `core.poolImpl`, `core.tokenImpl`, `core.stabilityPoolImpl`, `core.scenarioFeedImpl`, `oracles.TSLA.atlasSource.feedId`.
- OpenDevPools upserts `pools[]` rows by id: `nvda-dev` (kind `dev`, feed = NVDA mirror, PCS v2 router, MockRouter if absent), `nvda-scenario` and `tsla-scenario` (kind `scenario`, feed = ScenarioFeed, MockRouter + `setCaller`). `openTx` is `""` because a script cannot know its tx hash (read it from `contracts/broadcast/.../run-latest.json` if needed).
- 56.json: `chainId, updatedAt, deployer, core{riskOracle, logAnchor}, mainnet{atlasCmcAnchor, nvdabLens, nvdab, usdt, atlasNvdabFeed, atlasMultiFeed, pcsV3NvdabUsdt, keeper}, erc8004{identity 0x8004A169…a432, reputation 0x8004BAa1…9b63, agentId}`.

**DeploymentsIO API for other scripts** (inherit `script/lib/DeploymentsIO.sol`): `_readDeployments()`, `_deploymentsPath()`, `_jAddr/_jStr/_jB32/_jUint(json, ".key")` (missing → zero), `_readPools(json)`, `_findPool(pools, id)`, `_upsertPool(PoolEntry)` (replace by id or append, bumps updatedAt), `_writeSection(".key", rawJson)` (the key must already exist), `_q/_a/_kv` JSON builders, `_startBroadcastTestnet()` / `_startBroadcastMainnet()` (return the broadcaster), `_roleAddr(addrEnv, keyEnv, fallback)`.

**Contract interfaces other components must match**
- `AtlasPullAdapter(address mirror, bytes4 feedId, address signerOverride, string description)`. Append the raw Atlas payload (`[packages 20B×N][count 1B][sig 65B][0x7096]`) to calldata of:
  `verify() returns (uint256 price, uint256 timestamp)` (stateful: ts strictly increasing, age ≤ 60 s, ≤ 30 s future, |pull−mirror| ≤ 50 bps, mirror not halted);
  `verifyAndPrice(bool userSellsAsset) returns (uint256 price)`; `peek() view returns (price, timestamp, mirrorPrice, devBps)` (eth_call quote, no monotonic check).
  Helpers: `worseOf(pull, mirror, userSellsAsset) pure` (true = user hands the asset in, mints → min; false = redeems → max), `userPrice(bool) view returns (price, pullUsed)`, `mirrorPrice() view returns (price, updatedAt)`, `deviationBps(a,b)`, `lastPrice()`, `lastTimestamp()`, `verifiedCount()`, `feedId()`, `mirror()`, `signer()`, constants `ATLAS_SIGNER, MAX_AGE=60, MAX_DEV_BPS=50`. Also an IAggregatorV3 (18 dec) over the last verified pull, `halted()` = mirror's.
  `event PullVerified(bytes4 indexed feedId, address indexed caller, uint256 price, uint256 timestamp, uint256 mirrorPrice, uint256 devBps)` (prices WAD). The app placeholder ABI `PullVerified(bytes32,int256,uint256)` is wrong; regenerate from `out-scripts/AtlasPullAdapter.sol/AtlasPullAdapter.json`.
  A forwarding contract must call the adapter with the payload appended raw: `adapter.call(abi.encodePacked(abi.encodeCall(AtlasPullAdapter.verify, ()), payload))`.
- `AtlasCmcAnchor(address admin, address keeper, address atlasFeed)`; `KEEPER_ROLE = keccak256("KEEPER_ROLE")`; `anchor(uint256 cmcPriceE18, uint256 cmcTs, bytes32 respHash) returns (uint256 index)` (cmcTs strictly increasing, ≤ now+30 s; respHash ≠ 0; price ≠ 0). `event Anchor(uint256 indexed index, uint256 atlasPrice, uint256 cmcPrice, uint256 devBps, uint256 atlasUpdatedAt, bytes32 respHash, uint256 cmcTs, int256 gapBps, uint80 atlasRoundId)` (WAD prices; gapBps = (atlas−cmc)/cmc signed; devBps = |gap| rounded up). Views: `anchorCount()`, `lastCmcTs()`, `lastAnchor()` (struct), `atlasPrice()`, `atlasFeed()`. Both placeholder Anchor ABIs in services/ and app/ differ; regenerate.
- `NvdabLens(address pool, address base)`; `spotPriceWad() view` (USDT per NVDAB, WAD), `snapshot() view returns (Snapshot{priceWad, sqrtPriceX96, tick, liquidity, fee, virtualBase, virtualQuote, unlocked, blockNumber, blockTimestamp})`, `quoteSellBase(uint256) / quoteBuyBase(uint256) view returns (out, priceImpactBps)` (in-range estimate, no tick crossing), `pool() base() quote() baseIsToken0()`.
- Pool ids used: `nvda-dev`, `nvda-scenario`, `tsla-scenario` (DeployFlap reads `nvda-scenario`).

**Core change requests** (RESOLVED by the integrator: pull pricing deferred, poolLogic getter declined; see `## integrator` and SPEC.md §16)
- Worse-of-two pricing cannot reach the pool today: LeveragePool reads only `feed.latestRoundData()`, and trailing calldata on a pool call is not visible to the adapter. For a pull-priced LivePool, either (a) LeveragePool gets a `_userPrice(bool userSellsAsset)` hook that, when `msg.data` carries an Atlas payload, forwards it to `AtlasPullAdapter.verifyAndPrice` and uses the result for mints/redeems (keeper paths stay on the mirror), or (b) a router contract calls `adapter.verify()` first and the pool reads `AtlasPullAdapter.userPrice()`. Until then the adapter is a standalone verifier (`PullVerified` txs from `/api/atlas/pull`).
- Optional: expose `PoolFactory.poolLogic()` so scripts and verify do not have to scan LeveragePool bytecode.

**TODOs**
- [UNVERIFIED] Atlas NVDAB pull feed id: default `0x000003a6` (934, matches the MultiFeed id rule); 1005 (`0x000003ed`) is the SingleFeed registry id. Confirm with Atlas and set `ATLAS_PULL_FEED_ID_NVDA` before deploy. Also confirm the signature scope (no chainId in the signed bytes).
- TSLA mirror source is the mainnet MultiFeed (`fetch(0x000003a5)`); the keeper must read it that way. TSLA_PRICE_E18 default 400e18 is a placeholder; set it from the MultiFeed before deploy-core so the pairs and ScenarioFeed anchor are right.
- sUSD/mUSDC PCS pair for pegKeep is not created (needs sUSD minted from a pool once RiskOracle has a fresh snapshot).
- OpenDevPools needs the deployer to still be PoolFactory admin; after handoff the same actions need a 24 h Timelock schedule/execute (not scripted).
- Mainnet admin stays with the mainnet deployer (no value on 56); hand off later if wanted.
- Guardian defaults to the deployer when `GUARDIAN_ADDRESS` is unset; use the 2-of-3 Safe (or a simple multisig if Safe is absent on 97).

## flap-contracts

**What it is.** The Flap Pool Launch side of SplitStock in `contracts/` (Foundry, solc 0.8.26): a "backstop-first crowdfund" whose raise launches a 7777 tax token on Flap and then opens a NEW SplitStock NVDA pool through `PoolFactory.createPool`, with the first-loss xNVDA owned by the token's BackstopVault. Also the OpenFour-side `BackstopTreasury`.

- `src/flap/` copied **byte-for-byte** from `flap-sh/FlapPoolLaunchVaultExample` @ `29334f689774f6b3a39720b3fc802ab0d6a61718` (`diff -r` against the clone in the scratchpad `flap-example/src/flap` is empty). It only needs `solady/` (already remapped). The example's other remapping `@openzeppelin/=…` is not needed: our files import `@openzeppelin/contracts/…` (OZ 5.1) and `@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol` (OZ-upgradeable 4.9.6, the same Initializable the Crowd example uses). No new libs were installed.
- `src/launch/ISplitLaunch.sol`: `SplitPoolConfig` struct, `ISplitLauncherFactory`, `ISplitLauncherView`, `IBackstopVaultView`, local `IPortalQuoteLens` (`launchQuoteConfig`, read by raw staticcall because its ABI is undocumented), `IUniswapV2FactoryLike`, `FLAP_TOKEN_IMPL = 0x7777c57f…2222`.
- `src/launch/FeedLib.sol`: never-reverting AggregatorV3 read scaled to WAD, with a staleness check and a 30 s future-skew check.
- `src/launch/SplitLauncherFactory.sol`: inherits `LauncherFactoryBase` (`lf-v1`, `newLauncher` onlyHub). Hub, Guardian and paired-vault-factory immutables, one solady beacon, `deployDeterministicERC1967BeaconProxy(beacon, salt)`. Checks: strict decode (`keccak(abi.encode(decoded)) == keccak(data)`), paired vault factory, name 1–32 B, symbol 1–10 B, meta ≤ 512 B, target 0.5–1000 tBNB, seed 0.01 to target/2, duration 10 min–30 days, and the pool quote (target − seed) ≥ 1.1 × the live creation floor (`$750 × mult × 1.25 / quotePriceUsd`; skipped whenever the `launchQuoteConfig` read fails or looks implausible, i.e. enabled word ≠ 1 or price outside $1–$1M; the Portal re-checks at launch). The 0x7777 rule is left to the Portal's `lockSalt` (no hard-coded token impl in a check); `predictToken` is a mining view only. Views: `poolConfig()`, `poolSymbol()`, `predictLauncher(salt)`, `predictToken(salt) (token, ok)`, `creationFloor() (wei, known)`, `minPoolQuote()`, `launcherDataSchema()` (8 fields in encoding order). `upgradeVaultImplementation` is Guardian-only.
- `src/launch/SplitLauncher.sol`: has a fixed shape: 1,000,000 supply, `poolToken` 500,000 (50/50 like Flap's CrowdLauncher: at the opening price contributors' tokens are worth about 90% of what they paid; the old 80/20 split gave about 22%), tax 300/300 bps, VAULT 5000 / LP_BPS 2000 / DEFLATION 3000, taxDuration 30 d, antiFarmer 1 d, dexId 0, antiSniper 0, no commission, `encodeCreator(creator)`, and `Distribution{EXPLICIT, this, 500_000e18}` (`initializeDistribution` is copied from Crowd). `initialize` requires `msg.value == SALT_LOCK_FEE` and calls `lockSalt` itself. The filling `contribute()` calls `launchTaxTokenV2{value: targetRaise − backstopSeed}`; the seed tBNB stays in the Launcher for `openPool()`. `openPool()` is permissionless and runs once: `createPool(tNVDA, NVDA mirror, keccak("NVDA"), "NVDA", router, LIVE)`, then swap seed→tNVDA on PCS v2 (direct WBNB/tNVDA pair if it exists, else via mUSDC) with `minOut = seed × AtlasBNBUSD / NVDA price × 97%`, then `pool.seed(cIn, backstopVault)` and `pool.setDonor(backstopVault, true)`. `releaseSeed()` is the 14-day fallback that sends the seed to the vault if the pool never opens. A contribution over `remaining()` is clipped and the excess returned in the same call (`ExcessReturned`), so a 1-wei front-run cannot block the final contribution. Escrow returns use a non-reverting transfer: if the boost token refuses, the BNB refund / token claim still goes through and the escrow is recorded in `escrowOwed` for `withdrawEscrow()`. The holder boost works like this: `contributeBoosted()` pulls exactly 100e18 of `boostToken` (sUSD), gives +20% weight on up to 0.5 tBNB, allows one boost per address, and returns the escrow at claim or refund. `claim()` and `refund()` are pull payments: one-shot, mutually exclusive, and refund is 1× the contribution. `sweepDust()` sends rounding dust to the vault after every weight has claimed. The Guardian (the factory's) can only call `forceFail()` before launch, plus upgrade the beacon. `description()` is v1 JSON (EN + ZH, about 1.85 KB of copy) that names every fee and recipient and says ScenarioPool is a demo pool with a team-set price.
- `src/launch/BackstopVaultFactory.sol`: `DirectLaunchVaultFactoryBase` (`pl-v1`). `newVault` is onlyHub and runs `_validateLaunch` + `_requireNoReserveDistribution`. It checks `Portal.getLauncher(creator).launcherFactory == launcherFactory`, that `vaultData` is exactly 64 bytes `abi.encode(launcher, scenarioPool)` naming the caller and the launcher factory's `scenarioPool`, a native quote, a VAULT slot of exactly 5000, that the Launcher is `launching` with `raised == targetRaise`, and that the distribution is EXPLICIT to the Launcher. It deploys a beacon proxy keyed by the token. It also provides `predictVault(token)`, `vaultDataSchema`, `tokenCreationPolicies`, `isQuoteTokenSupported` (native only), and a Guardian-only upgrade.
- `src/launch/BackstopVault.sol`: `DirectLaunchVaultBase` + Initializable (initializers disabled in the constructor), no owner, never calls the token. Accounting follows CrowdVault: `seen = balance + totalOut`, and `receive()` only calls `_sync()`. `cover(target)` is permissionless and only accepts the live pool (`launcher.pool()`) or the vaultData ScenarioPool. The pool must have the vault as donor, a fresh price (or a price that is only not fresh because the feed is halted and is still within the pool's `maxPriceAge`: covers land during a halt, at the halted price) and S > V. It spends at most deficit × 1.03 in tBNB, capped per day at 50% of the buffer for the live pool and, for the ScenarioPool, 20% per day AND 10% of all revenue ever (`spentScenarioTotal`). It swaps tBNB→mUSDC with `minOut = amt × Atlas BNB/USD × 98%`; before swapping it checks `getAmountsOut` and halves the amount (up to 6×) until the quote meets that minimum, so a thin pair gives smaller covers instead of a `SwapShort` revert. Then `pool.donate(mUSDC, 0)` with an exact approve reset afterwards. Leftover mUSDC is kept for the next LIVE-pool cover only; the ScenarioPool only receives what that call bought. Events: `Defended(pool, bnbIn, usdcOut, crBefore, crAfter)`, `BufferValued(bnbUsd, atlasUpdatedAt)`, `RevenueRecognized`. `vaultUISchema` lists 9 methods incl. the permissionless writes `sync` and `valueBuffer`. Views (none revert): `bufferUsd()`, `bufferBnb()`, `bufferValuation()`, `livePool()`, `pool()`, `poolCollateralRatio()`, `xHeld()`, `capLeft(pool)`, `canCover(pool)`, `totalDefendedUsd`, `totalRevenue`, `description()`, `vaultUISchema()`, `version()`. `valueBuffer()` emits BufferValued as Atlas read evidence.
- `src/backstop/BackstopTreasury.sol` (OpenFour fees, not Flap): it is the preset author and partner. `sweep()` is permissionless and calls `claimDevFee(q, this)` + `claimPartnerFee(q, this)` for every quote asset, each in try/catch, emitting `Swept(asset, amount)`. `cover(pool) returns (uint256 donatedUsd)` is permissionless and only applies to a PoolFactory pool whose x this treasury holds (or one the admin registered) with CR < 1 and a fresh price. It donates held mUSDC first, then the pool's own asset (tTSLA); each holding is capped at 50% per day, and the pool caps the total at S − V. It emits `Defended(pool, assetAccepted, donatedUsd, crBefore, crAfter)` + `DonatedDetail`. `bufferUsd()` values the quote assets at their feeds (+ mUSDC at $1). Admin is the deployer, handed to the Timelock via `transferAdmin`/`acceptAdmin`, and is configuration only: `setFeeRouter`, `addQuoteAsset`, `setAssetFeed`, `registerPool`, `setRegistry` (once) and `callRegistry(data)`, which forwards to the OpenFour Registry so the preset author is the treasury. Admin has no withdraw, and the registry and fee-router targets may never be a held token or an x token.
- `script/DeployFlap.s.sol`: deploys the BackstopVaultFactory at the launcher factory's predicted address (nonce + 1), then the SplitLauncherFactory, and writes `flap.portal/guardian/launcherFactory/vaultFactory`. `script/DeployBackstopTreasury.s.sol` writes `openfour.backstopTreasury`. `script/FlapLaunch.s.sol` has the steps `newLauncher()` (mines a 7777 salt, grants CREATOR_ROLE to the predicted Launcher if the broadcaster is PoolFactory admin, pays exactly SALT_LOCK_FEE), `contribute(uint256)`, `fill()`, `contributeBoosted(uint256)`, `openPool()` (upserts `pools[]` id `nvda-flap`, kind `flap`), `dispatch()` (TaxProcessor), `cover()`, `claim()`, `refund()`, `status()`. All scripts reuse `script/lib/DeploymentsIO.sol` from the core builder.

**Build.** `cd contracts && export PATH="$HOME/.foundry/bin:$PATH" && forge build --out out-flap --cache-path cache-flap` passes (full project, 0 warnings in flap files). `out-flap/` and `cache-flap/` are in the root `.gitignore`. Sizes (runtime): SplitLauncher 21.5 KB, BackstopVault 17.2 KB, SplitLauncherFactory 9.3 KB, BackstopVaultFactory 8.5 KB, SplitStockConfig 1.2 KB (immutable), BackstopTreasury 10.7 KB. Tests: `test/fork/FlapLaunchFork.t.sol` (7, live Portal) and `test/launch/CoreAbiPin.t.sol` (3).

**Run (later, not done in this phase).** `forge script script/DeployFlap.s.sol --rpc-url $BSC_TESTNET_RPC --broadcast --out out-flap --cache-path cache-flap`, then `FlapLaunch.s.sol --sig "newLauncher()"`, `"fill()"`, `"openPool()"`, `"dispatch()"`, and so on. The broadcaster comes from `DeploymentsIO._startBroadcastTestnet()`: `DEPLOYER_PRIVATE_KEY`, else `KEEPER_PRIVATE_KEY`, else `--account`.

**Env vars** (optional, none secret): `FLAP_SCENARIO_POOL`, `FLAP_NO_SCENARIO`, `FLAP_BOOST_TOKEN`, `FLAP_POOL_SYMBOL`, `FLAP_LAUNCHER`, `FLAP_NAME`, `FLAP_SYMBOL`, `FLAP_META`, `FLAP_TARGET` (default 1.7e18), `FLAP_SEED` (default 0.2e18), `FLAP_SALE_DURATION` (default 3 days), `FLAP_SALT`, `FLAP_SALT_SEED`, `TREASURY_ADMIN`, `TREASURY_QUOTE_ASSET`, `TREASURY_QUOTE_FEED`, `ALLOW_NON_TESTNET`.

**Reads from deployments/97.json.** `flap.portal`, `flap.guardian`, `core.poolFactory`, `tokens.tNVDA`, `tokens.tTSLA`, `oracles.NVDA.mirror`, `oracles.TSLA.mirror`, `oracles.atlasBnbUsd`, `dex.router`, `pools[id=nvda-scenario]` (`.pool` becomes the vault's ScenarioPool tranche, `.sUSD` the default boost token), `openfour.feeRouter`, `openfour.registry`. **Writes:** `flap.launcherFactory`, `flap.vaultFactory`, `flap.launchers[] {launcher, token, vault, poolId:"nvda-flap"}`, `pools[] {id:"nvda-flap", kind:"flap", openedBy: launcher, openTx: ""}`, `openfour.backstopTreasury`.

**Cross-component contracts others must match**
- **CREATOR_ROLE:** every SplitLauncher must hold `CREATOR_ROLE` on PoolFactory before `openPool()`. Launcher addresses are deterministic (`factory.predictLauncher(salt)`), so the role can be granted before creation. `FlapLaunch.newLauncher` does it while the deployer is still admin. After the Timelock handoff it needs a Timelock `grantRole(CREATOR_ROLE, launcher)` (24 h).
- **ScenarioPool donor:** for `BackstopVault.cover(scenarioPool)`, the admin must call `scenarioPool.setDonor(vault, true)`. The live pool's donor is set by `openPool`. The OpenFour module (creator of the TSLA pool) must call `pool.setDonor(backstopTreasury, true)` and seed with `to = backstopTreasury`.
- **Launcher config tuple** (flap-ui `host.encode`): `abi.encode(SplitConfig{string name; string symbol; string meta; bytes32 salt; uint256 targetRaise; uint256 backstopSeed; uint256 saleDuration; address vaultFactory})`, encoded as ONE tuple, which matches flap-ui. `newLauncher` value must be exactly `Portal.SALT_LOCK_FEE()` (0.005 tBNB). If Flap's host `quote()` sends a different amount, initialize reverts `InvalidConfig`.
- **SplitLauncher ABI** (matches `app/src/abi/flap/SplitLauncher.ts` and `flap-ui/launcher/manifest.json`): `contribute()`, `contributeBoosted()` payable, `claim()`, `refund()`, `openPool() returns (address)`, `releaseSeed()`, `sweepDust()`, `forceFail()` (guardian). Views: `raised`, `targetRaise`, `remaining`, `saleDeadline`, `backstopSeed`, `poolQuote`, `launched`, `launching`, `failed`, `forcedFailed`, `poolOpened`, `pool` (the SplitStock pool), `lpPair` (the Flap V2 pair), `token`, `predictedToken`, `creator`, `factory`, `backstopVault`, `backstopBufferUsd`, `boostToken`, `boostAmount`, `contributions(a)`, `claimable(a)`, `weightOf(a)`, `boosted(a)`, `claimed(a)` (bool), `refunded(a)` (bool), `totalWeight`, `seedBalance`, `xLocked`, `seedMinOut(bnbIn)`, `description`. Events: `Contributed(user, amount, boosted, raised)`, `Launched(token, poolQuote, backstopSeed)`, `LaunchRecorded(token, lpPair, vault)`, `PoolOpened(pool, seedIn, xLocked)`, `SeedSwapped`, `SeedReleased`, `Claimed(user, tokenAmount, escrowReturned)`, `Refunded(user, bnbAmount, escrowReturned)`, `ForcedFailed`. Errors include `TargetExceeded(uint256 remaining)`, `SaleClosed`, `NotLaunched`, `AlreadyClaimed`, `AlreadyBoosted`, `NotRefundable`, `PoolAlreadyOpened`.
- **BackstopVault ABI:** `bufferUsd() returns (uint256)`. This is a single value, as the app and flap-ui expect. **services' placeholder `bufferUsd() returns (uint256 usd, uint256 atlasUpdatedAt)` is wrong:** use `bufferValuation() returns (bnb, usd, bnbUsd, atlasUpdatedAt, fresh, usdcHeld)` for the Atlas time. `cover(address) returns (uint256 usdcOut)`, `canCover(address)`, `pool()`, `poolCollateralRatio()`, `totalDefendedUsd()`. Events are as in the services placeholder.
- **BackstopTreasury ABI** (matches the app placeholder): `sweep()`, `cover(address) returns (uint256 donated)`, `bufferUsd() returns (uint256)`, `canCover(address)`, `pendingFees(asset)`, `Swept(asset, amount)`, `Defended(pool, amountIn, donated, crBefore, crAfter)`.
- `SplitLauncherFactory.launcherDataSchema()` and `BackstopVaultFactory.vaultDataSchema()` return Flap's schema **structs**, not strings. The app placeholders that declare `returns (string)` must use the generated ABI.
- The app/services `gen-abi` should read `contracts/out-flap/<File>.sol/<Contract>.json` (or `out/` after a full default build).

**TODOs**
- `launchQuoteConfig(uint8,address)`: the return shape is guessed as `(bool, uint256)`, based on raw words `[1, 700e18]`. Confirm it with Flap. If the read fails, the factory skips its early floor check and the Portal remains the guard.
- Atlas BNB/USD on 97 answered 58 s old at check time (research: ~60 s updates). `BNB_USD_MAX_AGE` is now 15 min in both SplitLauncher and BackstopVault (frozen once enabled).
- `openTx` in `pools[nvda-flap]` is left empty; fill it from `broadcast/FlapLaunch.s.sol/97/openPool-latest.json`.
- The tax token's taxProcessor ABI (`taxProcessor()`, `dispatch()`) comes from the example's ForkBase. Confirm it on the live token.
- Done: the Crowd-style fork flow on Portal v1.2.0 (enable via admin prank, launch, dispatch, claim/refund, openPool, cover at CR < 1). Still open: cover on the REAL testnet (needs the live pool below CR 1 and a deep WBNB/mUSDC pair).
- Ask Flap for multiplier 5000 so 1.5 tBNB graduates. At 10000 it creates (1.339 floor, ×1.1 = 1.473 ≤ 1.5) but shows as "New".

**Core change requests.** (RESOLVED by the integrator: `REGISTRAR_ROLE` + `PoolFactory.grantCreator` + `CreatorRegistrar`; see `## integrator`.) None required. Optional: a PoolFactory "registrar" role that lets SplitLauncherFactory grant CREATOR_ROLE to its own launchers, which would remove the per-launch Timelock grant.

**Config design (what Flap enables). Superseded on the pool-config point by "Immutable SplitStockConfig" at the end of this file: the config is now fixed per factory pair.**
- Frozen once Flap enables: `SplitLauncherFactory` and `BackstopVaultFactory` bytecode, which embeds the `SplitLauncher` and `BackstopVault` implementations (after enabling, only the Flap Guardian can change those, through each factory's beacon, ~24 h on request), plus everything the factories store as immutables: Portal, Guardian, the paired factory and the `SplitStockConfig` address.
- NOT changeable (Flap review): the SplitStock core (PoolFactory, tNVDA, NVDA mirror, routers, Atlas feed, ScenarioPool, boost token) lives in `src/launch/SplitStockConfig.sol` (`SplitPoolConfig` + pool symbol), set once in its constructor. `SplitLauncherFactory(hub, guardian, vaultFactory, config)` reverts `ConfigUnset()` at construction if the config is not set (it always is); `poolConfig()`/`poolSymbol()`/`configured()` show the fixed config.
- Snapshot: each `SplitLauncher.initialize(hub, creator, c, cfg, symbol)` stores the config of that moment and never reads the live config again (`openPool`, `seedMinOut`, `scenarioPool()`, `boostToken()`, `poolSymbol()`, `poolConfig()`). `BackstopVaultFactory` checks vaultData's ScenarioPool against `launcher.poolConfig()` (after checking the Portal recorded the launcher under our factory) and `BackstopVault.initialize` reads usdc/router/Atlas from the launcher's snapshot. A config change never touches an existing sale, pool or vault.
- (Historical, removed) Who could change it: `SplitStockConfig(admin, guardian, updateDelay)`. Admin (deployer, to be handed to the Timelock with `transferAdmin`/`acceptAdmin`) AND the Flap Guardian may each `setPoolConfig`, `cancelPoolConfig` and `transferAdmin` (README: every permissioned function also accepts the Guardian; the Guardian can take the admin role away). The FIRST config applies at once (no launcher can exist before it). Every later one is QUEUED for `updateDelay` (DeployFlap default 24 h via `FLAP_CONFIG_DELAY`, bounds 1 h–7 d, immutable), visible on chain via `pending()`/`pendingEta` and `ConfigQueued`, cancellable by admin or Guardian, then applied by anyone with `applyPoolConfig()` (re-validated). So a creator always sees the config their launcher will copy ≥ 24 h ahead, and Flap can veto a bad one.
- Validation (now in the constructor only): every core address has code, `poolFactory.usdc()` returns a contract (else every final contribution would revert in `BackstopVault.initialize`), a ScenarioPool must be `poolFactory.isPool`, boost token zero or a contract, assetId non-zero, symbol 1–10 bytes.
- Frozen core ABI subset (the Launcher/Vault implementations call it): `PoolFactory.createPool(address,address,bytes32,string,address,uint8)` with `PoolKind.LIVE == 0`, `usdc()`, `isPool()`, `LeveragePool.seed/setDonor/isDonor/xToken/donate(uint256,uint256)/state()` and the 26-word `PoolState` field order. Pinned by `test/launch/CoreAbiPin.t.sol`. **Core team: if that test fails, the change needs a new Flap factory pair and a new enable request.** Redeploying the core (even with the same ABI) now needs a new config + factory pair: `make deploy-flap`, then a new Flap enable request.
- BUG FIXED by the fork run: token prediction used solady `LibClone.predictDeterministicAddress` (44-byte proxy) but the Portal deploys an EIP-1167 clone. `predictToken`, `SplitLauncher.predictedToken` and `FlapLaunch._mineSalt` use OZ `Clones.predictDeterministicAddress`.
- Scripts: `DeployFlap.s.sol` = immutable config built from the core in deployments/97.json (the former `SetFlapConfig._build`, same pre-flight checks) → vault factory (at the predicted launcher-factory address) → launcher factory; needs the core and `pools[nvda-scenario]` first; on 97 it requires `flap.portal`/`flap.guardian` to equal `LaunchVaultAddresses`. `SetFlapConfig.s.sol` is deleted and `make set-flap-config` only prints a no-op message. `FlapLaunch.s.sol`: default `FLAP_SEED` is now 0.02 tBNB and `openPool()` preflights the seed swap (router quote vs Atlas minimum) before broadcasting.
- Testnet liquidity rule (openPool swaps the whole seed at ≤ 3% from Atlas; cover at ≤ 2% per piece): WBNB/tNVDA needs ≥ ~36 × the seed in tBNB (DeployCore's 0.1 tBNB pair fits a seed of ~0.0028 only), re-aligned to the Atlas price right before `openPool`; call `openPool` within 14 days (after that anyone may `releaseSeed`). A thin WBNB/mUSDC pair no longer reverts cover (it halves), but a deep, aligned pair is needed for a cover that closes the whole deficit.
- ScenarioPool tranche: kept for the cover demo (its price is team-set, so a cover there benefits that pool's xNVDA holders). Bounded at 20%/day and 10% of all revenue ever, paid only from that call's own swap, and disclosed in `description()`. For a launch that should have no team-priced tranche, deploy a pair with `FLAP_NO_SCENARIO=true make deploy-flap`.
- `test/fork/FlapLaunchFork.t.sol` (live Portal v1.2.0 on 97, admin `0x3bfC…4a05` via ProxyAdmin owner): 7/7 pass incl. the immutable config (no setter, constructor validation, a second pair) and a full `cover` (thin pair halving, deep pair to CR 1.0, ScenarioPool caps). Run: `forge test --match-path test/fork/FlapLaunchFork.t.sol --out out-flap --cache-path cache-flap -vvv`.
- ABI changes for gen-abi consumers (earlier round; the SplitStockConfig part is superseded, see the end of this file): `SplitStockConfig` constructor `(admin, guardian, updateDelay)` + `applyPoolConfig`, `cancelPoolConfig`, `pending`, `pendingEta`, `guardian`, `updateDelay`, `ConfigQueued`/`ConfigCancelled`; `SplitLauncher.initialize` signature, `poolConfig()`, `poolSymbol()`, `escrowOwed`, `withdrawEscrow`, `ExcessReturned`/`EscrowDeferred`/`EscrowWithdrawn`, `TargetExceeded` removed; `SplitLauncherFactory.config()`/`configured()`, `BadSalt`/`QuotePairDisabled` removed; `BackstopVault.spentScenarioTotal`, `SCENARIO_LIFETIME_CAP_BPS`, `MAX_DEPTH_HALVINGS`. The app copy "the contract reverts TargetExceeded" (`app/src/app/launch/page.tsx`) is now wrong: excess is returned instead.

## openfour

**What it is.** The "SplitStock Pool Launch" OpenFour preset (Route: OpenFour Hub, new launch mechanism) in `openfour/startup` (Hardhat, solc 0.8.24, optimizer 200, viaIR; compile settings unchanged). Derived from the openfour-docs FairLaunch starter (demo-only, unaudited). A fair launch raised in mock tTSLA graduates by opening a NEW SplitStock TSLA pool inside `executeMigration`: `PoolFactory.createPool(tTSLA, TSLA feed, keccak256("TSLA"), "TSLA", router, LIVE)` -> `seed(seedBps of the raise, BackstopTreasury)` (protocol-owned first-loss xTSLA) -> `mintStable(rest)` (capped by `maxMintStable()`, any excess stock to the treasury) -> meme/sUSD PCS v2 `pair.mint(0xdead)`. On any failure: meme/tTSLA fallback pair (pre-created and registered in init) + `FloorFallback`. Wording: "dollar-quoted graduation liquidity", not "price floor".

**Files** (`openfour/startup/`)
- `contracts/external/ISplitStock.sol`: ABI-exact subset of `contracts/src/interfaces` (IPoolFactory.createPool/isCreator/isAdmin/defaultParams/riskOracle/poolInfo, ILeveragePool seed/mintStable/maxMintStable/state/setDonor/..., IRiskOracle.riskView, IAggregatorV3, IHaltableFeed). Struct/enum order copied verbatim.
- `contracts/external/ISplitPoolLaunch.sol`: shared structs `SplitPoolGraduation`, `SplitPoolPreview`, branch ids, migrate<->data view interfaces, minimal PCS v2 pair/factory.
- `contracts/modules/migrate/SplitPoolMigrateModule.sol` (tag `module.migrate.splitstock_pool`, 23.9 KB runtime, under the 24 KB limit with ~650 B spare).
- `contracts/modules/data/SplitPoolCustomDataModule.sol` (tag `module.data.splitstock_pool`): FairLaunch trader stats (`totalPurchased`/`totalSold`/`traderStats`, read by FairLaunchTradeModule), `conditionsMetAt` grace anchor (set in afterHook the first time sold-out/soft-cap/expiry holds, reset if it stops holding), `floorSnapshot()` written in onMigrate (branch, pair, pool, sUSD, price, sUSD minted, xToTreasury, CR, leverage).
- `contracts/validators/SplitPoolPresetValidator.sol`: every FairLaunch check plus quote == tTSLA, migrate params pinned to PoolFactory / {live mirror, optional ScenarioFeed} / router / BackstopTreasury / "TSLA", seedBps [3000,7000], minSusdOutBps [8000,10000], graceWindow [60, 7d], minMigrateGas [4M, 20M], duration >= minDuration (60), trade fee <= 100 bps and fee recipient must be the treasury, maxRaise, saleAmount < maxSupply, soft feed read (answer > 0).
- `presets/splitstock-pool.json`: token/vault/curve/trade `reuse: true` (FairLaunch curve/trade come from the baseline registration), migrate + customData ours. Address fields are `FROM_DEPLOYMENTS:<path>` placeholders filled by the scripts. Demo meme "Gigawatt Goblin / GGOB", sale 800k at 0.000005 tTSLA = 4 tTSLA raise, 50 bps buy/sell fee to the treasury, duration 1800 s, grace 1800 s.
- `scripts/lib/splitstock.js`, `scripts/register-splitstock.js`, `scripts/lifecycle-splitstock.js`; `package.json` scripts `register:splitstock`, `lifecycle:splitstock`.

**Migrate module behaviour**
- `init(token, fourCore, feeRouter, params, version)`: initializer (constructor `_disableInitializers()`, no constructor args); requires non-zero token/core, decodes one tuple, validates ranges / non-zero / code, stores feeRouter, raw params, version, `endTime = now + duration`; on chain 97/56 pre-creates the meme/tTSLA PCS v2 pair and calls `token.setMigratedPools([pair], true)` (blocks transfers into it until MigratePending). `fallbackPairGuarded` reports whether that registration succeeded. Local Hardhat (31337): no pairs, `executeMigration` returns `(0, "")` like FairLaunch.
- `evaluate(ctx)`: view, no caller restriction, never reverts (code checks + try/catch + staticcall). canMigrate = conditions met (sold out || soft cap || expired) AND (healthy OR forced). healthy = module has CREATOR_ROLE (or admin) on PoolFactory, feed usable/fresh (factory `defaultParams().maxPriceAge`, 120 s) and not halted, RiskOracle readable, mints not paused, CMC ref present/fresh (`maxRefAge`) and Atlas-vs-CMC deviation <= `maxDevBps` (mirrors LeveragePool's breaker). forced = now >= min(customData.conditionsMetAt, endTime once expired) + graceWindow. Reasons: `"Deferred: <why>"`, `"Grace elapsed, fallback: <why>"`, `"Launch conditions not met"`. Hint data = `abi.encode(quoteToUse)`.
- `previewGraduation(token) view returns (SplitPoolPreview)`: same logic from live vault state; for app/keeper/agent ("Graduate now" button = `Core.migrate(token)` when `canMigrate`).
- `executeMigration(ctx, hookData)`: onlyFourCore, bound token, `ctx.vault == token.vault()`, `ctx.quoteAsset == stockAsset`, once; re-checks conditions and health/forced; q = min(hint, totalRaised, maxQuoteToUse, vault balance); pulls q with balance-delta check; `require(gasleft() >= minMigrateGas)`; pool path runs as `try this.runPoolLaunch(...)` (self-call, all-or-nothing). Catch: if gasleft < 400k or (empty revert data and gasleft <= g/63) the whole migration reverts (an OOG never becomes a fallback); otherwise fallback with the revert data as reason. Approvals reset; module ends with zero stock/sUSD. Pool branch unregisters the unused fallback pair and registers the meme/sUSD pair.
- Return data: `migratedDataVersion 1 = abi.encode(address pair, address sUSD, address pool)`, `2 = abi.encode(address pair, address tTSLA)`, `0 = ""` (no DEX on chain).
- Events: `PoolGraduated(address indexed token, address indexed pool, address indexed pair, address sUSD, address xToken, uint256 seedAmount, uint256 mintAmount, uint256 sUSDMinted, uint256 xToTreasury, uint256 leftoverToTreasury, uint256 liquidity, uint256 price)`, `FloorFallback(address indexed token, address indexed pair, uint256 quoteUsed, uint256 tokenUsed, uint256 liquidity, bytes reason)`, `FallbackPairRegistered(address indexed token, address indexed pair, bool guarded)`. CustomData: `ConditionsMet(token, at)`, `ConditionsReset(token, at)`, `FloorSnapshotRecorded(token, branch, pair, pool, price, sUSDMinted, cr)`.
- Other views: `lastGraduation()`, `conditionsMet(totalRaised, soldOut, ts)`, `fallbackPair()`, `fallbackPairGuarded()`, `pcsFactory()`, `assetId()`, `migrated()`, `getInitParams()`, `descriptor()`, `moduleEncodeSchema()` (14 fields; packed internally to fit the size limit; returns a normal `ModuleEncodeSchema`).
- Migrate params tuple (ABI order = schema order): `(uint256 softCap, uint256 duration, uint256 tokenLiquidityAmount, uint256 maxQuoteToUse, address stockAsset, address poolFactory, address feed, address poolRouter, address backstopTreasury, string stockSymbol, uint16 seedBps, uint16 minSusdOutBps, uint256 graceWindow, uint256 minMigrateGas)`. Defaults 0/1800/0/0/-/-/-/-/-/"TSLA"/5000/9000/1800/8000000. Curve/trade tuples are FairLaunch's. customDataParams must be empty.

**Build**
```
cd openfour/startup && npm install && npx hardhat compile    # passes, 43 files, no warnings
```
(No tests written or run this phase. A one-off local `moduleEncodeSchema()` read on the Hardhat network confirmed the 14 fields and an encode/decode round trip.)

**Run (BSC testnet 97, our fork only)**
```
# 0. core contracts + BackstopTreasury first (make deploy-core; DeployBackstopTreasury -> openfour.backstopTreasury)
# 1. our own OpenFour proxy set (writes openfour/fork-deploy/out/fork-deployment.json)
cd openfour/fork-deploy && npm install && npm run fork:dry && npm run fork      # Core.signer = deployer (leave SIGNER_ADDRESS empty)
# 2. FairLaunch baseline + SplitStock preset (author = BackstopTreasury), writes deployments/97.json openfour{}
cd ../startup && npx hardhat run scripts/register-splitstock.js --network bsctestnet
# 3. create (tTSLA quote, partner = treasury) -> grant CREATOR_ROLE to the migrate clone -> buy -> sell -> sell-out (auto-migrate)
npx hardhat run scripts/lifecycle-splitstock.js --network bsctestnet
#    fallback demo: GRANT_CREATOR=0 WAIT_FORCE=1 (defers, then forces meme/tTSLA after the grace window)
#    breaker/stale demo: FEED=scenario (pins the ScenarioFeed; validator allows it)
PRESET=splitstock-pool npx hardhat run scripts/pack-submit.js                   # submit pack
```
Both scripts refuse chainId 56/4663 and the shared OpenFour testnet set (registry `0xE501…7060`, core `0xd6DA…85Db`, feeRouter, tools), require `Registry.owner() == signer` and `Core.signer() == signer`, and cross-check deployments `openfour.registry` against the fork json. `out/` (gitignored) gets `fairlaunch-registration.json`, `splitstock-pool-registration.json`, `splitstock-pool-lifecycle-<token>.json`; copy the evidence to `docs/openfour/`. Before running the startup scripts again after `Core.setSigner(uiSigner)`, switch the signer back.

**Env vars** (openfour/.env or openfour/startup/.env; hardhat.config.js does not load the repo-root .env): `DEPLOYER_PRIVATE_KEY` (fork owner + Core.signer; never on the web server), `BSC_TESTNET_RPC_URL`/`RPC_URL` (public RPC only, the config rejects keyed URLs), `FORK_JSON`, `DEPLOYMENTS_JSON`, `PRESET_ID`, `BASELINE_PRESET_ID`, `SKIP_BASELINE`, `GAS_PRICE_WEI` (default 0.05 gwei), `GAS_LIMIT` (15M), overrides `BACKSTOP_TREASURY`, `STOCK_TOKEN`, `POOL_FACTORY`, `STOCK_FEED`, `SCENARIO_FEED`, `POOL_ROUTER`; lifecycle `TOKEN_NAME`, `TOKEN_SYMBOL`, `DURATION`, `FEED=scenario`, `GRANT_CREATOR=0`, `PARTNER=0`, `TRADE_FEE_BPS`, `SELL_OUT=0`, `WAIT_FORCE=1`, `POOL_ID`, `CREATE_FEE`, `FEE_SOURCE_PRESET_ID`, `BONDING_PRESET_ID`.

**Reads from deployments/97.json**: `tokens.tTSLA`, `core.poolFactory`, `oracles.TSLA.mirror`, `oracles.TSLA.scenarioFeed` (optional), `dex.router`, `openfour.backstopTreasury`, `openfour.registry/core/tools/feeRouter` (falls back to fork-deployment.json).
**Writes** (read-modify-write, other keys kept): `openfour.{registry, core, tools, feeRouter, presetId, migrateModule (impl), customDataModule (impl), validator, backstopTreasury, baselinePresetId, migrateModuleKey, customDataModuleKey, migrateTag, customDataTag, presetTx, stock, tokens[]}`; `openfour.tokens[] = {token, poolId, name, symbol, presetId, vault, migrateModule (clone), customData, branch: "pool"|"fallback"|null, pair, phase, createTx, migrateTx}`; on the pool branch a `pools[]` row `{id: "tsla-four" (or tsla-four-2…), symbol: "TSLA", assetId, kind: "four", pool, sUSD, xToken, stabilityPool, feed, openedBy: <migrate clone>, openTx}`.

**Other components must match**
- PoolFactory: `CREATOR_ROLE` is checked against the per-token migrate CLONE (msg.sender of createPool), not the impl. `lifecycle-splitstock.js` grants it right after createToken while the deployer is still PoolFactory admin. After `make handoff` this needs a Timelock op per token; until granted, evaluate() defers and the grace window forces the fallback. Run OpenFour graduations before handoff.
- The pool's creator is the migrate clone; it calls `pool.setDonor(BackstopTreasury, true)` best-effort. BackstopTreasury holds the seed xTSLA, so `_eligible(pool)` passes without `registerPool`. Preset author = BackstopTreasury is set directly in `upsertPreset` (the deployer owns the fork Registry), so `BackstopTreasury.callRegistry` is not needed. Token partner = BackstopTreasury at create (script retries without a partner if Core rejects it). `sweep()` collects dev/partner fees in tTSLA.
- Keeper: the TSLA mirror must be pushed within 120 s and RiskOracle must hold a fresh TSLA CMC snapshot (<= maxRefAge, deviation <= maxDevBps), otherwise graduation defers. The keeper can poke `Core.migrate(token)` when `previewGraduation(token).canMigrate` (including after forceAt).
- App/flap-ui: read `openfour.tokens[]` and `pools[]` (`kind: "four"`); show `previewGraduation(token)` (reason, forceAt, healthy, hasCreatorRole); decode `MigrateExecuted.encodedMigratedData` by version (1 = (pair, sUSD, pool), 2 = (pair, tTSLA)); do not assume pair token0/token1 order. Mock-asset labels everywhere; no Tesla/NVIDIA branding on memes.
- Gas: the sell-out buy runs createPool (4 clones + inits), seed, mintStable, createPair, mint: send >= 12M gas (scripts use 15M). createToken also creates the fallback pair (~3M extra).

**Core change requests** (RESOLVED by the integrator: `CreatorRegistrar.registerOpenFourToken(core, token)` reads the module from `Core.tokens(token)` instead of checking EIP-1167 code, since the closed Core's clone type is unverified; see `## integrator`)
- PoolFactory: per-clone CREATOR_ROLE grants do not scale past the demo and break after the Timelock handoff. Option: a `REGISTRAR_ROLE` that is the role admin of `CREATOR_ROLE` (`_setRoleAdmin`), held by a small OpenFour registrar that grants CREATOR_ROLE to `msg.sender` only if its runtime code is the EIP-1167 clone of the registered `SplitPoolMigrateModule` impl and its `fourCore()` is our Core.

**TODOs**
- Hardhat tests (MockFourCore + CloneFactory + mock PoolFactory/pool/PCS): happy path, mintStable revert -> fallback, OOG -> full revert, griefed pair, init once / zero address / bad ranges, evaluate never reverts when the pool/feed/oracle revert, deferred at T and T+grace-1, forced at T+grace, schema round trip, module zero balance.
- Unverified: whether a revert in executeMigration also reverts the sell-out buy in the closed Core (assumed yes; hence the non-reverting fallback and the standalone `Core.migrate`); whether Core caps the FairLaunch fee tier (`TRADE_FEE_BPS=0` if trades revert); whether Core inits the token before the migrate module (if not, `fallbackPairGuarded=false` and the fallback pair can be griefed).
- LP price after the pool branch is about 2x the sale price (half the raise is seed), vs 4x for the fallback/FairLaunch default. Tune `seedBps`/`tokenLiquidityAmount` if needed.
- AUDIT.md, verify-splitpool failure-path script, PRESET.md and `docs/openfour/` evidence copies are not written yet.

## services

**What it is.** `services/` (TypeScript, Node 20+, ESM, viem 2, Fastify 5, `postgres`, zod 4, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`): the deterministic keeper jobs, the AI Risk Steward, the indexer and the API. One Docker image; the compose command picks the role.

**Layout.**
- `src/config/env.ts` (every env var, zod-validated, role-key resolution), `src/config/deployments.ts` (the only address book loader, tolerant of `"0x…"` placeholders, re-reads on file change), `src/config/assets.ts` (CMC ids: NVDA = NVDAB CMC id 40215, rwa_id 2; TSLA = TSLAB id 40214; token address from 56.json `mainnet.<sym>b`, then `external.<SYM>B`, then the verified NVDAB default).
- `src/lib/`: `cmc.ts` (keyed REST, `X-CMC_PRO_API_KEY` header only, `/public-api` refused, raw bytes → `bodyHash = keccak256(raw)`, `error_code` "0"/0 normalised, ms timestamps, tolerant parsers), `governor.ts` (≈415 credits/day, monthly-remaining aware, ×2 above 90 % of pace, essential-only when exhausted), `hashlog.ts` (hash-chained log + raw body store), `merkle.ts`, `canonical.ts`, `chains.ts` (viem clients, fallback RPC lists, one signer per role), `tx.ts` (simulate → send → receipt → log), `pools.ts`, `scheduler.ts`, `verify.ts`, `alerts.ts` (Telegram), `math.ts`.
- `src/jobs/`: `atlasMirror` (15 s), `cmcCollector` (30 s tick; per-endpoint cadences from the plan, persisted in kv), `riskEngine` (5 min, RiskOracle 97), `rebalancer` (30 s rebalance + arb toward the mirror; `accrue` job hourly per pool), `backstopOps` (10 min: Flap `dispatch()`, `SplitLauncher.openPool()` once launched, `BackstopVault.sync()` + hourly `valueBuffer()`, `BackstopTreasury.sweep()`, `canCover` → `cover(pool)` when CR < 1), `openfourPoker` (1 min: `previewGraduation(token).canMigrate` → simulate + `Core.migrate(token)`), `indexer` (10 s, both chains → `events`), `logAnchor` (hourly, LogAnchor 97), `anchorMainnet` (15 min RiskOracle56.post + `AtlasCmcAnchor.anchor(refPriceE18, cmcTs, responseHash)`; daily LogAnchor56), `health` (gas balances).
- `src/agent/`: `mcp.ts` (streamable HTTP to `https://mcp.coinmarketcap.com/mcp`, header `X-CMC-MCP-API-KEY`; tools `us_equity_upcoming_event_calendar`, `get_upcoming_macro_events`, `get_crypto_technical_analysis`, `get_crypto_latest_news`, `get_global_metrics_latest`; args fitted to each tool's advertised schema; every result hashed, stored and logged; per-tool TTL cache), `gather.ts`, `prompt.ts` (static system prompt; MCP text inside `<untrusted_data>`), `decide.ts` (one call, no tools: `claude-opus-5-5`, adaptive thinking, `effort: high`, `output_config.format` from the zod schema, `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`, refusal / max_tokens handled), `validate.ts` (off-chain mirror of RiskOracle.propose: clamp → step cap → re-clamp → gaps, horizon in [300, agentMaxTtl], tighten/loosen/hold), `steward.ts` (run once / loop: hourly plus calendar edges), `erc8004.ts` (registration JSON, `register`, `setAgentWallet`, evaluator feedback).
- `src/api/server.ts` + `state.ts`, `src/backtest/backtest.ts`, `src/cli.ts`, `db/schema.sql`, `scripts/gen-abi.mjs` (`npm run abi`), `scripts/check-public-api.mjs` (`npm run check:public-api`), `Dockerfile`, `deploy/Caddyfile`. Root: `docker-compose.yml` (keeper, agent, api, postgres, caddy), `.github/workflows/keeper-backup.yml` (every 10 min: `keeper once --jobs mirror,rebalance,accrue --no-db` with the backup keys).

**Build / run.**
```
cd services && npm install && npx tsc --noEmit      # passes
npm run build                                        # tsc -> dist/
npm run abi                                          # regenerate src/abi from contracts/out(-flap) + openfour artifacts
npx tsx src/cli.ts db migrate
npx tsx src/cli.ts keeper run [--jobs mirror,cmc,risk,rebalance,accrue,backstop,openfour,indexer,anchor,mainnet,health] [--dry-run]
npx tsx src/cli.ts keeper once --jobs mirror,rebalance,accrue [--no-db] [--force] [--dry-run]
npx tsx src/cli.ts agent once [--asset NVDA] [--dry-run]      # agent run = loop
npx tsx src/cli.ts agent register --chain 97|56               # ERC-8004; then write erc8004.agentId into deployments/<chain>.json
npx tsx src/cli.ts api                                         # :8080
npx tsx src/cli.ts verify-snapshot <tx> [--chain 97] [--api https://…]
npx tsx src/cli.ts backtest [--days 30] [--json]
npx tsx src/cli.ts log verify
docker compose up -d --build                                   # from the repo root
```
No tests were written or run in this phase (user directive). Nothing was deployed or sent on-chain.

**Env vars** (all in `/.env.example`, server-side only, never `NEXT_PUBLIC_`): RPCs `BSC_TESTNET_RPC`, `BSC_MAINNET_RPC` (comma lists = fallback), `BSC_TESTNET_LOGS_RPC`, `BSC_MAINNET_LOGS_RPC` (keyed, needed for eth_getLogs); role keys `MIRROR_PRIVATE_KEY`, `RISK97_PRIVATE_KEY`, `RISK56_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, `AGENT56_PRIVATE_KEY`, `OPS_PRIVATE_KEY`, `ANCHOR_PRIVATE_KEY`, `ANCHOR56_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, `MAINNET_PRIVATE_KEY` (56 fallback for RISK56/ANCHOR56), `KEEPER_PRIVATE_KEY` + `KEY_FALLBACK=keeper` (dev only); `CMC_API_KEY`, `CMC_MCP_API_KEY`, `CMC_DAILY_CREDIT_BUDGET`, `CMC_MCP_CREDITS_PER_CALL`, `CMC_ASSETS`; `ANTHROPIC_API_KEY` (or `LLM_API_KEY`), `AGENT_MODEL`, `AGENT_EFFORT`, `AGENT_INTERVAL_SEC`, `AGENT_DRY_RUN`, `AGENT_ID`, `AGENT_MCP_TOOLS`; `KEEPER_TOKEN`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, `SERVE_RAW_BODIES`, `API_PORT`, `API_DOMAIN`; `DATABASE_URL`, `DB_DISABLED`, `POSTGRES_PASSWORD`; `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `LOW_BALANCE_WEI`; tuning `REBALANCE_FACTORY_POOLS`, `ARB_ENABLED`, `ARB_THRESHOLD_BPS`, `MAINNET_ENABLED`, `INDEXER_START_BLOCK_97/56`, `INDEXER_MAX_RANGE`. CI secrets: `MIRROR_BACKUP_PRIVATE_KEY`, `OPS_BACKUP_PRIVATE_KEY`, `BSC_TESTNET_RPC`, `BSC_MAINNET_RPC`, `BSC_MAINNET_LOGS_RPC`.

**Reads from deployments.** 97: `core.{riskOracle, poolFactory, marketCalendar, logAnchor, sandboxFactory}`, `oracles.<SYM>.{mirror, atlasSource.feed}`, `pools[]` (+ every `PoolFactory.poolAt` pool), `dex.{router, pairs.t<SYM>_mUSDC}`, `flap.launchers[].{launcher, token, vault, taxProcessor?, poolId}`, `openfour.{core, migrateModule, backstopTreasury, tokens[].{token, migrateModule, poolId}}`, `erc8004.{identity, reputation, agentId}`. 56: `core.{riskOracle, logAnchor}`, `mainnet.{atlasCmcAnchor, nvdab}`, `erc8004.*`. Writes nothing to deployments.

**What other components must match.**
- *Hashes (the app's /risk Verify panel and /proof verifier must use the same rules):* `bodyHash = keccak256(raw CMC response bytes)`. RiskOracle `Snapshot.responseHash = keccak256(bodyHash_1 ‖ bodyHash_2 ‖ …)` in the order of `data.components` of log entry `#snapshotId` (kinds: dex_price, quotes, rwa, kline, pools). `snapshotId` = that log entry's `seq`. Log `entryHash = keccak256(prevHash ‖ utf8(canonicalJSON(entry)))`, genesis prevHash = 32 zero bytes, canonical JSON = sorted keys, no whitespace, bigint as decimal string, null/undefined fields omitted; `entry = {seq, ts, service, kind, endpoint?, params?, http?, cmcTs?, creditCount?, elapsedMs?, bodyHash?, txHash?, chainId?, data?}`. Merkle: `parent = keccak256(left ‖ right)`, ordered leaves = entryHash in seq order, an odd last node is promoted unchanged. LogAnchor ranges start at `nextSeq()`.
- *Agent hashes on-chain:* `inputsHash = keccak256(utf8(canonicalJSON({model, effort, system, user})))`, `outputHash = keccak256(utf8(model output text))`, `modelIdHash = keccak256(utf8(served model id))`, `rationaleURI = <PUBLIC_BASE_URL>/agent/raw/<outputHash>`. `GET /agent/raw/<inputsHash|outputHash>` returns exactly the hashed bytes.
- *API routes* (the app proxies them under `/api/*`; reads public + rate-limited, writes need `Authorization: Bearer <KEEPER_TOKEN>`): `GET /healthz`, `/state` (pools with `state()`+`previewRebalance()`, risk per asset, mirror, calendar, CMC latest; 10 s cache), `/risk/latest`, `/risk/snapshots?asset&chain&limit`, `/risk/snapshot/:snapshotId`, `/risk/raw/:hash` (raw CMC body, header `x-body-hash`), `/risk/verify/:tx?chain=`, `/agent/proposals?asset&limit` (`{runs, events}`), `/agent/runs/:id`, `/agent/raw/:hash`, `/agent/registration.json?chain=` (the ERC-8004 agentURI), `POST /agent/run {asset?, dryRun?}`, `/events/:kind?chain&name&contract&before&limit` with kind ∈ all|mirror|risk|agent|pool|zone|launch|openfour|anchor|backstop|factory|stability|cmcAnchor|sandbox|other, `/logs/entries?from&to&limit`, `/logs/entry/:seq`, `/logs/raw/:hash`, `/logs/anchors`, `/logs/proof/:seq`, `/logs/export.jsonl`, `/cmc/usage` (`{governor, today[], keyInfo[]}`), `/backtest?days=30`, `POST /keeper/run {jobs[], dryRun?, force?}`. bigint fields are JSON strings.
- *Deploy scripts must grant:* AtlasMirror PUSHER → `MIRROR_PRIVATE_KEY` and `MIRROR_BACKUP_PRIVATE_KEY` addresses; RiskOracle(97) POSTER → RISK97, PROPOSER → AGENT; LogAnchor(97) ANCHOR_ROLE → ANCHOR; on 56: RiskOracle56 POSTER + AtlasCmcAnchor KEEPER_ROLE → RISK56 (or MAINNET), LogAnchor56 ANCHOR_ROLE → ANCHOR56. K_OPS needs no role (rebalance, accrue, dispatch, sweep, cover, openPool, migrate are permissionless) but needs tBNB plus some tNVDA/tTSLA/mUSDC inventory for the arb step.
- *OpenFour / Flap:* the poker calls `Core.migrate(address)` on `openfour.core` only after an eth_call simulation passes ([UNVERIFIED] name: not in the public IOpenFourCore interface). `openfour.tokens[].migrateModule` must be the per-token clone. Backstop ops expects `flap.launchers[].vault` and reads the tax processor from `taxProcessor` in deployments or `token.taxProcessor()`.
- *ABIs:* `src/abi/*.ts` are generated; core from `forge inspect`, Flap/backstop/mainnet from `contracts/out` or `out-flap`, OpenFour from `openfour/startup/artifacts`. Re-run `npm run abi` after any contract change; external ABIs (Atlas SingleFeed, PCS v2, ERC-20, Flap TaxProcessor, OpenFour Core, ERC-8004) are hand-written in `src/abi/External.ts`.

**TODOs / unverified.**
- Atlas SingleFeed update topic0 (`0x2bc717c4…5019`, observed via eth_getLogs) is used to pair each push with its mainnet tx; without `BSC_MAINNET_LOGS_RPC` pushes carry `srcBlock = 0`, `srcTxHash = 0x0`.
- CMC response shapes for `/v5/real-world-assets/quotes/latest`, `/v1/dex/token/pools`, `/v3/.../quotes/historical` and the k-line credit cost are parsed defensively; confirm with one keyed call each and adjust `src/lib/cmc.ts` parsers. Research saw `l = 0` on the DEX price call, so liquidity falls back to the pools endpoint. MCP credit cost per call is an estimate (`CMC_MCP_CREDITS_PER_CALL`); reconcile with `/v1/key/info` (logged hourly with our own Σ credit_count). Capture key/info before the 2026-12-01 reset.
- TSLA: TSLAB token address and rwa_id are unknown, so TSLA snapshots use only `/v3/cryptocurrency/quotes/latest?id=40214` (σ = 0, i.e. keep the previous rule leverage). Set `mainnet.tslab` in 56.json or `CMC_ASSETS` to enable the DEX price and k-line for TSLA. The OpenFour graduation needs a fresh TSLA snapshot and mirror (see the openfour notes).
- ERC-8004 `setAgentWallet` typed-data struct and `giveFeedback` signature are [UNVERIFIED]; check against the live registries before use.
- The indexer starts new contracts at the current cursor, so a contract added to deployments later is indexed from then on (set `INDEXER_START_BLOCK_97` and clear `indexer_cursors` to backfill).
- Nightly `pg_dump` runs from the host crontab (command in docker-compose.yml); not a compose service.
- Tests (unit tests for parsers, validator vs RiskOracle, Merkle/log chain vectors shared with the app) are for the next phase.

**Core change requests.** None.

## app

**What it is.** `app/`: Next.js 15.5 App Router, TypeScript (strict), Tailwind 3, wagmi 2.19 + viem 2.56, RainbowKit 2.2, TanStack Query 5. Writes go to BSC testnet (97); mainnet (56) is used read-only. The design uses IBM Plex Sans/Mono (from a Google Fonts `<link>`, so the build needs no network), light and dark themes (a `class` toggle that remembers the choice in localStorage), blue for stable (sUSD) and amber for leveraged (xSTOCK). It is responsive, and on phones the pool table becomes cards.

**Routes.** `/` (pitch, live V/S/xNAV/L/CR, the "four doors" diagram, Judge quick-verify with 5 BscScan links, tBNB drip), `/pools`, `/pools/[id]`, `/scenario`, `/risk`, `/agent`, `/backstop`, `/launch`, `/memes`, `/memes/new`, `/memes/[token]`, `/backtest`, `/proof`, `/status`.
- **Pools.** The real pools are `deployments.pools[]` entries with kind `flap` or `four`. Each one's state is read on-chain every 10 s with `useReadContracts`, which multicalls `state()`, `params()`, decimals, `StabilityPool.totalDeposits`, `BackstopVault/Treasury.bufferUsd` and `MarketCalendar.nextOpen/nextClose`. The detail view adds the user's balances and allowances, faucet cooldown, `AtlasMirror.latestRound` and the user's SP deposit and gains. Until a real pool exists, its row shows "awaiting launch" and links to /launch or /memes.
- **Demo pools.** Ten pools are listed in `src/config/demoPools.ts`: AAPL, MSFT, GOOGL, AMZN, META, AVGO, NFLX, COIN, MSTR, AMD. Their prices come from `/api/demo-prices`. Their state comes from `src/lib/demo.ts`, which is deterministic per pool id and drifts gently with slow sines and a push cadence of about 60 s. Demo pools use the same `PoolSnapshot` model and the same components as real pools, so the list and detail views look identical. The only differences are the "Opened by: Simulated" chip and the trade panel: for a demo pool it runs `src/lib/sim.ts` locally, keeping the viewer's balances and pool deltas in localStorage, and its toasts say "simulation".
- **Trade panel.** Tabs for mintStable, mintLever, redeemStable, redeemLever and redeemPair. Fee quotes come from `previewMint*` / `previewRedeem*` with a 0.5% minOut guard. The panel offers approve or an EIP-2612 permit (`mint*WithPermit`, domain `{name(), "1", 97, asset}`) and the faucet. It also shows a price chip (push age, plus pull from /api/atlas/pull with the deviation, and HALTED), a market pill, leverage and CR gauges, and the sUSD/x split bar.
- **Writes.** `src/hooks/useTx.ts` runs simulateContract → writeContract → waitForTransactionReceipt, decodes the receipt with every ABI, and shows a toast with the decoded events and a BscScan link. Reverts appear as the custom error name and its arguments. It switches the wallet to chain 97 first.
- **/scenario.** Three modes:
  - "My sandbox": `SandboxFactory.sandboxOf/create`.
  - "Shared ScenarioPool": the `pools[kind=scenario]` entry, using its feed.
  - "Offline simulation".
  Buttons: −22% (`ScenarioFeed.shock(-2200)`, then "Check a 1 tNVDA mint", which shows BreakerTripped through `previewMintStable`), +35%, −55% (the offline mode shows each waterfall step: zones → SP → vault cover → pro rata), "Run rebalance()", "Reset", and "Skip to pre-open". Block time cannot be moved on-chain, so "Skip to pre-open" projects the gap guard from `state()` locally. The SCENARIO banner is always shown.
- **/memes.** These pages use the OpenFour `frontend-style` pack, copied to `src/styles/openfour/` and scoped to `.of-page`. The token list merges `deployments.openfour.tokens[]`, the services records and the sign-route memory, and checks each with `Core.tokens()`; nothing scans logs. The create form is built from `Tools.getPresetEncodeSchemas(presetId)` and `getTokenBaseSchema()`, and its address fields that the validator pins are prefilled from deployments (stockAsset, poolFactory, feed, poolRouter, backstopTreasury, feeRecipient, stockSymbol). Buy and sell are priced with `Tools.estimateBuy/estimateSell` (run with simulateContract) and sent with `Core.buy/sell`, after approving the Core. The graduation panel shows `previewGraduation(token)` with each check, forceAt and reason, and a "Graduate now" button that calls `Core.migrate(token)`. After migration it shows `lastGraduation()` (pool, pair, seed and sUSD) and the comparison with stock4TaxV1.

**Server routes** (secrets never leave the server):
- `/api/state`, `/api/health` (→ services `/healthz`), `/api/risk/*`, `/api/agent/*`, `/api/events/[kind]` (kind ∈ services EVENT_KINDS or `all`), `/api/logs/*`, `/api/cmc/usage`, `/api/backtest`. Each is a GET proxy to `SERVICES_API_URL` with `Authorization: Bearer KEEPER_TOKEN`, a Next `revalidate` of 10–600 s and an in-memory per-IP rate limit. When the services are unreachable they return 503 `{offline:true}`, and the UI shows an "offline" notice.
- `/api/demo-prices`: CMC `/v5/real-world-assets/quotes/latest?symbol=AAPL,…,NVDA,TSLA`. The key goes in the `X-CMC_PRO_API_KEY` header only. Results are cached for `DEMO_PRICES_TTL_SEC` (600) in memory and in the Next data cache, the parser is tolerant, and it falls back to static prices labelled `fallback`. At the default TTL this costs at most about 144 calls a day; raise the TTL if the CMC budget is tight.
- `/api/atlas/pull?feed=nvdab|tslab`: POSTs `https://api.atlasoracle.io/report/v1/price/latest` with `X-API-KEY` (the same request as the SDK's HttpTransport) and returns `{payloadHex (= payload‖signature‖magicMarker), price, ts, feedId, packages}`. Rate limited to 20 per minute per IP.
- `/api/openfour/sign-create` (POST `{caller, createArgs, requestSignature}`). It runs these checks before signing:
  1. The EIP-191 `requestMessage(97, caller, requestId, createArgs)` was signed by `caller`.
  2. `presetId == deployments.openfour.presetId`.
  3. `initParams.quoteAsset == openfour.quoteAsset ?? tokens.tTSLA`.
  4. `now < validTimestamp ≤ now + 1h`.
  5. The requestId is fresh and nonzero.
  6. Name, symbol and URI pass the brand blocklist (NVIDIA, NVDA, TESLA, …; leetspeak is normalised).
  7. There is no anti-sniper and no presale, and the partner is either the BackstopTreasury or zero.
  8. The wallet has made fewer than 3 creates today, and the IP fewer than 10 requests an hour.
  
  If all pass, it signs `keccak256(encodePacked("createOpenFourToken", 97, caller, keccak256(createArgs)))` with `OF_UI_SIGNER_PRIVATE_KEY` (`signMessage raw`, exactly as in `openfour/startup/scripts/lib/demo.js`). `/api/openfour/tokens`: GET lists the tokens; POST `{txHash}` records a token from the TokenCreated event in the receipt of our fork Core.
- `/api/drip`: sends 0.005 tBNB from `DRIP_PRIVATE_KEY`, once per wallet per day. A GET returns an HMAC-signed arithmetic challenge that expires after 5 minutes. A wallet that already holds 4× the drip is refused.

**ABIs.** `npm run abi` (`scripts/gen-abi.mjs`) regenerates `src/abi/**` from `forge inspect <Name> abi --json` in `contracts/`, falls back to `contracts/out` or `contracts/out-flap`, and reads the Hardhat artifacts in `openfour/startup/artifacts` (IOpenFourCore, IOpenFourTools, IOpenFourVault, SplitPoolMigrateModule). The core, Flap, oracle and OpenFour ABIs have all now been generated from real artifacts. Two ABI files are hand-written: `abi/openfour/OpenFourCoreExtra.ts` (`migrate(address)` and `signer()`, which are missing from the public interface) and `abi/flap/FlapTaxProcessor.ts` (`dispatch()`, `token.taxProcessor()`). `npm run abi -- --no-forge` skips compiling.

**Build and run.**
```
cd app && npm install && npm run build     # prebuild = check-env (fails on NEXT_PUBLIC_*KEY) + sync-deployments
npm run dev                                 # http://localhost:3000 (predev also syncs deployments)
npm run typecheck   |   npm run abi
```
Result: `next build` passes. All 15 pages are prerendered, and the 14 API routes are dynamic. Webpack aliases the optional peers `@x402/*` (pulled in by `@coinbase/cdp-sdk` through wagmi's baseAccount connector) to `false`. The only warning left is a harmless "critical dependency" from viem/ox tempo.

**Env vars** (`app/.env.example`; also appended to `/.env.example`):
- Server only:
  - Services: `SERVICES_API_URL`, `KEEPER_TOKEN`.
  - CMC: `CMC_API_KEY`, `CMC_BASE_URL`, `DEMO_PRICES_TTL_SEC`.
  - Atlas: `ATLAS_API_KEY`, `ATLAS_PULL_FEED_ID_NVDA` / `_TSLA` (decimal or bytes4 hex; NVDAB defaults to 40215 [UNVERIFIED]), `ATLAS_PULL_FEED_IDS` (JSON override).
  - OpenFour signer: `OF_UI_SIGNER_PRIVATE_KEY`.
  - Drip: `DRIP_PRIVATE_KEY`, `DRIP_AMOUNT_WEI`, `DRIP_CHALLENGE_SECRET`.
  - RPCs: `BSC_TESTNET_RPC`, `BSC_MAINNET_RPC`.
- Public (never secrets): `NEXT_PUBLIC_WC_PROJECT_ID` (without it only injected wallets are offered), `NEXT_PUBLIC_BSC_TESTNET_RPCS`, `NEXT_PUBLIC_BSC_MAINNET_RPCS`, `NEXT_PUBLIC_FLAP_TOKEN_URL_PREFIX`.

**Reads from deployments.** These are loaded through `scripts/sync-deployments.mjs` → `src/generated/deployments.<id>.json` (gitignored). If a file is missing, an empty example is written so the build still works. The typed loader is `src/config/deployments.ts`.
- From 97:
  - `tokens.{tNVDA,tTSLA,mUSDC}`.
  - `core.{poolFactory,riskOracle,marketCalendar,logAnchor,sandboxFactory}`.
  - `oracles.<SYM>.mirror`.
  - `pools[]` (`id`, `symbol`, `kind`, `pool`, `sUSD`, `xToken`, `stabilityPool`, `feed`, `openedBy`, `assetId`).
  - `dex.router`.
  - `flap.{launcherFactory, launchers[].{launcher, token, vault, poolId, taxProcessor?}}`.
  - `openfour.{core, tools, presetId, backstopTreasury, quoteAsset?, tokens[].{token, poolId}}`.
  - `erc8004.{identity, agentId}`.
- From 56: the address book only (on /proof).

**Contracts other components must keep:**
- **Pool ids.** `nvda-flap`, `tsla-four` and `nvda-scenario` are the route slugs in `/pools/[id]`. The asset token is found as `tokens["t" + symbol]`.
- **SplitLauncher** views and actions are exactly as listed under flap-contracts. The app also reads `xLocked`, `launchedAt`, `name` and `symbol`. The tax processor comes from `flap.launchers[].taxProcessor`, or else from `token.taxProcessor()`.
- **Services API shapes the app parses:**
  - `/healthz`: `{keeperOnline, jobs[{job,lastOkAt,lastErrAt,lastErr}], wallets[{role,chain,balance,low}]}`.
  - `/events/:kind`: `{events[{chain_id, block_time, tx_hash, name, contract}]}`.
  - `/risk/snapshots`: rows with `snapshot_id`, `cmc_ts`, `ref_price` (WAD string), `vol_bps`, `status` and `tx_hash`.
  - `/risk/snapshot/:id`: `logEntry.data.components[{kind, bodyHash}]` and `/risk/raw/:hash` (the raw bytes).
  - `/agent/proposals`: `{runs[{proposal_id, tx_hash, model, served_model, validated{rationale, evidence[], adjustments[]}}]}`.
  - `/agent/raw/:outputHash` returns exactly the bytes that were hashed.
  - `/logs/proof/:seq`: `{entry{…, prevHash, entryHash}, anchor{root, fromSeq, toSeq}, proof[{sibling, left}]}`.
  - `/cmc/usage`: `{today[], keyInfo[]}`.
  - `/backtest?days=30`: `{asset, from, to, candles, series[{ts, price, xNav, naive2x, …}], events[{ts, zone, sizeUsd, levBefore, levAfter}], summary{worstCr, sellZones, buyZones}}`.
- **Hash rules.** `src/lib/verify.ts` mirrors `services/src/lib/{canonical,hashlog,merkle}.ts`: an ordered Merkle tree with the odd node promoted, `entryBody` fields, and `responseHash = keccak(bodyHash‖…)`.
- **Requested of services.** Add `GET /openfour/tokens → {tokens[{token, creator, name, symbol, requestId, txHash}]}` and `POST /openfour/records` (a body with `type: "signed" | "created"`, authenticated with the bearer KEEPER_TOKEN) as the durable store for the sign route. Until they exist, the app keeps its records in memory per server instance.

**TODO (next phase).**
- Tests: none were written, as directed.
- Pull-mode transactions. `useTx.sendRaw` and `/api/atlas/pull` are ready, but they are not wired to a pool function, because the core pool has no pull entry point and AtlasPullAdapter is a separate feed.
- EIP-5792 `useSendCalls` batching for approve and mint (permit is used instead).
- `/api/meta/upload` (IPFS pinning) is not built; tokenUri is entered by hand.
- A real captcha (Turnstile) for the drip.
- Confirm the CMC RWA response shape and the Atlas NVDAB pull feed id with one keyed call.
- ERC-8004 mainnet registration display.
- Set `NEXT_PUBLIC_FLAP_TOKEN_URL_PREFIX` once Flap's testnet token page URL is known.

## integrator

**What changed.** Phase-2 integration of every component into one consistent build. No tests were written or run, and nothing was deployed or broadcast. The frozen Flap files (`src/launch/*`, `src/flap/*`, `DeployFlap.s.sol`, `SetFlapConfig.s.sol`, `test/fork/FlapLaunchFork.t.sol`) were **not touched**. The interface files compiled into the Flap metadata are byte-identical (sha1 checked): `IPoolFactory`, `ILeveragePool`, `IRiskOracle`, `IAggregatorV3` and `IUniswapV2Router02`. The Flap bytecode is therefore unchanged.

**Core change requests: resolved** (details in `contracts/SPEC.md` §16, plus the §5 and §14.1 edits).
- **CREATOR_ROLE per launch: accepted.**
  - Core changes:
    - `Roles.REGISTRAR_ROLE` in `SplitConstants.sol`.
    - `PoolFactory.grantCreator(who)` (REGISTRAR_ROLE only; grants CREATOR_ROLE; never revokes; emits `CreatorGranted(creator, registrar)`) and `PoolFactory.isRegistrar(who)`. These are deliberately **not** in `IPoolFactory`, because that file is frozen with the Flap bytecode.
  - New contract `contracts/src/periphery/CreatorRegistrar.sol` `CreatorRegistrar(admin, poolFactory)`. Its functions are permissionless:
    - `registerFlapLauncher(factory, salt)`: grants to `factory.predictLauncher(salt)` for an allowlisted SplitLauncherFactory. It works before the launcher exists. The salt is `SplitLauncher.launchSalt()` or comes from the `SplitLauncherCreated` event.
    - `registerOpenFourToken(core, token)`: grants to the `migrateModule` that `core.tokens(token)` reports, for an allowlisted `(core, presetId)`. It decodes by word position. It does not check EIP-1167 code, because the closed Core's clone type is unverified.
  - Views: `openFourModuleOf(core, token)`, `flapFactoryAllowed(f)` and `openFourPresetAllowed(core, id)`.
  - Admin: `setFlapFactory` and `setOpenFourPreset`.
  - Wiring:
    - `DeployCore` deploys it, grants it REGISTRAR_ROLE and writes `core.creatorRegistrar`. The handoff target lists include it.
    - New `script/ConfigureRegistrar.s.sol` (`make configure-registrar`) allowlists `flap.launcherFactory` and `openfour.core` + `openfour.presetId`. Env overrides: `REGISTRAR_FLAP_FACTORY`, `REGISTRAR_OPENFOUR_CORE`, `REGISTRAR_OPENFOUR_PRESET_ID`.
  - Callers that now prefer the registrar, with the direct admin grant as fallback:
    - `FlapLaunch.newLauncher`;
    - `openfour/startup/scripts/lifecycle-splitstock.js` (new `CREATOR_REGISTRAR_ABI` in `scripts/lib/splitstock.js`);
    - services `backstopOps` (before `openPool()`: `isCreator`, then `launchSalt()`, then `registerFlapLauncher`);
    - services `openfourPoker` (when `previewGraduation.hasCreatorRole == false`);
    - the app meme page ("Register CREATOR_ROLE" button).
- **Worse-of-two pull pricing in LeveragePool: deferred.** LeveragePool has 605 B of margin, and `ILeveragePool` is frozen by the Flap bytecode. AtlasPullAdapter stays a standalone verifier.
- **`PoolFactory.poolLogic()`: declined.** `core.poolLogic` is already in the address book.

**Other fixes**
- `DeployCore`:
  - The flap placeholder now has `config` and `configAdmin`, because `DeployFlap._writeSection` needs those keys.
  - A fresh rewrite now **keeps an existing flap section**. DeployFlap can run first and create `97.json` with only `chainId` + `flap`; before this fix, DeployCore replaced that section with placeholders.
  - Checked with one in-memory `forge script` run (no RPC, chain 31337, file deleted afterwards). The flap keys survived and `core.creatorRegistrar` was written.
- **Build dirs:** `contracts/out` + `contracts/cache` are the only build dirs. `out-flap`, `cache-flap`, `out-scripts` and `cache-scripts` were deleted. The flap-factory-ready job may recreate `out-flap`, because its frozen script comments still say `--out out-flap`; those flags are optional. Updated to match: Makefile, `verify.sh`, `Verify.md`, and the FlapLaunch / DeployBackstopTreasury comments.
- **`verify.sh`** now also verifies CreatorRegistrar, SplitStockConfig, SplitLauncherFactory, BackstopVaultFactory and BackstopTreasury.
- **Makefile:**
  - Default dirs.
  - New targets: `build-all`, `abi`, `set-flap-config`, `deploy-backstop-treasury`, `openfour-fork`, `openfour-register`, `openfour-lifecycle`, `configure-registrar`, `flap S_SIG='…'`, `clean`.
- **ABIs regenerated** from the final artifacts:
  - services `npm run abi`: adds `CreatorRegistrar.ts` and `SplitLauncherFactory.ts`, both exported from `src/abi/index.ts`.
  - app `npm run abi`: adds `core/CreatorRegistrar.ts` and `flap/SplitStockConfig.ts`, both exported from `src/abi/index.ts`.
  - The `gen-abi` scripts read `contracts/out` first; `out-flap` is a legacy fallback.
- **Typings:** `core.creatorRegistrar` was added to the services zod schema and the app `Deployments` type, and `flap.config` / `configAdmin` to the app type. `deployments/SCHEMA.md` now documents these keys, plus the extra `core.*Impl` keys, `flap.launchers[].taxProcessor`, `openfour.tokens[].migrateModule` and the writer/placeholder rules.
- **Name and ABI cross-checks**, all matching:
  - OpenFour `contracts/external/ISplitStock.sol`: every function, event and error, with return types, against `contracts/out` IPoolFactory / ILeveragePool / IRiskOracle / IAggregatorV3.
  - The OpenFour script human-readable ABIs (POOL_FACTORY, CREATOR_REGISTRAR, POOL, MIGRATE, ERC20) against the compiled ABIs, using ethers selectors.
  - flap-ui `launcher/manifest.json`: 14 reads and 5 actions, with input, output and mutability against SplitLauncher.
  - flap-ui `vault/VaultABI.ts` against BackstopVault.
  - The launcher config tuple: one `SplitConfig` struct, as the factory decodes it.
  - The app and services use the generated const ABIs, so `tsc` enforces their function names. Hand-written ABIs remain only for the external Flap TaxProcessor, `OpenFourCore.migrate/signer`, ERC-8004, PCS and ERC-20.
- **`.gitignore`:**
  - `logs/` became `/logs/` + `services/logs/`, because the old pattern ignored the source dir `app/src/app/api/logs`.
  - `!openfour/fork-deploy/artifacts/` is re-included, because it holds the deploy bytecode the fork toolkit needs.
  - New patterns: `out-*/`, `cache-*/`, the whole `openfour/**/workbench/data/`, `openfour/startup/{out,cache,artifacts}`, `app/src/generated/`, `*.pem`, `*.key`, `pgdata/`, `backups/`.
- **`.env.example`:** every env name used in the code is now listed. Added: the Flap / BackstopTreasury / registrar script knobs, the OpenFour Hardhat and fork-deploy variables (they belong in `openfour/.env`), the flap-ui template dirs and `FORGE_BIN`.
- **`README.md`:** draft written (pitch, architecture, layout, setup, run order, env, address book, status).

**Build results (this phase)**
```
cd contracts && forge build                                   # passes (default out/)
cd openfour/startup && npx hardhat compile                    # passes (nothing to compile; up to date)
cd services && npx tsc --noEmit                               # passes
cd app && npm run build                                       # passes (all pages + 13 API routes)
cd flap-ui && FLAP_LAUNCHER_TEMPLATE_DIR=… FLAP_VAULT_TEMPLATE_DIR=… npm run build:launcher && npm run check:vault   # pass
make build-all                                                # runs all of the above (flap-ui only if .template exists)
```
The flap-ui template checkouts used this time live in the session scratchpad (`flap-template`, `flap-template-main`). On a fresh machine, run `cd flap-ui && npm run setup`.

**Run order on 97 (updated).**
1. `make deploy-core`, then a keeper mirror push, then `make open-dev-pools`.
2. Flap and backstop: `make deploy-flap` (it may already have run before core), `make set-flap-config`, `make deploy-backstop-treasury`.
3. OpenFour: `make openfour-fork`, then `make openfour-register`.
4. `make configure-registrar`.
5. Launches: `make flap S_SIG='newLauncher()'`, then `fill()`, then `openPool()`; and `make openfour-lifecycle`.
6. Last: `make handoff`.

After the handoff, new launches still get CREATOR_ROLE through the registrar, but changing the registrar allowlists needs a Timelock operation.

**Remaining gaps / TODOs**
- **Tests:** all suites are still to be written (Foundry unit / invariant / fork, Hardhat module tests, services unit tests, flap-ui `vault:e2e`). New code that needs tests:
  - `PoolFactory.grantCreator`;
  - `CreatorRegistrar`: the Flap path, and the OpenFour word decode against the real fork Core's `tokens()`;
  - DeployCore's flap-preserving rewrite.
- **Unverified field order:** the `RuntimeConfig` word positions in `CreatorRegistrar` come from the public `IOpenFourCore.tokens` getter. Confirm them against the fork Core with one `openFourModuleOf` eth_call before relying on it.
- **Mid-integration edits:** `SetFlapConfig` / `SplitStockConfig` landed during integration (flap-factory-ready job). The ABIs were regenerated after they landed, but if that job changes `src/launch/*` again, re-run `make abi`.
- **Still open from the components:** `services` should add `GET /openfour/tokens` and `POST /openfour/records`, which the app's sign route already expects. Their other open items remain in their own sections above: pull pricing, Atlas feed ids, CMC response shapes, the name of `Core.migrate`, the `launchQuoteConfig` shape, the ERC-8004 signature formats, the TSLAB address and `openTx` back-fill.
- **Flap change requests:** none.

## 50/50 split + halt/cover fairness (pre-enable change)

- Flap factories 0x79127b50… / 0x3449083b… were never enabled; they are superseded by a redeploy with the 50/50 split. Creation floor = $750 x mult x totalSupply/poolToken / quotePrice = $1,500 / $700 = 2.142857 tBNB (min pool quote 1.1x = 2.357143 tBNB); graduation floor about 4.29 tBNB. FlapLaunch defaults: FLAP_TARGET 4.7, FLAP_SEED 0.2 (pool quote 4.5, the fork test sees `FlapTokenGraduated` at launch). A 0.2 tBNB seed needs a WBNB/tNVDA pair of about 7+ tBNB for openPool's 3% minOut.
- LeveragePool redeem hold: `redeemStable` (and `previewRedeemStable`) revert `RedeemHeld()` while the feed is halted, the pool is under water by more than 1 bp (`V_c + S/BPS < S`) and `block.timestamp < feed.haltedAtSrc() + MAX_REDEEM_HOLD` (6 h, SplitConstants). `haltedAtSrc()` is a staticcall (AtlasMirror and MockAggregator expose it; ScenarioFeed and plain aggregators do not, so no hold there). redeemPair is never held. `donate` now works while halted (fresh age still required). Logic lives in PoolLogic (`quoteRedeemStable` became public with a `feed` argument), so LeveragePool shrank (23,929 B runtime).

## Immutable SplitStockConfig (Flap review fix, pre-enable change)

Flap's Pool Launch review (round 2) conditionally passed and asked for ONE change: the admin (team, later the Timelock) could queue new poolFactory / swapRouter / stock token / feed values for new Launchers, and a malicious router or factory could take a launch's seed at `openPool` and the vault's buffer during `cover`. Flap's rule is that on a contract that launches for users, only the Guardian may change where funds go. We took the second option Flap offered: **the config is fixed per factory pair.**

- `src/launch/SplitStockConfig.sol`: `constructor(SplitPoolConfig cfg, string poolSymbol)`. It validates exactly like the old `setPoolConfig`: every address has code, the boost token is zero or a contract, `assetId != 0`, the symbol is 1–10 bytes, `poolFactory.usdc()` returns a contract, and a ScenarioPool must be `poolFactory.isPool`.
  - All fields are stored as immutables; the symbol is one left-aligned word plus its length.
  - There is no admin, no pending admin, no setter, no queue or apply/cancel, and no Guardian. It holds no funds.
  - Views: `poolConfig()`, `poolSymbol()`, `current()` (configured = true), `isConfigured()` (always true), `version()` (constant 1), `MAX_SYMBOL_BYTES`. A single event, `ConfigFixed(cfg, poolSymbol)`, is emitted at deployment.
  - Errors: `ZeroAddress`, `NoCode`, `EmptyAssetId`, `BadSymbol`, `NoPoolFactoryUsdc`, `NotAPool`.
  - Runtime size is 1,245 B (it was 5.8 KB).
- `ISplitStockConfig` gains `version()`. `SplitLauncherFactory` now checks `isConfigured()` once, in its constructor (`ConfigUnset`), instead of on every `newLauncher`. Its comments and `config` NatSpec say the pool target is fixed per factory pair. Everything else is unchanged.
- `SplitLauncher.description()` (EN + ZH) now says the pool settings "are fixed for this launcher factory: they come from an immutable SplitStock config with no admin and no setter, so nobody can change them". The description is 2,563 bytes. No other logic in `SplitLauncher`, `BackstopVault` or `BackstopVaultFactory` changed (comments only).
- `script/DeployFlap.s.sol` reads the core from deployments/97.json exactly as `SetFlapConfig` did:
  - `core.poolFactory`, `tokens.tNVDA`, `oracles.NVDA.mirror`, `dex.router` (swap and pool router), `oracles.atlasBnbUsd`;
  - `pools[nvda-scenario].pool` and `.sUSD`, with the env overrides `FLAP_SCENARIO_POOL` / `FLAP_NO_SCENARIO` / `FLAP_BOOST_TOKEN` / `FLAP_NO_BOOST` / `FLAP_POOL_SYMBOL`.
  - It runs the same pre-flight `require`s and then deploys config (nonce+0) → vault factory (nonce+1, predicted launcher factory) → launcher factory (nonce+2).
  - It writes `flap.config`, `flap.configAdmin = 0x0`, `flap.vaultFactory` and `flap.launcherFactory`. It no longer creates a missing deployments file, because the core must exist first.
- `SetFlapConfig.s.sol` is deleted, and `make set-flap-config` only prints a no-op message. `.env.example`, `deployments/SCHEMA.md` (`configAdmin` is always 0x0), the `DeployCore` comment, the `FlapLaunch` message and the app `Deployments` type comments were updated. The ABIs were regenerated (services, app).
- `test/fork/FlapLaunchFork.t.sol` deploys the core before the pair and now runs 7 tests, all passing against the live Portal v1.2.0:
  - `test_01` asserts the config equals its constructor args and that every old selector (`setPoolConfig`, `applyPoolConfig`, `cancelPoolConfig`, `transferAdmin`, `acceptAdmin`, `admin`, `guardian`, `pending`) fails for the deployer, the Flap Guardian and a stranger.
  - `test_03` checks the same selectors mid-sale (this replaces "config change mid-sale is queued").
  - `test_06` is now `configFixedPerFactoryPair_validation_and_newPair`: constructor reverts, plus a second pair with a different config. Pair A and its Launchers are unchanged, and pair B refuses pair A's vault factory.
  - `FLAP_FORK_RPC` overrides the RPC.
- **Observed on the live Portal v1.2.0 (97 fork):** neither `newLauncher` nor `launchTaxTokenV2` (the filling contribution) checks whether Flap enabled the factory. A launch on an unenabled pair went through in the fork. The old `test_01` "Portal refuses a factory Flap has not enabled" only passed because our own `ConfigUnset` reverted. Enabling sets the multiplier (creation floor) and presumably the listing. The test now logs this behaviour instead of asserting a gate.
- Deploy order: `make deploy-core` → mirrors fresh → `make open-dev-pools` (creates `nvda-scenario`) → `make deploy-flap` → Flap enables the NEW `launcherFactory` + `vaultFactory` → `make configure-registrar` (allowlists the new launcher factory) → `scenarioPool.setDonor(newVault, true)` per launch when the ScenarioPool tranche is used → `make flap S_SIG='newLauncher()'` …
- The old pair is superseded and was never enabled: config 0x860fCFF9…, launcher factory 0xae8f0987…, vault factory 0xF5390582…. `docs/DEPLOYED.md` still lists it until the redeploy.

- **Adversarial review follow-up: core implementations pinned.** The immutable config alone left one non-Guardian path to a launch's seed: `PoolFactory.setImplementations` (core `DEFAULT_ADMIN_ROLE`, deployer then Timelock) changes the code `openPool`'s `createPool` clones, and `openPool` then approves and `seed`s the whole tNVDA swap output into that clone. Fix:
  - `SplitStockConfig` reads `poolImpl()` / `tokenImpl()` / `stabilityPoolImpl()` from the PoolFactory in its constructor and stores them as immutables (new error `NoPoolFactoryImplementations`, new view `implementations()`, also on `ISplitStockConfig`). Runtime size 1,409 B.
  - `SplitLauncher.openPool` calls `_requirePinnedImplementations` before `createPool` and reverts `CoreImplementationChanged` if the PoolFactory reports anything else. A blocked Launcher falls back to `releaseSeed` (seed to its BackstopVault after 14 days). SplitLauncher runtime 22,343 B.
  - `test/launch/CoreAbiPin.t.sol` pins the three new selectors. New fork test `test_08_openPool_refuses_swapped_core_implementations` (8/8 fork tests pass).
  - Consequence for the core team: after Flap enables this pair, calling `PoolFactory.setImplementations` blocks `openPool` for every not-yet-opened Launcher of the pair. Change implementations only together with a new factory pair.
  - Remaining core roles that touch an already opened pool (not the Flap contracts' funds routing): AtlasMirror `PUSHER_ROLE` (trusted price relay), `LeveragePool.setRouter` / `setParams` (PoolFactory admin, bounded by the pool's own minimum-output checks and `paramsValid`), and the team-priced ScenarioPool tranche (capped). Listed in README "Flap review notes", item 3.
