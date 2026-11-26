// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPortal, IPortalTypes} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {LaunchVaultAddresses} from "src/flap/LaunchVaultAddresses.sol";
import {LauncherDataSchema, VaultDataSchema} from "src/flap/IVaultSchemas.sol";

import {SplitLauncher, SplitConfig} from "src/launch/SplitLauncher.sol";
import {SplitLauncherFactory} from "src/launch/SplitLauncherFactory.sol";
import {BackstopVault} from "src/launch/BackstopVault.sol";
import {BackstopVaultFactory} from "src/launch/BackstopVaultFactory.sol";
import {SplitStockConfig} from "src/launch/SplitStockConfig.sol";
import {SplitPoolConfig, FLAP_TOKEN_IMPL} from "src/launch/ISplitLaunch.sol";

import {ILeveragePool} from "src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "src/interfaces/IRiskOracle.sol";
import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";
import {Roles} from "src/interfaces/SplitConstants.sol";
import {LeveragePool} from "src/core/LeveragePool.sol";
import {SplitToken} from "src/core/SplitToken.sol";
import {StabilityPool} from "src/core/StabilityPool.sol";
import {PoolFactory} from "src/core/PoolFactory.sol";
import {PoolMath} from "src/core/PoolMath.sol";
import {RiskOracle} from "src/core/RiskOracle.sol";
import {MarketCalendar} from "src/core/MarketCalendar.sol";
import {MockERC20Permit} from "src/mocks/MockERC20Permit.sol";
import {MockAggregator} from "src/mocks/MockAggregator.sol";

interface IProxyAdminLike {
    function owner() external view returns (address);
}

interface IAggV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IPcsRouter {
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256, uint256, uint256);
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface IPcsFactory {
    function getPair(address, address) external view returns (address);
}

interface IFlapRouterLike {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata, address, uint256)
        external
        payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256, uint256, address[] calldata, address, uint256)
        external;
}

interface IPcsPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function sync() external;
}

interface IWBNB {
    function deposit() external payable;
}

interface ITaxTokenLike {
    function taxProcessor() external view returns (address);
}

interface ITaxProcessorLike {
    function dispatch() external;
    function feeQuoteBalance() external view returns (uint256);
    function marketQuoteBalance() external view returns (uint256);
    function pendingDividendQuoteTokenBalance() external view returns (uint256);
    function lpQuoteBalance() external view returns (uint256);
}

