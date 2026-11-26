// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ILeveragePool} from "../../src/interfaces/ILeveragePool.sol";
import {IPoolFactory} from "../../src/interfaces/IPoolFactory.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {IMockRouter} from "../../src/interfaces/IMockRouter.sol";
import {ISplitToken} from "../../src/interfaces/ISplitToken.sol";
import {IStabilityPool} from "../../src/interfaces/IStabilityPool.sol";
import {ISandboxFactory} from "../../src/interfaces/ISandboxFactory.sol";
import {Roles, SplitConstants} from "../../src/interfaces/SplitConstants.sol";

import {LeveragePool} from "../../src/core/LeveragePool.sol";
import {SplitToken} from "../../src/core/SplitToken.sol";
import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {PoolFactory} from "../../src/core/PoolFactory.sol";
import {PoolMath} from "../../src/core/PoolMath.sol";

// ---------------------------------------------------------------------------------------------------------------
// Local stubs (BUILDER_B's contracts are reached only through interfaces).
// ---------------------------------------------------------------------------------------------------------------

contract A_Token is ERC20 {
    uint8 internal immutable _dec;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function burn(address from, uint256 a) external {
        _burn(from, a);
    }
}

contract A_Feed {
    int256 public answer;
    uint256 public updatedAt;
    bool public halted;
    bool public revertOnRead;
    uint8 public decimals = 8;
    uint80 internal _round;

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
        ++_round;
    }

    function setAt(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
        ++_round;
    }

    function setHalted(bool h) external {
        halted = h;
    }

    function setRevert(bool r) external {
        revertOnRead = r;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!revertOnRead, "feed down");
        return (_round, answer, updatedAt, updatedAt, _round);
    }
}

