// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20Permit} from "../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";
import {LeveragePool} from "../src/core/LeveragePool.sol";
import {SplitToken} from "../src/core/SplitToken.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {PoolFactory} from "../src/core/PoolFactory.sol";
import {CreatorRegistrar} from "../src/periphery/CreatorRegistrar.sol";
import {PoolMath} from "../src/core/PoolMath.sol";
import {SandboxFactory} from "../src/core/SandboxFactory.sol";
import {MarketCalendar} from "../src/core/MarketCalendar.sol";
import {RiskOracle} from "../src/core/RiskOracle.sol";
import {LogAnchor} from "../src/core/LogAnchor.sol";
import {AtlasMirror} from "../src/oracle/AtlasMirror.sol";
import {ScenarioFeed} from "../src/oracle/ScenarioFeed.sol";
import {AtlasPullAdapter} from "../src/oracle/AtlasPullAdapter.sol";
import {IRiskOracle} from "../src/interfaces/IRiskOracle.sol";
import {IScenarioFeed} from "../src/interfaces/IScenarioFeed.sol";
import {Roles} from "../src/interfaces/SplitConstants.sol";

import {CoreHandoff} from "./lib/CoreHandoff.sol";
import {IPcsV2RouterLiquidity, IPcsV2Factory} from "./lib/IPcsV2.sol";