/// @notice Pre-enable fork simulation of the SplitStock Flap pair against the LIVE BSC-testnet Portal (v1.2.0).
///         Everything Flap owns is real (Portal, token impl, tax processor, Flap V2 router, PancakeSwap v2); only the
///         SplitStock core is deployed in-fork (real src/core contracts + mock tNVDA / mUSDC / NVDA feed), because the
///         core is not final. The Atlas BNB/USD feed is the real one on 97. The core is deployed FIRST, because
///         the SplitStockConfig is immutable (fixed per factory pair) and is built from it, as in DeployFlap.s.sol.
///
///   forge test --match-path test/fork/FlapLaunchFork.t.sol --out out-flap --cache-path cache-flap -vvv
///   (FLAP_FORK_RPC overrides the BSC testnet RPC endpoint.)
contract FlapLaunchForkTest is Test {
    string internal constant RPC = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";

    address internal constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address internal constant PORTAL_PROXY_ADMIN = 0x0000Ed588dfc01749C20bA69b5f8c77d706E0000;
    address internal constant FLAP_GUARDIAN = 0x00004d58290854c5E9880F4b5B1993c6Ad8b0000;
    address internal constant FLAP_V2_ROUTER = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address internal constant PCS_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    address internal constant ATLAS_BNB_USD = 0x3957d289ee9C38272377786787ea34F9dd29788D;
    address internal constant WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;

    bytes32 internal constant NVDA = keccak256("NVDA");
    bytes32 internal constant LAUNCHED_TOPIC = keccak256("FlapDirectLaunched(address,uint8,address,bytes32,bytes)");
    bytes32 internal constant LAUNCHER_CREATED_TOPIC =
        keccak256("FlapNewLauncherCreated(address,address,address,string)");

    IPortal internal portal = IPortal(PORTAL);
    address internal flapAdmin;

    // Plain accounts with no code on BSC testnet (same pattern as Flap's ForkBase).
    address internal creator = address(uint160(0xC0DE0001));
    address internal alice = address(uint160(0xC0DE0002));
    address internal bob = address(uint160(0xC0DE0003));
    address internal trader = address(uint160(0xC0DE0004));
    address internal carol = address(uint160(0xC0DE0005));

    // SplitStock core stand-ins.
    MockERC20Permit internal tNVDA;
    MockERC20Permit internal mUSDC;
    MockERC20Permit internal sUSDBoost;
    MockAggregator internal nvdaFeed;
    PoolFactory internal poolFactory;
    RiskOracle internal riskOracle;
    address internal scenarioPool;

    // What Flap enables.
    SplitStockConfig internal config;
    BackstopVaultFactory internal vf;
    SplitLauncherFactory internal lf;

    uint256 internal saltCounter;

    // Journey state (kept in storage so each phase stays under the stack limit).
    SplitLauncher internal jl;
    address internal jToken;
    address internal jVault;

    function setUp() public {
        vm.createSelectFork(vm.envOr("FLAP_FORK_RPC", RPC));
        require(block.chainid == 97, "not BSC testnet");
        assertEq(PORTAL, LaunchVaultAddresses.hub(), "hub");
        assertEq(FLAP_GUARDIAN, LaunchVaultAddresses.guardian(), "guardian");

        flapAdmin = IProxyAdminLike(PORTAL_PROXY_ADMIN).owner();
        assertTrue(IAccessControl(PORTAL).hasRole(keccak256("AUDITOR_ROLE"), flapAdmin), "admin holds AUDITOR_ROLE");
        console2.log("Portal", PORTAL, "admin/auditor", flapAdmin);

        vm.deal(creator, 10 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.deal(trader, 500 ether);
        vm.deal(address(this), 500 ether);
        require(
            creator.code.length + alice.code.length + bob.code.length + trader.code.length + carol.code.length == 0,
            "test accounts have code"
        );

        // The core first: the config is immutable and is built from it.
        _deployCore();
        // The deploy order of DeployFlap.s.sol: config, vault factory at the predicted address, launcher factory.
        (config, vf, lf) = _deployPair(_poolCfg(), "NVDA");
    }

    /// @dev DeployFlap.s.sol order: immutable config (nonce+0), vault factory (nonce+1, knows the predicted launcher
    ///      factory), launcher factory (nonce+2).
    function _deployPair(SplitPoolConfig memory pc, string memory sym)
        internal
        returns (SplitStockConfig cfg_, BackstopVaultFactory vf_, SplitLauncherFactory lf_)
    {
        uint256 n = vm.getNonce(address(this));
        address predictedLf = vm.computeCreateAddress(address(this), n + 2);
        cfg_ = new SplitStockConfig(pc, sym);
        vf_ = new BackstopVaultFactory(PORTAL, FLAP_GUARDIAN, predictedLf);
        lf_ = new SplitLauncherFactory(PORTAL, FLAP_GUARDIAN, address(vf_), address(cfg_));
        assertEq(address(lf_), predictedLf, "launcher factory prediction");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Core stand-ins (deployed BEFORE the factories: the immutable config is built from them)
    // ═════════════════════════════════════════════════════════════════════════

    function _deployCore() internal {
        tNVDA = new MockERC20Permit("Test NVDA (MOCK)", "tNVDA", 18, address(this), 0, 1 days);
        mUSDC = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", 6, address(this), 0, 1 days);
        sUSDBoost = new MockERC20Permit("sUSD stand-in (MOCK)", "sUSD", 18, address(this), 0, 1 days);
        nvdaFeed = new MockAggregator(8, 180e8, "NVDA / USD (mock)");
        RiskOracle risk = new RiskOracle(address(this));
        riskOracle = risk;
        risk.grantRole(Roles.POSTER_ROLE, address(this));
        MarketCalendar cal = new MarketCalendar(address(this));
        risk.configureAsset(NVDA, _nvdaConfig());
        poolFactory = new PoolFactory(
            address(this),
            address(mUSDC),
            address(risk),
            address(cal),
            address(new LeveragePool()),
            address(new SplitToken()),
            address(new StabilityPool()),
            PoolMath.defaultParams()
        );
        // A demo ScenarioPool (the vault's second, capped tranche).
        scenarioPool = poolFactory.createPool(
            address(tNVDA), address(nvdaFeed), NVDA, "NVDA", PCS_ROUTER, ILeveragePool.PoolKind.SCENARIO
        );

        // PancakeSwap v2 testnet WBNB/tNVDA pair at the live Atlas BNB/USD over the NVDA price.
        (, int256 bnbUsd,,,) = IAggV3(ATLAS_BNB_USD).latestRoundData(); // 18 decimals on 97
        uint256 bnbIn = 100 ether;
        uint256 nvdaOut = bnbIn * uint256(bnbUsd) / 180e18;
        tNVDA.mint(address(this), nvdaOut);
        tNVDA.approve(PCS_ROUTER, nvdaOut);
        IPcsRouter(PCS_ROUTER).addLiquidityETH{value: bnbIn}(
            address(tNVDA), nvdaOut, 0, 0, address(this), vm.getBlockTimestamp() + 600
        );
        address pair = IPcsFactory(IPcsRouter(PCS_ROUTER).factory()).getPair(WBNB, address(tNVDA));
        assertTrue(pair != address(0), "WBNB/tNVDA pair");
        console2.log("Atlas BNB/USD (1e18)", uint256(bnbUsd));
        console2.log("PCS WBNB/tNVDA pair", pair, "tNVDA in", nvdaOut);
    }

    function _poolCfg() internal view returns (SplitPoolConfig memory c) {
        c = SplitPoolConfig({
            poolFactory: address(poolFactory),
            asset: address(tNVDA),
            feed: address(nvdaFeed),
            assetId: NVDA,
            poolRouter: PCS_ROUTER,
            swapRouter: PCS_ROUTER,
            atlasBnbUsd: ATLAS_BNB_USD,
            scenarioPool: scenarioPool,
            boostToken: address(sUSDBoost)
        });
    }

    function _enable() internal {
        _enablePair(address(lf), address(vf));
    }

    function _enablePair(address lf_, address vf_) internal {
        vm.startPrank(flapAdmin);
        portal.setLauncherFactoryMultiplier(lf_, 10_000, true);
        portal.setVaultFactoryMultiplier(vf_, 10_000, true);
        vm.stopPrank();
        (bool on, uint16 m) = portal.launcherFactoryMultiplier(lf_);
        assertTrue(on, "launcher factory enabled");
        assertEq(m, 10_000);
    }

    function _nvdaConfig() internal pure returns (IRiskOracle.AssetConfig memory) {
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

    function _mineSalt(bytes32 seed) internal returns (bytes32 salt) {
        uint256 start = ++saltCounter << 128;
        for (uint256 i = start;; ++i) {
            assembly ("memory-safe") {
                mstore(0x00, seed)
                mstore(0x20, i)
                salt := keccak256(0x00, 0x40)
            }
            if (uint16(uint160(Clones.predictDeterministicAddress(FLAP_TOKEN_IMPL, salt, PORTAL))) == 0x7777) {
                return salt;
            }
        }
    }

    function _cfg(bytes32 seed, uint256 target, uint256 seedBnb, uint256 duration)
        internal
        returns (SplitConfig memory c)
    {
        c.name = "SplitStock Backstop";
        c.symbol = "SPLIT";
        c.meta = "bafkreig4y5nwb4izyilbbmiydumvkld446d4k7j4ohg3x3q2lfel3fo4yq";
        c.salt = _mineSalt(seed);
        c.targetRaise = target;
        c.backstopSeed = seedBnb;
        c.saleDuration = duration;
        c.vaultFactory = address(vf);
    }

    function _newLauncher(SplitConfig memory c) internal returns (SplitLauncher l) {
        return _newLauncherOn(lf, c);
    }

    function _newLauncherOn(SplitLauncherFactory f, SplitConfig memory c) internal returns (SplitLauncher l) {
        // Every Launcher needs CREATOR_ROLE on PoolFactory before openPool (address is predictable).
        poolFactory.grantRole(Roles.CREATOR_ROLE, f.predictLauncher(c.salt));
        uint256 fee = portal.SALT_LOCK_FEE();
        vm.startPrank(creator);
        l = SplitLauncher(payable(portal.newLauncher{value: fee}(address(f), abi.encode(c))));
        vm.stopPrank();
    }

    /// @dev External so `vm.expectRevert` sees the constructor revert one call deeper than the test.
    function deployConfig(SplitPoolConfig memory pc, string memory sym) external returns (address) {
        return address(new SplitStockConfig(pc, sym));
    }

    function deployLauncherFactory(address config_) external returns (address) {
        return address(new SplitLauncherFactory(PORTAL, FLAP_GUARDIAN, address(vf), config_));
    }

    /// @dev The selectors of the old admin-updatable SplitStockConfig: none may exist on the immutable one.
    function _assertNoConfigSetter(address cfg_) internal {
        SplitPoolConfig memory any;
        bytes[8] memory calls = [
            abi.encodeWithSignature(
                "setPoolConfig((address,address,address,bytes32,address,address,address,address,address),string)",
                any,
                "NVDX"
            ),
            abi.encodeWithSignature("applyPoolConfig()"),
            abi.encodeWithSignature("cancelPoolConfig()"),
            abi.encodeWithSignature("transferAdmin(address)", alice),
            abi.encodeWithSignature("acceptAdmin()"),
            abi.encodeWithSignature("admin()"),
            abi.encodeWithSignature("guardian()"),
            abi.encodeWithSignature("pending()")
        ];
        address[3] memory callers = [address(this), FLAP_GUARDIAN, alice];
        for (uint256 i; i < calls.length; ++i) {
            for (uint256 k; k < callers.length; ++k) {
                vm.prank(callers[k]);
                (bool ok,) = cfg_.call(calls[i]);
                assertFalse(ok, "immutable config: no admin / setter / queue / guardian function");
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 1. Gates, schemas, description
    // ═════════════════════════════════════════════════════════════════════════

    function test_01_gates_schemas_and_immutableConfig() public {
        // The factory pair is born with its (immutable) config.
        assertTrue(lf.configured(), "config fixed at deploy");
        assertEq(lf.config(), address(config));
        assertEq(lf.pairedVaultFactory(), address(vf));
        assertEq(vf.launcherFactory(), address(lf));
        assertEq(lf.factorySpecVersion(), "lf-v1");
        assertEq(vf.factorySpecVersion(), "pl-v1");

        bytes32 salt = _mineSalt("gate");
        SplitConfig memory c;
        c.name = "Gate";
        c.symbol = "GATE";
        c.salt = salt;
        c.targetRaise = 4.7 ether;
        c.backstopSeed = 0.2 ether;
        c.saleDuration = 1 hours;
        c.vaultFactory = address(vf);
        uint256 fee = portal.SALT_LOCK_FEE();

        // (a) Not enabled by Flap. Observed on the live Portal v1.2.0 (97): neither `newLauncher` nor the launch
        //     (`launchTaxTokenV2` from the filling contribution) checks the multiplier's `enabled` flag; enabling
        //     sets the multiplier (creation floor) and the listing. The old version of this test only saw a revert
        //     because of our own ConfigUnset. Recorded here, not asserted, so a Portal-side gate later is fine too.
        poolFactory.grantRole(Roles.CREATOR_ROLE, lf.predictLauncher(c.salt));
        vm.startPrank(creator);
        (bool okNew, bytes memory retNew) =
            PORTAL.call{value: fee}(abi.encodeCall(IPortal.newLauncher, (address(lf), abi.encode(c))));
        vm.stopPrank();
        console2.log("     before enable: Portal.newLauncher ok =", okNew);
        if (okNew) {
            SplitLauncher pre = SplitLauncher(payable(abi.decode(retNew, (address))));
            vm.startPrank(bob);
            (bool okLaunch,) = address(pre).call{value: 4.7 ether}(abi.encodeCall(SplitLauncher.contribute, ()));
            vm.stopPrank();
            console2.log("     before enable: filling contribution (launch) ok =", okLaunch);
        }

        // (b) The factory refuses a config pointer that is not a contract.
        vm.expectRevert(abi.encodeWithSelector(SplitLauncherFactory.NoCode.selector, alice));
        this.deployLauncherFactory(alice);
        console2.log("[ok] factory refuses a config without code");

        // (c) Schemas.
        LauncherDataSchema memory ls = lf.launcherDataSchema();
        assertEq(ls.fields.length, 8, "8 launcher fields");
        string[8] memory names =
            ["name", "symbol", "meta", "salt", "targetRaise", "backstopSeed", "saleDuration", "vaultFactory"];
        for (uint256 i; i < 8; ++i) {
            assertEq(ls.fields[i].name, names[i], "launcher field order = SplitConfig order");
        }
        assertFalse(ls.isArray);
        VaultDataSchema memory vs = vf.vaultDataSchema();
        assertEq(vs.fields.length, 2, "2 vault fields");
        assertEq(vs.fields[0].name, "launcher");
        assertEq(vs.fields[1].name, "scenarioPool");
        console2.log("[ok] launcherDataSchema 8 fields, vaultDataSchema 2 fields");

        // (d) The flap-ui tuple encoding (one `tuple` param) is abi.encode(SplitConfig): first word is offset 0x20.
        bytes memory enc = abi.encode(c);
        assertEq(uint256(bytes32(enc)), 0x20, "single tuple head");

        // (e) Floor.
        (uint256 floorWei, bool known) = lf.creationFloor();
        assertTrue(known, "launchQuoteConfig readable");
        console2.log("creation floor (wei)", floorWei, "minPoolQuote (wei)", lf.minPoolQuote());

        // (f) SplitStockConfig is immutable: the values it was built with, version 1, and no function that could
        //     change them (Flap review: only the Guardian may change where funds go, so here nobody can).
        SplitPoolConfig memory want = _poolCfg();
        assertEq(keccak256(abi.encode(config.poolConfig())), keccak256(abi.encode(want)), "config = constructor args");
        assertEq(keccak256(abi.encode(lf.poolConfig())), keccak256(abi.encode(want)), "factory view = config");
        assertEq(config.poolSymbol(), "NVDA");
        assertEq(lf.poolSymbol(), "NVDA");
        assertEq(config.version(), 1);
        assertTrue(config.isConfigured());
        (SplitPoolConfig memory cur, string memory curSym, bool on) = config.current();
        assertEq(keccak256(abi.encode(cur)), keccak256(abi.encode(want)));
        assertEq(curSym, "NVDA");
        assertTrue(on);
        _assertNoConfigSetter(address(config));
        console2.log("[ok] SplitStockConfig: immutable (v1), no setter / admin / queue / guardian function");

        // (g) Enabled: the config was fixed before the factory existed, so newLauncher just works.
        _enable();
        SplitLauncher l = _newLauncher(_cfg("gate-ok", 4.7 ether, 0.2 ether, 1 hours));
        assertEq(keccak256(abi.encode(l.poolConfig())), keccak256(abi.encode(want)), "launcher copies the fixed config");
        assertEq(l.poolSymbol(), "NVDA");
    }

    function test_02_strictDecode_and_floorGuard() public {
        _enable();
        uint256 fee = portal.SALT_LOCK_FEE();

        SplitConfig memory c = _cfg("strict", 4.7 ether, 0.2 ether, 1 hours);
        vm.startPrank(creator);
        vm.expectRevert(SplitLauncherFactory.InvalidData.selector);
        portal.newLauncher{value: fee}(address(lf), bytes.concat(abi.encode(c), bytes32(0)));
        vm.stopPrank();

        // Pool quote 2.0 tBNB is below 1.1x the 50/50 floor (about 2.36 tBNB at BNB $700, multiplier 10000).
        c.targetRaise = 2.2 ether;
        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(SplitLauncherFactory.BelowFloor.selector, 2 ether, lf.minPoolQuote())
        );
        portal.newLauncher{value: fee}(address(lf), abi.encode(c));
        vm.stopPrank();

        // A salt whose token does not end in 7777: the factory no longer re-checks it (no hard-coded token impl in the
        // frozen bytecode); the Portal's own lockSalt refuses it.
        c.targetRaise = 4.7 ether;
        c.salt = keccak256("not-mined");
        address bad = Clones.predictDeterministicAddress(FLAP_TOKEN_IMPL, c.salt, PORTAL);
        (, bool okSalt) = lf.predictToken(c.salt);
        assertFalse(okSalt, "predictToken flags the unmined salt");
        if (uint16(uint160(bad)) != 0x7777) {
            vm.startPrank(creator);
            (bool ok, bytes memory ret) =
                PORTAL.call{value: fee}(abi.encodeCall(IPortal.newLauncher, (address(lf), abi.encode(c))));
            vm.stopPrank();
            assertFalse(ok, "Portal lockSalt refuses a non-7777 salt");
            console2.log("     unmined salt -> Portal revert selector:");
            console2.logBytes4(bytes4(ret));
        }
        console2.log("[ok] trailing bytes -> InvalidData, quote 2.0 -> BelowFloor, unmined salt -> Portal refuses");
    }

    /// @dev Flap README minimum suite items that apply here: Hub-only entry points, Guardian-only upgrade and
    ///      forceFail, a stranger launch naming our vault factory.
    function test_05_hubGuardianAndStrangerChecks() public {
        _enable();

        vm.expectRevert(abi.encodeWithSignature("NotHub(address)", address(this)));
        lf.newLauncher(creator, "");
        vm.expectRevert(abi.encodeWithSignature("NotHub(address)", address(this)));
        vf.newVault(address(1), creator, 0, "");

        address newImpl = address(new SplitLauncher());
        vm.expectRevert(abi.encodeWithSignature("NotGuardian(address)", address(this)));
        lf.upgradeVaultImplementation(newImpl);
        address newVaultImpl = address(new BackstopVault());
        vm.expectRevert(abi.encodeWithSignature("NotGuardian(address)", address(this)));
        vf.upgradeVaultImplementation(newVaultImpl);

        // Guardian: forceFail before launch opens refunds; nothing else.
        SplitLauncher l = _newLauncher(_cfg("guardian", 4.7 ether, 0.2 ether, 1 days));
        vm.startPrank(alice);
        l.contribute{value: 0.4 ether}();
        vm.expectRevert(abi.encodeWithSignature("NotGuardian(address)", alice));
        l.forceFail();
        vm.stopPrank();
        vm.startPrank(FLAP_GUARDIAN);
        l.forceFail();
        lf.upgradeVaultImplementation(newImpl);
        vm.stopPrank();
        assertEq(lf.beaconImplementation(), newImpl, "guardian upgraded the beacon");
        assertEq(l.contributions(alice), 0.4 ether, "state survives the upgrade");
        assertTrue(l.failed());
        uint256 before = alice.balance;
        vm.startPrank(alice);
        l.refund();
        vm.stopPrank();
        assertEq(alice.balance - before, 0.4 ether, "refund after forceFail");

        // A launch that names our vault factory from an address the Portal never recorded as our Launcher.
        IPortalTypes.FeeConfig[] memory fees = new IPortalTypes.FeeConfig[](3);
        fees[0] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeSlotType.VAULT,
            bps: 5000,
            configData: abi.encode(
                IPortalTypes.FeeConfigVault({vaultFactory: address(vf), vaultData: abi.encode(creator, scenarioPool)})
            )
        });
        fees[1] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.LP_BPS, bps: 2000, configData: ""});
        fees[2] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.DEFLATION, bps: 3000, configData: ""});
        IPortalTypes.CreateTaxTokenParams memory p;
        p.name = "Stranger";
        p.symbol = "STR";
        p.totalSupply = 1_000_000 ether;
        p.salt = _mineSalt("stranger");
        p.poolQuote = 2 ether;
        p.poolToken = 1_000_000 ether;
        p.buyTaxRate = 300;
        p.sellTaxRate = 300;
        p.taxDuration = 30 days;
        p.antiFarmerDuration = 1 days;
        p.feeConfigs = fees;
        Distribution memory d;
        IPortalTypes.CreatorBuyParams memory noBuy;
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(BackstopVaultFactory.NotFromLauncherFactory.selector, creator));
        portal.launchTaxTokenV2{value: 2 ether}(p, d, noBuy);
        vm.stopPrank();
        console2.log("[ok] NotHub x2, NotGuardian x3, guardian forceFail+upgrade, stranger launch refused");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. Full journey
    // ═════════════════════════════════════════════════════════════════════════

    function test_03_fullJourney_launch_trade_dispatch_openPool_claim() public {
        _enable();

        _journeyCreate();
        _journeyContribute();
        _journeyTrade();
        _journeyOpenPool();
        _journeyClaim();
    }

    function _journeyCreate() internal {
        // ── newLauncher (mined 7777 salt, exactly SALT_LOCK_FEE)
        SplitConfig memory c = _cfg("journey", 4.7 ether, 0.2 ether, 3 days);
        vm.recordLogs();
        SplitLauncher l = _newLauncher(c);
        Vm.Log[] memory creation = vm.getRecordedLogs();
        assertEq(portal.getLauncher(address(l)).launcherFactory, address(lf), "Portal recorded the Launcher");
        assertEq(l.creator(), creator);
        assertEq(l.predictedToken(), Clones.predictDeterministicAddress(FLAP_TOKEN_IMPL, c.salt, PORTAL));
        console2.log("[ok] newLauncher", address(l), "predicted token", l.predictedToken());

        // description(): v1 JSON, < 4096 bytes, same string in FlapNewLauncherCreated.
        string memory d = l.description();
        console2.log("description bytes", bytes(d).length);
        assertLt(bytes(d).length, 4096, "description < 4096 bytes");
        assertEq(_descriptionFromLogs(creation, address(l)), d, "event carries description()");
        assertTrue(_contains(d, '{"v":1,"name":"SplitStock Backstop"'), "v1 json");
        assertTrue(_contains(d, '"poolTokenRatio":"500000000000000000"'), "50% pool");

        // ── Snapshot = the factory pair's fixed config; nobody (admin, Guardian, stranger) can change it mid-sale.
        SplitPoolConfig memory snap = l.poolConfig();
        assertEq(snap.scenarioPool, scenarioPool);
        assertEq(snap.poolFactory, address(poolFactory));
        assertEq(keccak256(abi.encode(snap)), keccak256(abi.encode(config.poolConfig())), "snapshot = fixed config");
        _assertNoConfigSetter(address(config));
        assertEq(l.scenarioPool(), scenarioPool, "launcher ScenarioPool");
        assertEq(l.boostToken(), address(sUSDBoost), "launcher boost token");
        assertEq(l.poolSymbol(), "NVDA", "launcher pool symbol");
        console2.log("[ok] config has no setter: the sale's pool target cannot change mid-sale");
        jl = l;
    }

    function _journeyContribute() internal {
        SplitLauncher l = jl;

        // ── Contributions: alice boosted 0.5, bob fills the remaining 4.2 (launch in the same tx).
        sUSDBoost.mint(alice, 100 ether);
        vm.startPrank(alice);
        sUSDBoost.approve(address(l), 100 ether);
        l.contributeBoosted{value: 0.5 ether}();
        vm.stopPrank();
        assertEq(l.remaining(), 4.2 ether);

        // A 1-wei front-run of the final contribution no longer blocks it: bob sends 4.25, 4.2 - 1 wei is taken
        // and the rest comes back in the same call.
        vm.startPrank(carol);
        l.contribute{value: 1}();
        vm.stopPrank();
        uint256 bobBefore = bob.balance;
        vm.recordLogs();
        vm.startPrank(bob);
        l.contribute{value: 4.25 ether}();
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(bobBefore - bob.balance, 4.2 ether - 1, "only the remaining amount was taken");
        assertEq(l.contributions(bob), 4.2 ether - 1);
        assertTrue(_hasTopic(logs, address(l), keccak256("ExcessReturned(address,uint256)")), "ExcessReturned");

        assertTrue(l.launched(), "launched");
        address token = l.token();
        assertEq(token, l.predictedToken(), "token at the predicted 7777 address");
        assertEq(uint16(uint160(token)), 0x7777);
        assertEq(_launchedCreator(logs, token), creator, "FlapDirectLaunched shows the user");
        assertTrue(_hasTopic(logs, address(l), keccak256("FlapDistributionInitialized(address,uint256)")), "dist init");
        // Pool quote 4.5 tBNB >= the 50/50 graduation floor (about 4.29 tBNB at $700, multiplier 10000): graduated at launch.
        assertTrue(_hasTopic(logs, PORTAL, keccak256("FlapTokenGraduated(address)")), "FlapTokenGraduated at launch");
        assertEq(IERC20(token).balanceOf(address(l)), 500_000 ether, "500,000 reserve in the Launcher");
        (address vaultAddr, address vfAddr) = portal.getLaunchVault(token);
        assertEq(vfAddr, address(vf), "vault from the paired factory");
        assertEq(l.backstopVault(), vaultAddr);
        BackstopVault vault = BackstopVault(payable(vaultAddr));
        assertEq(vault.launcher(), address(l));
        assertEq(vault.scenarioPool(), scenarioPool, "vault uses the launcher's snapshot, not the live config");
        assertEq(vault.usdc(), address(mUSDC));
        assertEq(address(l).balance, 0.2 ether, "seed kept for openPool");
        console2.log("[ok] FlapDirectLaunched token", token);
        console2.log("     vault", vaultAddr, "lpPair", l.lpPair());
        jToken = token;
        jVault = vaultAddr;
    }

    function _journeyTrade() internal {
        address token = jToken;
        address vaultAddr = jVault;
        BackstopVault vault = BackstopVault(payable(vaultAddr));

        // ── Trade on the Flap V2 router (fee-on-transfer) and dispatch the tax.
        vm.warp(vm.getBlockTimestamp() + 601);
        uint256 vaultBefore = vaultAddr.balance;
        _generateTaxAndDispatch(token);
        uint256 revenue = vaultAddr.balance - vaultBefore;
        assertGt(revenue, 0, "VAULT slot paid the BackstopVault");
        assertEq(vault.totalRevenue(), vaultAddr.balance, "receive() recognized the revenue");
        console2.log("[ok] dispatch -> vault received (wei)", revenue);
    }

    function _journeyOpenPool() internal {
        SplitLauncher l = jl;
        address vaultAddr = jVault;
        BackstopVault vault = BackstopVault(payable(vaultAddr));

        // ── openPool: new SplitStock pool, seeded, first-loss x held by the vault.
        nvdaFeed.setAnswer(180e8); // the pool requires a price younger than maxPriceAge
        vm.recordLogs();
        address pool = l.openPool();
        Vm.Log[] memory openLogs = vm.getRecordedLogs();
        assertTrue(poolFactory.isPool(pool), "PoolFactory pool");
        IPoolFactory.PoolInfo memory info = poolFactory.poolInfo(pool);
        assertEq(info.symbol, "NVDA", "the fixed pool symbol");
        assertEq(info.creator, address(l));
        uint256 xHeld = IERC20(info.xToken).balanceOf(vaultAddr);
        assertGt(xHeld, 0, "xNVDA held by the vault");
        assertEq(xHeld, l.xLocked());
        assertTrue(ILeveragePool(pool).isDonor(vaultAddr), "vault is donor");
        assertEq(l.seedBalance(), 0);
        assertEq(address(l).balance, 0, "seed spent");
        assertGt(tNVDA.balanceOf(pool), 0, "pool holds tNVDA");
        assertTrue(_hasTopic(openLogs, address(l), keccak256("PoolOpened(address,uint256,uint256)")));
        assertEq(vault.livePool(), pool);
        console2.log("[ok] openPool", pool);
        console2.log("     tNVDA seeded", tNVDA.balanceOf(pool), "xNVDA in vault", xHeld);
    }

    function _journeyClaim() internal {
        SplitLauncher l = jl;
        address token = jToken;

        // ── Claims: alice weight 0.6 (0.5 x 1.2), bob 4.2 - 1 wei, carol 1 wei -> total 4.8 of 500,000.
        vm.startPrank(alice);
        l.claim();
        vm.stopPrank();
        vm.startPrank(bob);
        l.claim();
        vm.stopPrank();
        uint256 a = IERC20(token).balanceOf(alice);
        uint256 b = IERC20(token).balanceOf(bob);
        assertEq(a, uint256(500_000 ether) * 0.6 ether / 4.8 ether, "alice 0.6/4.8");
        assertEq(b, uint256(500_000 ether) * (4.2 ether - 1) / 4.8 ether, "bob 4.2/4.8");
        assertEq(sUSDBoost.balanceOf(alice), 100 ether, "escrow returned");
        vm.startPrank(alice);
        vm.expectRevert(SplitLauncher.AlreadyClaimed.selector);
        l.claim();
        vm.stopPrank();
        console2.log("[ok] claim alice", a, "bob", b);

        vm.startPrank(carol); // the 1-wei front-runner
        l.claim();
        vm.stopPrank();
        uint256 dust = IERC20(token).balanceOf(address(l));
        if (dust > 0) l.sweepDust();
        console2.log("     dust swept to vault", dust);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 3. Missed target -> refund
    // ═════════════════════════════════════════════════════════════════════════

    function test_04_missedTarget_refund() public {
        _enable();
        SplitConfig memory c = _cfg("refund", 4.7 ether, 0.2 ether, 10 minutes);
        SplitLauncher l = _newLauncher(c);

        sUSDBoost.mint(carol, 100 ether);
        uint256 before = carol.balance;
        vm.startPrank(carol);
        sUSDBoost.approve(address(l), 100 ether);
        l.contributeBoosted{value: 0.3 ether}();
        vm.expectRevert(SplitLauncher.NotRefundable.selector);
        l.refund();
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 10 minutes + 1);
        assertTrue(l.failed(), "failed after the deadline");
        assertEq(l.remaining(), 0);
        vm.startPrank(carol);
        vm.expectRevert(SplitLauncher.SaleClosed.selector);
        l.contribute{value: 0.1 ether}();
        vm.stopPrank();

        // A boost token that refuses the escrow transfer no longer blocks the BNB refund.
        vm.mockCallRevert(
            address(sUSDBoost), abi.encodeWithSelector(IERC20.transfer.selector, carol, 100 ether), "blocked"
        );
        vm.startPrank(carol);
        l.refund();
        vm.expectRevert(SplitLauncher.NothingToRefund.selector);
        l.refund();
        vm.stopPrank();
        assertEq(carol.balance, before, "1x refund despite the failing escrow token");
        assertEq(l.escrowOwed(carol), 100 ether, "escrow recorded as owed");
        vm.clearMockedCalls();
        vm.startPrank(carol);
        l.withdrawEscrow();
        vm.expectRevert(SplitLauncher.NothingToClaim.selector);
        l.withdrawEscrow();
        vm.stopPrank();
        assertEq(sUSDBoost.balanceOf(carol), 100 ether, "escrow back via withdrawEscrow");
        assertEq(l.escrowHeld(), 0);
        assertEq(address(l).balance, 0, "nothing left");
        console2.log("[ok] missed target -> refund 0.3 tBNB; blocked escrow deferred, then withdrawEscrow 100 sUSD");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. Config fixed per factory pair: constructor validation, no setter, a new core = a new pair
    // ═════════════════════════════════════════════════════════════════════════

    function test_06_configFixedPerFactoryPair_validation_and_newPair() public {
        // Constructor validation (the same checks the old setPoolConfig ran).
        SplitPoolConfig memory bad = _poolCfg();
        bad.scenarioPool = address(tNVDA); // a contract, but not a PoolFactory pool
        vm.expectRevert(abi.encodeWithSelector(SplitStockConfig.NotAPool.selector, address(tNVDA)));
        this.deployConfig(bad, "NVDA");
        bad = _poolCfg();
        bad.poolFactory = address(tNVDA); // has code, but no usdc()
        vm.expectRevert(SplitStockConfig.NoPoolFactoryUsdc.selector);
        this.deployConfig(bad, "NVDA");
        bad = _poolCfg();
        bad.feed = address(0);
        vm.expectRevert(SplitStockConfig.ZeroAddress.selector);
        this.deployConfig(bad, "NVDA");
        bad = _poolCfg();
        bad.swapRouter = alice; // no code
        vm.expectRevert(abi.encodeWithSelector(SplitStockConfig.NoCode.selector, alice));
        this.deployConfig(bad, "NVDA");
        bad = _poolCfg();
        bad.boostToken = alice; // optional, but a contract when set
        vm.expectRevert(abi.encodeWithSelector(SplitStockConfig.NoCode.selector, alice));
        this.deployConfig(bad, "NVDA");
        bad = _poolCfg();
        bad.assetId = bytes32(0);
        vm.expectRevert(SplitStockConfig.EmptyAssetId.selector);
        this.deployConfig(bad, "NVDA");
        vm.expectRevert(SplitStockConfig.BadSymbol.selector);
        this.deployConfig(_poolCfg(), "");
        vm.expectRevert(SplitStockConfig.BadSymbol.selector);
        this.deployConfig(_poolCfg(), "ELEVENCHARS");
        console2.log("[ok] SplitStockConfig constructor: NotAPool, NoPoolFactoryUsdc, ZeroAddress, NoCode x2, EmptyAssetId, BadSymbol x2");

        // Pair A (the original) and a Launcher on it.
        _enable();
        SplitLauncher oldL = _newLauncher(_cfg("pair-a", 4.7 ether, 0.2 ether, 3 days));

        // "Changing the core" = a NEW config + factory pair (here: no ScenarioPool, no boost, symbol NVDB), which
        // Flap must enable separately. Pair A and its Launchers are untouched.
        SplitPoolConfig memory next = _poolCfg();
        next.scenarioPool = address(0);
        next.boostToken = address(0);
        (SplitStockConfig cfgB, BackstopVaultFactory vfB, SplitLauncherFactory lfB) = _deployPair(next, "NVDB");
        assertTrue(address(cfgB) != address(config) && address(lfB) != address(lf), "a new pair");
        _assertNoConfigSetter(address(cfgB));

        SplitConfig memory cB = _cfg("pair-b", 4.7 ether, 0.2 ether, 3 days);
        cB.vaultFactory = address(vfB);
        // A new pair is a new Flap enable request (its own multiplier). A Launcher of pair B cannot point at pair A's
        // vault factory.
        uint256 fee = portal.SALT_LOCK_FEE();
        SplitConfig memory cross = _cfg("pair-x", 4.7 ether, 0.2 ether, 3 days);
        _enablePair(address(lfB), address(vfB));
        vm.startPrank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(SplitLauncherFactory.WrongVaultFactory.selector, address(vf), address(vfB))
        );
        portal.newLauncher{value: fee}(address(lfB), abi.encode(cross));
        vm.stopPrank();

        SplitLauncher newL = _newLauncherOn(lfB, cB);
        assertEq(newL.poolSymbol(), "NVDB");
        assertEq(newL.scenarioPool(), address(0));
        assertEq(newL.boostToken(), address(0));
        // Pair A is unchanged.
        assertEq(lf.poolSymbol(), "NVDA");
        assertEq(lf.poolConfig().scenarioPool, scenarioPool);
        assertEq(oldL.poolSymbol(), "NVDA");
        assertEq(oldL.scenarioPool(), scenarioPool);
        console2.log("[ok] new core = new pair; pair A config and launchers unchanged; cross-pair vault factory refused");
    }

    /// @dev The PoolFactory admin (a core role, not the Flap Guardian) can call `setImplementations`. The config pins
    ///      the implementations at deploy, so openPool refuses swapped ones and the seed can only reach the vault.
    function test_08_openPool_refuses_swapped_core_implementations() public {
        (address pi, address ti, address si) = config.implementations();
        assertEq(pi, poolFactory.poolImpl(), "pinned poolImpl");
        assertEq(ti, poolFactory.tokenImpl(), "pinned tokenImpl");
        assertEq(si, poolFactory.stabilityPoolImpl(), "pinned stabilityPoolImpl");

        _enable();
        SplitLauncher l = _newLauncher(_cfg("impl-swap", 4.7 ether, 0.2 ether, 1 days));
        vm.startPrank(bob);
        l.contribute{value: 4.7 ether}();
        vm.stopPrank();
        assertTrue(l.launched());
        address vault = l.backstopVault();

        // Core admin swaps the pool implementation after the Launcher exists.
        poolFactory.setImplementations(address(new LeveragePool()), ti, si);
        nvdaFeed.setAnswer(180e8);
        vm.expectRevert(SplitLauncher.CoreImplementationChanged.selector);
        l.openPool();

        // Fail-closed: the seed can only go to the BackstopVault, after SEED_RELEASE_DELAY.
        vm.warp(block.timestamp + l.SEED_RELEASE_DELAY());
        uint256 before = vault.balance;
        l.releaseSeed();
        assertEq(vault.balance - before, 0.2 ether, "seed to vault");
        console2.log("[ok] swapped PoolFactory implementations: openPool refused, seed released to the vault");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 5. BackstopVault.cover: thin pair (halving), deep pair (full), ScenarioPool tranche
    // ═════════════════════════════════════════════════════════════════════════

    ILeveragePool internal cPool;
    BackstopVault internal cVault;
    uint256 internal cBnbUsd;

    function test_07_cover_livePool_thinThenDeep_and_scenarioTranche() public {
        _enable();
        _coverSetup();
        _coverThin();
        _coverDeep();
        _coverScenario();
    }

    function _coverSetup() internal {
        SplitLauncher l = _newLauncher(_cfg("cover", 4.7 ether, 0.2 ether, 1 days));
        vm.startPrank(bob);
        l.contribute{value: 4.7 ether}();
        vm.stopPrank();
        cVault = BackstopVault(payable(l.backstopVault()));
        (bool sent,) = address(cVault).call{value: 2 ether}(""); // stands in for tax revenue (test_03 proves dispatch)
        assertTrue(sent);
        assertEq(cVault.totalRevenue(), 2 ether);

        nvdaFeed.setAnswer(180e8);
        cPool = ILeveragePool(l.openPool());
        _postRef(180e18); // the pool's CMC reference breaker needs a fresh reference before any mint
        _mintStable(address(cPool), carol);

        // ScenarioPool tranche: seed + mint at $180, vault allowlisted as donor (PoolFactory admin).
        tNVDA.mint(address(this), 1 ether);
        tNVDA.approve(scenarioPool, 1 ether);
        ILeveragePool(scenarioPool).seed(1 ether, address(this));
        _mintStable(scenarioPool, alice);
        ILeveragePool(scenarioPool).setDonor(address(cVault), true);

        // Crash NVDA so both pools go under water (live CR about 0.7).
        ILeveragePool.PoolState memory st = cPool.state();
        uint256 crashed = st.S * 0.7e18 / st.C / 1e10; // 8-decimal answer
        nvdaFeed.setAnswer(int256(crashed));
        st = cPool.state();
        assertTrue(st.priceFresh, "fresh after the crash");
        assertLt(st.collateralRatio, 1e18, "live pool under water");
        assertTrue(cVault.canCover(address(cPool)));
        console2.log("live pool CR before (1e18)", st.collateralRatio, "deficit USD", st.S - st.V);
        (, int256 bnbUsdI,,,) = IAggV3(ATLAS_BNB_USD).latestRoundData();
        cBnbUsd = uint256(bnbUsdI);
    }

    /// @dev Thin WBNB/mUSDC pair (0.15 tBNB, the DeployCore default): cover halves the swap instead of reverting.
    function _coverThin() internal {
        _addUsdcLiquidity(0.15 ether, cBnbUsd);
        ILeveragePool.PoolState memory st = cPool.state();
        uint256 planned = Math.mulDiv(st.S - st.V, 1e18, cBnbUsd) * 10_300 / 10_000;
        uint256 out1 = cVault.cover(address(cPool));
        uint256 spent1 = cVault.totalOut();
        uint256 crAfter = cPool.state().collateralRatio;
        assertGt(out1, 0, "donated");
        assertLt(spent1, planned, "swap was halved to fit the thin pair");
        assertGt(crAfter, st.collateralRatio, "CR improved");
        console2.log("[ok] thin pair: planned tBNB", planned, "spent", spent1);
        console2.log("     mUSDC donated", out1, "CR after", crAfter);
    }

    /// @dev Deep pair re-aligned to Atlas: the rest of the deficit is covered (the pool caps it at S - V). The NVDA
    ///      feed is HALTED here (the gap a mirror halts on): redeemStable is held, and cover still lands at the
    ///      halted price, so the holder who waited is made whole instead of the first redeemer taking the haircut.
    function _coverDeep() internal {
        _addUsdcLiquidity(60 ether, cBnbUsd);
        _alignUsdcPair(cBnbUsd);
        nvdaFeed.setHalted(true);
        ILeveragePool.PoolState memory st1 = cPool.state();
        assertFalse(st1.priceFresh, "halted price is not fresh");
        assertTrue(st1.feedHalted, "feed halted");
        assertTrue(cVault.canCover(address(cPool)), "coverable while halted");
        uint256 sCarol = IERC20(cPool.sUSD()).balanceOf(carol);
        vm.startPrank(carol);
        vm.expectRevert(ILeveragePool.RedeemHeld.selector);
        cPool.redeemStable(sCarol, 0, 0);
        vm.stopPrank();

        uint256 out2 = cVault.cover(address(cPool));
        ILeveragePool.PoolState memory st2 = cPool.state();
        assertGe(st2.V + 1e15, st2.S, "deficit covered");
        assertTrue(st2.feedHalted, "covered during the halt");

        // Made whole: carol redeems at about $1 per sUSD (less the 20 bps fee) while still halted.
        vm.startPrank(carol);
        (uint256 cOut, uint256 uOut) = cPool.redeemStable(sCarol / 2, 0, 0);
        vm.stopPrank();
        uint256 paidUsd = Math.mulDiv(cOut, st2.price, 1e18) + uOut * 1e12;
        assertGe(paidUsd, (sCarol / 2) * 9_970 / 10_000, "par after the cover");
        nvdaFeed.setHalted(false);
        console2.log("[ok] halted: redeemStable held, cover landed, carol redeemed at par (USD)", paidUsd);
        assertEq(cVault.spentLive(block.timestamp / 1 days), cVault.totalOut(), "live tranche accounting");
        console2.log("[ok] deep pair: mUSDC donated", out2, "CR after", st2.collateralRatio);
        console2.log("     totalDefendedUsd", cVault.totalDefendedUsd());
    }

    /// @dev ScenarioPool tranche: capped, and paid only from this call's own swap (leftover mUSDC stays for live).
    function _coverScenario() internal {
        uint256 heldBefore = mUSDC.balanceOf(address(cVault));
        assertLt(ILeveragePool(scenarioPool).state().collateralRatio, 1e18, "scenario under water");
        uint256 cap = cVault.capLeft(scenarioPool);
        uint256 lifeCap = cVault.totalRevenue() / 10;
        assertLe(cap, lifeCap, "lifetime cap 10% of revenue");
        uint256 outS = cVault.cover(scenarioPool);
        assertGt(outS, 0);
        assertLe(cVault.spentScenarioTotal(), cap, "within the scenario cap");
        assertGe(mUSDC.balanceOf(address(cVault)), heldBefore, "leftover mUSDC not given to the ScenarioPool");
        console2.log("[ok] scenario tranche: cap tBNB", cap, "spent", cVault.spentScenarioTotal());
        console2.log("     mUSDC donated", outS, "live leftover kept", heldBefore);

        // Not coverable: a random address, and a healthy pool.
        vm.expectRevert(abi.encodeWithSelector(BackstopVault.NotCoverable.selector, address(0xBEEF)));
        cVault.cover(address(0xBEEF));
        nvdaFeed.setAnswer(180e8);
        vm.expectRevert();
        cVault.cover(address(cPool));
    }

    function _postRef(uint256 ref) internal {
        IRiskOracle.Snapshot memory last = riskOracle.latestSnapshot(NVDA);
        riskOracle.post(
            NVDA,
            IRiskOracle.Snapshot({
                refPrice: ref,
                volBps: 5000,
                liqUsd: 1_000_000e18,
                premiumBps: 0,
                cmcTs: block.timestamp,
                snapshotId: last.snapshotId + 1,
                responseHash: keccak256(abi.encode(NVDA, last.snapshotId + 1))
            })
        );
    }

    function _mintStable(address pool, address who) internal {
        uint256 cIn = ILeveragePool(pool).maxMintStable();
        if (cIn > 2 ether) cIn = 2 ether;
        require(cIn > 0, "maxMintStable is 0");
        tNVDA.mint(who, cIn);
        vm.startPrank(who);
        tNVDA.approve(pool, cIn);
        ILeveragePool(pool).mintStable(cIn, 0, vm.getBlockTimestamp());
        vm.stopPrank();
    }

    function _addUsdcLiquidity(uint256 bnbIn, uint256 bnbUsd) internal {
        uint256 usdcAmt = bnbIn * bnbUsd / 1e30; // 6 decimals
        mUSDC.mint(address(this), usdcAmt);
        mUSDC.approve(PCS_ROUTER, usdcAmt);
        IPcsRouter(PCS_ROUTER).addLiquidityETH{value: bnbIn}(
            address(mUSDC), usdcAmt, 0, 0, address(this), vm.getBlockTimestamp() + 600
        );
    }

    /// @dev Push the WBNB/mUSDC pair back to the Atlas price by donating the short side and calling sync().
    function _alignUsdcPair(uint256 bnbUsd) internal {
        IPcsPair pair = IPcsPair(IPcsFactory(IPcsRouter(PCS_ROUTER).factory()).getPair(WBNB, address(mUSDC)));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rW, uint256 rU) = pair.token0() == WBNB ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 wantU = rW * bnbUsd / 1e30;
        if (wantU > rU) {
            mUSDC.mint(address(pair), wantU - rU);
        } else {
            uint256 wantW = rU * 1e30 / bnbUsd;
            IWBNB(WBNB).deposit{value: wantW - rW}();
            IERC20(WBNB).transfer(address(pair), wantW - rW);
        }
        pair.sync();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Helpers
    // ═════════════════════════════════════════════════════════════════════════

    function _buy(address token, uint256 bnb) internal {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = token;
        IFlapRouterLike(FLAP_V2_ROUTER).swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnb}(
            0, path, trader, vm.getBlockTimestamp() + 600
        );
    }

    function _sell(address token, uint256 amount) internal {
        IERC20(token).approve(FLAP_V2_ROUTER, amount);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = WBNB;
        IFlapRouterLike(FLAP_V2_ROUTER).swapExactTokensForETHSupportingFeeOnTransferTokens(
            amount, 0, path, trader, vm.getBlockTimestamp() + 600
        );
    }

    function _taxLiquidated(address proc) internal view returns (bool) {
        ITaxProcessorLike t = ITaxProcessorLike(proc);
        return t.feeQuoteBalance() > 0 || t.marketQuoteBalance() > 0 || t.pendingDividendQuoteTokenBalance() > 0
            || t.lpQuoteBalance() > 0;
    }

    function _generateTaxAndDispatch(address token) internal {
        address proc = ITaxTokenLike(token).taxProcessor();
        uint256 rounds;
        vm.startPrank(trader);
        _buy(token, 2 ether);
        for (; rounds < 80; ++rounds) {
            if (_taxLiquidated(proc)) break;
            uint256 sellAmt = IERC20(token).balanceOf(trader) * 30 / 100;
            if (sellAmt == 0) break;
            uint256 before_ = trader.balance;
            _sell(token, sellAmt);
            uint256 proceeds = trader.balance - before_;
            if (proceeds > 0) _buy(token, proceeds * 90 / 100);
        }
        vm.stopPrank();
        assertTrue(_taxLiquidated(proc), "tax never liquidated");
        console2.log("     tax processor", proc, "rounds", rounds);
        ITaxProcessorLike(proc).dispatch();
    }

    function _launchedCreator(Vm.Log[] memory logs, address token) internal pure returns (address c) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != PORTAL || logs[i].topics.length == 0 || logs[i].topics[0] != LAUNCHED_TOPIC) continue;
            address t;
            (t,, c,,) = abi.decode(logs[i].data, (address, uint8, address, bytes32, bytes));
            if (t == token) return c;
        }
        revert("FlapDirectLaunched not found");
    }

    function _descriptionFromLogs(Vm.Log[] memory logs, address launcher) internal pure returns (string memory) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != PORTAL || logs[i].topics.length == 0 || logs[i].topics[0] != LAUNCHER_CREATED_TOPIC)
            {
                continue;
            }
            (address emitted,,, string memory desc) = abi.decode(logs[i].data, (address, address, address, string));
            if (emitted == launcher) return desc;
        }
        revert("FlapNewLauncherCreated not found");
    }

    function _hasTopic(Vm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool m = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    m = false;
                    break;
                }
            }
            if (m) return true;
        }
        return false;
    }

    receive() external payable {}
}
