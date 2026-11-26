// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ILeveragePool} from "../../src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {IMockRouter} from "../../src/interfaces/IMockRouter.sol";
import {ISandboxFactory} from "../../src/interfaces/ISandboxFactory.sol";
import {IScenarioFeed} from "../../src/interfaces/IScenarioFeed.sol";
import {Roles, SplitConstants} from "../../src/interfaces/SplitConstants.sol";

import {LeveragePool} from "../../src/core/LeveragePool.sol";
import {SplitToken} from "../../src/core/SplitToken.sol";
import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {PoolFactory} from "../../src/core/PoolFactory.sol";
import {PoolMath} from "../../src/core/PoolMath.sol";
import {RiskOracle} from "../../src/core/RiskOracle.sol";
import {MarketCalendar} from "../../src/core/MarketCalendar.sol";
import {AtlasMirror} from "../../src/oracle/AtlasMirror.sol";
import {ScenarioFeed} from "../../src/oracle/ScenarioFeed.sol";
import {MockERC20Permit} from "../../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../../src/mocks/MockRouter.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";

/// @notice Integration smoke test: BUILDER_A's pool stack against BUILDER_B's real contracts (no stubs).
///         18-decimal tNVDA, 6-decimal mUSDC, 8-decimal feeds, default PoolParams, the NVDA AssetConfig from
///         SPEC.md §7.9 and the real NYSE calendar.
contract IntegrationSmokeTest is Test {
    bytes32 constant NVDA = keccak256("NVDA");
    bytes32 constant TSLA = keccak256("TSLA");
    /// Thu 2026-07-02 10:30 EDT (session 13:30-20:00 UTC, SPEC.md §8 vector).
    uint256 constant T_OPEN = 1782999000 + 3600;
    /// Thu 2026-07-02 17:00 EDT; Fri 3 Jul is a holiday, so the next open is Mon 6 Jul.
    uint256 constant T_CLOSED = 1783022400 + 3600;

    MockERC20Permit asset;
    MockERC20Permit usdc;
    MockAggregator feed;
    RiskOracle risk;
    MarketCalendar cal;
    MockRouter router;
    PoolFactory factory;

    address admin = makeAddr("admin");
    address poster = makeAddr("poster");
    address agent = makeAddr("agent");
    address guardian = makeAddr("guardian");
    address launcher = makeAddr("launcher");
    address backstop = makeAddr("backstop");
    address bob = makeAddr("bob");
    address alice;
    uint256 aliceKey;

    LeveragePool pool;
    uint256 snapId;
    uint256 lastCmcTs;

    function setUp() public {
        (alice, aliceKey) = makeAddrAndKey("alice");
        vm.warp(T_OPEN);
        vm.startPrank(admin);
        asset = new MockERC20Permit("Test NVDA (MOCK)", "tNVDA", 18, admin, 100e18, 1 days);
        usdc = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", 6, admin, 1000e6, 1 days);
        feed = new MockAggregator(8, 100e8, "NVDA / USD (mock)");
        risk = new RiskOracle(admin);
        cal = new MarketCalendar(admin);
        router = new MockRouter(admin);

        risk.configureAsset(NVDA, _nvdaConfig());
        risk.grantRole(Roles.POSTER_ROLE, poster);
        risk.grantRole(Roles.PROPOSER_ROLE, agent);
        risk.grantRole(Roles.GUARDIAN_ROLE, guardian);
        asset.grantRole(Roles.MINTER_ROLE, address(router));
        usdc.grantRole(Roles.MINTER_ROLE, address(router));

        factory = new PoolFactory(
            admin,
            address(usdc),
            address(risk),
            address(cal),
            address(new LeveragePool()),
            address(new SplitToken()),
            address(new StabilityPool()),
            PoolMath.defaultParams()
        );
        factory.grantRole(Roles.CREATOR_ROLE, launcher);
        factory.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();

        _post(100e18);
        pool = _newPool(address(feed), NVDA);
    }

    // ------------------------------------------------------------------ helpers

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

    function _post(uint256 refPrice) internal {
        if (block.timestamp <= lastCmcTs) vm.warp(lastCmcTs + 1);
        lastCmcTs = block.timestamp;
        vm.prank(poster);
        risk.post(
            NVDA,
            IRiskOracle.Snapshot({
                refPrice: refPrice,
                volBps: 5000,
                liqUsd: 1_000_000e18,
                premiumBps: 0,
                cmcTs: block.timestamp,
                snapshotId: ++snapId,
                responseHash: keccak256(abi.encode(snapId))
            })
        );
    }

    function _newPool(address feed_, bytes32 id) internal returns (LeveragePool p) {
        vm.prank(launcher);
        p = LeveragePool(
            factory.createPool(address(asset), feed_, id, "NVDA", address(router), ILeveragePool.PoolKind.LIVE)
        );
        vm.prank(admin);
        router.setCaller(
            address(p),
            IMockRouter.CallerConfig({
                enabled: true, feed: feed_, asset: address(asset), usdc: address(usdc), slippageBps: 0, offsetBps: 0
            })
        );
    }

    function _seed(LeveragePool p) internal {
        vm.prank(admin);
        asset.mint(launcher, 10e18);
        vm.startPrank(launcher);
        asset.approve(address(p), type(uint256).max);
        p.seed(10e18, backstop);
        vm.stopPrank();
    }

    /// seed $1,000 then mintStable $1,000 at $100: L ~ 2, CR ~ 2.
    function _bootstrap(LeveragePool p) internal {
        _seed(p);
        vm.prank(admin);
        asset.mint(alice, 100e18);
        vm.startPrank(alice);
        asset.approve(address(p), type(uint256).max);
        IERC20(p.sUSD()).approve(p.stabilityPool(), type(uint256).max);
        p.mintStable(10e18, 0, block.timestamp);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ tests

    function test_int_seedMint_realOracleAndCalendar() public {
        _bootstrap(pool);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NORMAL));
        assertEq(uint8(st.riskSource), uint8(IRiskOracle.Source.RULE));
        assertEq(st.snapshotId, 1);
        assertTrue(st.marketOpen);
        assertFalse(st.gapGuard);
        assertEq(st.triggerLev, 2.67e18);
        assertEq(st.targetLev, 2e18);
        assertEq(st.lowerTriggerLev, 1.6e18);
        assertEq(st.maxMintLev, 2.335e18);
        // open fee 30 bps lowered by the dynamic fee to the 10 bps floor (L = 1 before the first mint).
        assertEq(IERC20(pool.sUSD()).balanceOf(alice), 999e18);
        assertApproxEqRel(st.leverage, 2e18, 2e15);

        uint256 m = pool.maxMintStable();
        assertGt(m, 0);
        vm.prank(alice);
        pool.mintStable(m, 0, block.timestamp);
        assertLe(pool.state().leverage, 2.335e18);
    }

    function test_int_sellZone_dex_6decUsdc() public {
        _bootstrap(pool);
        feed.setAnswer(78e8);
        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertTrue(pv.executable);
        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 cSold, uint256 out) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(cSold, pv.amountIn);
        (uint256 C, uint256 U) = pool.reserves();
        assertEq(U, out);
        assertEq(usdc.balanceOf(address(pool)), U);
        assertEq(asset.balanceOf(address(pool)), C);
        assertGt(out, 400e6); // 6-decimal mUSDC
        assertApproxEqAbs(pool.state().leverage, 2e18, 0.05e18);
        assertEq(asset.allowance(address(pool), address(router)), 0);

        // Breaker on the real oracle: ref $100 vs P $78.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 2200, 250));
        pool.mintStable(1e18, 0, block.timestamp);
    }

    function test_int_spRoute_closedMarket() public {
        _bootstrap(pool);
        StabilityPool spool = StabilityPool(pool.stabilityPool());
        vm.prank(alice);
        spool.deposit(500e18);
        vm.warp(T_CLOSED);
        feed.setAnswer(78e8);
        _post(78e18);
        assertFalse(pool.state().marketOpen);
        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 cSold, uint256 sBurn) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.STABILITY_POOL));
        assertGt(sBurn, 0);
        assertApproxEqAbs(pool.state().leverage, 2e18, 0.05e18);
        (uint256 gainC,) = spool.gainsOf(alice);
        assertApproxEqAbs(gainC, cSold, 1e6);
    }

    function test_int_gapGuard() public {
        _bootstrap(pool);
        uint256 nextOpen = cal.nextOpen(T_CLOSED);
        assertEq(nextOpen, 1783344600); // Mon 2026-07-06 09:30 EDT
        vm.warp(nextOpen - 1800);
        feed.setAnswer(85.6e8); // L ~ 2.4
        _post(85.6e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertTrue(st.gapGuard);
        assertEq(st.triggerLev, 2.3e18);
        assertEq(st.targetLev, 1.8e18);
        assertGt(st.leverage, 2.3e18);
        (, ILeveragePool.Route r,,) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertApproxEqAbs(pool.state().leverage, 1.8e18, 0.05e18);
    }

    function test_int_atlasMirror_haltBlocksMintsNotExits() public {
        AtlasMirror mirror = new AtlasMirror(admin, 56, makeAddr("atlasNvda"), 8, "NVDA / USD (Atlas mirror)");
        address pusher = makeAddr("pusher");
        vm.startPrank(admin);
        mirror.grantRole(Roles.PUSHER_ROLE, pusher);
        mirror.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();
        vm.prank(pusher);
        mirror.push(100e8, 1, block.timestamp, block.timestamp, 1, bytes32(uint256(1)));

        LeveragePool p = _newPool(address(mirror), NVDA);
        _bootstrap(p);
        assertEq(uint8(p.state().mode), uint8(ILeveragePool.Mode.NORMAL));

        vm.warp(block.timestamp + 1);
        vm.prank(pusher);
        mirror.push(78e8, 2, block.timestamp, block.timestamp, 2, bytes32(uint256(2))); // -22% > cap: halts
        assertTrue(mirror.halted());
        ILeveragePool.PoolState memory st = p.state();
        assertTrue(st.feedHalted);
        assertTrue(st.mintsPaused);
        assertFalse(st.priceFresh);
        assertEq(st.price, 78e18); // stored even though halted

        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        p.mintLever(1e18, 0, block.timestamp);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        p.rebalance();
        (uint256 cOut,) = p.redeemStable(100e18, 0, 0); // exits stay open
        assertGt(cOut, 0);
        IERC20(p.sUSD()).transfer(backstop, 100e18);
        vm.stopPrank();
        vm.prank(backstop);
        (uint256 sB, uint256 xB,,) = p.redeemPair(100e18, 1000e18, 0, 0);
        assertEq(sB, 100e18);
        assertGt(xB, 0);

        vm.prank(guardian);
        mirror.clearHalt();
        assertFalse(p.state().feedHalted);
    }

    function test_int_permitMint() public {
        _seed(pool);
        vm.prank(admin);
        asset.mint(alice, 10e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                alice,
                address(pool),
                10e18,
                asset.nonces(alice),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(aliceKey, keccak256(abi.encodePacked("\x19\x01", asset.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(alice);
        uint256 sOut = pool.mintStableWithPermit(10e18, 0, block.timestamp, deadline, v, r, s);
        assertEq(sOut, 999e18);
        assertEq(asset.allowance(alice, address(pool)), 0);
    }

    function test_int_agentTighten_revoke_stale() public {
        _bootstrap(pool);
        vm.prank(agent);
        (, bool applied) = risk.propose(
            NVDA,
            IRiskOracle.AgentParams({
                triggerLev: 2.4e18,
                targetLev: 2.0e18,
                lowerTriggerLev: 1.6e18,
                maxDevBps: 250,
                closedFeeBps: 100,
                gapGuardSec: 3600,
                horizonSec: 3600
            }),
            bytes32("in"),
            bytes32("out"),
            bytes32("model"),
            "ipfs://rationale",
            0
        );
        assertTrue(applied);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.riskSource), uint8(IRiskOracle.Source.AGENT));
        assertEq(st.triggerLev, 2.57e18); // step cap 0.1 from the rule's 2.67

        vm.prank(guardian);
        risk.revokeAgent();
        st = pool.state();
        assertEq(uint8(st.riskSource), uint8(IRiskOracle.Source.RULE));
        assertEq(st.triggerLev, 2.67e18);

        vm.warp(block.timestamp + 901);
        feed.setAnswer(100e8);
        st = pool.state();
        assertEq(uint8(st.riskSource), uint8(IRiskOracle.Source.FALLBACK));
        assertEq(st.triggerLev, 2.2e18);
        assertEq(st.targetLev, 1.9e18);
    }

    function test_int_totality_and_unconfiguredAsset() public {
        _bootstrap(pool);
        feed.setRevertOnRead(true);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NO_PRICE));
        assertEq(pool.maxMintStable(), 0);
        pool.currentRisk();
        assertFalse(pool.previewRebalance().executable);
        IERC20 xT = IERC20(pool.xToken());
        vm.prank(backstop);
        xT.transfer(alice, 100e18);
        vm.prank(alice);
        (uint256 sB, uint256 xB, uint256 cOut,) = pool.redeemPair(100e18, 100e18, 0, 0);
        assertGt(sB, 0);
        assertGt(xB, 0);
        assertGt(cOut, 0);
        feed.setRevertOnRead(false);

        // A pool on an asset id the RiskOracle does not know: FALLBACK, no ref, mints fail closed; seed still works.
        feed.setAnswer(100e8);
        LeveragePool t = _newPool(address(feed), TSLA);
        _seed(t);
        assertEq(uint8(t.state().riskSource), uint8(IRiskOracle.Source.FALLBACK));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StaleRefPrice.selector, type(uint256).max, 3600));
        t.mintStable(1e18, 0, block.timestamp);
    }

    function test_int_sandbox_realScenarioFeedAndRouter() public {
        ScenarioFeed feedImpl = new ScenarioFeed();
        address sbx = deployCode(
            "SandboxFactory.sol:SandboxFactory",
            abi.encode(
                address(factory),
                address(router),
                address(feedImpl),
                address(asset),
                address(usdc),
                NVDA,
                "NVDA",
                address(feed),
                int256(100e8),
                uint256(10e18),
                uint256(10e18)
            )
        );
        vm.startPrank(admin);
        factory.grantRole(Roles.CREATOR_ROLE, sbx);
        router.grantRole(Roles.AUTHORIZER_ROLE, sbx);
        asset.grantRole(Roles.MINTER_ROLE, sbx);
        vm.stopPrank();

        vm.prank(bob);
        (address p, address f) = ISandboxFactory(sbx).create();
        LeveragePool sp = LeveragePool(p);
        assertEq(uint8(sp.kind()), uint8(ILeveragePool.PoolKind.SANDBOX));
        assertEq(IScenarioFeed(f).operator(), bob);
        assertEq(IScenarioFeed(f).anchor(), 100e8);
        assertEq(IERC20(sp.xToken()).balanceOf(bob), 1000e18 - SplitConstants.MIN_X);
        assertEq(IERC20(sp.sUSD()).balanceOf(bob), 999e18);
        assertApproxEqRel(sp.state().leverage, 2e18, 2e15);

        vm.prank(alice);
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        IScenarioFeed(f).shock(-2200);

        vm.prank(bob);
        IScenarioFeed(f).shock(-2200);
        (ILeveragePool.Zone z, ILeveragePool.Route r,,) = sp.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertApproxEqAbs(sp.state().leverage, 2e18, 0.05e18);
        // The live pool on the same asset is untouched.
        (uint256 c0, uint256 u0) = pool.reserves();
        assertEq(c0 + u0, 0);
    }
}
