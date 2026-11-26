// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILeveragePool} from "../src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../src/interfaces/IRiskOracle.sol";
import {IMockRouter} from "../src/interfaces/IMockRouter.sol";
import {IUniswapV2Router02} from "../src/interfaces/IUniswapV2Router02.sol";
import {Roles} from "../src/interfaces/SplitConstants.sol";

import {LeveragePool} from "../src/core/LeveragePool.sol";
import {SplitToken} from "../src/core/SplitToken.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {PoolFactory} from "../src/core/PoolFactory.sol";
import {PoolMath} from "../src/core/PoolMath.sol";
import {MarketCalendar} from "../src/core/MarketCalendar.sol";
import {MockERC20Permit} from "../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

import {ZonesRiskStub, ZonesV2Pair, ZonesV2Router, ZonesEvilRouter} from "./helpers/zonesHelpers.sol";

/// @notice Rebalance sell/buy zone tests against SPEC.md §2.3 / §2.5 / §13.1(7) / §13.2.
///         Expected values are recomputed here from the SPEC formulas (independent replica), never from PoolMath.
///         Setup (§13.2): P = $100, seed $1,000 (10e18 asset), mintStable $1,000 with fees 0 -> L = 2, CR = 2.
///         Real MarketCalendar, real MockRouter / MockAggregator / MockERC20Permit, a settable risk stub with fees 0.
abstract contract ZonesBase is Test {
    using Math for uint256;

    bytes32 constant NVDA = keccak256("NVDA");
    uint256 constant WAD = 1e18;
    uint256 constant BPS = 1e4;
    uint256 constant MAX = type(uint256).max;
    /// Thu 2026-07-02 10:30 EDT (open).
    uint256 constant T_OPEN = 1782999000 + 3600;
    /// Thu 2026-07-02 17:00 EDT (closed; Fri 3 Jul holiday).
    uint256 constant T_CLOSED = 1783022400 + 3600;
    /// Mon 2026-07-06 09:30 EDT.
    uint256 constant NEXT_OPEN = 1783344600;

    uint256 constant TRIG = 2.67e18;
    uint256 constant TGT = 2.0e18;
    uint256 constant LOW = 1.6e18;
    uint256 constant SLIP = 50; // PoolParams.maxSlipBps default
    uint256 constant DISC = 100; // PoolParams.spDiscountBps default
    uint256 constant EPS = 0.05e18;
    uint256 constant SNAP = 7;

    MockERC20Permit asset;
    MockERC20Permit usdc;
    MockAggregator feed;
    ZonesRiskStub risk;
    MarketCalendar cal;
    MockRouter router;
    PoolFactory factory;
    LeveragePool pool;
    StabilityPool sp;
    IERC20 sUSD;

    address admin = makeAddr("admin");
    address launcher = makeAddr("launcher");
    address backstop = makeAddr("backstop");
    address alice = makeAddr("alice");

    uint256 aU = 1e18;
    uint256 uS;

    function _usdcDec() internal pure virtual returns (uint8);

    function setUp() public {
        vm.warp(T_OPEN);
        uS = 10 ** (18 - _usdcDec());
        vm.startPrank(admin);
        asset = new MockERC20Permit("Test NVDA (MOCK)", "tNVDA", 18, admin, 100e18, 1 days);
        usdc = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", _usdcDec(), admin, 1000, 1 days);
        feed = new MockAggregator(8, 100e8, "NVDA / USD (mock)");
        cal = new MarketCalendar(admin);
        router = new MockRouter(admin);
        asset.grantRole(Roles.MINTER_ROLE, address(router));
        usdc.grantRole(Roles.MINTER_ROLE, address(router));
        risk = new ZonesRiskStub();
        risk.set(_rv());

        ILeveragePool.PoolParams memory p = PoolMath.defaultParams();
        p.redeemFeeBps = 0;
        p.dynFeeMaxBps = 0;
        p.minFeeBps = 0;
        p.fundingRateBps = 0; // keep S fixed while SP deposits exist
        factory = new PoolFactory(
            admin,
            address(usdc),
            address(risk),
            address(cal),
            address(new LeveragePool()),
            address(new SplitToken()),
            address(new StabilityPool()),
            p
        );
        factory.grantRole(Roles.CREATOR_ROLE, launcher);
        vm.stopPrank();

        vm.prank(launcher);
        pool = LeveragePool(
            factory.createPool(address(asset), address(feed), NVDA, "NVDA", address(router), ILeveragePool.PoolKind.LIVE)
        );
        vm.prank(admin);
        router.setCaller(
            address(pool),
            IMockRouter.CallerConfig({
                enabled: true, feed: address(feed), asset: address(asset), usdc: address(usdc), slippageBps: 0, offsetBps: 0
            })
        );
        sUSD = IERC20(pool.sUSD());
        sp = StabilityPool(pool.stabilityPool());
        _bootstrap();
    }

    // ================================================================== setup helpers

    function _rv() internal view returns (IRiskOracle.RiskView memory v) {
        v.params = IRiskOracle.RiskParams({
            triggerLev: TRIG,
            targetLev: TGT,
            lowerTriggerLev: LOW,
            maxDevBps: 250,
            openFeeBps: 0,
            closedFeeBps: 0,
            gapGuardSec: 3600,
            maxSellChunkUsd: 50_000e18
        });
        v.source = IRiskOracle.Source.RULE;
        v.refPrice = 100e18;
        v.refTs = block.timestamp;
        v.snapshotId = SNAP;
    }

    function _bootstrap() internal {
        vm.startPrank(admin);
        asset.mint(launcher, 10e18);
        asset.mint(alice, 100e18);
        vm.stopPrank();
        vm.startPrank(launcher);
        asset.approve(address(pool), type(uint256).max);
        pool.seed(10e18, backstop);
        vm.stopPrank();
        vm.startPrank(alice);
        asset.approve(address(pool), type(uint256).max);
        sUSD.approve(address(sp), type(uint256).max);
        pool.mintStable(10e18, 0, block.timestamp);
        vm.stopPrank();
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.S, 1000e18, "bootstrap S");
        assertEq(st.C, 20e18, "bootstrap C");
        assertEq(st.leverage, 2e18, "bootstrap L");
        assertEq(st.collateralRatio, 2e18, "bootstrap CR");
    }

    function _price(int256 a8) internal {
        feed.setAnswer(a8);
    }

    function _warp(uint256 t, int256 a8) internal {
        vm.warp(t);
        feed.setAnswer(a8);
    }

    function _fill(uint256 slipBps, int256 offsetBps) internal {
        vm.prank(admin);
        router.setFill(address(pool), slipBps, offsetBps);
    }

    function _deposit(uint256 amount) internal {
        vm.prank(alice);
        sp.deposit(amount);
    }

    function _setRouter(address r) internal {
        vm.prank(admin);
        pool.setRouter(r);
    }

    function _setParam(uint256 minRebalanceUsd) internal {
        ILeveragePool.PoolParams memory p = pool.params();
        p.minRebalanceUsd = minRebalanceUsd;
        vm.prank(admin);
        pool.setParams(p);
    }

    function _books() internal view returns (uint256 C, uint256 U, uint256 S) {
        (C, U) = pool.reserves();
        S = sUSD.totalSupply();
    }

    function _usdc(uint256 dollars) internal pure returns (uint256) {
        return dollars * 10 ** _usdcDec();
    }

    // ================================================================== SPEC replica (§1, §2.2, §2.5)

    function _P(int256 a8) internal pure returns (uint256) {
        return uint256(a8) * 1e10;
    }

    function _val(uint256 c, uint256 P, Math.Rounding r) internal view returns (uint256) {
        return Math.mulDiv(c, P, aU, r);
    }

    function _amt(uint256 usd, uint256 P, Math.Rounding r) internal view returns (uint256) {
        return Math.mulDiv(usd, aU, P, r);
    }

    function _wu(uint256 w, bool ceil) internal view returns (uint256) {
        return ceil ? Math.ceilDiv(w, uS) : w / uS;
    }

    function _E(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (int256) {
        return int256(_val(C, P, Math.Rounding.Floor) + U * uS) - int256(S);
    }

    function _L(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (uint256) {
        int256 e = _E(C, U, S, P);
        if (e <= 0) return C == 0 ? 0 : MAX;
        return Math.mulDiv(_val(C, P, Math.Rounding.Ceil), WAD, uint256(e), Math.Rounding.Ceil);
    }

    function _CR(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (uint256) {
        return S == 0 ? MAX : Math.mulDiv(_val(C, P, Math.Rounding.Floor) + U * uS, WAD, S, Math.Rounding.Floor);
    }

    /// D = (C·P − T·E)/(1 − T·s), rounded down.
    function _D(uint256 C, uint256 U, uint256 S, uint256 P, uint256 T, uint256 s) internal view returns (uint256) {
        int256 e = _E(C, U, S, P);
        uint256 cpF = _val(C, P, Math.Rounding.Floor);
        if (e <= 0) return cpF;
        uint256 te = Math.mulDiv(T, uint256(e), WAD, Math.Rounding.Floor);
        if (cpF <= te) return 0;
        return Math.mulDiv(cpF - te, WAD, WAD - Math.mulDiv(T, s, BPS, Math.Rounding.Ceil), Math.Rounding.Floor);
    }

    /// B = (T·E − C·P)/(1 + (T − 1)·s), rounded down.
    function _B(uint256 C, uint256 U, uint256 S, uint256 P, uint256 T, uint256 s) internal view returns (uint256) {
        int256 e = _E(C, U, S, P);
        uint256 cpC = _val(C, P, Math.Rounding.Ceil);
        uint256 te = Math.mulDiv(T, uint256(e), WAD, Math.Rounding.Floor);
        if (te <= cpC) return 0;
        return Math.mulDiv(te - cpC, WAD, WAD + Math.mulDiv(T - WAD, s, BPS, Math.Rounding.Ceil), Math.Rounding.Floor);
    }

    /// DEX sell minOut = wu(mulDiv(value, BPS − s, BPS, Ceil), Ceil).
    function _sellMinOut(uint256 value, uint256 s) internal view returns (uint256) {
        return _wu(Math.mulDiv(value, BPS - s, BPS, Math.Rounding.Ceil), true);
    }

    /// MockRouter asset->usdc fill (§12).
    function _mockSellOut(uint256 cIn, uint256 P, uint256 slip, int256 off) internal view returns (uint256) {
        uint256 pEff = Math.mulDiv(P, uint256(int256(BPS) + off), BPS);
        return Math.mulDiv(Math.mulDiv(cIn, pEff, aU), BPS - slip, BPS) / uS;
    }

    /// MockRouter usdc->asset fill (§12).
    function _mockBuyOut(uint256 uIn, uint256 P, uint256 slip) internal view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(uIn * uS, BPS - slip, BPS), aU, P);
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        (p[0], p[1]) = (a, b);
    }

    function _assertBooksMatchBalances() internal view {
        (uint256 C, uint256 U) = pool.reserves();
        assertEq(asset.balanceOf(address(pool)), C, "asset books");
        assertEq(usdc.balanceOf(address(pool)), U, "usdc books");
        assertEq(asset.allowance(address(pool), pool.router()), 0, "asset allowance reset");
        assertEq(usdc.allowance(address(pool), pool.router()), 0, "usdc allowance reset");
    }

    // ================================================================== trigger detection

    /// §13.2 trigger edge: −20.05% gives L ≈ 2.6695, not in the zone.
    function test_trigger_minus2005_notInZone() public {
        _price(79.95e8);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 L = _L(C, U, S, _P(79.95e8));
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.leverage, L);
        assertApproxEqAbs(L, 2.6695e18, 0.0001e18);
        assertEq(st.collateralRatio, 1.599e18);
        assertEq(st.triggerLev, TRIG);
        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertEq(uint8(pv.zone), uint8(ILeveragePool.Zone.NONE));
        assertFalse(pv.executable);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, L));
        pool.rebalance();
    }

    /// §13.2 trigger edge: −20.07% gives L ≈ 2.6706, in the sell zone.
    function test_trigger_minus2007_sells() public {
        _price(79.93e8);
        assertApproxEqAbs(pool.state().leverage, 2.6706e18, 0.0001e18);
        (ILeveragePool.Zone z, ILeveragePool.Route r,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertApproxEqAbs(pool.state().leverage, TGT, EPS);
    }

    /// Exact boundary from L = 20P/(20P − 1000) = 2.67  ⇔  P = 79.940119...: the sell zone is strict (L > Tr).
    /// Note: −20.06% (P = 79.94) is already IN the zone (L = 2.670007); the edge is at −20.0599%.
    function test_trigger_exactEdge() public {
        _price(79.94012e8);
        uint256 L = pool.state().leverage;
        assertLe(L, TRIG);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, L));
        pool.rebalance();

        _price(79.94011e8);
        assertGt(pool.state().leverage, TRIG);
        assertEq(uint8(pool.previewRebalance().zone), uint8(ILeveragePool.Zone.SELL));

        _price(79.94e8); // −20.06%
        assertGt(pool.state().leverage, TRIG);
        (ILeveragePool.Zone z,,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
    }

    function test_trigger_guards_staleAndHalted() public {
        _price(78e8);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.rebalance();
        _price(78e8);
        feed.setHalted(true);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        pool.rebalance();
        feed.setHalted(false);
        pool.rebalance();
    }

    // ================================================================== sell zone: size, minOut, accounting

    struct SellExp {
        uint256 C;
        uint256 U;
        uint256 S;
        uint256 P;
        uint256 Lb;
        uint256 D;
        uint256 cSold;
        uint256 value;
        uint256 minOut;
        uint256 out;
        uint256 La;
    }

    /// Expected DEX sell (MockRouter fill with `slip`, offset 0) for target T and budget s = maxSlipBps.
    function _sellExp(uint256 P, uint256 T, uint256 slip) internal view returns (SellExp memory e) {
        e.P = P;
        (e.C, e.U, e.S) = _books();
        e.Lb = _L(e.C, e.U, e.S, P);
        e.D = _D(e.C, e.U, e.S, P, T, SLIP);
        e.cSold = Math.min(e.C, _amt(e.D, P, Math.Rounding.Floor));
        e.value = _val(e.cSold, P, Math.Rounding.Floor);
        e.minOut = _sellMinOut(e.value, SLIP);
        e.out = _mockSellOut(e.cSold, P, slip, 0);
        e.La = _L(e.C - e.cSold, e.U + e.out, e.S, P);
    }

    /// §13.2 −22%: L = 1.56/0.56; DEX sells D = 440/0.99 = 444.44 USD and lands at ≈ 1.992 (slip 0, budget s = 0.5%).
    function test_sell_minus22_exact() public {
        _price(78e8);
        SellExp memory e = _sellExp(_P(78e8), TGT, 0);
        assertEq(e.Lb, Math.mulDiv(1560e18, WAD, 560e18, Math.Rounding.Ceil));
        assertEq(pool.state().collateralRatio, 1.56e18);
        assertEq(e.D, Math.mulDiv(440e18, WAD, 0.99e18));
        assertApproxEqAbs(e.D, 444.444444e18, 1e12);

        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertEq(uint8(pv.zone), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(pv.route), uint8(ILeveragePool.Route.DEX));
        assertEq(pv.sizeUsd, e.D, "preview D");
        assertEq(pv.chunkUsd, e.D, "preview chunk");
        assertEq(pv.amountIn, e.cSold, "preview amountIn");
        assertEq(pv.minOut, e.minOut, "preview minOut");
        assertTrue(pv.executable);

        vm.expectCall(address(asset), abi.encodeCall(IERC20.approve, (address(router), e.cSold)));
        vm.expectCall(
            address(router),
            abi.encodeCall(
                IUniswapV2Router02.swapExactTokensForTokens,
                (e.cSold, e.minOut, _path(address(asset), address(usdc)), address(pool), block.timestamp)
            )
        );
        vm.expectEmit(address(pool));
        emit ILeveragePool.SellZone(e.Lb, e.La, e.cSold, e.out, TRIG, SNAP, ILeveragePool.Route.DEX);
        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(aIn, e.cSold);
        assertEq(aOut, e.out);

        (uint256 Ca, uint256 Ua) = pool.reserves();
        assertEq(Ca, e.C - e.cSold);
        assertEq(Ua, e.out);
        _assertBooksMatchBalances();
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.leverage, e.La);
        assertLt(e.La, e.Lb);
        assertApproxEqAbs(e.La, 1.992063e18, 0.000001e18); // (1560 − 444.44)/560
        assertGe(e.La + EPS, TGT);
        assertApproxEqAbs(st.collateralRatio, 1.56e18, 1e12); // slip 0: V unchanged
        assertEq(pool.lastRebalanceAt(), block.timestamp);

        // Breaker: ref still $100 -> dev 2200 bps > 250.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 2200, 250));
        pool.mintStable(1e18, 0, block.timestamp);
    }

    /// The (1 − T·s) term pre-pays the swap cost: with a fill just inside the budget, L lands on T (not above it as
    /// the cost-free size C·P − T·E would leave it).
    function test_sell_sizeIncludesSwapCost() public {
        _price(78e8);
        _fill(49, 0);
        SellExp memory e = _sellExp(_P(78e8), TGT, 49);
        int256 Eb = _E(e.C, e.U, e.S, e.P);
        uint256 naive = 1560e18 - Math.mulDiv(TGT, uint256(Eb), WAD);
        assertGt(e.D, naive);
        (,, uint256 cSold, uint256 out) = pool.rebalance();
        assertEq(cSold, e.cSold);
        assertEq(out, e.out);
        uint256 La = pool.state().leverage;
        assertEq(La, e.La);
        assertApproxEqAbs(La, TGT, 0.0003e18, "lands on T");
        // Cost-free sizing would have overshot above T by ~0.0077.
        uint256 cNaive = _amt(naive, e.P, Math.Rounding.Floor);
        assertGt(_L(e.C - cNaive, _mockSellOut(cNaive, e.P, 49, 0), e.S, e.P), TGT + 0.007e18);
        // E loss within budget (§2.5 post-check 4).
        int256 Ea = _E(e.C - cSold, out, e.S, e.P);
        assertLe(uint256(Eb - Ea), Math.mulDiv(e.value, SLIP, BPS, Math.Rounding.Ceil) + 2);
    }

    function test_sell_pairOffsetInsideBudget() public {
        uint256 P = _P(78e8);
        _price(78e8);
        _fill(0, -40); // pair 0.4% below the oracle
        (uint256 C,,) = _books();
        (,, uint256 cSold, uint256 out) = pool.rebalance();
        assertEq(out, _mockSellOut(cSold, P, 0, -40));
        (uint256 Ca, uint256 Ua,) = _books();
        assertEq(Ca, C - cSold);
        assertEq(Ua, out);
        uint256 La = pool.state().leverage;
        assertLe(La, TGT);
        assertGe(La + EPS, TGT);
        _assertBooksMatchBalances();
    }

    /// A fill worse than maxSlipBps fails every halving; with no SP deposits -> RebalanceCheckFailed(1).
    function test_sell_fillOutsideBudget_noSp_reverts() public {
        _price(78e8);
        _fill(51, 0);
        assertFalse(pool.previewRebalance().executable);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.RebalanceCheckFailed.selector, 1));
        pool.rebalance();
    }

    /// Same, but with SP deposits (NORMAL, open market): falls back to the SP route (§2.5 DEX route).
    function test_sell_fillOutsideBudget_fallsBackToSp() public {
        uint256 P = _P(78e8);
        _price(78e8);
        _fill(51, 0);
        _deposit(500e18);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 D = _D(C, U, S, P, TGT, DISC);
        uint256 cSold = _amt(D, P, Math.Rounding.Floor);
        uint256 sBurn = Math.mulDiv(_val(cSold, P, Math.Rounding.Floor), BPS - DISC, BPS, Math.Rounding.Ceil);
        (, ILeveragePool.Route r, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.STABILITY_POOL));
        assertEq(aIn, cSold);
        assertEq(aOut, sBurn);
        assertEq(sUSD.totalSupply(), S - sBurn);
        assertEq(sp.totalDeposits(), 500e18 - sBurn);
        assertApproxEqAbs(pool.state().leverage, TGT, 1e12);
        assertEq(pool.lastRebalanceAt(), 0, "SP route sets no cooldown");
    }

    /// DEX route even with SP deposits while NORMAL and open.
    function test_sell_openNormal_withDeposits_usesDex() public {
        _price(78e8);
        _deposit(500e18);
        (, ILeveragePool.Route r,,) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(sp.totalDeposits(), 500e18);
    }

    /// NORMAL and closed with deposits: SP route, sized with the discount, no cooldown.
    function test_sell_closedNormal_spRoute() public {
        uint256 P = _P(78e8);
        _deposit(500e18);
        _warp(T_CLOSED, 78e8);
        assertFalse(pool.state().marketOpen);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 Lb = _L(C, U, S, P);
        uint256 D = _D(C, U, S, P, TGT, DISC);
        assertEq(D, Math.mulDiv(440e18, WAD, 0.98e18));
        (, ILeveragePool.Route r, uint256 aIn, uint256 sBurn) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.STABILITY_POOL));
        assertEq(aIn, _amt(D, P, Math.Rounding.Floor));
        assertEq(sUSD.totalSupply(), S - sBurn);
        ILeveragePool.PoolState memory st = pool.state();
        assertLt(st.leverage, Lb);
        assertApproxEqAbs(st.leverage, TGT, 1e12);
        assertEq(asset.balanceOf(address(sp)), aIn);
        assertEq(pool.lastRebalanceAt(), 0);
        assertEq(st.leverage, _L(C - aIn, U, S - sBurn, P));
    }

    // ================================================================== chunk cap, cooldown, dust

    /// −30%: L = 3.5. Chunk cap $100: each call sells exactly amt(100) and L steps toward T; DEX cooldown 30 s between
    /// chunks; once in band NotInZone wins over Cooldown (R5).
    function test_sell_chunkCap_cooldown() public {
        uint256 P = _P(70e8);
        risk.setChunk(100e18);
        _price(70e8);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 D = _D(C, U, S, P, TGT, SLIP);
        uint256 chunkC = _amt(100e18, P, Math.Rounding.Floor);
        uint256 Lprev = pool.state().leverage;
        assertEq(Lprev, 3.5e18);

        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertEq(pv.sizeUsd, D);
        assertEq(pv.chunkUsd, 100e18);
        assertEq(pv.amountIn, chunkC);

        uint256 t = block.timestamp;
        for (uint256 i; i < 4; ++i) {
            (,, uint256 cSold,) = pool.rebalance();
            assertEq(cSold, chunkC, "chunk cap");
            assertLe(_val(cSold, P, Math.Rounding.Floor), 100e18);
            assertLt(_val(cSold, P, Math.Rounding.Floor), D);
            uint256 L = pool.state().leverage;
            assertLt(L, Lprev, "L moves down");
            assertGe(L + EPS, TGT, "no oversell");
            Lprev = L;
            if (i < 3) {
                assertGt(L, TRIG);
                assertEq(pool.previewRebalance().cooldownLeft, 30);
                vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Cooldown.selector, 30));
                pool.rebalance();
                _warp(t + 10, 70e8);
                vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Cooldown.selector, 20));
                pool.rebalance();
                t += 30;
                _warp(t, 70e8);
            }
        }
        // 3.5 -> 3.25 -> 3.0 -> 2.75 -> 2.5: in band, still cooling down -> NotInZone.
        assertApproxEqAbs(Lprev, 2.5e18, 1e12);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, Lprev));
        pool.rebalance();
        _assertBooksMatchBalances();
    }

    function test_sell_belowDust() public {
        risk.setChunk(0.5e18);
        _price(78e8);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BelowDust.selector, 0.5e18, 1e18));
        pool.rebalance();
    }

    // ================================================================== real UniswapV2-style pair

    uint256 vA; // pair asset reserve at creation
    uint256 vU; // pair usdc reserve at creation
    ZonesV2Pair vPair;

    function _v2(uint256 rAsset, uint256 rUsdc) internal {
        (vA, vU) = (rAsset, rUsdc);
        vPair = new ZonesV2Pair(address(asset), address(usdc));
        vm.startPrank(admin);
        asset.mint(address(vPair), rAsset);
        usdc.mint(address(vPair), rUsdc);
        vm.stopPrank();
        vPair.sync();
        _setRouter(address(new ZonesV2Router(vPair)));
    }

    function _v2Out(uint256 x, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        return x * 9975 * rOut / (rIn * 10000 + x * 9975);
    }

    function _v2Sell(uint256 x) internal view returns (uint256) {
        return _v2Out(x, vA, vU);
    }

    /// Deep pair priced at the oracle: one chunk to target; output is the AMM output, measured by balance delta.
    function test_v2_deep_sellToTarget() public {
        _price(78e8);
        _v2(100_000e18, _usdc(7_800_000));
        SellExp memory e = _sellExp(_P(78e8), TGT, 0);
        uint256 out = _v2Sell(e.cSold);
        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(aIn, e.cSold);
        assertEq(aOut, out);
        assertEq(vPair.reserve0(), vA + e.cSold);
        assertEq(vPair.reserve1(), vU - out);
        _assertBooksMatchBalances();
        uint256 La = pool.state().leverage;
        assertApproxEqAbs(La, TGT, EPS);
        assertLe(La, TGT);
    }

    /// Shallow pair: the full chunk's price impact breaks the budget, the halved chunk passes.
    function test_v2_shallow_halvesChunk() public {
        uint256 P = _P(78e8);
        _price(78e8);
        _v2(1_500e18, _usdc(117_000));
        SellExp memory e = _sellExp(P, TGT, 0);
        assertLt(_v2Sell(e.cSold), e.minOut, "full chunk fails");
        uint256 half = _amt(e.D / 2, P, Math.Rounding.Floor);
        uint256 minHalf = _sellMinOut(_val(half, P, Math.Rounding.Floor), SLIP);
        assertGe(_v2Sell(half), minHalf);

        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertEq(pv.sizeUsd, e.D);
        assertEq(pv.chunkUsd, e.D / 2);
        assertEq(pv.amountIn, half);
        assertEq(pv.minOut, minHalf);
        (,, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(aIn, half);
        assertEq(aOut, _v2Sell(half));
        assertLt(pool.state().leverage, e.Lb);
        _assertBooksMatchBalances();
    }

    /// Very shallow pair: only D/2^7 passes (the 8th try of MAX_CHUNK_HALVINGS = 8).
    function test_v2_veryShallow_sevenHalvings() public {
        uint256 P = _P(78e8);
        _price(78e8);
        _v2(25e18, _usdc(1_950));
        SellExp memory e = _sellExp(P, TGT, 0);
        uint256 c6 = _amt(e.D >> 6, P, Math.Rounding.Floor);
        assertLt(_v2Sell(c6), _sellMinOut(_val(c6, P, Math.Rounding.Floor), SLIP));
        (,, uint256 aIn,) = pool.rebalance();
        assertEq(aIn, _amt(e.D >> 7, P, Math.Rounding.Floor));
        _assertBooksMatchBalances();
    }

    /// Halving below minRebalanceUsd stops the loop and counts as a failed quote (R5): RebalanceCheckFailed(1).
    function test_v2_halvingBelowFloor_failedQuote() public {
        _price(78e8);
        _setParam(300e18); // D ≈ 444 >= 300, D/2 ≈ 222 < 300
        _v2(1_500e18, _usdc(117_000));
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.RebalanceCheckFailed.selector, 1));
        pool.rebalance();
    }

    /// Buy zone through the real pair.
    function test_v2_buyZone() public {
        uint256 P = _P(105e8);
        _price(78e8);
        pool.rebalance(); // MockRouter sell first so U > 0
        _v2(100_000e18, _usdc(10_500_000));
        _warp(block.timestamp + 30, 105e8);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 Lb = _L(C, U, S, P);
        assertLt(Lb, LOW);
        uint256 uIn = Math.min(U, _wu(_B(C, U, S, P, TGT, SLIP), false));
        uint256 out = _v2Out(uIn, vU, vA);
        (ILeveragePool.Zone z,, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.BUY));
        assertEq(aIn, uIn);
        assertEq(aOut, out);
        assertEq(vPair.reserve1(), vU + uIn);
        uint256 La = pool.state().leverage;
        assertGt(La, Lb);
        assertLe(La, TGT + EPS);
        assertApproxEqAbs(La, TGT, EPS);
        _assertBooksMatchBalances();
    }

    // ================================================================== balance-delta accounting

    function _evil(ZonesEvilRouter.Mode m, uint256 extra) internal returns (ZonesEvilRouter r) {
        r = new ZonesEvilRouter(address(asset), address(usdc), address(feed), 18, _usdcDec(), 8);
        vm.startPrank(admin);
        asset.mint(address(r), 1_000e18);
        usdc.mint(address(r), _usdc(1_000_000));
        vm.stopPrank();
        r.setMode(m, extra);
        _setRouter(address(r));
    }

    function test_delta_outBelowMin_reverts5() public {
        _price(78e8);
        _evil(ZonesEvilRouter.Mode.UNDER_MIN, 0);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.RebalanceCheckFailed.selector, 5));
        pool.rebalance();
    }

    function test_delta_shortPull_reverts5() public {
        _price(78e8);
        _evil(ZonesEvilRouter.Mode.SHORT_PULL, 0);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.RebalanceCheckFailed.selector, 5));
        pool.rebalance();
    }

    /// Router returns the quote but delivers less (still >= minOut): U is credited the actual delta.
    function test_delta_shortOut_creditsActual() public {
        _price(78e8);
        uint256 short = _usdc(1);
        ZonesEvilRouter r = _evil(ZonesEvilRouter.Mode.SHORT_OUT, short);
        (uint256 C,,) = _books();
        uint256 q = r.getAmountsOut(pool.previewRebalance().amountIn, _path(address(asset), address(usdc)))[1];
        (,, uint256 cSold, uint256 out) = pool.rebalance();
        assertEq(out, q - short, "out = balance delta");
        (uint256 Ca, uint256 Ua,) = _books();
        assertEq(Ua, q - short);
        assertEq(Ca, C - cSold);
        assertGe(out, r.lastAmountOutMin());
        _assertBooksMatchBalances();
    }

    /// Router delivers more than it reports: U is credited the actual delta, not the return value.
    function test_delta_extraOut_creditsActual() public {
        _price(78e8);
        uint256 extra = _usdc(3);
        ZonesEvilRouter r = _evil(ZonesEvilRouter.Mode.EXTRA_OUT, extra);
        uint256 q = r.getAmountsOut(pool.previewRebalance().amountIn, _path(address(asset), address(usdc)))[1];
        (,,, uint256 out) = pool.rebalance();
        assertEq(out, q + extra);
        (, uint256 Ua,) = _books();
        assertEq(Ua, q + extra);
        _assertBooksMatchBalances();
    }

    /// Tokens sent to the pool directly are ignored by the books (no balanceOf accounting).
    function test_delta_donationByTransferIgnored() public {
        uint256 P = _P(78e8);
        _price(78e8);
        vm.prank(admin);
        usdc.mint(address(pool), _usdc(10_000));
        (uint256 C, uint256 U, uint256 S) = _books();
        assertEq(U, 0);
        assertEq(pool.state().leverage, _L(C, U, S, P));
        (,,, uint256 out) = pool.rebalance();
        (, uint256 Ua) = pool.reserves();
        assertEq(Ua, out);
    }

    // ================================================================== buy zone

    function _sellAt78() internal {
        _price(78e8);
        pool.rebalance();
    }

    struct BuyExp {
        uint256 C;
        uint256 U;
        uint256 S;
        uint256 Lb;
        uint256 B;
        uint256 uIn;
        uint256 minOut;
        uint256 out;
        uint256 La;
    }

    function _buyExp(uint256 P) internal view returns (BuyExp memory e) {
        (e.C, e.U, e.S) = _books();
        e.Lb = _L(e.C, e.U, e.S, P);
        e.B = _B(e.C, e.U, e.S, P, TGT, SLIP);
        uint256 chunk = Math.min(e.B, e.U * uS);
        assertEq(chunk, e.B, "B binds");
        e.uIn = Math.min(e.U, _wu(chunk, false));
        e.minOut = _amt(Math.mulDiv(e.uIn * uS, BPS - SLIP, BPS, Math.Rounding.Ceil), P, Math.Rounding.Ceil);
        e.out = _mockBuyOut(e.uIn, P, 0);
        e.La = _L(e.C + e.out, e.U - e.uIn, e.S, P);
    }

    /// §13.2 (R3): after the −22% sell, recover to $105: L ≈ 1.587 < 1.6 and the buy brings L back to ≈ 2.0.
    function test_buy_afterSellRecovery_105() public {
        _sellAt78();
        _price(105e8);
        // The buy zone uses the DEX cooldown.
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Cooldown.selector, 30));
        pool.rebalance();
        _warp(block.timestamp + 30, 105e8);
        risk.setRef(105e18, block.timestamp);

        BuyExp memory e = _buyExp(_P(105e8));
        assertApproxEqAbs(e.Lb, 1.587e18, 0.001e18);
        assertEq(pool.state().leverage, e.Lb);

        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertEq(uint8(pv.zone), uint8(ILeveragePool.Zone.BUY));
        assertEq(pv.sizeUsd, e.B);
        assertEq(pv.amountIn, e.uIn);
        assertEq(pv.minOut, e.minOut);
        assertTrue(pv.executable);

        vm.expectCall(address(usdc), abi.encodeCall(IERC20.approve, (address(router), e.uIn)));
        vm.expectCall(
            address(router),
            abi.encodeCall(
                IUniswapV2Router02.swapExactTokensForTokens,
                (e.uIn, e.minOut, _path(address(usdc), address(asset)), address(pool), block.timestamp)
            )
        );
        vm.expectEmit(address(pool));
        emit ILeveragePool.BuyZone(e.Lb, e.La, e.uIn, e.out, LOW, SNAP, ILeveragePool.Route.DEX);
        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.BUY));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(aIn, e.uIn);
        assertEq(aOut, e.out);
        (uint256 Ca, uint256 Ua,) = _books();
        assertEq(Ca, e.C + e.out);
        assertEq(Ua, e.U - e.uIn);
        _assertBooksMatchBalances();
        assertEq(pool.state().leverage, e.La);
        assertGt(e.La, e.Lb);
        assertLe(e.La, TGT + EPS);
        assertApproxEqAbs(e.La, TGT, 0.003e18);
        assertEq(pool.lastRebalanceAt(), block.timestamp);

        // Ref refreshed to $105: mints pass the breaker again.
        vm.prank(alice);
        pool.mintStable(0.1e18, 0, block.timestamp);
    }

    function test_buy_sizeIncludesSwapCost() public {
        uint256 P = _P(105e8);
        _sellAt78();
        _warp(block.timestamp + 30, 105e8);
        _fill(49, 0);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 uIn = Math.min(U, _wu(_B(C, U, S, P, TGT, SLIP), false));
        (,, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(aIn, uIn);
        assertEq(aOut, _mockBuyOut(uIn, P, 49));
        uint256 La = pool.state().leverage;
        assertApproxEqAbs(La, TGT, 0.0003e18);
        int256 Ea = _E(C + aOut, U - uIn, S, P);
        assertLe(uint256(_E(C, U, S, P) - Ea), Math.mulDiv(uIn * uS, SLIP, BPS, Math.Rounding.Ceil) + 2);
    }

    /// §13.2: +33% straight after bootstrap -> L ≈ 1.6024, not in the buy zone.
    function test_buy_plus33_notInZone() public {
        _price(133e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.leverage, Math.mulDiv(2660e18, WAD, 1660e18, Math.Rounding.Ceil));
        assertApproxEqAbs(st.leverage, 1.6024e18, 0.0001e18);
        assertEq(st.collateralRatio, 2.66e18);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, st.leverage));
        pool.rebalance();
    }

    /// R3: +35% gives L ≈ 1.588 < 1.6, but U == 0 so the buy zone cannot fire.
    function test_buy_plus35_noUsdc_notInZone() public {
        _price(135e8);
        uint256 L = pool.state().leverage;
        assertLt(L, LOW);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, L));
        pool.rebalance();
    }

    /// No buy inside the gap guard; the same state buys once the market opens.
    function test_buy_blockedInGapGuard() public {
        _sellAt78();
        _warp(NEXT_OPEN - 1800, 105e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertTrue(st.gapGuard);
        assertLt(st.leverage, st.lowerTriggerLev);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, st.leverage));
        pool.rebalance();
        _warp(NEXT_OPEN + 60, 105e8);
        (ILeveragePool.Zone z,,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.BUY));
    }

    // ================================================================== gap guard

    /// Effective trigger/target tighten to 2.3/1.8 within gapGuardSec of nextOpen (inclusive), not before.
    function test_gap_tighteningNearNextOpen() public {
        assertEq(cal.nextOpen(T_CLOSED), NEXT_OPEN);
        _warp(NEXT_OPEN - 3601, 85.6e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertFalse(st.gapGuard);
        assertEq(st.triggerLev, TRIG);
        assertEq(st.targetLev, TGT);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, st.leverage));
        pool.rebalance();

        _warp(NEXT_OPEN - 3600, 85.6e8);
        st = pool.state();
        assertTrue(st.gapGuard);
        assertFalse(st.marketOpen);
        assertEq(st.triggerLev, 2.3e18);
        assertEq(st.targetLev, 1.8e18);
        assertEq(st.lowerTriggerLev, 1.6e18);
        SellExp memory e = _sellExp(_P(85.6e8), 1.8e18, 0);
        assertApproxEqAbs(e.Lb, 2.4045e18, 0.0001e18);
        vm.expectEmit(address(pool));
        emit ILeveragePool.SellZone(e.Lb, e.La, e.cSold, e.out, 2.3e18, SNAP, ILeveragePool.Route.DEX);
        (, ILeveragePool.Route r, uint256 aIn,) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(aIn, e.cSold);
        assertApproxEqAbs(pool.state().leverage, 1.8e18, EPS);
        assertLe(pool.state().leverage, 1.8e18);
    }

    function test_gap_sizeIncludesCost_landsOn18() public {
        _warp(NEXT_OPEN - 1800, 85.6e8);
        _fill(49, 0);
        pool.rebalance();
        assertApproxEqAbs(pool.state().leverage, 1.8e18, 0.0005e18);
    }

    function test_gap_notAppliedOnceOpen() public {
        _warp(NEXT_OPEN, 85.6e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertTrue(st.marketOpen);
        assertFalse(st.gapGuard);
        assertEq(st.triggerLev, TRIG);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, st.leverage));
        pool.rebalance();
    }

    function test_gap_withDeposits_spRoute() public {
        _deposit(500e18);
        _warp(NEXT_OPEN - 1800, 85.6e8);
        (, ILeveragePool.Route r,,) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.STABILITY_POOL));
        assertApproxEqAbs(pool.state().leverage, 1.8e18, 1e12);
    }

    // ================================================================== scenario regressions

    /// −50%: E = 0, L = MAX, xNAV = 0, UNDERWATER (§13.2). The SP route is never used; the DEX sells all stock.
    function test_scn_minus50_underwater() public {
        _deposit(500e18);
        _price(50e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.UNDERWATER));
        assertEq(st.E, 0);
        assertEq(st.leverage, MAX);
        assertEq(st.xNav, 0);
        assertEq(st.collateralRatio, 1e18);

        vm.prank(launcher);
        pool.setDonor(backstop, true);
        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.NotUnderwater.selector);
        pool.donate(_usdc(1), 0);

        risk.setRef(50e18, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintStable(1e18, 0, block.timestamp);

        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX), "never SP while underwater");
        assertEq(aIn, 20e18, "D = CP_f sells all stock");
        assertEq(aOut, _usdc(1000));
        assertEq(sp.totalDeposits(), 500e18);
        (uint256 C, uint256 U) = pool.reserves();
        assertEq(C, 0);
        assertEq(U, _usdc(1000));
        _assertBooksMatchBalances();
    }

    /// −49%: CR = 1.02 -> STABILITY, xNAV = 0.02 (≈ 0), L = 51. DEX (no deposits) with a fill inside the budget
    /// brings L back near T.
    function test_scn_minus49_stability_dex() public {
        uint256 P = _P(51e8);
        _price(51e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.STABILITY));
        assertEq(st.xNav, 0.02e18);
        assertEq(st.collateralRatio, 1.02e18);
        assertEq(st.leverage, 51e18);
        assertEq(st.leverMintFeeBps, 0);
        _fill(49, 0);
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 D = _D(C, U, S, P, TGT, SLIP);
        (, ILeveragePool.Route r, uint256 aIn,) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertEq(aIn, _amt(D, P, Math.Rounding.Floor));
        uint256 La = pool.state().leverage;
        assertGe(La + EPS, TGT);
        assertLe(La, TGT);
    }

    /// −49% with a slip-0 fill: the D formula pre-pays 0.5% cost on a sale ≈ 50× E, so the better fill oversells
    /// to L ≈ 1.505 < T − ε and post-check (3) reverts (SPEC §2.5). Documents the spec behaviour.
    function test_scn_minus49_betterFillOversells_reverts3() public {
        _price(51e8);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.RebalanceCheckFailed.selector, 3));
        pool.rebalance();
    }

    /// −49% with SP deposits: STABILITY routes to the SP even while open; burning at a 1% discount raises CR.
    function test_scn_minus49_stability_spRoute_raisesCR() public {
        uint256 P = _P(51e8);
        _deposit(500e18);
        _price(51e8);
        uint256 CRb = pool.state().collateralRatio;
        (uint256 C, uint256 U, uint256 S) = _books();
        uint256 Lb = _L(C, U, S, P);
        uint256 D = _D(C, U, S, P, TGT, DISC);
        uint256 cap = Math.mulDiv(500e18, BPS, BPS - DISC);
        uint256 cSold = Math.min(C, _amt(Math.min(D, cap), P, Math.Rounding.Floor));
        uint256 sBurn =
            Math.min(500e18, Math.mulDiv(_val(cSold, P, Math.Rounding.Floor), BPS - DISC, BPS, Math.Rounding.Ceil));
        (, ILeveragePool.Route r, uint256 aIn, uint256 aOut) = pool.rebalance();
        assertEq(uint8(r), uint8(ILeveragePool.Route.STABILITY_POOL));
        assertEq(aIn, cSold);
        assertEq(aOut, sBurn);
        ILeveragePool.PoolState memory st = pool.state();
        assertGt(st.collateralRatio, CRb, "SP route raises CR");
        assertLt(st.leverage, Lb);
        assertEq(st.S, S - sBurn);
    }

    /// +33%: L ≈ 1.6024 (see test_buy_plus33_notInZone). −22% and −20.05/−20.07% are covered above.
    function test_scn_minus22_then_plus_recovery_roundTrip() public {
        _sellAt78();
        assertApproxEqAbs(pool.state().leverage, 1.992063e18, 0.000001e18);
        _warp(block.timestamp + 30, 105e8);
        assertApproxEqAbs(pool.state().leverage, 1.5872e18, 0.0001e18);
        pool.rebalance();
        assertApproxEqAbs(pool.state().leverage, 2e18, 0.003e18);
    }
}

/// 18-decimal asset, 18-decimal mUSDC, 8-decimal feed.
contract Zones18Test is ZonesBase {
    function _usdcDec() internal pure override returns (uint8) {
        return 18;
    }
}

/// 18-decimal asset, 6-decimal mUSDC, 8-decimal feed.
contract Zones6Test is ZonesBase {
    function _usdcDec() internal pure override returns (uint8) {
        return 6;
    }
}
