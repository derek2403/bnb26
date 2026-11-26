// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {SplitConstants, Roles} from "../../src/interfaces/SplitConstants.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {IAtlasMirror} from "../../src/interfaces/IAtlasMirror.sol";
import {IMockRouter} from "../../src/interfaces/IMockRouter.sol";
import {IMockERC20} from "../../src/interfaces/IMockERC20.sol";
import {IScenarioFeed} from "../../src/interfaces/IScenarioFeed.sol";
import {ILogAnchor} from "../../src/interfaces/ILogAnchor.sol";
import {IMarketCalendar} from "../../src/interfaces/IMarketCalendar.sol";

import {RiskOracle} from "../../src/core/RiskOracle.sol";
import {MarketCalendar} from "../../src/core/MarketCalendar.sol";
import {LogAnchor} from "../../src/core/LogAnchor.sol";
import {AtlasMirror} from "../../src/oracle/AtlasMirror.sol";
import {ScenarioFeed} from "../../src/oracle/ScenarioFeed.sol";
import {MockERC20Permit} from "../../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../../src/mocks/MockRouter.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";

/// @notice Smoke tests for BUILDER_B contracts (oracle, calendar, anchor, mocks).
contract BuilderBSmokeTest is Test {
    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal poster = makeAddr("poster");
    address internal agent = makeAddr("agent");
    address internal alice = makeAddr("alice");

    bytes32 internal constant NVDA = keccak256("NVDA");
    uint256 internal constant T0 = 1795700000; // 2026-11-26

    function setUp() public {
        vm.warp(T0);
        vm.roll(1000);
    }

    // ================================================================ mocks

    function test_MockERC20_faucetMintBurnPermit() public {
        MockERC20Permit usdc = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", 6, admin, 1000e6, 1 days);
        assertEq(usdc.decimals(), 6);

        vm.prank(alice);
        assertEq(usdc.faucet(), 1000e6);
        vm.warp(T0 + 100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMockERC20.FaucetCooldown.selector, 1 days - 100));
        usdc.faucet();
        vm.warp(T0 + 1 days);
        vm.prank(alice);
        usdc.faucet();
        assertEq(usdc.balanceOf(alice), 2000e6);

        vm.prank(alice);
        vm.expectRevert(IMockERC20.NotMinter.selector);
        usdc.mint(alice, 1);
        vm.prank(admin);
        usdc.burn(alice, 500e6);
        assertEq(usdc.balanceOf(alice), 1500e6);

        // permit
        (address owner, uint256 pk) = makeAddrAndKey("owner");
        bytes32 typehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(typehash, owner, alice, 7e6, 0, block.timestamp + 1));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        usdc.permit(owner, alice, 7e6, block.timestamp + 1, v, r, s);
        assertEq(usdc.allowance(owner, alice), 7e6);
        assertEq(usdc.nonces(owner), 1);
    }

    function test_MockAggregator() public {
        MockAggregator f = new MockAggregator(8, 100e8, "NVDA / USD");
        (uint80 id, int256 a,, uint256 u,) = f.latestRoundData();
        assertEq(id, 1);
        assertEq(a, 100e8);
        assertEq(u, T0);
        f.setAnswerAt(-1, T0 + 999);
        (id, a,, u,) = f.latestRoundData();
        assertEq(id, 2);
        assertEq(a, -1);
        assertEq(u, T0 + 999);
        (, a,,,) = f.getRoundData(1);
        assertEq(a, 100e8);
        vm.expectRevert(abi.encodeWithSelector(MockAggregator.UnknownRound.selector, uint80(9)));
        f.getRoundData(9);
        f.setRevertOnRead(true);
        vm.expectRevert(MockAggregator.ReadReverted.selector);
        f.latestRoundData();
        f.setHalted(true);
        assertTrue(f.halted());
        assertEq(f.version(), 1);
    }

    function _router18_6()
        internal
        returns (MockRouter router, MockERC20Permit asset, MockERC20Permit usdc, MockAggregator feed)
    {
        asset = new MockERC20Permit("Test NVDA (MOCK)", "tNVDA", 18, admin, 0, 0);
        usdc = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", 6, admin, 0, 0);
        feed = new MockAggregator(8, 100e8, "NVDA / USD");
        router = new MockRouter(admin);
        vm.startPrank(admin);
        asset.grantRole(Roles.MINTER_ROLE, address(router));
        usdc.grantRole(Roles.MINTER_ROLE, address(router));
        router.setCaller(
            address(this),
            IMockRouter.CallerConfig({
                enabled: true,
                feed: address(feed),
                asset: address(asset),
                usdc: address(usdc),
                slippageBps: 0,
                offsetBps: 0
            })
        );
        asset.mint(address(this), 10e18);
        usdc.mint(address(this), 1000e6);
        vm.stopPrank();
    }

    function test_MockRouter_quotesAndSwaps() public {
        (MockRouter router, MockERC20Permit asset, MockERC20Permit usdc,) = _router18_6();
        address[] memory sell = new address[](2);
        sell[0] = address(asset);
        sell[1] = address(usdc);
        address[] memory buy = new address[](2);
        buy[0] = address(usdc);
        buy[1] = address(asset);

        assertEq(router.getAmountsOut(1e18, sell)[1], 100e6);
        assertEq(router.getAmountsOut(100e6, buy)[1], 1e18);

        vm.prank(admin);
        router.setFill(address(this), 50, -100); // 0.5% slip, pair 1% below oracle
        // 1e18 * $99 * 0.995 = 98.505
        assertEq(router.getAmountsOut(1e18, sell)[1], 98_505_000);
        // 100 USDC * 0.995 / $99
        assertEq(router.getAmountsOut(100e6, buy)[1], uint256(99.5e18) / 99);
        uint256 needIn = router.getAmountsIn(98_505_000, sell)[0];
        assertGe(router.getAmountsOut(needIn, sell)[1], 98_505_000);
        uint256 needUsdc = router.getAmountsIn(1e18, buy)[0];
        assertGe(router.getAmountsOut(needUsdc, buy)[1], 1e18);

        asset.approve(address(router), 2e18);
        uint256[] memory amts = router.swapExactTokensForTokens(2e18, 0, sell, alice, block.timestamp);
        assertEq(amts[1], 197_010_000);
        assertEq(asset.balanceOf(address(this)), 8e18);
        assertEq(asset.totalSupply(), 8e18); // input burned
        assertEq(usdc.balanceOf(alice), 197_010_000);

        vm.expectRevert(abi.encodeWithSelector(IMockRouter.InsufficientOutput.selector, 98_505_000, 1e9));
        router.swapExactTokensForTokens(1e18, 1e9, sell, alice, block.timestamp);
        vm.expectRevert(IMockRouter.Expired.selector);
        router.swapExactTokensForTokens(1e18, 0, sell, alice, block.timestamp - 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMockRouter.UnknownCaller.selector, alice));
        router.getAmountsOut(1e18, sell);

        address[] memory bad = new address[](2);
        bad[0] = address(asset);
        bad[1] = address(asset);
        vm.expectRevert(IMockRouter.BadPath.selector);
        router.getAmountsOut(1e18, bad);

        vm.expectRevert(IMockRouter.NotAuthorized.selector);
        router.setFill(address(this), 0, 0);
        vm.expectRevert(IMockRouter.EthNotSupported.selector);
        router.swapExactETHForTokens(0, sell, alice, block.timestamp);
        assertEq(router.factory(), address(router));
        assertEq(router.WETH(), address(0));
    }

    // ============================================================ LogAnchor

    function test_LogAnchor_contiguity() public {
        LogAnchor la = new LogAnchor(admin);
        assertEq(la.latest().root, bytes32(0));
        vm.prank(admin);
        la.grantRole(Roles.ANCHOR_ROLE, poster);

        vm.expectRevert(ILogAnchor.NotAnchorer.selector);
        la.anchor(bytes32(uint256(1)), 0, 9);

        vm.startPrank(poster);
        vm.expectRevert(ILogAnchor.ZeroRoot.selector);
        la.anchor(bytes32(0), 0, 9);
        assertEq(la.anchor(bytes32(uint256(1)), 0, 9), 0);
        assertEq(la.nextSeq(), 10);
        assertEq(la.anchor(bytes32(uint256(2)), 10, 10), 1);
        vm.expectRevert(abi.encodeWithSelector(ILogAnchor.BadRange.selector, 11, 12, 13));
        la.anchor(bytes32(uint256(3)), 12, 13);
        vm.expectRevert(abi.encodeWithSelector(ILogAnchor.BadRange.selector, 11, 11, 10));
        la.anchor(bytes32(uint256(3)), 11, 10);
        vm.stopPrank();
        assertEq(la.count(), 2);
        assertEq(la.latest().toSeq, 10);
        assertEq(la.anchorAt(0).root, bytes32(uint256(1)));
    }

    // ======================================================= MarketCalendar

    function test_Calendar_specVectors() public {
        MarketCalendar cal = new MarketCalendar(admin);
        uint256 MAX = type(uint256).max;
        assertEq(cal.nextOpen(1795723200), 1795789800);
        assertTrue(cal.isOpen(1795789800));
        assertEq(cal.nextClose(1795789800), 1795802400);
        assertFalse(cal.isOpen(1795802400));
        assertEq(cal.nextOpen(1795802400), 1796049000);

        (uint256 o, uint256 c) = cal.sessionOf(cal.dayIndexOf(1772807400));
        assertEq(o, 1772807400); // Fri 2026-03-06 EST
        (o,) = cal.sessionOf(cal.dayIndexOf(1773063000));
        assertEq(o, 1773063000); // Mon 2026-03-09 EDT
        (o, c) = cal.sessionOf(cal.dayIndexOf(1782999000));
        assertEq(o, 1782999000);
        assertEq(c, 1783022400); // Thu 2026-07-02 normal day
        (o,) = cal.sessionOf(cal.dayIndexOf(1793629800));
        assertEq(o, 1793629800); // Mon 2026-11-02 EST again
        (o, c) = cal.sessionOf(cal.dayIndexOf(1830263400));
        assertEq(o, 1830263400);
        assertEq(c, 1830286800); // Fri 2027-12-31

        assertFalse(cal.isOpen(1830315600));
        assertEq(cal.nextOpen(1830315600), MAX);
        assertEq(cal.nextClose(1830315600), MAX);
        assertTrue(cal.inGapGuard(1795789800 - 3600, 3600));
        assertFalse(cal.inGapGuard(1795789800 - 3601, 3600));
        assertTrue(cal.isHoliday(20783));
        assertEq(cal.earlyCloseMinute(20784), 780);

        // admin amend
        vm.prank(admin);
        cal.setEarlyClose(21175, 780); // 2027-12-23
        assertEq(cal.earlyCloseMinute(21175), 780);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IMarketCalendar.BadMinute.selector, 570));
        cal.setEarlyClose(21175, 570);
        // totality at extremes
        assertFalse(cal.isOpen(MAX));
        cal.sessionOf(MAX);
        cal.dayIndexOf(0);
    }

    function testFuzz_Calendar_openImpliesFutureBounds(uint256 ts) public {
        MarketCalendar cal = new MarketCalendar(admin);
        ts = bound(ts, 1767243600, 1830315599);
        if (cal.isOpen(ts)) {
            assertGt(cal.nextClose(ts), ts);
            assertGt(cal.nextOpen(ts), ts);
        }
        uint256 n = cal.nextOpen(ts);
        if (n != type(uint256).max) assertTrue(cal.isOpen(n));
    }

    // ========================================================== AtlasMirror

    function _mirror() internal returns (AtlasMirror m) {
        m = new AtlasMirror(admin, 56, address(0xA71A5), 8, "NVDAB / USD");
        vm.startPrank(admin);
        m.grantRole(Roles.PUSHER_ROLE, poster);
        m.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();
    }

    function test_AtlasMirror_pushHaltAutoClear() public {
        AtlasMirror m = _mirror();
        vm.expectRevert(IAtlasMirror.NoData.selector);
        m.latestRoundData();
        vm.expectRevert(IAtlasMirror.NotPusher.selector);
        m.push(100e8, 1, T0, T0, 1, bytes32(0));

        uint256 src = T0 - 50; // mainnet clock slightly behind
        vm.startPrank(poster);
        m.push(100e8, 10, src, src, 111, bytes32("tx"));
        (uint80 id, int256 a,, uint256 u,) = m.latestRoundData();
        assertEq(id, 10);
        assertEq(a, 100e8);
        assertEq(u, src); // Atlas time, not push time

        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.RoundNotIncreasing.selector, uint80(10), uint80(10)));
        m.push(101e8, 10, src + 1, src + 1, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.UpdatedAtNotIncreasing.selector, src, src));
        m.push(101e8, 11, src, src, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.FutureTimestamp.selector, T0 + 31, T0));
        m.push(101e8, 11, T0 + 31, T0 + 31, 1, 0);

        m.push(104e8, 11, src + 10, src + 10, 1, 0); // +4% in band
        assertFalse(m.halted());
        m.push(120e8, 12, src + 20, src + 20, 1, 0); // +15.4% -> halt but stored
        assertTrue(m.halted());
        (, a,,,) = m.latestRoundData();
        assertEq(a, 120e8);

        vm.warp(T0 + 1000);
        m.push(121e8, 13, src + 120, src + 120, 1, 0);
        m.push(122e8, 14, src + 220, src + 220, 1, 0);
        assertTrue(m.halted()); // 2 confirmations
        m.push(122e8, 15, src + 319, src + 319, 1, 0);
        assertTrue(m.halted()); // 3 confirmations but < 300 s of source time since halt
        m.push(122e8, 16, src + 320, src + 320, 1, 0);
        assertFalse(m.halted());

        // hourly allowance: 26h gap -> cap = min(500 + 26*100, 2000) = 2000 bps
        uint256 later = src + 320 + 26 hours;
        vm.warp(later);
        m.push(146e8, 17, later, later, 1, 0); // +19.7% in band
        assertFalse(m.halted());
        vm.stopPrank();

        vm.prank(guardian);
        m.forceHalt();
        vm.warp(later + 3000);
        vm.startPrank(poster);
        for (uint80 i; i < 5; ++i) {
            m.push(146e8, 18 + i, later + 400 * (i + 1), later + 400 * (i + 1), 1, 0);
        }
        vm.stopPrank();
        assertTrue(m.halted()); // manual halt never auto-clears
        vm.prank(alice);
        vm.expectRevert(AtlasMirror.NotGuardianOrAdmin.selector);
        m.clearHalt();
        vm.prank(guardian);
        m.clearHalt();
        assertFalse(m.halted());
        assertEq(m.roundCount(), 13);
        (, a,,,) = m.getRoundData(12);
        assertEq(a, 120e8);
    }

    // ========================================================= ScenarioFeed

    function test_ScenarioFeed() public {
        ScenarioFeed impl = new ScenarioFeed();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(0), alice, false, 1);

        MockAggregator ref = new MockAggregator(8, 100e8, "ref");
        ScenarioFeed f = ScenarioFeed(Clones.clone(address(impl)));
        f.initialize(address(ref), alice, false, 0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        f.initialize(address(ref), alice, false, 0);
        assertEq(f.anchor(), 100e8);
        assertEq(f.decimals(), 8);

        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        f.setPrice(90e8);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(161e8), 40e8, 160e8));
        f.setPrice(161e8);
        f.setPrice(40e8);
        f.setPrice(100e8);
        f.shock(-2200);
        (uint80 id, int256 a,, uint256 u,) = f.latestRoundData();
        assertEq(a, 78e8);
        assertEq(id, 4);
        assertEq(u, block.timestamp);
        f.setStaleness(500);
        (,,, u,) = f.latestRoundData();
        assertEq(u, block.timestamp - 500);
        f.setHalted(true);
        ref.setAnswer(110e8);
        f.reset();
        vm.stopPrank();
        (, a,, u,) = f.latestRoundData();
        assertEq(a, 110e8);
        assertEq(u, block.timestamp);
        assertFalse(f.halted());

        // public setter clone with no reference
        ScenarioFeed g = ScenarioFeed(Clones.clone(address(impl)));
        vm.expectRevert(IScenarioFeed.NoAnchor.selector);
        g.initialize(address(0), alice, true, 0);
        g.initialize(address(0), alice, true, 50e8);
        vm.prank(makeAddr("anyone"));
        g.shock(5000);
        (, a,,,) = g.latestRoundData();
        assertEq(a, 75e8);
        vm.prank(makeAddr("anyone"));
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        g.setStaleness(1);
    }

    // =========================================================== RiskOracle

    function _oracle() internal returns (RiskOracle ro) {
        ro = new RiskOracle(admin);
        vm.startPrank(admin);
        ro.grantRole(Roles.POSTER_ROLE, poster);
        ro.grantRole(Roles.PROPOSER_ROLE, agent);
        ro.grantRole(Roles.GUARDIAN_ROLE, guardian);
        ro.configureAsset(
            NVDA,
            IRiskOracle.AssetConfig({
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
            })
        );
        vm.stopPrank();
    }

    function _snap(uint256 id, uint256 vol, uint256 liq, int256 prem) internal view returns (IRiskOracle.Snapshot memory) {
        return IRiskOracle.Snapshot({
            refPrice: 100e18,
            volBps: vol,
            liqUsd: liq,
            premiumBps: prem,
            cmcTs: block.timestamp,
            snapshotId: id,
            responseHash: keccak256(abi.encode(id))
        });
    }

    function test_RiskOracle_ruleStepStaleFallback() public {
        RiskOracle ro = _oracle();
        // unknown id: total views, FALLBACK
        IRiskOracle.RiskView memory v = ro.riskView(keccak256("NOPE"));
        assertEq(uint8(v.source), uint8(IRiskOracle.Source.FALLBACK));
        assertEq(v.params.triggerLev, 2.2e18);
        assertEq(v.refPrice, 0);

        vm.prank(poster);
        ro.post(NVDA, _snap(1, 6000, 1_000_000e18, -20));
        IRiskOracle.RiskParams memory r = ro.params(NVDA);
        assertEq(r.triggerLev, 2.57e18); // 2.67 - 1000 bps * 1e14
        assertEq(r.targetLev, 2.0e18);
        assertEq(r.lowerTriggerLev, 1.6e18);
        assertEq(r.openFeeBps, 40);
        assertEq(r.maxSellChunkUsd, 20_000e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));

        // huge vol: clamp to 2.2 then step-capped at 2.57 - 0.1
        vm.warp(block.timestamp + 60);
        vm.prank(poster);
        ro.post(NVDA, _snap(2, 20000, 0, 0));
        r = ro.params(NVDA);
        assertEq(r.triggerLev, 2.47e18);
        assertEq(r.targetLev, 2.0e18);
        assertEq(r.maxSellChunkUsd, 20_000e18); // liq 0 keeps previous chunk

        // vol 0 keeps the previous triple
        vm.warp(block.timestamp + 60);
        vm.prank(poster);
        ro.post(NVDA, _snap(3, 0, 1e18, 0));
        assertEq(ro.params(NVDA).triggerLev, 2.47e18);
        assertEq(ro.params(NVDA).maxSellChunkUsd, 100e18); // min chunk

        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.SnapshotNotIncreasing.selector, 3, 3));
        ro.post(NVDA, _snap(3, 0, 0, 0));

        // stale -> fallback merge (all <= fallback for min-fields)
        vm.warp(block.timestamp + 901);
        v = ro.riskView(NVDA);
        assertEq(uint8(v.source), uint8(IRiskOracle.Source.FALLBACK));
        assertEq(v.params.triggerLev, 2.2e18);
        assertEq(v.params.targetLev, 1.9e18);
        assertEq(v.params.maxDevBps, 150);
        assertEq(v.params.openFeeBps, 100);
        assertEq(v.params.closedFeeBps, 100);
        assertEq(v.params.gapGuardSec, 7200);
        assertEq(v.params.maxSellChunkUsd, 100e18);
        assertEq(v.refPrice, 100e18);
        assertEq(v.snapshotId, 3);

        vm.prank(guardian);
        ro.setMintsPaused(NVDA, true);
        assertTrue(ro.riskView(NVDA).mintsPaused);
        assertFalse(ro.mintsPaused(keccak256("TSLA")));
    }

    function test_RiskOracle_agentTwoSpeed() public {
        RiskOracle ro = _oracle();
        vm.prank(poster);
        ro.post(NVDA, _snap(1, 6000, 1_000_000e18, 0)); // rule trigger 2.57

        IRiskOracle.AgentParams memory q = IRiskOracle.AgentParams({
            triggerLev: 2.47e18,
            targetLev: 1.9e18,
            lowerTriggerLev: 1.5e18,
            maxDevBps: 200,
            closedFeeBps: 150,
            gapGuardSec: 5400,
            horizonSec: 3600
        });
        vm.prank(agent);
        (uint256 id1, bool applied) = ro.propose(NVDA, q, "in", "out", "model", "ipfs://r1", 7);
        assertTrue(applied);
        assertEq(uint8(ro.proposal(id1).status), uint8(IRiskOracle.ProposalStatus.APPLIED));
        assertEq(ro.params(NVDA).triggerLev, 2.47e18);
        assertEq(ro.params(NVDA).closedFeeBps, 150);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.AGENT));

        // rate limit
        q.triggerLev = 2.4e18;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.ProposalRateLimited.selector, 1020));
        ro.propose(NVDA, q, "", "", "", "", 7);

        // loosening queues; early apply reverts; veto blocks
        vm.roll(block.number + 20);
        q.triggerLev = 2.9e18; // step-capped to 2.57
        vm.prank(agent);
        (uint256 id2, bool applied2) = ro.propose(NVDA, q, "", "", "", "", 7);
        assertFalse(applied2);
        assertEq(ro.proposal(id2).params.triggerLev, 2.57e18);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.TooEarly.selector, block.timestamp + 1800));
        ro.applyProposal(id2);
        vm.prank(guardian);
        ro.veto(id2);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.NotQueued.selector, id2));
        ro.applyProposal(id2);

        // queue again, wait, refresh snapshot, apply
        vm.roll(block.number + 20);
        vm.prank(agent);
        (uint256 id3,) = ro.propose(NVDA, q, "", "", "", "", 7);
        vm.warp(block.timestamp + 1800);
        vm.prank(poster);
        ro.post(NVDA, _snap(2, 6000, 1_000_000e18, 0));
        ro.applyProposal(id3);
        assertEq(uint8(ro.proposal(id3).status), uint8(IRiskOracle.ProposalStatus.EXECUTED));
        // effective trigger = min(rule 2.57, agent 2.57); closedFee max(100, 150)
        assertEq(ro.params(NVDA).triggerLev, 2.57e18);
        assertEq(ro.params(NVDA).closedFeeBps, 150);

        // revoke removes agent influence immediately
        vm.prank(guardian);
        ro.revokeAgent();
        (, bool active,,) = ro.agentParams(NVDA);
        assertFalse(active);
        assertEq(ro.params(NVDA).closedFeeBps, 100);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));
        vm.roll(block.number + 20);
        vm.prank(agent);
        vm.expectRevert(IRiskOracle.AgentDisabled.selector);
        ro.propose(NVDA, q, "", "", "", "", 7);

        vm.prank(admin);
        ro.setAgentId(9);
        vm.prank(admin);
        ro.restoreAgent();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.WrongAgentId.selector, 9, 7));
        ro.propose(NVDA, q, "", "", "", "", 7);
    }

    function testFuzz_RiskOracle_postStaysInClamps(uint256 vol1, uint256 vol2, uint256 liq, int256 prem) public {
        RiskOracle ro = _oracle();
        vol1 = bound(vol1, 0, 1e9);
        vol2 = bound(vol2, 0, 1e9);
        liq = bound(liq, 0, 1e36);
        vm.startPrank(poster);
        ro.post(NVDA, _snap(1, vol1, liq, prem));
        IRiskOracle.RiskParams memory a = ro.ruleParams(NVDA);
        vm.warp(block.timestamp + 1);
        ro.post(NVDA, _snap(2, vol2, liq, prem));
        vm.stopPrank();
        IRiskOracle.RiskParams memory b = ro.params(NVDA);
        IRiskOracle.Clamps memory c = ro.clamps();
        assertGe(b.triggerLev, c.minTriggerLev);
        assertLe(b.triggerLev, c.maxTriggerLev);
        assertGe(b.targetLev, c.minTargetLev);
        assertLe(b.targetLev, c.maxTargetLev);
        assertGe(b.lowerTriggerLev, c.minLowerTriggerLev);
        assertLe(b.lowerTriggerLev, c.maxLowerTriggerLev);
        assertGe(b.triggerLev - b.targetLev, c.minTriggerTargetGap);
        assertGe(b.targetLev - b.lowerTriggerLev, c.minTargetLowerGap);
        assertLe(b.openFeeBps, c.maxOpenFeeBps);
        uint256 d = a.triggerLev > b.triggerLev ? a.triggerLev - b.triggerLev : b.triggerLev - a.triggerLev;
        assertLe(d, ro.stepCaps().lev);
    }
}