/// @dev Clone-able ScenarioFeed stand-in: always fresh.
contract A_ScenarioFeed {
    int256 public answer;
    address public operator;
    bool internal _init;

    function initialize(address ref, address op, bool, int256 initial) external {
        require(!_init, "init");
        _init = true;
        operator = op;
        answer = initial;
        if (ref != address(0)) {
            (, int256 a,,,) = A_Feed(ref).latestRoundData();
            if (a > 0) answer = a;
        }
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function halted() external pure returns (bool) {
        return false;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}

contract A_Risk {
    IRiskOracle.RiskView internal _v;
    bool public revertOnRead;

    function set(IRiskOracle.RiskView memory v) external {
        _v = v;
    }

    function setRef(uint256 p, uint256 ts) external {
        _v.refPrice = p;
        _v.refTs = ts;
    }

    function setRevert(bool r) external {
        revertOnRead = r;
    }

    function riskView(bytes32) external view returns (IRiskOracle.RiskView memory) {
        require(!revertOnRead, "risk down");
        return _v;
    }
}

contract A_Calendar {
    bool public open = true;
    bool public gap;

    function set(bool o, bool g) external {
        open = o;
        gap = g;
    }

    function isOpen(uint256) external view returns (bool) {
        return open;
    }

    function inGapGuard(uint256, uint256) external view returns (bool) {
        return gap;
    }
}

/// @dev Fills at the caller's feed price (minus slippage), minting the output and burning the input.
contract A_Router {
    mapping(address => IMockRouter.CallerConfig) public cfg;

    function setCaller(address caller, IMockRouter.CallerConfig calldata c) external {
        cfg[caller] = c;
    }

    function setSlip(address caller, uint256 bps) external {
        cfg[caller].slippageBps = bps;
    }

    function _out(address caller, uint256 amountIn, address[] memory path) internal view returns (uint256) {
        IMockRouter.CallerConfig memory c = cfg[caller];
        require(c.enabled, "unknown caller");
        (, int256 a,,,) = A_Feed(c.feed).latestRoundData();
        uint256 p = uint256(a) * 1e10; // 8-dec feed -> WAD
        uint256 aU = 10 ** A_Token(c.asset).decimals();
        uint256 uS = 10 ** (18 - A_Token(c.usdc).decimals());
        if (path[0] == c.asset) {
            uint256 usd = amountIn * p / aU * (1e4 - c.slippageBps) / 1e4;
            return usd / uS;
        }
        uint256 usdIn = amountIn * uS * (1e4 - c.slippageBps) / 1e4;
        return usdIn * aU / p;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = amountIn;
        r[1] = _out(msg.sender, amountIn, path);
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256)
        external
        returns (uint256[] memory r)
    {
        uint256 out = _out(msg.sender, amountIn, path);
        require(out >= minOut, "min out");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        A_Token(path[0]).burn(address(this), amountIn);
        A_Token(path[1]).mint(to, out);
        r = new uint256[](2);
        r[0] = amountIn;
        r[1] = out;
    }
}

// ---------------------------------------------------------------------------------------------------------------

contract BuilderASmokeTest is Test {
    bytes32 constant NVDA = keccak256("NVDA");

    A_Token asset;
    A_Token usdc;
    A_Feed feed;
    A_Risk risk;
    A_Calendar cal;
    A_Router router;
    PoolFactory factory;

    address admin = makeAddr("admin");
    address launcher = makeAddr("launcher");
    address backstop = makeAddr("backstop");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address guardian = makeAddr("guardian");

    LeveragePool pool;
    IERC20 sUSD;
    IERC20 xT;
    StabilityPool sp;

    function setUp() public {
        vm.warp(1_790_000_000);
        asset = new A_Token("tNVDA", 18);
        usdc = new A_Token("mUSDC", 18);
        feed = new A_Feed();
        feed.set(100e8);
        risk = new A_Risk();
        risk.set(_rv(0, 0));
        cal = new A_Calendar();
        router = new A_Router();

        ILeveragePool.PoolParams memory p = PoolMath.defaultParams();
        // Scenario settings (SPEC.md §13.2): no fees.
        p.redeemFeeBps = 0;
        p.dynFeeMaxBps = 0;
        p.minFeeBps = 0;
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
        vm.startPrank(admin);
        factory.grantRole(Roles.CREATOR_ROLE, launcher);
        factory.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();

        pool = _newPool();
    }

    function _rv(uint256 openFee, uint256 closedFee) internal view returns (IRiskOracle.RiskView memory v) {
        v.params = IRiskOracle.RiskParams({
            triggerLev: 2.67e18,
            targetLev: 2.0e18,
            lowerTriggerLev: 1.6e18,
            maxDevBps: 250,
            openFeeBps: openFee,
            closedFeeBps: closedFee,
            gapGuardSec: 3600,
            maxSellChunkUsd: 1_000_000e18
        });
        v.source = IRiskOracle.Source.RULE;
        v.refPrice = 100e18;
        v.refTs = block.timestamp;
        v.snapshotId = 7;
    }

    function _newPool() internal returns (LeveragePool p) {
        vm.prank(launcher);
        p = LeveragePool(factory.createPool(address(asset), address(feed), NVDA, "NVDA", address(router), ILeveragePool.PoolKind.LIVE));
        router.setCaller(
            address(p),
            IMockRouter.CallerConfig({
                enabled: true,
                feed: address(feed),
                asset: address(asset),
                usdc: address(usdc),
                slippageBps: 0,
                offsetBps: 0
            })
        );
        sUSD = IERC20(p.sUSD());
        xT = IERC20(p.xToken());
        sp = StabilityPool(p.stabilityPool());
    }

    /// seed $1,000 then mintStable $1,000 at $100: L = 2, CR = 2.
    function _bootstrap() internal {
        asset.mint(launcher, 10e18);
        vm.startPrank(launcher);
        asset.approve(address(pool), type(uint256).max);
        pool.seed(10e18, backstop);
        vm.stopPrank();

        asset.mint(alice, 100e18);
        vm.startPrank(alice);
        asset.approve(address(pool), type(uint256).max);
        sUSD.approve(address(sp), type(uint256).max);
        pool.mintStable(10e18, 0, block.timestamp);
        vm.stopPrank();
    }

    function _setPrice(int256 p8) internal {
        feed.set(p8);
    }

    // ------------------------------------------------------------------ factory + tokens

    function test_createPool_wiring() public view {
        IPoolFactory.PoolInfo memory info = factory.poolInfo(address(pool));
        assertEq(info.pool, address(pool));
        assertEq(info.creator, launcher);
        assertEq(ISplitToken(address(sUSD)).symbol(), "sUSD-NVDA");
        assertEq(ISplitToken(address(xT)).name(), "SplitStock Lever NVDA (MOCK)");
        assertEq(ISplitToken(address(sUSD)).decimals(), 18);
        assertEq(pool.creator(), launcher);
        assertEq(uint8(pool.lastMode()), uint8(ILeveragePool.Mode.UNSEEDED));
        assertTrue(factory.isPool(address(pool)));
        assertEq(factory.poolsByAsset(NVDA).length, 1);
        assertEq(sp.pool(), address(pool));
    }

    function test_createPool_onlyCreator() public {
        vm.prank(alice);
        vm.expectRevert(IPoolFactory.NotCreatorOrAdmin.selector);
        factory.createPool(address(asset), address(feed), NVDA, "NVDA", address(router), ILeveragePool.PoolKind.LIVE);
    }

    function test_tokens_onlyPool() public {
        vm.expectRevert(ISplitToken.OnlyPool.selector);
        ISplitToken(address(sUSD)).mint(alice, 1);
    }

    // ------------------------------------------------------------------ seed / mint / L = 2

    function test_seed_and_mint_L2() public {
        _bootstrap();
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.X, 1000e18);
        assertEq(xT.balanceOf(SplitConstants.DEAD), SplitConstants.MIN_X);
        assertEq(xT.balanceOf(backstop), 1000e18 - SplitConstants.MIN_X);
        assertEq(st.S, 1000e18);
        assertEq(st.leverage, 2e18);
        assertEq(st.collateralRatio, 2e18);
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NORMAL));
        assertEq(st.maxMintLev, 2.335e18);

        vm.prank(alice);
        vm.expectRevert(ILeveragePool.NotCreatorOrAdmin.selector);
        pool.seed(1e18, alice);
        vm.prank(launcher);
        vm.expectRevert(ILeveragePool.AlreadySeeded.selector);
        pool.seed(1e18, alice);
    }

    function test_maxMintStable_isExact() public {
        _bootstrap();
        uint256 m = pool.maxMintStable();
        assertGt(m, 0);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        pool.mintStable(m, 0, block.timestamp);
        assertLe(pool.state().leverage, 2.335e18);
        vm.revertToState(snap);
        vm.prank(alice);
        vm.expectRevert();
        pool.mintStable(m * 101 / 100 + 1, 0, block.timestamp);
    }

    function test_mintLever_lowersL() public {
        _bootstrap();
        uint256 lb = pool.state().leverage;
        vm.prank(alice);
        uint256 xOut = pool.mintLever(5e18, 0, block.timestamp);
        assertApproxEqAbs(xOut, 500e18, 1e6);
        assertLt(pool.state().leverage, lb);
    }

    // ------------------------------------------------------------------ -22% sell zone (DEX)

    function test_sellZone_minus22() public {
        _bootstrap();
        _setPrice(78e8);
        ILeveragePool.PoolState memory st = pool.state();
        assertApproxEqRel(st.leverage, 2.7857e18, 1e14);

        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        assertEq(uint8(pv.zone), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(pv.route), uint8(ILeveragePool.Route.DEX));
        assertTrue(pv.executable);
        assertApproxEqRel(pv.sizeUsd, 444.444e18, 1e14);

        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 inAmt, uint256 out) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.DEX));
        assertApproxEqRel(out, 444.444e18, 1e14);
        assertGt(inAmt, 0);
        assertApproxEqRel(pool.state().leverage, 1.992e18, 1e15);
        assertEq(usdc.allowance(address(pool), address(router)), 0);

        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.NotInZone.selector, pool.state().leverage));
        pool.rebalance();

        // Another drop puts L back above the trigger, but the DEX route is cooling down.
        _setPrice(62e8);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.Cooldown.selector, 30));
        pool.rebalance();
        _setPrice(78e8);

        // Breaker: ref still $100, dev 2200 bps > 250.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.BreakerTripped.selector, 2200, 250));
        pool.mintStable(1e18, 0, block.timestamp);
    }

    function test_notInZone_triggerEdge() public {
        _bootstrap();
        _setPrice(79.95e8); // -20.05%: L ~ 2.6695
        vm.expectRevert();
        pool.rebalance();
        _setPrice(79.93e8); // -20.07%: L ~ 2.6706
        (ILeveragePool.Zone z,,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
    }

    function test_buyZone_afterRecovery() public {
        _bootstrap();
        _setPrice(78e8);
        pool.rebalance();
        vm.warp(block.timestamp + 60);
        risk.setRef(105e18, block.timestamp);
        _setPrice(105e8);
        uint256 lb = pool.state().leverage;
        assertLt(lb, 1.6e18);
        (ILeveragePool.Zone z,,,) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.BUY));
        assertApproxEqRel(pool.state().leverage, 2e18, 1e16);
    }

    // ------------------------------------------------------------------ StabilityPool route + funding

    function test_spRoute_whenClosed() public {
        _bootstrap();
        vm.prank(alice);
        sp.deposit(500e18);
        cal.set(false, false);
        _setPrice(78e8);
        (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 cSold, uint256 sBurn) = pool.rebalance();
        assertEq(uint8(z), uint8(ILeveragePool.Zone.SELL));
        assertEq(uint8(r), uint8(ILeveragePool.Route.STABILITY_POOL));
        assertApproxEqRel(sBurn, 444.49e18, 1e15);
        assertApproxEqRel(pool.state().leverage, 2e18, 1e15);
        (uint256 gainC,) = sp.gainsOf(alice);
        assertApproxEqAbs(gainC, cSold, 1e6);
        assertApproxEqAbs(sp.depositOf(alice), 500e18 - sBurn, 1e6);
        assertLe(sp.depositOf(alice), sp.totalDeposits());
        assertLe(sp.totalDeposits(), sUSD.balanceOf(address(sp)));

        vm.prank(alice);
        sp.withdraw(type(uint256).max);
        assertEq(sp.depositOf(alice), 0);
        assertApproxEqAbs(asset.balanceOf(alice), 90e18 + cSold, 1e6);
    }

    function test_funding_oneDay() public {
        _bootstrap();
        vm.prank(alice);
        sp.deposit(500e18);
        vm.warp(block.timestamp + 1 days);
        _setPrice(100e8);
        int256 eBefore = pool.state().E;
        uint256 minted = pool.accrue();
        uint256 expected = uint256(1000e18) * 400 * 86400 / (1e4 * 365 days);
        assertEq(minted, expected);
        assertEq(sUSD.totalSupply(), 1000e18 + expected);
        assertEq(pool.state().E, eBefore - int256(expected));
        (, uint256 reward) = sp.gainsOf(alice);
        assertApproxEqAbs(reward, expected, 1e6);
        assertLe(reward, expected);
    }

    // ------------------------------------------------------------------ underwater, donate, redeems

    function test_underwater_minus55() public {
        _bootstrap();
        _setPrice(45e8);
        risk.setRef(45e18, block.timestamp);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.UNDERWATER));
        assertEq(pool.maxMintStable(), 0);

        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintStable(1e18, 0, block.timestamp);
        vm.expectRevert(ILeveragePool.Underwater.selector);
        pool.mintLever(1e18, 0, block.timestamp);
        (uint256 cOut, uint256 uOut) = pool.redeemStable(100e18, 0, 0);
        vm.stopPrank();
        assertEq(cOut, 2e18); // sNet/S of C = 100/1000 * 20
        assertEq(uOut, 0);

        vm.prank(backstop);
        vm.expectRevert(ILeveragePool.NotDonor.selector);
        pool.donate(1, 0);
    }

    function test_donate_cappedAtDeficit() public {
        _bootstrap();
        vm.prank(launcher);
        pool.setDonor(backstop, true);
        _setPrice(45e8); // V = 900, S = 1000
        usdc.mint(backstop, 1000e18);
        vm.startPrank(backstop);
        usdc.approve(address(pool), type(uint256).max);
        (uint256 u, uint256 a) = pool.donate(1000e18, 0);
        vm.stopPrank();
        assertEq(u, 100e18);
        assertEq(a, 0);
        (, uint256 U) = pool.reserves();
        assertEq(U, 100e18);
    }

    function test_redeemPair_noOracle() public {
        _bootstrap();
        feed.setRevert(true);
        risk.setRevert(true);
        ILeveragePool.PoolState memory st = pool.state(); // never reverts
        assertEq(uint8(st.mode), uint8(ILeveragePool.Mode.NO_PRICE));
        assertTrue(st.mintsPaused == false || st.mintsPaused == true);
        pool.maxMintStable();
        pool.currentRisk();
        pool.previewRebalance();

        // Give alice some x from the backstop and pair-redeem at the S:X ratio (1:1 here).
        vm.prank(backstop);
        xT.transfer(alice, 100e18);
        vm.prank(alice);
        (uint256 sB, uint256 xB, uint256 cOut, uint256 uOut) = pool.redeemPair(100e18, 100e18, 0, 0);
        assertEq(sB, 100e18);
        assertEq(xB, 100e18);
        assertEq(cOut, 2e18); // 100/1000 of C = 20
        assertEq(uOut, 0);
    }

    function test_redeemLever_and_stale() public {
        _bootstrap();
        vm.prank(backstop);
        (uint256 cOut,) = pool.redeemLever(100e18, 0, 0);
        assertEq(cOut, 1e18);
        assertLe(pool.state().leverage, 2.67e18);

        vm.warp(block.timestamp + 121);
        vm.prank(backstop);
        vm.expectRevert(abi.encodeWithSelector(ILeveragePool.StalePrice.selector, 121, 120));
        pool.redeemLever(1e18, 0, 0);
        // redeemStable accepts up to a day.
        vm.prank(alice);
        pool.redeemStable(10e18, 0, 0);
    }

    function test_halt_blocksMintsNotExits() public {
        _bootstrap();
        feed.setHalted(true);
        vm.startPrank(alice);
        vm.expectRevert(ILeveragePool.FeedHalted.selector);
        pool.mintStable(1e18, 0, block.timestamp);
        pool.redeemStable(10e18, 0, 0);
        vm.stopPrank();
        assertTrue(pool.state().mintsPaused);
    }

    // ------------------------------------------------------------------ admin, isolation, sandbox

    function test_admin_roles() public {
        vm.prank(guardian);
        pool.setMintsPaused(true);
        vm.prank(alice);
        vm.expectRevert(ILeveragePool.NotAdminOrGuardian.selector);
        pool.setMintsPaused(false);

        ILeveragePool.PoolParams memory p = pool.params();
        p.stabilityCR = 5e18;
        vm.prank(admin);
        vm.expectRevert(ILeveragePool.InvalidParams.selector);
        pool.setParams(p);
        p.stabilityCR = 1.3e18;
        vm.prank(guardian);
        vm.expectRevert(ILeveragePool.NotAdmin.selector);
        pool.setParams(p);
        vm.prank(admin);
        pool.setParams(p);
    }

    function test_isolation_twoPools() public {
        _bootstrap();
        LeveragePool p1 = pool;
        LeveragePool p2 = _newPool();
        assertTrue(p2.sUSD() != p1.sUSD());
        asset.mint(launcher, 5e18);
        vm.startPrank(launcher);
        asset.approve(address(p2), type(uint256).max);
        p2.seed(5e18, backstop);
        vm.stopPrank();
        (uint256 c1, uint256 u1) = p1.reserves();
        assertEq(c1, 20e18);
        assertEq(u1, 0);
        assertEq(IERC20(p1.sUSD()).totalSupply(), 1000e18);
        assertEq(IERC20(p2.xToken()).totalSupply(), 500e18);
    }

    function test_sandbox_create() public {
        A_ScenarioFeed feedImpl = new A_ScenarioFeed();
        // Flat 11-argument ABI encoding (SPEC.md §0.1) must deploy unchanged.
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
        assertEq(ISandboxFactory(sbx).symbol(), "NVDA");
        assertEq(ISandboxFactory(sbx).seedAssetAmount(), 10e18);
        vm.prank(admin);
        factory.grantRole(Roles.CREATOR_ROLE, sbx);

        vm.prank(bob);
        (address p, address f) = ISandboxFactory(sbx).create();
        assertEq(ISandboxFactory(sbx).sandboxOf(bob).pool, p);
        assertEq(uint8(ILeveragePool(p).kind()), uint8(ILeveragePool.PoolKind.SANDBOX));
        assertEq(ILeveragePool(p).feed(), f);
        assertEq(IERC20(ILeveragePool(p).xToken()).balanceOf(bob), 1000e18 - SplitConstants.MIN_X);
        assertEq(IERC20(ILeveragePool(p).sUSD()).balanceOf(bob), 1000e18);
        assertEq(ILeveragePool(p).state().leverage, 2e18);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ISandboxFactory.AlreadyHasSandbox.selector, p));
        ISandboxFactory(sbx).create();
    }
}
