// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILeveragePool} from "../src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../src/interfaces/IRiskOracle.sol";
import {IMockRouter} from "../src/interfaces/IMockRouter.sol";
import {Roles, SplitConstants} from "../src/interfaces/SplitConstants.sol";

import {LeveragePool} from "../src/core/LeveragePool.sol";
import {SplitToken} from "../src/core/SplitToken.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {PoolFactory} from "../src/core/PoolFactory.sol";
import {PoolMath} from "../src/core/PoolMath.sol";
import {MockERC20Permit} from "../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../src/mocks/MockRouter.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

import {PoolRiskStub, PoolCalendarStub, PoolShortFeed, PoolNoHaltFeed} from "./helpers/poolStubs.sol";

/// @notice LeveragePool behaviour against SPEC.md §1-§2 (seed, mints, redeems, fees, caps, breaker, staleness,
///         stability / underwater modes, donate, funding, view totality, pause). Real tokens, feeds, router,
///         factory, SplitToken and StabilityPool; RiskOracle and MarketCalendar are settable stubs
///         (test/helpers/poolStubs.sol) so exact risk values (incl. ones the real clamps forbid) can be set.
///         Expected values are recomputed from the SPEC formulas in this file, never read back from the pool.
///         Runs for three decimal sets: asset/usdc/feed = 18/6/8, 18/18/8, 6/6/18.
abstract contract LeveragePoolTestBase is Test {
    bytes32 internal constant ID = keccak256("NVDA");
    uint256 internal constant BPS = 1e4;
    uint256 internal constant MAXU = type(uint256).max;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant MIN_X = SplitConstants.MIN_X;
    address internal constant DEAD = SplitConstants.DEAD;

    MockERC20Permit internal asset;
    MockERC20Permit internal usdc;
    MockAggregator internal feed;
    MockRouter internal router;
    PoolRiskStub internal risk;
    PoolCalendarStub internal cal;
    PoolFactory internal factory;

    LeveragePool internal pool;
    IERC20 internal sT;
    IERC20 internal xT;
    StabilityPool internal sp;

    uint8 internal aDec;
    uint8 internal uDec;
    uint8 internal fDec;
    uint256 internal aU;
    uint256 internal uS;
    uint256 internal fS;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal launcher = makeAddr("launcher");
    address internal backstop = makeAddr("backstop");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal donor = makeAddr("donor");
    address internal rando = makeAddr("rando");

    struct B {
        uint256 C;
        uint256 U;
        uint256 S;
        uint256 X;
        uint256 P;
    }

    function _decs() internal pure virtual returns (uint8 a, uint8 u, uint8 f);

    function setUp() public {
        (aDec, uDec, fDec) = _decs();
        aU = 10 ** aDec;
        uS = 10 ** (18 - uDec);
        fS = 10 ** (18 - fDec);
        vm.warp(T0);

        vm.startPrank(admin);
        asset = new MockERC20Permit("Test NVDA (MOCK)", "tNVDA", aDec, admin, 0, 1 days);
        usdc = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", uDec, admin, 0, 1 days);
        feed = new MockAggregator(fDec, int256(100e18 / fS), "NVDA / USD (mock)");
        router = new MockRouter(admin);
        risk = new PoolRiskStub();
        cal = new PoolCalendarStub();
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

        risk.setRef(100e18, block.timestamp);
        pool = _newPool(address(feed));
        sT = IERC20(pool.sUSD());
        xT = IERC20(pool.xToken());
        sp = StabilityPool(pool.stabilityPool());
    }

    // =============================================================== helpers

    function _newPool(address feed_) internal returns (LeveragePool p) {
        vm.prank(launcher);
        p = LeveragePool(factory.createPool(address(asset), feed_, ID, "NVDA", address(router), ILeveragePool.PoolKind.LIVE));
        vm.prank(admin);
        router.setCaller(
            address(p),
            IMockRouter.CallerConfig({
                enabled: true, feed: feed_, asset: address(asset), usdc: address(usdc), slippageBps: 0, offsetBps: 0
            })
        );
    }

    /// whole-unit amount expressed as WAD (e.g. 3.3e18) -> asset units
    function _q(uint256 wadUnits) internal view returns (uint256) {
        return wadUnits * aU / 1e18;
    }

    function _usdc(uint256 wadUsd) internal view returns (uint256) {
        return wadUsd / uS;
    }

    function _fund(address to, uint256 amt) internal {
        vm.prank(admin);
        asset.mint(to, amt);
        vm.prank(to);
        asset.approve(address(pool), MAXU);
    }

    function _fundUsdc(address to, uint256 amt) internal {
        vm.prank(admin);
        usdc.mint(to, amt);
        vm.prank(to);
        usdc.approve(address(pool), MAXU);
    }

    function _setPrice(uint256 wad) internal {
        require(wad % fS == 0, "price not representable");
        feed.setAnswer(int256(wad / fS));
    }

    function _setPriceAndRef(uint256 wad) internal {
        _setPrice(wad);
        risk.setRef(wad, block.timestamp);
    }

    function _seed() internal {
        _seedPool(pool, _q(10e18));
    }

    function _seedPool(LeveragePool p, uint256 cIn) internal {
        vm.prank(admin);
        asset.mint(launcher, cIn);
        vm.startPrank(launcher);
        asset.approve(address(p), MAXU);
        p.seed(cIn, backstop);
        vm.stopPrank();
    }

    /// seed $1,000 (10 units at $100) then alice mintStable 10 units: C = 20u, S = 999e18, X = 1000e18, L ~ 2.
    function _bootstrap() internal {
        _seed();
        _fund(alice, _q(100e18));
        vm.prank(alice);
        pool.mintStable(_q(10e18), 0, block.timestamp);
    }

    function _b() internal view returns (B memory b) {
        (b.C, b.U) = pool.reserves();
        b.S = sT.totalSupply();
        b.X = xT.totalSupply();
        b.P = pool.state().price;
    }

    // ---- reference math (SPEC.md §1, §2.2), independent of PoolMath

    function _r(bool ceil) internal pure returns (Math.Rounding) {
        return ceil ? Math.Rounding.Ceil : Math.Rounding.Floor;
    }

    function _val(uint256 c, uint256 P, bool ceil) internal view returns (uint256) {
        return Math.mulDiv(c, P, aU, _r(ceil));
    }

    function _amt(uint256 usd, uint256 P, bool ceil) internal view returns (uint256) {
        return Math.mulDiv(usd, aU, P, _r(ceil));
    }

    function _net(uint256 x, uint256 fee) internal pure returns (uint256) {
        return Math.mulDiv(x, BPS - fee, BPS, Math.Rounding.Floor);
    }

    function _eF(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (int256) {
        return int256(_val(C, P, false) + U * uS) - int256(S);
    }

    function _eC(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (int256) {
        return int256(_val(C, P, true) + U * uS) - int256(S);
    }

    function _lev(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (uint256) {
        int256 e = _eF(C, U, S, P);
        if (e <= 0) return C == 0 ? 0 : MAXU;
        return Math.mulDiv(_val(C, P, true), 1e18, uint256(e), Math.Rounding.Ceil);
    }

    function _cr(uint256 C, uint256 U, uint256 S, uint256 P) internal view returns (uint256) {
        if (S == 0) return MAXU;
        return Math.mulDiv(_val(C, P, false) + U * uS, 1e18, S, Math.Rounding.Floor);
    }

    function _xNav(B memory b) internal view returns (uint256) {
        if (b.X == 0) return 1e18;
        int256 e = _eF(b.C, b.U, b.S, b.P);
        return e <= 0 ? 0 : Math.mulDiv(uint256(e), 1e18, b.X, Math.Rounding.Floor);
    }

    function _lowerFee(uint256 b, uint256 d, uint256 minFee) internal pure returns (uint256) {
        if (b <= minFee) return b;
        return Math.max(minFee, b > d ? b - d : 0);
    }

    /// SPEC.md §2.3 dynamic fees from the pre-action L and the effective T/Tr/Lo/base.
    function _expFees(uint256 L, uint256 T, uint256 Tr, uint256 Lo, uint256 base, bool stability)
        internal
        view
        returns (uint256 sf, uint256 lf)
    {
        ILeveragePool.PoolParams memory p = pool.params();
        uint256 u;
        if (L >= T) {
            u = (L == MAXU || Tr <= T) ? BPS : Math.min(BPS, Math.mulDiv(L - T, BPS, Tr - T));
            uint256 d = p.dynFeeMaxBps * u / BPS;
            sf = base + d;
            lf = _lowerFee(base, d, p.minFeeBps);
        } else {
            u = T > Lo ? Math.min(BPS, Math.mulDiv(T - L, BPS, T - Lo)) : BPS;
            uint256 d = p.dynFeeMaxBps * u / BPS;
            lf = base + d;
            sf = _lowerFee(base, d, p.minFeeBps);
        }
        if (stability) lf = 0;
    }

    /// SPEC.md §2.5 redeemLever outputs.
    function _expRedeemLever(B memory b, uint256 x, uint256 fee) internal view returns (uint256 cOut, uint256 uOut) {
        uint256 valueNet = _net(Math.mulDiv(x, uint256(_eF(b.C, b.U, b.S, b.P)), b.X), fee);
        cOut = Math.min(b.C, _amt(valueNet, b.P, false));
        uint256 rem = valueNet - Math.min(valueNet, _val(cOut, b.P, true));
        uOut = Math.min(b.U, rem / uS);
    }

    function _curFees() internal view returns (uint256 sf, uint256 lf) {
        ILeveragePool.PoolState memory st = pool.state();
        IRiskOracle.RiskView memory rv = risk.riskView(ID);
        uint256 base = st.marketOpen ? rv.params.openFeeBps : rv.params.closedFeeBps;
        return _expFees(
            st.leverage, st.targetLev, st.triggerLev, st.lowerTriggerLev, base, st.mode == ILeveragePool.Mode.STABILITY
        );
    }

    function _withParams(function(ILeveragePool.PoolParams memory) internal pure f) internal {
        ILeveragePool.PoolParams memory p = pool.params();
        f(p);
        vm.prank(admin);
        pool.setParams(p);
    }

    function _p_zeroMinFee(ILeveragePool.PoolParams memory p) internal pure {
        p.minFeeBps = 0;
    }

    function _p_zeroFunding(ILeveragePool.PoolParams memory p) internal pure {
        p.fundingRateBps = 0;
    }

    function _assertViewsTotal() internal view {
        pool.state();
        pool.maxMintStable();
        pool.currentRisk();
        pool.previewRebalance();
    }

    // =============================================================== seed

    function test_seed_mintsMinXToDeadAndRestToRecipient() public {
        _seed();
        assertEq(xT.totalSupply(), 1000e18);
        assertEq(xT.balanceOf(DEAD), MIN_X);
        assertEq(xT.balanceOf(backstop), 1000e18 - MIN_X);
        assertEq(xT.balanceOf(launcher), 0);
        (uint256 C, uint256 U) = pool.reserves();
        assertEq(C, _q(10e18));
        assertEq(U, 0);
        assertEq(asset.balanceOf(address(pool)), C);
        assertEq(sT.totalSupply(), 0);
        assertEq(pool.lastAccrualAt(), block.timestamp);
        assertEq(uint8(pool.lastMode()), uint8(ILeveragePool.Mode.NORMAL));
        // xNAV = $1 at seed
        assertEq(pool.state().xNav, 1e18);
    }

    function test_seed_emitsSeededAndModeChanged() public {
        uint256 cIn = _q(10e18);
        vm.prank(admin);
        asset.mint(launcher, cIn);
        vm.startPrank(launcher);
        asset.approve(address(pool), MAXU);
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Seeded(launcher, backstop, cIn, 1000e18 - MIN_X, MIN_X, 100e18);
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.ModeChanged(ILeveragePool.Mode.UNSEEDED, ILeveragePool.Mode.NORMAL);
        uint256 xr = pool.seed(cIn, backstop);
        vm.stopPrank();
        assertEq(xr, 1000e18 - MIN_X);
    }

    function test_seed_onlyCreatorOrAdmin() public {
        _fund(rando, _q(10e18));
        vm.prank(rando);
        asset.approve(address(pool), MAXU);
        vm.prank(rando);
        vm.expectRevert(ILeveragePool.NotCreatorOrAdmin.selector);
        pool.seed(_q(10e18), backstop);

        // guardian is not enough
        vm.prank(guardian);
        vm.expectRevert(ILeveragePool.NotCreatorOrAdmin.selector);
        pool.seed(_q(10e18), backstop);

        // admin may seed as the fallback
        vm.prank(admin);
        asset.mint(admin, _q(10e18));
        vm.startPrank(admin);
        asset.approve(address(pool), MAXU);
        pool.seed(_q(10e18), backstop);
        vm.stopPrank();
        assertEq(xT.balanceOf(backstop), 1000e18 - MIN_X);
    }

    function test_seed_revertsAlreadySeeded() public {
        _seed();
        vm.prank(admin);
        asset.mint(launcher, _q(10e18));
        vm.prank(launcher);
        vm.expectRevert(ILeveragePool.AlreadySeeded.selector);
        pool.seed(_q(10e18), backstop);
    }

    function test_seed_revertsZeroRecipientAndZeroAmount() public {
        vm.prank(admin);
        asset.mint(launcher, _q(10e18));
        vm.startPrank(launcher);
        asset.approve(address(pool), MAXU);
        vm.expectRevert(ILeveragePool.ZeroAddress.selector);
        pool.seed(_q(10e18), address(0));
        vm.expectRevert(ILeveragePool.ZeroAmount.selector);
        pool.seed(0, backstop);
        vm.stopPrank();
    }

    /// xTotal = val(cIn, Floor) must be > MIN_X. Uses the smallest feed unit so val(cIn) can hit MIN_X exactly.
    function test_seed_tooSmallBoundary_floorRounding() public {
        feed.setAnswer(1); // P = fS wei per whole unit
        uint256 cIn = MIN_X * aU / fS; // val == MIN_X exactly
        assertEq(_val(cIn, fS, false), MIN_X);
        vm.prank(admin);
        asset.mint(launcher, cIn * 10);
        vm.startPrank(launcher);
        asset.approve(address(pool), MAXU);
        vm.expectRevert(ILeveragePool.SeedTooSmall.selector);
        pool.seed(cIn, backstop);
        // one extra wei of asset is worth < 1 wei of USD: still floored to MIN_X
        if (aU > fS) {
            vm.expectRevert(ILeveragePool.SeedTooSmall.selector);
            pool.seed(cIn + 1, backstop);
        }
        uint256 step = aU >= fS ? aU / fS : 1;
        uint256 xr = pool.seed(cIn + step, backstop);
        vm.stopPrank();
        assertEq(xr, 1);
        assertEq(xT.balanceOf(DEAD), MIN_X);
    }

    function test_seed_requiresFreshUnhaltedPrice() public {
        vm.prank(admin);
        asset.mint(launcher, _q(10e18));
        vm.prank(launcher);
        asset.approve(address(pool), MAXU);

        vm.warp(block.timestamp + 121);
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.seed(_q(10e18), backstop);

        _setPrice(100e18);
        feed.setHalted(true);
        vm.prank(launcher);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        pool.seed(_q(10e18), backstop);
        feed.setHalted(false);

        feed.setRevertOnRead(true);
        vm.prank(launcher);
        vm.expectRevert(ILeveragePool.NoPrice.selector);
        pool.seed(_q(10e18), backstop);
    }

    /// No fee and no breaker on seed; a mint pause does not block it either.
    function test_seed_noBreakerNoFeeIgnoresMintPause() public {
        risk.setRef(0, 0);
        risk.setMintsPaused(true);
        vm.prank(guardian);
        pool.setMintsPaused(true);
        _setPrice(123.45678901e18);
        uint256 cIn = _q(7.777e18);
        _seedPool(pool, cIn);
        uint256 xTotal = _val(cIn, 123.45678901e18, false);
        assertEq(xT.totalSupply(), xTotal);
        assertEq(xT.balanceOf(backstop), xTotal - MIN_X);
    }

    // =============================================================== mintStable

    function test_mintStable_mathFeeAndEvent() public {
        _bootstrap();
        // L = 1 before the first mint: stableFee = lower(30, 50) = max(10, 0) = 10 bps
        assertEq(sT.balanceOf(alice), 999e18);

        _setPriceAndRef(101.23456789e18);
        B memory b = _b();
        (uint256 sf,) = _curFees();
        uint256 cIn = _q(1.2345e18);
        uint256 expOut = _net(_val(cIn, b.P, false), sf);
        assertEq(pool.state().stableMintFeeBps, sf);
        (uint256 pOut, uint256 pFee) = pool.previewMintStable(cIn);
        assertEq(pOut, expOut);
        assertEq(pFee, sf);

        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Minted(alice, ILeveragePool.Action.MINT_STABLE, cIn, expOut, sf, b.P);
        vm.prank(alice);
        uint256 out = pool.mintStable(cIn, expOut, block.timestamp);
        assertEq(out, expOut);
        (uint256 C,) = pool.reserves();
        assertEq(C, b.C + cIn);
        assertEq(sT.totalSupply(), b.S + expOut);
    }

    function test_mintStable_slippage() public {
        _bootstrap();
        (uint256 o,) = pool.previewMintStable(_q(1e18));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Slippage.selector, o, o + 1));
        pool.mintStable(_q(1e18), o + 1, block.timestamp);
    }

    /// SPEC.md §2.4 guard order.
    function test_mintStable_guardOrder() public {
        // 3. NotSeeded (before the pause check 4)
        vm.prank(guardian);
        pool.setMintsPaused(true);
        _fund(alice, _q(100e18));
        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.NotSeeded.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.stopPrank();
        vm.prank(guardian);
        pool.setMintsPaused(false);

        _bootstrap();
        vm.startPrank(alice);
        // 1. Expired beats ZeroAmount
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Expired.selector, block.timestamp - 1));
        pool.mintStable(0, 0, block.timestamp - 1);
        // 2. ZeroAmount
        vm.expectRevert(ILeveragePool.ZeroAmount.selector);
        pool.mintStable(0, 0, block.timestamp);
        vm.stopPrank();

        // 4. paused beats unusable price
        risk.setMintsPaused(true);
        feed.setRevertOnRead(true);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.MintsArePaused.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        risk.setMintsPaused(false);

        // 5. NoPrice
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.NoPrice.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        feed.setRevertOnRead(false);

        // 6. stale beats halted
        vm.warp(block.timestamp + 121);
        risk.setRef(100e18, block.timestamp);
        feed.setHalted(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.mintStable(_q(1e18), 0, block.timestamp);

        // 7. halted beats the breaker
        _setPrice(150e18);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);

        // 8. breaker
        feed.setHalted(false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 5000, 250));
        pool.mintStable(_q(1e18), 0, block.timestamp);
    }

    function test_mintStable_leverageCap_exactL() public {
        _bootstrap();
        B memory b = _b();
        assertEq(pool.state().maxMintLev, 2.335e18); // (2.0 + 2.67) / 2
        uint256 cIn = _q(15e18);
        (uint256 sf,) = _curFees();
        uint256 sOut = _net(_val(cIn, b.P, false), sf);
        uint256 lp = _lev(b.C + cIn, b.U, b.S + sOut, b.P);
        assertGt(lp, 2.335e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.LeverageTooHigh.selector, lp, 2.335e18));
        pool.mintStable(cIn, 0, block.timestamp);
    }

    /// CR' >= stabilityCR is checked after the L cap; reachable when the risk trigger is very high.
    function test_mintStable_crCap_exactCR() public {
        _bootstrap();
        risk.setLevels(10e18, 9e18, 1.6e18);
        B memory b = _b();
        uint256 cIn = _q(25e18);
        (uint256 sf,) = _curFees();
        uint256 sOut = _net(_val(cIn, b.P, false), sf);
        uint256 crp = _cr(b.C + cIn, b.U, b.S + sOut, b.P);
        assertLt(crp, 1.3e18);
        assertLe(_lev(b.C + cIn, b.U, b.S + sOut, b.P), 9.5e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.CRTooLow.selector, crp, 1.3e18));
        pool.mintStable(cIn, 0, block.timestamp);
    }

    function test_mintStable_closedMarketCap() public {
        _bootstrap();
        uint256 cIn = _q(2.6e18);

        cal.set(false, false);
        ILeveragePool.PoolState memory st = pool.state();
        assertFalse(st.marketOpen);
        assertEq(st.maxMintLev, 2.2e18); // min(2.335, closedMaxLev 2.2)
        (, uint256 mm) = pool.currentRisk();
        assertEq(mm, 2.2e18);
        B memory b = _b();
        (uint256 sf,) = _curFees();
        // closed base fee 100; L ~ 1.998 < T so the stable fee is lowered by d = 0
        assertEq(sf, 100);
        uint256 sOut = _net(_val(cIn, b.P, false), sf);
        uint256 lp = _lev(b.C + cIn, b.U, b.S + sOut, b.P);
        assertGt(lp, 2.2e18);
        assertLt(lp, 2.335e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.LeverageTooHigh.selector, lp, 2.2e18));
        pool.mintStable(cIn, 0, block.timestamp);

        // open: the same mint fits under 2.335
        cal.set(true, false);
        vm.prank(alice);
        pool.mintStable(cIn, 0, block.timestamp);
        assertLe(pool.state().leverage, 2.335e18);
    }

    function test_gapGuard_effectiveLevels() public {
        _bootstrap();
        cal.set(false, true);
        ILeveragePool.PoolState memory st = pool.state();
        assertTrue(st.gapGuard);
        assertEq(st.targetLev, 1.8e18);
        assertEq(st.triggerLev, 2.3e18);
        assertEq(st.lowerTriggerLev, 1.6e18); // min(1.6, 1.8 - 0.2)
        assertEq(st.maxMintLev, 2.05e18); // min((1.8 + 2.3)/2, 2.2)
        (IRiskOracle.RiskParams memory r, uint256 mm) = pool.currentRisk();
        assertEq(r.targetLev, 1.8e18);
        assertEq(r.triggerLev, 2.3e18);
        assertEq(r.lowerTriggerLev, 1.6e18);
        assertEq(mm, 2.05e18);
        // Lo is also capped at T - 0.2 outside the gap guard
        cal.set(true, false);
        risk.setLevels(2.67e18, 1.7e18, 1.6e18);
        assertEq(pool.state().lowerTriggerLev, 1.5e18);
    }

    function test_mintStable_revertsInStabilityAndUnderwater() public {
        _bootstrap();
        _setPriceAndRef(60e18); // CP 1200, S 999: CR ~ 1.2
        assertEq(uint8(pool.state().mode), uint8(ILeveragePool.Mode.STABILITY));
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.StabilityMode.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);

        _setPriceAndRef(45e18);
        assertEq(uint8(pool.state().mode), uint8(ILeveragePool.Mode.UNDERWATER));
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
    }

    function test_mintWithPermit_toleratesBadSignature() public {
        _bootstrap();
        // allowance already set by _fund; a garbage permit is swallowed (front-run tolerant)
        vm.startPrank(alice);
        uint256 s = pool.mintStableWithPermit(_q(1e18), 0, block.timestamp, block.timestamp, 27, bytes32(0), bytes32(0));
        assertGt(s, 0);
        uint256 x = pool.mintLeverWithPermit(_q(1e18), 0, block.timestamp, block.timestamp, 27, bytes32(0), bytes32(0));
        assertGt(x, 0);
        vm.stopPrank();
    }

    // =============================================================== maxMintStable

    function test_maxMintStable_levCapExact() public {
        _bootstrap();
        uint256 m = pool.maxMintStable();
        assertGt(m, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        pool.mintStable(m, 0, block.timestamp);
        assertLe(pool.state().leverage, 2.335e18);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectPartialRevert(ILeveragePool.LeverageTooHigh.selector);
        pool.mintStable(m * 101 / 100 + 1, 0, block.timestamp);
    }

    function test_maxMintStable_crCapExact() public {
        _bootstrap();
        risk.setLevels(10e18, 9e18, 1.6e18);
        uint256 m = pool.maxMintStable();
        assertGt(m, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        pool.mintStable(m, 0, block.timestamp);
        assertGe(pool.state().collateralRatio, 1.3e18);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectPartialRevert(ILeveragePool.CRTooLow.selector);
        pool.mintStable(m * 101 / 100 + 1, 0, block.timestamp);
    }

    function test_maxMintStable_closedMarket() public {
        _bootstrap();
        cal.set(false, false);
        uint256 m = pool.maxMintStable();
        assertGt(m, 0);
        vm.prank(alice);
        pool.mintStable(m, 0, block.timestamp);
        assertLe(pool.state().leverage, 2.2e18);
    }

    function test_maxMintStable_zeroWhenMintWouldRevert() public {
        assertEq(pool.maxMintStable(), 0); // unseeded
        _bootstrap();
        assertGt(pool.maxMintStable(), 0);
        uint256 snap = vm.snapshotState();

        vm.prank(guardian);
        pool.setMintsPaused(true);
        assertEq(pool.maxMintStable(), 0, "local pause");
        vm.revertToState(snap);

        risk.setMintsPaused(true);
        assertEq(pool.maxMintStable(), 0, "risk pause");
        vm.revertToState(snap);

        feed.setHalted(true);
        assertEq(pool.maxMintStable(), 0, "halted");
        vm.revertToState(snap);

        vm.warp(block.timestamp + 121);
        risk.setRef(100e18, block.timestamp);
        assertEq(pool.maxMintStable(), 0, "stale");
        vm.revertToState(snap);

        _setPrice(103e18);
        assertEq(pool.maxMintStable(), 0, "breaker");
        vm.revertToState(snap);

        risk.setRef(100e18, block.timestamp - 3601);
        assertEq(pool.maxMintStable(), 0, "stale ref");
        vm.revertToState(snap);

        risk.setRef(0, 0);
        assertEq(pool.maxMintStable(), 0, "no ref");
        vm.revertToState(snap);

        _setPriceAndRef(60e18);
        assertEq(pool.maxMintStable(), 0, "stability");
        vm.revertToState(snap);

        _setPriceAndRef(45e18);
        assertEq(pool.maxMintStable(), 0, "underwater");
        vm.revertToState(snap);

        feed.setRevertOnRead(true);
        assertEq(pool.maxMintStable(), 0, "no price");
        vm.revertToState(snap);

        risk.setReverts(true);
        assertEq(pool.maxMintStable(), 0, "risk oracle down -> fallback paused");
    }

    // =============================================================== mintLever

    function test_mintLever_mathUsesECeil() public {
        _bootstrap();
        _setPriceAndRef(101.23456789e18);
        B memory b = _b();
        (, uint256 lf) = _curFees();
        uint256 cIn = _q(3.3e18);
        uint256 vNet = _net(_val(cIn, b.P, false), lf);
        int256 eC = _eC(b.C, b.U, b.S, b.P);
        uint256 exp = Math.mulDiv(vNet, b.X, uint256(eC), Math.Rounding.Floor);
        assertLe(exp, Math.mulDiv(vNet, b.X, uint256(_eF(b.C, b.U, b.S, b.P)), Math.Rounding.Floor));
        (uint256 px, uint256 pf) = pool.previewMintLever(cIn);
        assertEq(px, exp);
        assertEq(pf, lf);

        uint256 navBefore = pool.state().xNav;
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Minted(alice, ILeveragePool.Action.MINT_LEVER, cIn, exp, lf, b.P);
        vm.prank(alice);
        uint256 out = pool.mintLever(cIn, exp, block.timestamp);
        assertEq(out, exp);
        assertEq(xT.totalSupply(), b.X + exp);
        assertEq(sT.totalSupply(), b.S);
        // no dilution of existing x holders
        assertGe(pool.state().xNav + 1, navBefore);
    }

    function testFuzz_mintLever_neverRaisesL(uint256 cIn, uint256 priceCents) public {
        _bootstrap();
        priceCents = bound(priceCents, 7600, 20000); // $76..$200, NORMAL mode
        _setPriceAndRef(priceCents * 1e16);
        cIn = bound(cIn, 1, _q(1000e18));
        uint256 lb = pool.state().leverage;
        _fund(bob, cIn);
        vm.prank(bob);
        try pool.mintLever(cIn, 0, block.timestamp) {
            assertLe(pool.state().leverage, lb);
        } catch (bytes memory err) {
            assertEq(bytes4(err), ILeveragePool.ZeroOutput.selector);
        }
    }

    /// No leverage cap on mintLever: allowed even above the trigger; mintStable is blocked there.
    function test_mintLever_noCapAboveTrigger() public {
        _bootstrap();
        _setPriceAndRef(75.2e18); // CP 1504, E 505, L ~ 2.98 > 2.67, CR ~ 1.5
        ILeveragePool.PoolState memory st = pool.state();
        assertGt(st.leverage, 2.67e18);
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NORMAL));
        vm.prank(alice);
        vm.expectPartialRevert(ILeveragePool.LeverageTooHigh.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.prank(alice);
        pool.mintLever(_q(50e18), 0, block.timestamp);
        assertLt(pool.state().leverage, st.leverage);
    }

    function test_mintLever_revertsUnderwater() public {
        _bootstrap();
        _setPriceAndRef(45e18);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintLever(_q(1e18), 0, block.timestamp);
    }

    function test_mintLever_guards() public {
        _bootstrap();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Expired.selector, block.timestamp - 1));
        pool.mintLever(_q(1e18), 0, block.timestamp - 1);
        vm.expectRevert(ILeveragePool.ZeroAmount.selector);
        pool.mintLever(0, 0, block.timestamp);
        vm.stopPrank();
        (uint256 o,) = pool.previewMintLever(_q(1e18));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Slippage.selector, o, o + 1));
        pool.mintLever(_q(1e18), o + 1, block.timestamp);

        vm.prank(guardian);
        pool.setMintsPaused(true);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.MintsArePaused.selector);
        pool.mintLever(_q(1e18), 0, block.timestamp);
        vm.prank(guardian);
        pool.setMintsPaused(false);

        feed.setHalted(true);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        pool.mintLever(_q(1e18), 0, block.timestamp);
    }

    // =============================================================== fees

    function test_fees_dynamicBands_open() public {
        _bootstrap();
        // below the lower trigger: L ~ 1.555 -> u = BPS, d = 50
        _setPriceAndRef(140e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertLt(st.leverage, 1.6e18);
        assertEq(st.leverMintFeeBps, 80);
        assertEq(st.stableMintFeeBps, 10); // max(10, 30 - 50)

        // inside [T, Tr]: proportional
        _setPriceAndRef(88.37e18);
        st = pool.state();
        assertGt(st.leverage, 2e18);
        assertLt(st.leverage, 2.67e18);
        (uint256 sf, uint256 lf) = _curFees();
        assertEq(st.stableMintFeeBps, sf);
        assertEq(st.leverMintFeeBps, lf);
        assertGt(sf, 30);
        assertLt(sf, 80);

        // the action charges exactly the advertised fee
        B memory b = _b();
        uint256 cIn = _q(0.01e18);
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Minted(alice, ILeveragePool.Action.MINT_STABLE, cIn, _net(_val(cIn, b.P, false), sf), sf, b.P);
        vm.prank(alice);
        pool.mintStable(cIn, 0, block.timestamp);

        // above the trigger: u = BPS
        _setPriceAndRef(75.2e18);
        st = pool.state();
        assertGt(st.leverage, 2.67e18);
        assertEq(st.stableMintFeeBps, 80);
        assertEq(st.leverMintFeeBps, 10);
    }

    function test_fees_closedBase() public {
        _bootstrap();
        cal.set(false, false);
        _setPriceAndRef(75.2e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.stableMintFeeBps, 150);
        assertEq(st.leverMintFeeBps, 50);
        _setPriceAndRef(140e18);
        st = pool.state();
        assertEq(st.leverMintFeeBps, 150);
        assertEq(st.stableMintFeeBps, 50);
    }

    function test_fees_baseAtOrBelowMinFeeNotLowered() public {
        _bootstrap();
        risk.setFees(5, 5);
        _setPriceAndRef(140e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.stableMintFeeBps, 5);
        assertEq(st.leverMintFeeBps, 55);
    }

    function test_fees_triggerNotAboveTarget_fullDynFee() public {
        _bootstrap();
        risk.setLevels(2.0e18, 2.0e18, 1.6e18);
        _setPriceAndRef(88.37e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.stableMintFeeBps, 80);
        assertEq(st.leverMintFeeBps, 10);
    }

    function test_fees_underwaterLMax_noRevert() public {
        _bootstrap();
        _setPriceAndRef(45e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.leverage, MAXU);
        assertEq(st.stableMintFeeBps, 80);
        assertEq(st.leverMintFeeBps, 10);
    }

    function test_fees_redeemFees() public {
        _bootstrap();
        (,, uint256 f1) = pool.previewRedeemStable(10e18);
        assertEq(f1, 20);
        (,, uint256 f2) = pool.previewRedeemLever(10e18);
        assertEq(f2, 20);
        vm.prank(alice);
        sT.transfer(backstop, 10e18);
        B memory b = _b();
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Redeemed(
            backstop,
            ILeveragePool.Action.REDEEM_PAIR,
            10e18,
            Math.mulDiv(10e18, b.X, b.S, Math.Rounding.Ceil),
            _net(Math.mulDiv(b.C, 10e18, b.S), 20),
            0,
            20,
            0
        );
        vm.prank(backstop);
        pool.redeemPair(10e18, MAXU, 0, 0);
    }

    // =============================================================== redeemStable

    function test_redeemStable_math_VgeS() public {
        _bootstrap();
        _setPriceAndRef(101.23456789e18);
        B memory b = _b();
        uint256 s = 123.456789e18;
        (uint256 expC, uint256 expU) = _expRedeemStable(b, s);

        uint256 bal = asset.balanceOf(alice);
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Redeemed(alice, ILeveragePool.Action.REDEEM_STABLE, s, 0, expC, expU, 20, b.P);
        vm.prank(alice);
        (uint256 cOut, uint256 uOut) = pool.redeemStable(s, expC, expU);
        assertEq(cOut, expC);
        assertEq(uOut, expU);
        assertEq(asset.balanceOf(alice) - bal, expC);
        B memory a = _b();
        assertEq(a.C, b.C - expC);
        assertEq(a.S, b.S - s);
        // E (x holders) not reduced, sUSD backing not reduced
        assertGe(_eF(a.C, a.U, a.S, a.P), _eF(b.C, b.U, b.S, b.P));
        assertGe(_cr(a.C, a.U, a.S, a.P), _cr(b.C, b.U, b.S, b.P));
    }

    function _expRedeemStable(B memory b, uint256 s) internal view returns (uint256 cOut, uint256 uOut) {
        uint256 sNet = _net(s, 20);
        uint256 den = Math.max(_val(b.C, b.P, true) + b.U * uS, b.S);
        cOut = Math.mulDiv(b.C, sNet, den);
        uOut = Math.mulDiv(b.U, sNet, den);
    }

    function test_redeemStable_worksUpToRedeemPriceAge() public {
        _bootstrap();
        vm.warp(block.timestamp + 121); // too old for mints
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);
        vm.warp(T0 + 86400);
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);
        vm.warp(T0 + 86401);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 86401, 86400));
        pool.redeemStable(10e18, 0, 0);
    }

    function test_redeemStable_futureTimestampAndNoPrice() public {
        _bootstrap();
        feed.setAnswerAt(int256(100e18 / fS), block.timestamp + 31);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 0, 86400));
        pool.redeemStable(10e18, 0, 0);
        feed.setAnswerAt(int256(100e18 / fS), block.timestamp + 30);
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);

        feed.setRevertOnRead(true);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.NoPrice.selector);
        pool.redeemStable(10e18, 0, 0);
    }

    function test_redeemStable_zeroAndSlippage() public {
        _bootstrap();
        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.ZeroAmount.selector);
        pool.redeemStable(0, 0, 0);
        (uint256 c,,) = pool.previewRedeemStable(10e18);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.SlippageC.selector, c, c + 1));
        pool.redeemStable(10e18, c + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.SlippageU.selector, 0, 1));
        pool.redeemStable(10e18, 0, 1);
        vm.stopPrank();
    }

    // =============================================================== redeemLever

    function test_redeemLever_math() public {
        _bootstrap();
        _setPriceAndRef(101.23456789e18);
        B memory b = _b();
        uint256 x = 100e18;
        (uint256 expC, uint256 expU) = _expRedeemLever(b, x, 20);
        uint256 navBefore = _xNav(b);

        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.Redeemed(backstop, ILeveragePool.Action.REDEEM_LEVER, 0, x, expC, expU, 20, b.P);
        vm.prank(backstop);
        (uint256 cOut, uint256 uOut) = pool.redeemLever(x, expC, expU);
        assertEq(cOut, expC);
        assertEq(uOut, expU);
        assertEq(asset.balanceOf(backstop), expC);
        B memory a = _b();
        assertEq(a.X, b.X - x);
        assertGe(_xNav(a) + 1, navBefore);
        assertLe(pool.state().leverage, 2.67e18);
    }

    /// Stock first, then mUSDC: with L < 1 (U large, S = 0) one holder's claim exceeds the stock.
    function test_redeemLever_stockFirstThenUsdc() public {
        _bootstrap();
        _setPrice(78e18);
        pool.rebalance(); // DEX sell: U > 0
        (, uint256 U0) = pool.reserves();
        assertGt(U0, 0);
        uint256 sAll = sT.balanceOf(alice);
        vm.prank(alice);
        pool.redeemStable(sAll, 0, 0);
        assertEq(sT.totalSupply(), 0);

        B memory b = _b();
        uint256 x = xT.balanceOf(backstop);
        uint256 valueNet = _net(Math.mulDiv(x, uint256(_eF(b.C, b.U, b.S, b.P)), b.X), 20);
        uint256 expC = Math.min(b.C, _amt(valueNet, b.P, false));
        assertEq(expC, b.C, "all stock paid first");
        uint256 rem = valueNet - Math.min(valueNet, _val(expC, b.P, true));
        uint256 expU = Math.min(b.U, rem / uS);
        assertGt(expU, 0);
        vm.prank(backstop);
        (uint256 cOut, uint256 uOut) = pool.redeemLever(x, 0, 0);
        assertEq(cOut, expC);
        assertEq(uOut, expU);
        assertEq(usdc.balanceOf(backstop), expU);
    }

    function test_redeemLever_leverageAfterCappedAtTrigger() public {
        _bootstrap();
        B memory b = _b();
        uint256 x = 700e18;
        uint256 valueNet = _net(Math.mulDiv(x, uint256(_eF(b.C, b.U, b.S, b.P)), b.X), 20);
        uint256 cOut = Math.min(b.C, _amt(valueNet, b.P, false));
        uint256 lp = _lev(b.C - cOut, b.U, b.S, b.P);
        assertGt(lp, 2.67e18);
        vm.prank(backstop);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.LeverageTooHigh.selector, lp, 2.67e18));
        pool.redeemLever(x, 0, 0);
        // the cap is the effective (gap-guarded) trigger
        cal.set(false, true);
        uint256 x2 = 290e18;
        valueNet = _net(Math.mulDiv(x2, uint256(_eF(b.C, b.U, b.S, b.P)), b.X), 20);
        cOut = Math.min(b.C, _amt(valueNet, b.P, false));
        lp = _lev(b.C - cOut, b.U, b.S, b.P);
        assertGt(lp, 2.3e18);
        assertLt(lp, 2.67e18);
        vm.prank(backstop);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.LeverageTooHigh.selector, lp, 2.3e18));
        pool.redeemLever(x2, 0, 0);
    }

    function test_redeemLever_guards() public {
        _bootstrap();
        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.ZeroAmount.selector);
        pool.redeemLever(0, 0, 0);

        vm.warp(block.timestamp + 121);
        vm.prank(backstop);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.redeemLever(10e18, 0, 0);

        _setPrice(100e18);
        feed.setHalted(true);
        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        pool.redeemLever(10e18, 0, 0);
        feed.setHalted(false);

        _setPriceAndRef(45e18);
        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.redeemLever(10e18, 0, 0);
    }

    function test_redeemLever_slippage() public {
        _bootstrap();
        (uint256 c,,) = pool.previewRedeemLever(10e18);
        vm.prank(backstop);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.SlippageC.selector, c, c + 1));
        pool.redeemLever(10e18, c + 1, 0);
    }

    // =============================================================== redeemPair

    function test_redeemPair_sBinding() public {
        _bootstrap();
        vm.prank(alice);
        sT.transfer(backstop, 100e18);
        B memory b = _b();
        uint256 lb = pool.state().leverage;
        uint256 xExp = Math.mulDiv(100e18, b.X, b.S, Math.Rounding.Ceil);
        uint256 cExp = _net(Math.mulDiv(b.C, 100e18, b.S), 20);
        vm.prank(backstop);
        (uint256 sB, uint256 xB, uint256 cOut, uint256 uOut) = pool.redeemPair(100e18, MAXU, 0, 0);
        assertEq(sB, 100e18);
        assertEq(xB, xExp);
        assertEq(cOut, cExp);
        assertEq(uOut, 0);
        assertEq(sT.balanceOf(backstop), 0);
        assertEq(xT.balanceOf(backstop), 1000e18 - MIN_X - xExp);
        uint256 la = pool.state().leverage;
        assertLe(la, lb + 1);
        assertGe(la, lb * 995 / 1000);
    }

    function test_redeemPair_xBinding_withUsdc() public {
        _bootstrap();
        _setPrice(78e18);
        pool.rebalance();
        vm.prank(backstop);
        xT.transfer(alice, 50e18);
        B memory b = _b();
        assertGt(b.U, 0);
        uint256 lb = pool.state().leverage;
        uint256 sExp = Math.mulDiv(50e18, b.S, b.X, Math.Rounding.Ceil);
        uint256 cExp = _net(Math.mulDiv(b.C, 50e18, b.X), 20);
        uint256 uExp = _net(Math.mulDiv(b.U, 50e18, b.X), 20);
        vm.prank(alice);
        (uint256 sB, uint256 xB, uint256 cOut, uint256 uOut) = pool.redeemPair(MAXU, 50e18, cExp, uExp);
        assertEq(xB, 50e18);
        assertEq(sB, sExp);
        assertEq(cOut, cExp);
        assertEq(uOut, uExp);
        uint256 la = pool.state().leverage;
        assertLe(la, lb + 1);
        assertGe(la, lb * 995 / 1000);
    }

    function test_redeemPair_S0_requiresSMaxZero() public {
        _seed();
        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.BadPairRatio.selector);
        pool.redeemPair(1, 100e18, 0, 0);
        (uint256 C,) = pool.reserves();
        vm.prank(backstop);
        (uint256 sB, uint256 xB, uint256 cOut,) = pool.redeemPair(0, 100e18, 0, 0);
        assertEq(sB, 0);
        assertEq(xB, 100e18);
        assertEq(cOut, _net(Math.mulDiv(C, 100e18, 1000e18), 20));
    }

    function test_redeemPair_notSeededAndZero() public {
        vm.expectRevert(ILeveragePool.NotSeeded.selector);
        pool.redeemPair(1, 1, 0, 0);
        _bootstrap();
        vm.prank(alice);
        vm.expectRevert();
        pool.redeemPair(0, 0, 0, 0);
    }

    /// No oracle: works with a reverting feed, a halt, a days-old price, a reverting RiskOracle and paused mints.
    function test_redeemPair_needsNoOracle() public {
        _bootstrap();
        vm.prank(backstop);
        xT.transfer(alice, 500e18);
        risk.setReverts(true);
        cal.setReverts(true, true);
        vm.prank(guardian);
        pool.setMintsPaused(true);
        feed.setHalted(true);
        vm.warp(block.timestamp + 10 days);
        vm.prank(alice);
        pool.redeemPair(10e18, MAXU, 0, 0);
        feed.setRevertOnRead(true);
        vm.expectEmit(true, true, false, false, address(pool));
        emit ILeveragePool.Redeemed(alice, ILeveragePool.Action.REDEEM_PAIR, 0, 0, 0, 0, 20, 0);
        vm.prank(alice);
        (uint256 sB,, uint256 cOut,) = pool.redeemPair(10e18, MAXU, 0, 0);
        assertEq(sB, 10e18);
        assertGt(cOut, 0);
    }

    function test_redeemPair_capsAtSupply_noOverflow() public {
        _bootstrap();
        uint256 xb = xT.balanceOf(backstop);
        vm.prank(backstop);
        xT.transfer(alice, xb);
        // alice holds all S and all but MIN_X of X
        vm.prank(alice);
        (uint256 sB, uint256 xB,,) = pool.redeemPair(MAXU, 500e18, 0, 0);
        assertEq(xB, 500e18);
        assertEq(sB, Math.mulDiv(500e18, 999e18, 1000e18, Math.Rounding.Ceil));
    }

    // =============================================================== breaker

    function test_breaker_boundaryAndCeilRounding() public {
        _bootstrap();
        _setPrice(102.5e18); // dev exactly 250
        vm.prank(alice);
        pool.mintStable(_q(0.1e18), 0, block.timestamp);
        _setPrice(102.50000001e18); // dev 250.000001 -> ceil 251
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 251, 250));
        pool.mintStable(_q(0.1e18), 0, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 251, 250));
        pool.mintLever(_q(0.1e18), 0, block.timestamp);

        _setPrice(97.5e18);
        vm.prank(alice);
        pool.mintLever(_q(0.1e18), 0, block.timestamp);
        _setPrice(97.49999999e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 251, 250));
        pool.mintLever(_q(0.1e18), 0, block.timestamp);

        // maxDev comes from the risk view
        risk.setMaxDev(50);
        _setPrice(100.6e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 60, 50));
        pool.mintStable(_q(0.1e18), 0, block.timestamp);
    }

    function test_breaker_refMissingOrStale() public {
        _bootstrap();
        risk.setRef(0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StaleRefPrice.selector, MAXU, 3600));
        pool.mintStable(_q(1e18), 0, block.timestamp);

        risk.setRef(100e18, block.timestamp - 3601);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StaleRefPrice.selector, 3601, 3600));
        pool.mintLever(_q(1e18), 0, block.timestamp);

        risk.setRef(100e18, block.timestamp - 3600);
        vm.prank(alice);
        pool.mintLever(_q(1e18), 0, block.timestamp);

        // a ref timestamp in the future has age 0 (saturating)
        risk.setRef(100e18, block.timestamp + 1000);
        vm.prank(alice);
        pool.mintLever(_q(1e18), 0, block.timestamp);
    }

    function test_breaker_blocksMintsOnly() public {
        _bootstrap();
        _setPrice(85e18); // ref still $100: dev 1500
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 1500, 250));
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 1500, 250));
        pool.mintLever(_q(1e18), 0, block.timestamp);
        pool.redeemStable(10e18, 0, 0);
        vm.stopPrank();
        vm.startPrank(backstop);
        pool.redeemLever(10e18, 0, 0);
        vm.stopPrank();
        vm.prank(alice);
        sT.transfer(backstop, 10e18);
        vm.prank(backstop);
        pool.redeemPair(10e18, MAXU, 0, 0);
        pool.accrue();
        // a sell-zone rebalance is not gated by the breaker
        _setPrice(78e18);
        (ILeveragePool.Zone z,,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
    }

    // =============================================================== staleness

    function test_stalePrice_blocksMintsNotExits() public {
        _bootstrap();
        vm.prank(backstop);
        xT.transfer(alice, 100e18);
        vm.warp(block.timestamp + 121);
        risk.setRef(100e18, block.timestamp);
        ILeveragePool.PoolState memory st = pool.state();
        assertFalse(st.priceFresh);
        assertEq(st.priceAge, 121);
        assertEq(st.price, 100e18);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.mintLever(_q(1e18), 0, block.timestamp);
        (uint256 c1,) = pool.redeemStable(10e18, 0, 0);
        assertGt(c1, 0);
        (,, uint256 c2,) = pool.redeemPair(10e18, MAXU, 0, 0);
        assertGt(c2, 0);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.rebalance();
    }

    function test_futureTimestamp_blocksMints() public {
        _bootstrap();
        feed.setAnswerAt(int256(100e18 / fS), block.timestamp + 31);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.priceAge, 0);
        assertFalse(st.priceFresh);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 0, 120));
        pool.mintStable(_q(1e18), 0, block.timestamp);
        feed.setAnswerAt(int256(100e18 / fS), block.timestamp + 30);
        assertTrue(pool.state().priceFresh);
        vm.prank(alice);
        pool.mintStable(_q(1e18), 0, block.timestamp);
    }

    // =============================================================== stability mode

    function test_stabilityMode_rules() public {
        _bootstrap();
        risk.setLevels(10e18, 9e18, 1.6e18); // keep L under the trigger so redeemLever is allowed
        _setPriceAndRef(60e18);
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.ModeChanged(ILeveragePool.Mode.NORMAL, ILeveragePool.Mode.STABILITY);
        pool.accrue();
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.STABILITY));
        assertEq(uint8(pool.lastMode()), uint8(ILeveragePool.Mode.STABILITY));
        assertLt(st.collateralRatio, 1.3e18);
        assertEq(st.leverMintFeeBps, 0);

        // mintLever at fee 0
        B memory b = _b();
        uint256 cIn = _q(1e18);
        uint256 exp = Math.mulDiv(_val(cIn, b.P, false), b.X, uint256(_eC(b.C, b.U, b.S, b.P)));
        vm.prank(alice);
        assertEq(pool.mintLever(cIn, 0, block.timestamp), exp);

        // redeemLever fee = stabilityRedeemFeeBps (100); redeemStable keeps redeemFeeBps (20)
        (,, uint256 fL) = pool.previewRedeemLever(10e18);
        assertEq(fL, 100);
        (,, uint256 fS_) = pool.previewRedeemStable(10e18);
        assertEq(fS_, 20);
        b = _b();
        uint256 expC = Math.min(
            b.C, _amt(_net(Math.mulDiv(10e18, uint256(_eF(b.C, b.U, b.S, b.P)), b.X), 100), b.P, false)
        );
        vm.prank(backstop);
        (uint256 cOut,) = pool.redeemLever(10e18, 0, 0);
        assertEq(cOut, expC);
    }

    // =============================================================== underwater

    function test_underwater_redeemStableProRataExact() public {
        _bootstrap();
        vm.prank(admin);
        pool.setDonor(donor, true);
        _setPriceAndRef(45e18);
        _fundUsdc(donor, _usdc(50e18));
        vm.prank(donor);
        pool.donate(_usdc(50e18), 0); // U > 0, still underwater
        B memory b = _b();
        assertGt(b.U, 0);
        assertGt(b.S, _val(b.C, b.P, true) + b.U * uS);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.UNDERWATER));
        assertEq(st.leverage, MAXU);
        assertEq(st.xNav, 0);
        assertLt(st.E, 0);

        uint256 s = 100e18;
        uint256 sNet = _net(s, 20);
        vm.prank(alice);
        (uint256 cOut, uint256 uOut) = pool.redeemStable(s, 0, 0);
        assertEq(cOut, Math.mulDiv(b.C, sNet, b.S));
        assertEq(uOut, Math.mulDiv(b.U, sNet, b.S));
    }

    function test_underwater_mintsAndRedeemLeverRevert() public {
        _bootstrap();
        _setPriceAndRef(45e18);
        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintLever(_q(1e18), 0, block.timestamp);
        vm.stopPrank();
        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.redeemLever(1e18, 0, 0);
    }

    /// -50% with zero fees: V == S exactly, E = 0 -> UNDERWATER, L = MAX, donate has no deficit.
    function test_underwater_E0_edge() public {
        risk.setFees(0, 0);
        _withParams(_p_zeroMinFee);
        _bootstrap();
        assertEq(sT.totalSupply(), 1000e18);
        vm.prank(admin);
        pool.setDonor(donor, true);
        _setPriceAndRef(50e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.E, 0);
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.UNDERWATER));
        assertEq(st.leverage, MAXU);
        assertEq(st.collateralRatio, 1e18);
        _fundUsdc(donor, _usdc(100e18));
        vm.prank(donor);
        vm.expectRevert(ILeveragePool.NotUnderwater.selector);
        pool.donate(_usdc(100e18), 0);
    }

    // =============================================================== donate

    function test_setDonor_access() public {
        vm.prank(rando);
        vm.expectRevert(ILeveragePool.NotCreatorOrAdmin.selector);
        pool.setDonor(donor, true);
        vm.prank(guardian);
        vm.expectRevert(ILeveragePool.NotCreatorOrAdmin.selector);
        pool.setDonor(donor, true);
        vm.prank(launcher);
        vm.expectRevert(ILeveragePool.ZeroAddress.selector);
        pool.setDonor(address(0), true);

        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.DonorSet(donor, true, launcher);
        vm.prank(launcher);
        pool.setDonor(donor, true);
        assertTrue(pool.isDonor(donor));
        vm.prank(admin);
        pool.setDonor(donor, false);
        assertFalse(pool.isDonor(donor));
    }

    function test_donate_onlyDonorAndOnlyUnderwater() public {
        _bootstrap();
        _fundUsdc(rando, _usdc(10e18));
        vm.prank(rando);
        vm.expectRevert(ILeveragePool.NotDonor.selector);
        pool.donate(_usdc(10e18), 0);

        vm.prank(admin);
        pool.setDonor(donor, true);
        _fundUsdc(donor, _usdc(10e18));
        vm.prank(donor);
        vm.expectRevert(ILeveragePool.NotUnderwater.selector);
        pool.donate(_usdc(10e18), 0);
    }

    function test_donate_usdcFirstCappedAtDeficit() public {
        _bootstrap();
        vm.prank(admin);
        pool.setDonor(donor, true);
        _setPriceAndRef(45.12345678e18);
        B memory b = _b();
        uint256 vC = _val(b.C, b.P, true);
        uint256 deficit = b.S - vC;
        uint256 expU = deficit / uS;
        uint256 expA = _amt(deficit - expU * uS, b.P, false);
        _fundUsdc(donor, _usdc(1000e18));
        _fund(donor, _q(100e18));
        uint256 crB = _cr(b.C, b.U, b.S, b.P);
        uint256 crA = _cr(b.C + expA, b.U + expU, b.S, b.P);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ILeveragePool.Donated(donor, expU, expA, crB, crA);
        vm.prank(donor);
        (uint256 ua, uint256 aa) = pool.donate(_usdc(1000e18), _q(100e18));
        assertEq(ua, expU);
        assertEq(aa, expA);
        assertEq(usdc.balanceOf(donor), _usdc(1000e18) - expU);
        assertEq(asset.balanceOf(donor), _q(100e18) - expA);
        // never gifts value to x holders
        ILeveragePool.PoolState memory st = pool.state();
        assertLe(st.E, 0);
        assertEq(st.xNav, 0);
        assertLe(st.collateralRatio, 1e18);
    }

    function test_donate_assetCoversRemainder() public {
        _bootstrap();
        vm.prank(admin);
        pool.setDonor(donor, true);
        _setPriceAndRef(45e18); // V 900, S 999: deficit 99
        _fundUsdc(donor, _usdc(50e18));
        _fund(donor, _q(100e18));
        vm.prank(donor);
        (uint256 ua, uint256 aa) = pool.donate(_usdc(50e18), _q(100e18));
        assertEq(ua, _usdc(50e18));
        assertEq(aa, _amt(49e18, 45e18, false));
        (uint256 C, uint256 U) = pool.reserves();
        assertEq(U, _usdc(50e18));
        assertEq(C, _q(20e18) + aa);
        assertLe(pool.state().E, 0);
    }

    function test_donate_freshUnhaltedPrice() public {
        _bootstrap();
        vm.prank(admin);
        pool.setDonor(donor, true);
        _setPriceAndRef(45e18);
        _fundUsdc(donor, _usdc(10e18));
        vm.warp(block.timestamp + 121);
        vm.prank(donor);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.donate(_usdc(10e18), 0);
        _setPrice(45e18);
        feed.setHalted(true);
        // A halted (but fresh) price still accepts a donation, so a backstop cover can land during the redeem hold.
        vm.prank(donor);
        (uint256 ua,) = pool.donate(_usdc(10e18), 0);
        assertEq(ua, _usdc(10e18), "donate works while halted");
        feed.setHalted(false);
        vm.prank(donor);
        vm.expectRevert();
        pool.donate(0, 0); // nothing accepted
    }

    // =============================================================== redeemStable halt hold

    /// Halted + underwater: redeemStable is held (RedeemHeld) for MAX_REDEEM_HOLD from haltedAtSrc, redeemPair stays
    /// open, a donation during the hold makes the pool whole, and the hold lifts after 6 h even without a cover.
    function test_redeemStable_heldWhileHaltedAndUnderwater() public {
        _bootstrap();
        vm.prank(backstop);
        xT.transfer(alice, 500e18);
        _setPriceAndRef(45e18); // V = 900 < S = 999
        feed.setHalted(true);
        uint256 t0 = block.timestamp;
        assertTrue(pool.state().feedHalted);

        vm.prank(alice);
        vm.expectRevert(ILeveragePool.RedeemHeld.selector);
        pool.redeemStable(10e18, 0, 0);
        vm.expectRevert(ILeveragePool.RedeemHeld.selector);
        pool.previewRedeemStable(10e18);

        // redeemPair is never held.
        vm.prank(alice);
        (uint256 sB,,,) = pool.redeemPair(10e18, MAXU, 0, 0);
        assertEq(sB, 10e18, "redeemPair open during the hold");

        // Still held just before 6 h (keep the price within maxRedeemPriceAge).
        vm.warp(t0 + 6 hours - 1);
        feed.setAnswer(int256(45e18 / fS));
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.RedeemHeld.selector);
        pool.redeemStable(10e18, 0, 0);

        // Released at 6 h, still halted and underwater: pays the V/S haircut like before.
        vm.warp(t0 + 6 hours);
        vm.prank(alice);
        (uint256 cOut,) = pool.redeemStable(10e18, 0, 0);
        assertGt(cOut, 0, "hold released after MAX_REDEEM_HOLD");
    }

    function test_redeemStable_holdEndsWhenCoveredOrSolvent() public {
        _bootstrap();
        vm.prank(admin);
        pool.setDonor(donor, true);
        _setPriceAndRef(45e18);
        feed.setHalted(true);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.RedeemHeld.selector);
        pool.redeemStable(10e18, 0, 0);

        // A cover while halted lifts V to S: no longer underwater, so redeemStable pays par again.
        _fundUsdc(donor, _usdc(200e18));
        vm.prank(donor);
        pool.donate(_usdc(200e18), 0);
        ILeveragePool.PoolState memory st = pool.state();
        assertGe(st.V + 1, st.S, "covered");
        uint256 bal = usdc.balanceOf(alice) * uS + _val(asset.balanceOf(alice), st.price, false);
        vm.prank(alice);
        pool.redeemStable(100e18, 0, 0);
        uint256 got = usdc.balanceOf(alice) * uS + _val(asset.balanceOf(alice), st.price, false) - bal;
        assertGe(got, _net(100e18, 20) - 1e15, "made whole after the cover");
    }

    function test_redeemStable_neverHeldWhenSolventOrFeedWithoutHaltTime() public {
        _bootstrap();
        feed.setHalted(true); // P = 100: V = 2000 > S
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);

        // Underwater and halted, but the feed exposes no haltedAtSrc: no hold.
        _setPriceAndRef(45e18);
        vm.mockCallRevert(address(feed), abi.encodeWithSignature("haltedAtSrc()"), "");
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);
        vm.clearMockedCalls();

        // Underwater but not halted: no hold.
        feed.setHalted(false);
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);
    }

    // =============================================================== funding

    function _depositSp(uint256 amt) internal {
        vm.startPrank(alice);
        sT.approve(address(sp), MAXU);
        sp.deposit(amt);
        vm.stopPrank();
    }

    function test_accrue_oneDayExact() public {
        _bootstrap();
        _depositSp(500e18);
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e18);
        B memory b = _b();
        int256 eB = _eF(b.C, b.U, b.S, b.P);
        uint256 exp = Math.mulDiv(b.S, 400 * 1 days, BPS * 365 days);
        assertGt(exp, 0);
        uint256 spBal = sT.balanceOf(address(sp));

        vm.expectEmit(false, false, false, true, address(pool));
        emit ILeveragePool.FundingAccrued(exp, 400, 1 days);
        uint256 minted = pool.accrue();
        assertEq(minted, exp);
        assertEq(sT.balanceOf(address(sp)), spBal + exp);
        assertEq(pool.lastAccrualAt(), block.timestamp);
        B memory a = _b();
        assertEq(eB - _eF(a.C, a.U, a.S, a.P), int256(exp));
        (, uint256 reward) = sp.gainsOf(alice);
        // SP product-sum rounding loses at most ~totalDeposits/1e18 wei per notify
        assertLe(reward, exp);
        assertApproxEqAbs(reward, exp, 1e3);
        // second call in the same block: dt = 0
        assertEq(pool.accrue(), 0);
    }

    function test_accrue_dtCappedAtOneDay() public {
        _bootstrap();
        _depositSp(500e18);
        vm.warp(block.timestamp + 3 days);
        _setPrice(100e18);
        uint256 exp = Math.mulDiv(sT.totalSupply(), 400 * 1 days, BPS * 365 days);
        assertEq(pool.accrue(), exp);
    }

    function test_accrue_skips() public {
        _bootstrap();
        // no SP deposits
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e18);
        assertEq(pool.accrue(), 0);
        assertEq(pool.lastAccrualAt(), block.timestamp);

        _depositSp(500e18);
        uint256 snap = vm.snapshotState();

        // rate 0
        _withParams(_p_zeroFunding);
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e18);
        assertEq(pool.accrue(), 0);
        vm.revertToState(snap);

        // price older than maxRedeemPriceAge
        vm.warp(block.timestamp + 1 days + 1);
        assertEq(pool.accrue(), 0);
        assertEq(pool.lastAccrualAt(), block.timestamp);
        vm.revertToState(snap);

        // not NORMAL
        vm.warp(block.timestamp + 1 days);
        _setPrice(60e18);
        assertEq(pool.accrue(), 0);
        vm.revertToState(snap);

        // no price at all: never reverts
        vm.warp(block.timestamp + 1 days);
        feed.setRevertOnRead(true);
        assertEq(pool.accrue(), 0);
        vm.revertToState(snap);

        // a RiskOracle / calendar outage does not matter
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e18);
        risk.setReverts(true);
        cal.setReverts(true, true);
        assertGt(pool.accrue(), 0);
    }

    /// SPEC.md §2.5 accrue skip list is `!usable || age > maxRedeemPriceAge || ...`; age saturates to 0 for a
    /// future updatedAt, so a future-dated (but usable) price is not in the skip list.
    function test_accrue_futureDatedPrice_notInSpecSkipList() public {
        _bootstrap();
        _depositSp(500e18);
        vm.warp(block.timestamp + 1 days);
        feed.setAnswerAt(int256(100e18 / fS), block.timestamp + 31);
        uint256 exp = Math.mulDiv(sT.totalSupply(), 400 * 1 days, BPS * 365 days);
        assertEq(pool.accrue(), exp);
    }

    function test_accrue_runsAtStartOfMutations() public {
        _bootstrap();
        _depositSp(500e18);
        vm.warp(block.timestamp + 1 days);
        _setPriceAndRef(100e18);
        uint256 exp = Math.mulDiv(sT.totalSupply(), 400 * 1 days, BPS * 365 days);
        uint256 spBal = sT.balanceOf(address(sp));
        vm.expectEmit(false, false, false, true, address(pool));
        emit ILeveragePool.FundingAccrued(exp, 400, 1 days);
        vm.prank(alice);
        pool.mintLever(_q(1e18), 0, block.timestamp);
        assertEq(sT.balanceOf(address(sp)), spBal + exp);

        // redeemPair also accrues first
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e18);
        exp = Math.mulDiv(sT.totalSupply(), 400 * 1 days, BPS * 365 days);
        spBal = sT.balanceOf(address(sp));
        vm.prank(backstop);
        xT.transfer(alice, 10e18);
        vm.prank(alice);
        pool.redeemPair(MAXU, 10e18, 0, 0);
        assertGt(sT.balanceOf(address(sp)), spBal - 0); // minted funding, then alice's sUSD burned (not SP's)
        assertEq(sT.balanceOf(address(sp)), spBal + exp);
    }

    function test_setParams_accruesAtOldRateFirst() public {
        _bootstrap();
        _depositSp(500e18);
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e18);
        uint256 exp = Math.mulDiv(sT.totalSupply(), 400 * 1 days, BPS * 365 days);
        uint256 spBal = sT.balanceOf(address(sp));
        _withParams(_p_zeroFunding);
        assertEq(sT.balanceOf(address(sp)), spBal + exp);
        assertEq(pool.params().fundingRateBps, 0);
    }

    // =============================================================== state() totality

    function test_state_unseeded() public view {
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.UNSEEDED));
        assertEq(st.X, 0);
        assertEq(st.xNav, 1e18);
        assertEq(st.leverage, 0);
        assertEq(st.collateralRatio, MAXU);
        assertEq(st.E, 0);
        assertEq(st.price, 100e18);
        assertTrue(st.priceFresh);
        _assertViewsTotal();
        assertFalse(pool.previewRebalance().executable);
    }

    function test_state_S0() public {
        _seed();
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NORMAL));
        assertEq(st.S, 0);
        assertEq(st.collateralRatio, MAXU);
        assertEq(st.leverage, 1e18);
        assertEq(st.V, 1000e18);
        assertEq(st.E, 1000e18);
        _assertViewsTotal();
    }

    function test_state_feedReverts_noPrice() public {
        _bootstrap();
        feed.setRevertOnRead(true);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NO_PRICE));
        assertEq(st.price, 0);
        assertFalse(st.priceFresh);
        assertEq(st.V, 0); // uw(U), U = 0
        assertEq(st.E, -int256(999e18));
        assertEq(st.leverage, MAXU);
        assertEq(st.xNav, 0);
        assertEq(st.collateralRatio, 0);
        _assertViewsTotal();
        assertFalse(pool.previewRebalance().executable);
    }

    function test_state_unusableAnswers() public {
        _bootstrap();
        int256[3] memory bad = [int256(0), int256(-1), type(int256).min];
        for (uint256 i; i < bad.length; ++i) {
            feed.setAnswer(bad[i]);
            assertEq(uint8(pool.state().mode), uint8(ILeveragePool.Mode.NO_PRICE));
            assertEq(pool.state().price, 0);
            _assertViewsTotal();
        }
        // updatedAt == 0
        feed.setAnswerAt(int256(100e18 / fS), 0);
        assertEq(uint8(pool.state().mode), uint8(ILeveragePool.Mode.NO_PRICE));
        _assertViewsTotal();
        // answer * fS above uint96.max is unusable; exactly at the bound is usable
        uint256 lim = uint256(type(uint96).max) / fS;
        feed.setAnswer(int256(lim + 1));
        assertEq(uint8(pool.state().mode), uint8(ILeveragePool.Mode.NO_PRICE));
        _assertViewsTotal();
        feed.setAnswer(int256(lim));
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.price, lim * fS);
        assertTrue(st.mode != ILeveragePool.Mode.NO_PRICE);
        _assertViewsTotal();
        feed.setAnswer(type(int256).max);
        _assertViewsTotal();
    }

    function test_state_staleAndFuture() public {
        _bootstrap();
        vm.warp(block.timestamp + 10 days);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.priceAge, 10 days);
        assertFalse(st.priceFresh);
        assertEq(st.price, 100e18);
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NORMAL)); // staleness is not a mode
        _assertViewsTotal();
        feed.setAnswerAt(int256(100e18 / fS), block.timestamp + 365 days);
        st = pool.state();
        assertEq(st.priceAge, 0);
        assertFalse(st.priceFresh);
        _assertViewsTotal();
    }

    function test_state_shortReturnFeed() public {
        LeveragePool p = _newPool(address(new PoolShortFeed()));
        ILeveragePool.PoolState memory st = p.state();
        assertEq(st.price, 0);
        assertFalse(st.feedHalted);
        assertFalse(st.priceFresh);
        p.maxMintStable();
        p.currentRisk();
        p.previewRebalance();
        vm.prank(admin);
        asset.mint(launcher, _q(10e18));
        vm.startPrank(launcher);
        asset.approve(address(p), MAXU);
        vm.expectRevert(ILeveragePool.NoPrice.selector);
        p.seed(_q(10e18), backstop);
        vm.stopPrank();
    }

    function test_state_feedWithoutHalted() public {
        PoolNoHaltFeed f = new PoolNoHaltFeed();
        LeveragePool p = _newPool(address(f));
        uint256 cIn = 10e18 * aU / 1e18;
        _seedPool(p, cIn);
        ILeveragePool.PoolState memory st = p.state();
        assertFalse(st.feedHalted);
        assertTrue(st.priceFresh);
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NORMAL));
    }

    function test_state_underwater() public {
        _bootstrap();
        _setPriceAndRef(45e18);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.UNDERWATER));
        assertEq(st.E, int256(900e18) - int256(999e18));
        assertEq(st.leverage, MAXU);
        assertEq(st.xNav, 0);
        assertEq(st.collateralRatio, Math.mulDiv(900e18, 1e18, 999e18));
        _assertViewsTotal();
    }

    function test_state_riskOracleReverts_fallback() public {
        _bootstrap();
        risk.setReverts(true);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.riskSource), uint8(IRiskOracle.Source.FALLBACK));
        assertEq(st.triggerLev, 2.2e18);
        assertEq(st.targetLev, 1.9e18);
        assertEq(st.lowerTriggerLev, 1.5e18);
        assertTrue(st.mintsPaused);
        assertEq(st.snapshotId, 0);
        (IRiskOracle.RiskParams memory r,) = pool.currentRisk();
        assertEq(r.maxDevBps, 150);
        assertEq(r.openFeeBps, 100);
        assertEq(r.closedFeeBps, 100);
        assertEq(r.gapGuardSec, 7200);
        assertEq(r.maxSellChunkUsd, 1_000e18);
        _assertViewsTotal();
        assertEq(pool.maxMintStable(), 0);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.MintsArePaused.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0); // exits unaffected
    }

    function test_state_calendarReverts_closedNoGap() public {
        _bootstrap();
        cal.setReverts(true, true);
        ILeveragePool.PoolState memory st = pool.state();
        assertFalse(st.marketOpen);
        assertFalse(st.gapGuard);
        assertEq(st.maxMintLev, 2.2e18);
        assertEq(st.targetLev, 2e18);
        _assertViewsTotal();
        // isOpen false + inGapGuard reverting -> no gap guard
        cal.setReverts(false, true);
        cal.set(false, true);
        st = pool.state();
        assertFalse(st.marketOpen);
        assertFalse(st.gapGuard);
        assertEq(st.triggerLev, 2.67e18);
    }

    function test_state_halted() public {
        _bootstrap();
        feed.setHalted(true);
        ILeveragePool.PoolState memory st = pool.state();
        assertTrue(st.feedHalted);
        assertTrue(st.mintsPaused);
        assertFalse(st.priceFresh);
        assertEq(st.price, 100e18);
        _assertViewsTotal();
        // a halt never blocks redeemStable
        vm.prank(alice);
        (uint256 c,) = pool.redeemStable(10e18, 0, 0);
        assertGt(c, 0);
    }

    /// Tokens sent to the pool directly are ignored (C and U are internal accounting, never balanceOf).
    function test_directTransfersIgnored() public {
        _bootstrap();
        ILeveragePool.PoolState memory st = pool.state();
        _fund(bob, _q(5e18));
        _fundUsdc(bob, _usdc(500e18));
        vm.startPrank(bob);
        asset.transfer(address(pool), _q(5e18));
        usdc.transfer(address(pool), _usdc(500e18));
        vm.stopPrank();
        ILeveragePool.PoolState memory a = pool.state();
        assertEq(a.C, st.C);
        assertEq(a.U, st.U);
        assertEq(a.E, st.E);
        assertEq(a.leverage, st.leverage);
    }

    function testFuzz_views_neverRevert(int256 answer, uint256 updatedAt, uint256 warpBy, uint8 flags) public {
        if (flags & 1 != 0) _bootstrap();
        else if (flags & 2 != 0) _seed();
        warpBy = bound(warpBy, 0, 3650 days);
        vm.warp(block.timestamp + warpBy);
        updatedAt = bound(updatedAt, 0, type(uint64).max);
        feed.setAnswerAt(answer, updatedAt);
        feed.setHalted(flags & 4 != 0);
        risk.setReverts(flags & 8 != 0);
        cal.setReverts(flags & 16 != 0, flags & 32 != 0);
        cal.set(flags & 64 == 0, flags & 128 != 0);
        feed.setRevertOnRead(flags & 3 == 3 && flags & 4 != 0);
        _assertViewsTotal();
    }

    // =============================================================== pause

    function test_setMintsPaused_access() public {
        vm.prank(rando);
        vm.expectRevert(ILeveragePool.NotAdminOrGuardian.selector);
        pool.setMintsPaused(true);
        vm.prank(launcher);
        vm.expectRevert(ILeveragePool.NotAdminOrGuardian.selector);
        pool.setMintsPaused(true);
        vm.expectEmit(true, true, false, true, address(pool));
        emit ILeveragePool.MintsPaused(true, guardian);
        vm.prank(guardian);
        pool.setMintsPaused(true);
        assertTrue(pool.localMintsPaused());
        vm.prank(admin);
        pool.setMintsPaused(false);
        assertFalse(pool.localMintsPaused());
    }

    function _exitsAllWork() internal {
        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.MintsArePaused.selector);
        pool.mintStable(_q(1e18), 0, block.timestamp);
        vm.expectRevert(ILeveragePool.MintsArePaused.selector);
        pool.mintLever(_q(1e18), 0, block.timestamp);
        (uint256 c1,) = pool.redeemStable(10e18, 0, 0);
        assertGt(c1, 0);
        (,, uint256 c2,) = pool.redeemPair(10e18, MAXU, 0, 0);
        assertGt(c2, 0);
        vm.stopPrank();
        vm.prank(backstop);
        (uint256 c3,) = pool.redeemLever(10e18, 0, 0);
        assertGt(c3, 0);
        pool.accrue();
        _setPrice(78e18);
        (ILeveragePool.Zone z,,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
    }

    function test_localPause_neverBlocksExits() public {
        _bootstrap();
        vm.prank(backstop);
        xT.transfer(alice, 100e18);
        vm.prank(guardian);
        pool.setMintsPaused(true);
        assertTrue(pool.state().mintsPaused);
        _exitsAllWork();
    }

    function test_riskPause_neverBlocksExits() public {
        _bootstrap();
        vm.prank(backstop);
        xT.transfer(alice, 100e18);
        risk.setMintsPaused(true);
        assertTrue(pool.state().mintsPaused);
        _exitsAllWork();
    }

    // =============================================================== admin

    function test_setParams_accessAndBounds() public {
        ILeveragePool.PoolParams memory p = pool.params();
        vm.prank(rando);
        vm.expectRevert(ILeveragePool.NotAdmin.selector);
        pool.setParams(p);
        vm.prank(guardian);
        vm.expectRevert(ILeveragePool.NotAdmin.selector);
        pool.setParams(p);

        ILeveragePool.PoolParams[] memory bad = new ILeveragePool.PoolParams[](12);
        for (uint256 i; i < bad.length; ++i) bad[i] = pool.params();
        bad[0].redeemFeeBps = 101;
        bad[1].stabilityRedeemFeeBps = 19; // < redeemFeeBps
        bad[2].dynFeeMaxBps = 201;
        bad[3].fundingRateBps = 1501;
        bad[4].maxPriceAge = 29;
        bad[5].maxRedeemPriceAge = 119; // < maxPriceAge
        bad[6].maxRefAge = 7201;
        bad[7].maxSlipBps = 9;
        bad[8].stabilityCR = 1.09e18;
        bad[9].closedMaxLev = 3.01e18;
        bad[10].gapTriggerLev = 2.09e18; // < gapTargetLev + 0.3
        bad[11].levEpsilon = 0;
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(ILeveragePool.InvalidParams.selector);
            pool.setParams(bad[i]);
        }
        p.redeemFeeBps = 100;
        p.stabilityRedeemFeeBps = 300;
        p.maxRedeemPriceAge = 7 days;
        vm.expectEmit(false, false, false, true, address(pool));
        emit ILeveragePool.ParamsUpdated(p);
        vm.prank(admin);
        pool.setParams(p);
        assertEq(pool.params().redeemFeeBps, 100);
    }

    function test_setRouter() public {
        vm.prank(rando);
        vm.expectRevert(ILeveragePool.NotAdmin.selector);
        pool.setRouter(address(router));
        vm.startPrank(admin);
        vm.expectRevert(ILeveragePool.ZeroAddress.selector);
        pool.setRouter(address(0));
        vm.expectRevert(ILeveragePool.ZeroAddress.selector);
        pool.setRouter(rando);
        MockRouter r2 = new MockRouter(admin);
        vm.expectEmit(true, false, false, true, address(pool));
        emit ILeveragePool.RouterSet(address(r2));
        pool.setRouter(address(r2));
        vm.stopPrank();
        assertEq(pool.router(), address(r2));
    }

    // =============================================================== round trips (invariant 4)

    function testFuzz_roundTrip_stable_noProfit(uint256 cIn) public {
        _bootstrap();
        cIn = bound(cIn, 1, pool.maxMintStable());
        _fund(bob, cIn);
        vm.startPrank(bob);
        uint256 s = pool.mintStable(cIn, 0, block.timestamp);
        try pool.redeemStable(s, 0, 0) returns (uint256 c, uint256 u) {
            assertLe(c, cIn);
            assertEq(u, 0);
        } catch (bytes memory err) {
            assertEq(bytes4(err), ILeveragePool.ZeroOutput.selector);
        }
        vm.stopPrank();
    }

    function testFuzz_roundTrip_lever_noProfit(uint256 cIn) public {
        _bootstrap();
        cIn = bound(cIn, 1, _q(100e18));
        _fund(bob, cIn);
        vm.startPrank(bob);
        uint256 x;
        try pool.mintLever(cIn, 0, block.timestamp) returns (uint256 x_) {
            x = x_;
        } catch {
            vm.stopPrank();
            return;
        }
        try pool.redeemLever(x, 0, 0) returns (uint256 c, uint256 u) {
            assertLe(c, cIn);
            assertEq(u, 0);
        } catch (bytes memory err) {
            assertEq(bytes4(err), ILeveragePool.ZeroOutput.selector);
        }
        vm.stopPrank();
    }

    function testFuzz_roundTrip_pair_noProfit(uint256 cIn) public {
        _bootstrap();
        cIn = bound(cIn, _q(0.001e18), _q(3e18));
        _fund(bob, 2 * cIn);
        vm.startPrank(bob);
        uint256 x = pool.mintLever(cIn, 0, block.timestamp);
        uint256 s = pool.mintStable(cIn, 0, block.timestamp);
        (,, uint256 c, uint256 u) = pool.redeemPair(s, x, 0, 0);
        assertLe(c, 2 * cIn);
        assertEq(u, 0);
        vm.stopPrank();
    }
}

contract LeveragePool_A18_U6_F8_Test is LeveragePoolTestBase {
    function _decs() internal pure override returns (uint8, uint8, uint8) {
        return (18, 6, 8);
    }
}

contract LeveragePool_A18_U18_F8_Test is LeveragePoolTestBase {
    function _decs() internal pure override returns (uint8, uint8, uint8) {
        return (18, 18, 8);
    }
}

contract LeveragePool_A6_U6_F18_Test is LeveragePoolTestBase {
    function _decs() internal pure override returns (uint8, uint8, uint8) {
        return (6, 6, 18);
    }
}