/// @title DeployCore (BSC testnet 97)
/// @notice Deploys the SplitStock core and writes deployments/97.json (SCHEMA.md):
///         mocks tNVDA / tTSLA / mUSDC, implementations (+ PoolLogic, linked by forge), MarketCalendar,
///         RiskOracle (NVDA + TSLA configured), LogAnchor, AtlasMirror + AtlasPullAdapter + ScenarioFeed per asset,
///         MockRouter, PoolFactory, SandboxFactory (NVDA), TimelockController, all SPEC.md §14.1 role grants, and
///         PancakeSwap v2 pairs tNVDA/mUSDC, tTSLA/mUSDC, WBNB/mUSDC, WBNB/tNVDA seeded at the configured prices.
///         Admin handoff to the Timelock is DEFERRED by default (HANDOFF_ADMIN=false) so OpenDevPools, Flap and
///         OpenFour can still be wired by the deployer; run HandoffAdmin.s.sol afterwards.
/// @dev forge script script/DeployCore.s.sol:DeployCore --rpc-url bsc_testnet --broadcast --slow
///      Pools are NOT opened here (Flap / Four.meme launches and OpenDevPools do that).
contract DeployCore is CoreHandoff {
    bytes32 internal constant NVDA = keccak256("NVDA");
    bytes32 internal constant TSLA = keccak256("TSLA");

    address internal constant PCS_V2_ROUTER_97 = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    address internal constant WBNB_97 = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address internal constant ATLAS_NVDAB_56 = 0xf25Af12920D408bAf6211e9e90eDa89DF3D8CCDa;
    address internal constant ATLAS_MULTIFEED_56 = 0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa;
    address internal constant ATLAS_BNB_USD_97 = 0x3957d289ee9C38272377786787ea34F9dd29788D;

    // ---------------------------------------------------------------- config
    address internal deployer;
    uint8 internal usdcDec;
    uint256 internal nvdaPrice; // WAD
    uint256 internal tslaPrice; // WAD
    uint256 internal bnbPrice; // WAD
    address internal guardian;
    address internal poster;
    address internal agent;
    address internal pusher;
    address internal pusherBackup;
    address internal anchorer;
    address internal scenarioOperator;
    address internal atlasNvdaSrc;
    address internal atlasTslaSrc;
    address internal atlasBnbUsd;
    bool internal handoffNow;

    // ---------------------------------------------------------------- deployed
    MockERC20Permit internal tNVDA;
    MockERC20Permit internal tTSLA;
    MockERC20Permit internal mUSDC;
    address internal poolImpl;
    address internal poolLogic;
    address internal tokenImpl;
    address internal spImpl;
    address internal feedImpl;
    MarketCalendar internal calendar;
    RiskOracle internal risk;
    LogAnchor internal logAnchor;
    AtlasMirror internal mirrorNVDA;
    AtlasMirror internal mirrorTSLA;
    AtlasPullAdapter internal pullNVDA;
    AtlasPullAdapter internal pullTSLA;
    address internal scenarioNVDA;
    address internal scenarioTSLA;
    MockRouter internal mockRouter;
    PoolFactory internal factory;
    CreatorRegistrar internal registrar;
    SandboxFactory internal sandbox;
    TimelockController internal timelock;

    address internal router;
    address internal dexFactory;
    address internal wbnb;
    address internal pairNvdaUsdc;
    address internal pairTslaUsdc;
    address internal pairWbnbUsdc;
    address internal pairWbnbNvda;

    function run() external {
        _loadConfig();
        deployer = _startBroadcastTestnet();
        _resolveRoleDefaults();

        _deployMocks();
        _deployImplementations();
        _deployOracleAndRisk();
        _deployFactories();
        _deployTimelock();
        _seedPairs();
        if (handoffNow) _handoff(_targets(), address(timelock), deployer);

        vm.stopBroadcast();

        _writeDeployments();
        _logSummary();
    }

    // ---------------------------------------------------------------- config

    function _loadConfig() internal {
        usdcDec = uint8(vm.envOr("MUSDC_DECIMALS", uint256(18)));
        nvdaPrice = vm.envOr("NVDA_PRICE_E18", uint256(150e18));
        tslaPrice = vm.envOr("TSLA_PRICE_E18", uint256(400e18));
        bnbPrice = vm.envOr("BNB_PRICE_E18", uint256(554.69e18));
        atlasNvdaSrc = vm.envOr("ATLAS_NVDA_SRC_FEED", ATLAS_NVDAB_56);
        atlasTslaSrc = vm.envOr("ATLAS_TSLA_SRC_FEED", ATLAS_MULTIFEED_56);
        atlasBnbUsd = vm.envOr("ATLAS_BNB_USD_FEED", ATLAS_BNB_USD_97);
        handoffNow = vm.envOr("HANDOFF_ADMIN", false);
        require(nvdaPrice > 0 && tslaPrice > 0 && bnbPrice > 0, "prices");
        require(usdcDec <= 18, "MUSDC_DECIMALS");
    }

    /// @dev Role holders: explicit *_ADDRESS, else the address of the service key, else KEEPER_PRIVATE_KEY's
    ///      address, else the deployer (demo only; rotate before judging).
    function _resolveRoleDefaults() internal {
        address keeper = _roleAddr("KEEPER_ADDRESS", "KEEPER_PRIVATE_KEY", deployer);
        guardian = vm.envOr("GUARDIAN_ADDRESS", deployer);
        poster = _roleAddr("RISK_POSTER_ADDRESS", "RISK97_PRIVATE_KEY", keeper);
        agent = _roleAddr("AGENT_ADDRESS", "AGENT_PRIVATE_KEY", keeper);
        pusher = _roleAddr("MIRROR_PUSHER_ADDRESS", "MIRROR_PRIVATE_KEY", keeper);
        pusherBackup = _roleAddr("MIRROR_BACKUP_ADDRESS", "MIRROR_BACKUP_PRIVATE_KEY", address(0));
        anchorer = _roleAddr("ANCHOR_ADDRESS", "ANCHOR_PRIVATE_KEY", keeper);
        scenarioOperator = _roleAddr("SCENARIO_OPERATOR_ADDRESS", "OPS_PRIVATE_KEY", deployer);
    }

    // ---------------------------------------------------------------- steps

    function _deployMocks() internal {
        uint256 cooldown = vm.envOr("FAUCET_COOLDOWN", uint256(1 days));
        tNVDA = new MockERC20Permit(
            "Test NVDA (MOCK)", "tNVDA", 18, deployer, vm.envOr("TNVDA_FAUCET", uint256(10e18)), cooldown
        );
        tTSLA = new MockERC20Permit(
            "Test TSLA (MOCK)", "tTSLA", 18, deployer, vm.envOr("TTSLA_FAUCET", uint256(5e18)), cooldown
        );
        mUSDC = new MockERC20Permit(
            "Mock USDC (MOCK)", "mUSDC", usdcDec, deployer, vm.envOr("MUSDC_FAUCET", 10_000 * 10 ** usdcDec), cooldown
        );
    }

    function _deployImplementations() internal {
        // `new LeveragePool()` makes forge deploy and link PoolLogic first (SPEC.md R2).
        poolImpl = address(new LeveragePool());
        poolLogic = vm.envOr("POOL_LOGIC", address(0));
        if (poolLogic == address(0)) poolLogic = _findLinkedLibrary(poolImpl);
        tokenImpl = address(new SplitToken());
        spImpl = address(new StabilityPool());
        feedImpl = address(new ScenarioFeed());
    }

    function _deployOracleAndRisk() internal {
        calendar = new MarketCalendar(deployer);

        risk = new RiskOracle(deployer);
        risk.configureAsset(NVDA, _assetConfig());
        risk.configureAsset(TSLA, _assetConfig());
        risk.grantRole(Roles.POSTER_ROLE, poster);
        risk.grantRole(Roles.PROPOSER_ROLE, agent);
        risk.grantRole(Roles.GUARDIAN_ROLE, guardian);

        logAnchor = new LogAnchor(deployer);
        logAnchor.grantRole(Roles.ANCHOR_ROLE, anchorer);

        mirrorNVDA = new AtlasMirror(deployer, 56, atlasNvdaSrc, 18, "NVDAB / USD (Atlas mirror, BSC 56)");
        mirrorTSLA = new AtlasMirror(deployer, 56, atlasTslaSrc, 18, "TSLAB / USD (Atlas mirror, BSC 56)");
        _mirrorRoles(mirrorNVDA);
        _mirrorRoles(mirrorTSLA);

        address signerOverride = vm.envOr("ATLAS_PULL_SIGNER", address(0));
        pullNVDA = new AtlasPullAdapter(
            address(mirrorNVDA),
            bytes4(uint32(vm.envOr("ATLAS_PULL_FEED_ID_NVDA", uint256(0x3a6)))),
            signerOverride,
            "NVDAB / USD (Atlas pull)"
        );
        pullTSLA = new AtlasPullAdapter(
            address(mirrorTSLA),
            bytes4(uint32(vm.envOr("ATLAS_PULL_FEED_ID_TSLA", uint256(0x3a5)))),
            signerOverride,
            "TSLAB / USD (Atlas pull)"
        );

        // Canonical ScenarioFeeds (team-set price, bounded to 0.4x..1.6x of the mirror anchor). The mirror has
        // no data yet, so the anchor is the configured price (mirror decimals = 18).
        scenarioNVDA = Clones.clone(feedImpl);
        IScenarioFeed(scenarioNVDA).initialize(address(mirrorNVDA), scenarioOperator, false, int256(nvdaPrice));
        scenarioTSLA = Clones.clone(feedImpl);
        IScenarioFeed(scenarioTSLA).initialize(address(mirrorTSLA), scenarioOperator, false, int256(tslaPrice));
    }

    function _mirrorRoles(AtlasMirror m) internal {
        m.grantRole(Roles.PUSHER_ROLE, pusher);
        if (pusherBackup != address(0) && pusherBackup != pusher) m.grantRole(Roles.PUSHER_ROLE, pusherBackup);
        m.grantRole(Roles.GUARDIAN_ROLE, guardian);
    }

    function _deployFactories() internal {
        mockRouter = new MockRouter(deployer);
        tNVDA.grantRole(Roles.MINTER_ROLE, address(mockRouter));
        tTSLA.grantRole(Roles.MINTER_ROLE, address(mockRouter));
        mUSDC.grantRole(Roles.MINTER_ROLE, address(mockRouter));

        factory = new PoolFactory(
            deployer, address(mUSDC), address(risk), address(calendar), poolImpl, tokenImpl, spImpl, PoolMath.defaultParams()
        );
        factory.grantRole(Roles.GUARDIAN_ROLE, guardian);
        // CreatorRegistrar: grants CREATOR_ROLE to allowlisted Flap launchers / OpenFour migrate modules without a
        // Timelock op per launch. Allowlists are set by script/ConfigureRegistrar.s.sol after DeployFlap / OpenFour.
        registrar = new CreatorRegistrar(deployer, address(factory));
        factory.grantRole(Roles.REGISTRAR_ROLE, address(registrar));

        sandbox = new SandboxFactory(
            SandboxFactory.Wiring({
                poolFactory: address(factory),
                mockRouter: address(mockRouter),
                feedImpl: feedImpl,
                asset: address(tNVDA),
                usdc: address(mUSDC),
                assetId: NVDA
            }),
            "NVDA",
            SandboxFactory.Amounts({
                referenceFeed: address(mirrorNVDA),
                fallbackAnswer: int256(nvdaPrice),
                seedAssetAmount: vm.envOr("SANDBOX_SEED_TNVDA", uint256(10e18)),
                stableAssetAmount: vm.envOr("SANDBOX_STABLE_TNVDA", uint256(4e18))
            })
        );
        factory.grantRole(Roles.CREATOR_ROLE, address(sandbox));
        mockRouter.grantRole(Roles.AUTHORIZER_ROLE, address(sandbox));
        tNVDA.grantRole(Roles.MINTER_ROLE, address(sandbox));
    }

    function _deployTimelock() internal {
        address[] memory proposers = new address[](1);
        proposers[0] = vm.envOr("TIMELOCK_PROPOSER", deployer);
        address[] memory executors = new address[](1);
        executors[0] = vm.envOr("TIMELOCK_EXECUTOR", address(0)); // address(0) = anyone may execute after delay
        // admin = address(0): the Timelock administers itself.
        timelock = new TimelockController(vm.envOr("TIMELOCK_DELAY", uint256(1 days)), proposers, executors, address(0));
    }

    // ---------------------------------------------------------------- PancakeSwap v2 pairs

    function _seedPairs() internal {
        router = vm.envOr("PCS_V2_ROUTER", PCS_V2_ROUTER_97);
        if (vm.envOr("SKIP_DEX", false) || !_hasCode(router)) {
            console2.log("DEX: skipped (SKIP_DEX or router has no code on this chain)");
            wbnb = vm.envOr("WBNB", WBNB_97);
            return;
        }
        IPcsV2RouterLiquidity r = IPcsV2RouterLiquidity(router);
        dexFactory = r.factory();
        wbnb = r.WETH();
        address lp = vm.envOr("LP_RECIPIENT", deployer);
        uint256 deadline = block.timestamp + 1 hours;

        // tNVDA / mUSDC and tTSLA / mUSDC at the configured (mirror) prices.
        uint256 nvdaAmt = vm.envOr("PAIR_TNVDA_AMOUNT", uint256(200e18));
        uint256 tslaAmt = vm.envOr("PAIR_TTSLA_AMOUNT", uint256(75e18));
        _addTokenPair(tNVDA, nvdaAmt, _usdcFor(nvdaAmt, nvdaPrice), lp, deadline);
        _addTokenPair(tTSLA, tslaAmt, _usdcFor(tslaAmt, tslaPrice), lp, deadline);

        // WBNB / mUSDC at Atlas BNB/USD, WBNB / tNVDA at BNB/NVDA. Native tBNB comes from the deployer.
        uint256 bnbForUsdc = vm.envOr("PAIR_WBNB_MUSDC_BNB", uint256(0.15 ether));
        uint256 bnbForNvda = vm.envOr("PAIR_WBNB_TNVDA_BNB", uint256(0.1 ether));
        if (bnbForUsdc > 0) _addEthPair(mUSDC, _usdcFor(bnbForUsdc, bnbPrice), bnbForUsdc, lp, deadline);
        if (bnbForNvda > 0) {
            _addEthPair(tNVDA, Math.mulDiv(bnbForNvda, bnbPrice, nvdaPrice), bnbForNvda, lp, deadline);
        }

        IPcsV2Factory f = IPcsV2Factory(dexFactory);
        pairNvdaUsdc = f.getPair(address(tNVDA), address(mUSDC));
        pairTslaUsdc = f.getPair(address(tTSLA), address(mUSDC));
        pairWbnbUsdc = f.getPair(wbnb, address(mUSDC));
        pairWbnbNvda = f.getPair(wbnb, address(tNVDA));
    }

    /// @dev mUSDC units worth `amount` (18-dec asset or native) at `priceWad`.
    function _usdcFor(uint256 amount, uint256 priceWad) internal view returns (uint256) {
        return Math.mulDiv(amount, priceWad * 10 ** usdcDec, 1e36);
    }

    function _addTokenPair(MockERC20Permit asset, uint256 assetAmt, uint256 usdcAmt, address lp, uint256 deadline)
        internal
    {
        if (assetAmt == 0 || usdcAmt == 0) return;
        asset.mint(deployer, assetAmt);
        mUSDC.mint(deployer, usdcAmt);
        IERC20(address(asset)).approve(router, assetAmt);
        IERC20(address(mUSDC)).approve(router, usdcAmt);
        IPcsV2RouterLiquidity(router).addLiquidity(
            address(asset), address(mUSDC), assetAmt, usdcAmt, 0, 0, lp, deadline
        );
    }

    function _addEthPair(MockERC20Permit token, uint256 tokenAmt, uint256 bnbAmt, address lp, uint256 deadline)
        internal
    {
        if (tokenAmt == 0) return;
        token.mint(deployer, tokenAmt);
        IERC20(address(token)).approve(router, tokenAmt);
        IPcsV2RouterLiquidity(router).addLiquidityETH{value: bnbAmt}(address(token), tokenAmt, 0, 0, lp, deadline);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev SPEC.md §7.9 recommended NVDA AssetConfig (TSLA uses the same values).
    function _assetConfig() internal pure returns (IRiskOracle.AssetConfig memory) {
        return IRiskOracle.AssetConfig({
            enabled: true,
            baseTriggerLev: 2.67e18,
            baseTargetLev: 2.0e18,
            baseLowerTriggerLev: 1.6e18,
            volRefBps: 5000,
            volSlopeLev: 1e14,
            maxDevBps: 250,
            closedFeeBps: 100,
            baseOpenFeeBps: 30,
            premiumFeeShareBps: 5000,
            gapGuardSec: 3600,
            chunkBpsOfLiq: 200,
            minChunkUsd: 100e18,
            maxChunkUsd: 50_000e18
        });
    }

    /// @dev Finds the library forge linked into `impl`: the first PUSH20 operand (walking opcodes, so push data
    ///      is skipped correctly) that is not `impl` itself and has substantial code. LeveragePool's only such
    ///      operand is PoolLogic (DELEGATECALL target). Override with POOL_LOGIC if ever ambiguous.
    function _findLinkedLibrary(address impl) internal view returns (address lib) {
        bytes memory code = impl.code;
        uint256 n = code.length;
        uint256 i;
        while (i < n) {
            uint8 op = uint8(code[i]);
            if (op == 0x73 && i + 20 < n) {
                address cand;
                assembly ("memory-safe") {
                    cand := shr(96, mload(add(add(code, 33), i)))
                }
                if (cand != impl && cand.code.length > 1000) return cand;
            }
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            ++i;
        }
        revert("PoolLogic address not found in LeveragePool code; set POOL_LOGIC");
    }

    function _targets() internal view returns (address[] memory t) {
        t = new address[](11);
        t[10] = address(registrar);
        t[0] = address(factory);
        t[1] = address(risk);
        t[2] = address(calendar);
        t[3] = address(logAnchor);
        t[4] = address(mirrorNVDA);
        t[5] = address(mirrorTSLA);
        t[6] = address(mockRouter);
        t[7] = address(tNVDA);
        t[8] = address(tTSLA);
        t[9] = address(mUSDC);
    }

    // ---------------------------------------------------------------- deployments/97.json

    function _writeDeployments() internal {
        string memory path = _deploymentsPath();
        bool fresh = vm.envOr("FRESH_DEPLOYMENTS_FILE", false) || !vm.isFile(path);
        // DeployFlap may run BEFORE DeployCore (the Flap factories hold no core address) and then creates a file
        // with only chainId + flap. A fresh rewrite must keep that flap section instead of the placeholder.
        string memory flapJson = _flapPlaceholder();
        if (vm.isFile(path)) {
            string memory prev = vm.readFile(path);
            if (vm.keyExistsJson(prev, ".flap.launcherFactory")) flapJson = _flapFrom(prev);
        }
        if (!fresh) {
            string memory old = vm.readFile(path);
            string[6] memory keys = [".tokens", ".core", ".oracles", ".dex", ".flap", ".openfour"];
            for (uint256 i; i < keys.length; ++i) {
                if (!vm.keyExistsJson(old, keys[i])) fresh = true;
            }
            if (!vm.keyExistsJson(old, ".pools") || !vm.keyExistsJson(old, ".erc8004")) fresh = true;
        }

        if (fresh) {
            string memory full = string.concat(
                "{",
                _kv("chainId", vm.toString(block.chainid)),
                ",",
                _kv("updatedAt", _q(_isoNow())),
                ",",
                _kv("deployer", _a(deployer)),
                ",",
                _kv("tokens", _tokensJson()),
                ",",
                _kv("core", _coreJson()),
                ","
            );
            full = string.concat(
                full,
                _kv("oracles", _oraclesJson()),
                ",",
                _kv("pools", "[]"),
                ",",
                _kv("dex", _dexJson()),
                ",",
                _kv("flap", flapJson),
                ",",
                _kv("openfour", _openfourPlaceholder()),
                ",",
                _kv("erc8004", _erc8004Json()),
                "}"
            );
            vm.writeJson(full, path);
        } else {
            // Keep flap / openfour / erc8004 written by other scripts; replace everything the core owns.
            // Old pools belong to the previous PoolFactory, so pools[] is reset.
            vm.writeJson(vm.toString(block.chainid), path, ".chainId");
            vm.writeJson(_a(deployer), path, ".deployer");
            vm.writeJson(_tokensJson(), path, ".tokens");
            vm.writeJson(_coreJson(), path, ".core");
            vm.writeJson(_oraclesJson(), path, ".oracles");
            vm.writeJson("[]", path, ".pools");
            vm.writeJson(_dexJson(), path, ".dex");
            _touch(path);
            console2.log("WARNING: existing flap/openfour sections kept; they point at the PREVIOUS core.");
        }
        console2.log("wrote", path);
    }

    function _tokensJson() internal view returns (string memory) {
        return string.concat(
            "{",
            _kv("tNVDA", _a(address(tNVDA))),
            ",",
            _kv("tTSLA", _a(address(tTSLA))),
            ",",
            _kv("mUSDC", _a(address(mUSDC))),
            ",",
            _kv("WBNB", _a(wbnb)),
            "}"
        );
    }

    function _coreJson() internal view returns (string memory) {
        string memory a = string.concat(
            "{",
            _kv("poolFactory", _a(address(factory))),
            ",",
            _kv("poolLogic", _a(poolLogic)),
            ",",
            _kv("riskOracle", _a(address(risk))),
            ",",
            _kv("marketCalendar", _a(address(calendar))),
            ","
        );
        a = string.concat(
            a,
            _kv("logAnchor", _a(address(logAnchor))),
            ",",
            _kv("sandboxFactory", _a(address(sandbox))),
            ",",
            _kv("creatorRegistrar", _a(address(registrar))),
            ",",
            _kv("timelock", _a(address(timelock))),
            ",",
            _kv("guardian", _a(guardian)),
            ","
        );
        // Implementations (beyond SCHEMA.md minimum; used by Verify and the indexer).
        return string.concat(
            a,
            _kv("poolImpl", _a(poolImpl)),
            ",",
            _kv("tokenImpl", _a(tokenImpl)),
            ",",
            _kv("stabilityPoolImpl", _a(spImpl)),
            ",",
            _kv("scenarioFeedImpl", _a(feedImpl)),
            "}"
        );
    }

    function _oraclesJson() internal view returns (string memory) {
        string memory nvda = string.concat(
            "{",
            _kv("mirror", _a(address(mirrorNVDA))),
            ",",
            _kv("scenarioFeed", _a(scenarioNVDA)),
            ",",
            _kv("pullAdapter", _a(address(pullNVDA))),
            ",",
            _kv("atlasSource", string.concat("{", _kv("chainId", "56"), ",", _kv("feed", _a(atlasNvdaSrc)), "}")),
            "}"
        );
        string memory tsla = string.concat(
            "{",
            _kv("mirror", _a(address(mirrorTSLA))),
            ",",
            _kv("scenarioFeed", _a(scenarioTSLA)),
            ",",
            _kv("pullAdapter", _a(address(pullTSLA))),
            ",",
            _kv(
                "atlasSource",
                string.concat(
                    "{",
                    _kv("chainId", "56"),
                    ",",
                    _kv("feed", _a(atlasTslaSrc)),
                    ",",
                    // MultiFeed id for TSLAB (registry 933); only meaningful when feed is the MultiFeed.
                    _kv("feedId", _q(vm.envOr("ATLAS_TSLA_MULTIFEED_ID", string("0x000003a5")))),
                    "}"
                )
            ),
            "}"
        );
        return string.concat(
            "{", _kv("NVDA", nvda), ",", _kv("TSLA", tsla), ",", _kv("atlasBnbUsd", _a(atlasBnbUsd)), "}"
        );
    }

    function _dexJson() internal view returns (string memory) {
        string memory pairs = string.concat(
            "{",
            _kv("tNVDA_mUSDC", _a(pairNvdaUsdc)),
            ",",
            _kv("tTSLA_mUSDC", _a(pairTslaUsdc)),
            ",",
            _kv("WBNB_mUSDC", _a(pairWbnbUsdc)),
            ",",
            _kv("WBNB_tNVDA", _a(pairWbnbNvda)),
            "}"
        );
        return string.concat(
            "{",
            _kv("router", _a(router)),
            ",",
            _kv("factory", _a(dexFactory)),
            ",",
            _kv("mockRouter", _a(address(mockRouter))),
            ",",
            _kv("pairs", pairs),
            "}"
        );
    }

    function _flapPlaceholder() internal pure returns (string memory) {
        return string.concat(
            "{",
            _kv("portal", _q("0x000042108465206185A077Edc3F3fd2b49060000")),
            ",",
            _kv("guardian", _q("0x00004d58290854c5E9880F4b5B1993c6Ad8b0000")),
            ",",
            _kv("v2Router", _q("0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3")),
            ",",
            // written by DeployFlap (immutable SplitStockConfig; configAdmin stays 0x0, no admin); the key must exist for _writeSection
            _kv("config", _a(address(0))),
            ",",
            _kv("configAdmin", _a(address(0))),
            ",",
            _kv("launcherFactory", _a(address(0))),
            ",",
            _kv("vaultFactory", _a(address(0))),
            ",",
            _kv("launchers", "[]"),
            "}"
        );
    }

    /// @dev Rebuilds the flap section from an existing file (keys DeployFlap / FlapLaunch write), defaulting to
    ///      the placeholder values for anything missing.
    function _flapFrom(string memory j) internal view returns (string memory) {
        string memory s = string.concat(
            "{",
            _kv("portal", _a(_orAddr(j, ".flap.portal", 0x000042108465206185A077Edc3F3fd2b49060000))),
            ",",
            _kv("guardian", _a(_orAddr(j, ".flap.guardian", 0x00004d58290854c5E9880F4b5B1993c6Ad8b0000))),
            ",",
            _kv("v2Router", _a(_orAddr(j, ".flap.v2Router", 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3))),
            ",",
            _kv("config", _a(_jAddr(j, ".flap.config"))),
            ",",
            _kv("configAdmin", _a(_jAddr(j, ".flap.configAdmin"))),
            ",",
            _kv("launcherFactory", _a(_jAddr(j, ".flap.launcherFactory"))),
            ",",
            _kv("vaultFactory", _a(_jAddr(j, ".flap.vaultFactory"))),
            ","
        );
        string memory rows = "[";
        for (uint256 i; vm.keyExistsJson(j, string.concat(".flap.launchers[", vm.toString(i), "]")); ++i) {
            string memory k = string.concat(".flap.launchers[", vm.toString(i), "]");
            rows = string.concat(
                rows,
                i == 0 ? "{" : ",{",
                _kv("launcher", _a(_jAddr(j, string.concat(k, ".launcher")))),
                ",",
                _kv("token", _a(_jAddr(j, string.concat(k, ".token")))),
                ",",
                _kv("vault", _a(_jAddr(j, string.concat(k, ".vault")))),
                ",",
                _kv("poolId", _q(_jStr(j, string.concat(k, ".poolId")))),
                "}"
            );
        }
        return string.concat(s, _kv("launchers", string.concat(rows, "]")), "}");
    }

    function _orAddr(string memory j, string memory key, address dflt) internal view returns (address a) {
        a = _jAddr(j, key);
        if (a == address(0)) a = dflt;
    }

    function _openfourPlaceholder() internal pure returns (string memory) {
        string memory z = _a(address(0));
        string memory a = string.concat(
            "{",
            _kv("registry", z),
            ",",
            _kv("core", z),
            ",",
            _kv("tools", z),
            ",",
            _kv("feeRouter", z),
            ",",
            _kv("presetId", "null"),
            ","
        );
        return string.concat(
            a,
            _kv("migrateModule", z),
            ",",
            _kv("customDataModule", z),
            ",",
            _kv("validator", z),
            ",",
            _kv("backstopTreasury", z),
            ",",
            _kv("tokens", "[]"),
            "}"
        );
    }

    function _erc8004Json() internal view returns (string memory) {
        string memory agentId = "null";
        string memory path = _deploymentsPath();
        if (vm.isFile(path)) {
            (uint256 id, bool ok) = _jUint(vm.readFile(path), ".erc8004.agentId");
            if (ok) agentId = vm.toString(id);
        }
        return string.concat(
            "{",
            _kv("identity", _q("0x8004A818BFB912233c491871b3d84c89A494BD9e")),
            ",",
            _kv("reputation", _q("0x8004B663056A597Dffe9eCcC1965A193B7388713")),
            ",",
            _kv("agentId", agentId),
            "}"
        );
    }

    function _logSummary() internal view {
        _log("deployer", deployer);
        _log("tNVDA", address(tNVDA));
        _log("tTSLA", address(tTSLA));
        _log("mUSDC", address(mUSDC));
        _log("PoolLogic", poolLogic);
        _log("PoolFactory", address(factory));
        _log("RiskOracle", address(risk));
        _log("MarketCalendar", address(calendar));
        _log("LogAnchor", address(logAnchor));
        _log("AtlasMirror NVDA", address(mirrorNVDA));
        _log("AtlasMirror TSLA", address(mirrorTSLA));
        _log("AtlasPullAdapter NVDA", address(pullNVDA));
        _log("ScenarioFeed NVDA", scenarioNVDA);
        _log("MockRouter", address(mockRouter));
        _log("SandboxFactory", address(sandbox));
        _log("Timelock", address(timelock));
        _log("Guardian", guardian);
        console2.log("admin handed to timelock:", handoffNow);
    }
}
