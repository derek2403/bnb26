// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILeveragePool} from "../../src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {ISplitToken} from "../../src/interfaces/ISplitToken.sol";
import {Roles, SplitConstants} from "../../src/interfaces/SplitConstants.sol";
import {LeveragePool} from "../../src/core/LeveragePool.sol";
import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {PoolMath} from "../../src/core/PoolMath.sol";

import {InvariantEnv} from "../helpers/invariantEnv.sol";
import {PoolHandler} from "../helpers/invariantPoolHandler.sol";
import {RiskHandler} from "../helpers/invariantRiskHandler.sol";

// =====================================================================================================
// Shared assertions
// =====================================================================================================

abstract contract InvariantAsserts is InvariantEnv {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant MAX = type(uint256).max;

    /// @dev SPEC.md §7.4 / §7.6 / §13.3.12: effective params always inside the clamps and gap-consistent; stale
    ///      means <= fallback; fresh means <= rule; an active agent only tightens; agent never touches openFee
    ///      or the chunk.
    function _assertEffective(bytes32 id) internal view {
        IRiskOracle.RiskParams memory e = risk.params(id);
        IRiskOracle.Clamps memory c = risk.clamps();
        assertGe(e.triggerLev, c.minTriggerLev, "eff trigger < clamp");
        assertLe(e.triggerLev, c.maxTriggerLev, "eff trigger > clamp");
        assertGe(e.targetLev, c.minTargetLev, "eff target < clamp");
        assertLe(e.targetLev, c.maxTargetLev, "eff target > clamp");
        assertGe(e.lowerTriggerLev, c.minLowerTriggerLev, "eff lower < clamp");
        assertLe(e.lowerTriggerLev, c.maxLowerTriggerLev, "eff lower > clamp");
        assertGe(e.triggerLev, e.targetLev + c.minTriggerTargetGap, "eff trigger-target gap");
        assertGe(e.targetLev, e.lowerTriggerLev + c.minTargetLowerGap, "eff target-lower gap");
        assertGe(e.maxDevBps, c.minMaxDevBps, "eff maxDev < clamp");
        assertLe(e.maxDevBps, c.maxMaxDevBps, "eff maxDev > clamp");
        assertGe(e.openFeeBps, c.minOpenFeeBps, "eff openFee < clamp");
        assertLe(e.openFeeBps, c.maxOpenFeeBps, "eff openFee > clamp");
        assertGe(e.closedFeeBps, c.minClosedFeeBps, "eff closedFee < clamp");
        assertLe(e.closedFeeBps, c.maxClosedFeeBps, "eff closedFee > clamp");
        assertGe(e.gapGuardSec, c.minGapGuardSec, "eff gapGuard < clamp");
        assertLe(e.gapGuardSec, c.maxGapGuardSec, "eff gapGuard > clamp");
        assertGt(e.maxSellChunkUsd, 0, "eff chunk == 0");

        IRiskOracle.RiskView memory rv = risk.riskView(id);
        assertEq(keccak256(abi.encode(rv.params)), keccak256(abi.encode(e)), "riskView.params != params");
        assertEq(uint256(rv.source), uint256(risk.source(id)), "riskView.source != source");

        IRiskOracle.Snapshot memory snap = risk.latestSnapshot(id);
        bool stale = snap.snapshotId == 0
            || (block.timestamp > snap.cmcTs ? block.timestamp - snap.cmcTs : 0) > risk.timing().staleAfter;
        (IRiskOracle.AgentParams memory q, bool active,,) = risk.agentParams(id);
        if (stale) {
            IRiskOracle.Fallback memory fb = risk.fallbackParams();
            assertEq(uint256(rv.source), uint256(IRiskOracle.Source.FALLBACK), "stale but source != FALLBACK");
            assertLe(e.triggerLev, fb.triggerLev, "stale trigger > fallback");
            assertLe(e.targetLev, fb.targetLev, "stale target > fallback");
            assertLe(e.lowerTriggerLev, fb.lowerTriggerLev, "stale lower > fallback");
            assertLe(e.maxDevBps, fb.maxDevBps, "stale maxDev > fallback");
            assertGe(e.openFeeBps, fb.feeBps, "stale openFee < fallback");
            assertGe(e.closedFeeBps, fb.feeBps, "stale closedFee < fallback");
            assertGe(e.gapGuardSec, fb.gapGuardSec, "stale gapGuard < fallback");
            assertLe(e.maxSellChunkUsd, fb.maxSellChunkUsd, "stale chunk > fallback");
        } else {
            IRiskOracle.RiskParams memory r = risk.ruleParams(id);
            assertTrue(rv.source != IRiskOracle.Source.FALLBACK, "fresh but FALLBACK");
            assertLe(e.triggerLev, r.triggerLev, "agent loosened trigger beyond rule");
            assertLe(e.targetLev, r.targetLev, "agent loosened target beyond rule");
            assertLe(e.lowerTriggerLev, r.lowerTriggerLev, "agent loosened lower beyond rule");
            assertLe(e.maxDevBps, r.maxDevBps, "agent loosened maxDev beyond rule");
            assertGe(e.closedFeeBps, r.closedFeeBps, "agent loosened closedFee beyond rule");
            assertGe(e.gapGuardSec, r.gapGuardSec, "agent loosened gapGuard beyond rule");
            assertEq(e.openFeeBps, r.openFeeBps, "openFee not the rule value (agent may not set it)");
            assertEq(e.maxSellChunkUsd, r.maxSellChunkUsd, "chunk not the rule value (agent may not set it)");
            if (!active) {
                assertEq(keccak256(abi.encode(e)), keccak256(abi.encode(r)), "no agent, fresh: eff != rule");
                assertEq(uint256(rv.source), uint256(IRiskOracle.Source.RULE), "no agent, fresh: source != RULE");
            }
        }
        if (active) {
            assertLe(e.triggerLev, q.triggerLev, "eff trigger > active agent");
            assertLe(e.targetLev, q.targetLev, "eff target > active agent");
            assertLe(e.lowerTriggerLev, q.lowerTriggerLev, "eff lower > active agent");
            assertLe(e.maxDevBps, q.maxDevBps, "eff maxDev > active agent");
            assertGe(e.closedFeeBps, q.closedFeeBps, "eff closedFee < active agent");
            assertGe(e.gapGuardSec, q.gapGuardSec, "eff gapGuard < active agent");
        }
    }

    /// @dev SPEC.md §2.3: the pool's effective params after the gap guard and the closed-market cap.
    function _assertPoolEffective(LeveragePool p) internal view {
        IRiskOracle.RiskParams memory e = risk.params(p.assetId());
        (IRiskOracle.RiskParams memory rp, uint256 mm) = p.currentRisk();
        ILeveragePool.PoolState memory st = p.state();
        ILeveragePool.PoolParams memory pp = p.params();
        assertLe(rp.triggerLev, e.triggerLev, "pool Tr > oracle trigger");
        assertLe(rp.targetLev, e.targetLev, "pool T > oracle target");
        assertLe(rp.lowerTriggerLev, e.lowerTriggerLev, "pool Lo > oracle lower");
        assertLe(rp.lowerTriggerLev + 0.2e18, rp.targetLev, "pool Lo > T - 0.2");
        assertLe(mm, (rp.targetLev + rp.triggerLev) / 2, "maxMintLev > (T+Tr)/2");
        if (!st.marketOpen) assertLe(mm, pp.closedMaxLev, "closed market: maxMintLev > closedMaxLev");
        if (st.gapGuard) {
            assertLe(rp.triggerLev, pp.gapTriggerLev, "gap guard: Tr > gapTriggerLev");
            assertLe(rp.targetLev, pp.gapTargetLev, "gap guard: T > gapTargetLev");
        }
        assertEq(rp.maxDevBps, e.maxDevBps, "pool maxDev != oracle");
        assertEq(st.triggerLev, rp.triggerLev, "state/currentRisk trigger mismatch");
        assertEq(st.maxMintLev, mm, "state/currentRisk maxMintLev mismatch");
    }
}

// =====================================================================================================
// Pool invariants (SPEC.md §13.1)
// =====================================================================================================

abstract contract PoolInvariantBase is InvariantAsserts {
    struct PoolSnap {
        uint256 C;
        uint256 U;
        uint256 S;
        uint256 X;
        uint256 balA;
        uint256 balU;
        uint256 spTotal;
        uint256 spBal;
        uint256 spAsset;
        uint256 lastAccrualAt;
        uint256 lastRebalanceAt;
        uint256 lastMode;
        uint256 feedAnswer;
    }

    PoolHandler internal h;
    LeveragePool internal pool; // fuzzed
    LeveragePool internal poolB; // same asset + feed, never touched
    LeveragePool internal poolT; // TSLA, other asset + feed, never touched
    address internal carol = makeAddr("carol"); // passive bootstrap holder (not a handler actor)
    address internal bob = makeAddr("bob");
    address[] internal actorList;
    PoolSnap internal snapB;
    PoolSnap internal snapT;
    uint256 internal poolCount0;

    function _usdcDecimals() internal pure virtual returns (uint8);
    function _priceMoves() internal pure virtual returns (bool);

    function setUp() public virtual {
        _deployEnv(_usdcDecimals());

        pool = _newPool(asset, feed, NVDA, "NVDA");
        poolB = _newPool(asset, feed, NVDA, "NVDA");
        poolT = _newPool(tsla, tslaFeed, TSLA, "TSLA");

        _seedPool(pool, 100e18); // $10,000 of first-loss x to the backstop
        _mintStableAs(pool, carol, 100e18, 2_000e18); // L ~ 2, SP funded
        _seedPool(poolB, 10e18);
        _mintStableAs(poolB, bob, 10e18, 300e18);
        _seedPool(poolT, 4e18);
        _mintStableAs(poolT, bob, 4e18, 300e18);

        actorList.push(makeAddr("actor0"));
        actorList.push(makeAddr("actor1"));
        actorList.push(makeAddr("actor2"));
        actorList.push(makeAddr("actor3"));
        h = new PoolHandler(pool, feed, risk, router, donor, backstop, actorList, _priceMoves());

        vm.startPrank(admin);
        asset.grantRole(Roles.MINTER_ROLE, address(h));
        usdc.grantRole(Roles.MINTER_ROLE, address(h));
        risk.grantRole(Roles.POSTER_ROLE, address(h));
        risk.grantRole(Roles.GUARDIAN_ROLE, address(h));
        factory.grantRole(Roles.GUARDIAN_ROLE, address(h));
        router.grantRole(Roles.AUTHORIZER_ROLE, address(h));
        pool.setDonor(donor, true);
        vm.stopPrank();

        targetContract(address(h));
        targetSelector(FuzzSelector({addr: address(h), selectors: _selectors()}));

        snapB = _snap(poolB);
        snapT = _snap(poolT);
        poolCount0 = factory.poolCount();
    }

    function _selectors() internal view virtual returns (bytes4[] memory s) {
        bool moves = _priceMoves();
        s = new bytes4[](moves ? 16 : 12);
        uint256 i;
        s[i++] = PoolHandler.mintStable.selector;
        s[i++] = PoolHandler.mintMax.selector;
        s[i++] = PoolHandler.mintLever.selector;
        s[i++] = PoolHandler.redeemStable.selector;
        s[i++] = PoolHandler.redeemLever.selector;
        s[i++] = PoolHandler.redeemPair.selector;
        s[i++] = PoolHandler.roundTrip.selector;
        s[i++] = PoolHandler.rebalance.selector;
        s[i++] = PoolHandler.accrue.selector;
        s[i++] = PoolHandler.spDeposit.selector;
        s[i++] = PoolHandler.spWithdraw.selector;
        s[i++] = PoolHandler.togglePause.selector;
        if (moves) {
            s[i++] = PoolHandler.donate.selector;
            s[i++] = PoolHandler.movePrice.selector;
            s[i++] = PoolHandler.warp.selector;
            s[i++] = PoolHandler.setFill.selector;
        }
    }

    // ------------------------------------------------------------------ (2) books

    /// @notice §13.1.1: internal C, U never exceed the token balances; S and X are the token supplies.
    function invariant_booksBackedByBalances() public view {
        (uint256 C, uint256 U) = pool.reserves();
        assertGe(asset.balanceOf(address(pool)), C, "asset balance < C");
        assertGe(usdc.balanceOf(address(pool)), U, "usdc balance < U");
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.C, C, "state.C != reserves");
        assertEq(st.U, U, "state.U != reserves");
        assertEq(st.S, IERC20(pool.sUSD()).totalSupply(), "S != sUSD supply");
        assertEq(st.X, IERC20(pool.xToken()).totalSupply(), "X != x supply");
    }

    /// @notice §13.1.5: after seed X >= MIN_X forever (dead shares), and S > 0 implies X > 0.
    function invariant_deadShares() public view {
        uint256 X = IERC20(pool.xToken()).totalSupply();
        assertGe(X, SplitConstants.MIN_X, "X < MIN_X");
        assertGe(IERC20(pool.xToken()).balanceOf(SplitConstants.DEAD), SplitConstants.MIN_X, "dead shares moved");
    }

    // ------------------------------------------------------------------ (1) claims <= assets

    /// @notice §13.1.2: S*min(1, V/S) + X*xNAV <= V (+1e6 wei), and the StabilityPool claims are covered by what
    ///         the SP holds (§4 invariants), so the sum of every claim never exceeds the assets backing it.
    function invariant_claimsWithinAssets() public view {
        ILeveragePool.PoolState memory st = pool.state();
        if (st.price != 0) {
            uint256 sClaim = Math.min(st.S, st.V);
            uint256 xClaim = Math.mulDiv(st.X, st.xNav, WAD);
            assertLe(sClaim + xClaim, st.V + 1e6, "S*min(1,V/S) + X*xNAV > V");
        }
        _assertSpSolvent(pool, actorList, carol);
    }

    function _assertSpSolvent(LeveragePool p, address[] memory users, address extra) internal view {
        StabilityPool spool = StabilityPool(p.stabilityPool());
        IERC20 st = IERC20(p.sUSD());
        uint256 sumDep;
        uint256 sumAsset;
        uint256 sumReward;
        for (uint256 i; i <= users.length; ++i) {
            address u = i < users.length ? users[i] : extra;
            sumDep += spool.depositOf(u);
            (uint256 g1, uint256 g2) = spool.gainsOf(u);
            sumAsset += g1;
            sumReward += g2;
        }
        uint256 td = spool.totalDeposits();
        uint256 bal = st.balanceOf(address(spool));
        assertLe(sumDep, td, "SP: sum compounded deposits > totalDeposits");
        assertLe(td, bal, "SP: totalDeposits > sUSD balance");
        assertLe(sumAsset, IERC20(p.asset()).balanceOf(address(spool)), "SP: asset gains > asset balance");
        assertLe(sumReward, bal - td, "SP: sUSD rewards > balance - totalDeposits");
    }

    // ------------------------------------------------------------------ (3) no extraction / round trips

    function invariant_noRoundTripProfit() public view {
        _assertProp(h.P_ROUND_TRIP());
    }

    function invariant_noDilutionAtFixedPrice() public view {
        _assertProp(h.P_DILUTION());
    }

    // ------------------------------------------------------------------ (4) exits

    /// @notice redeemStable and redeemPair never revert for holders when the pool has assets, even while paused
    ///         or halted: checked on every handler call and by a full bank run at the end of every call sequence.
    function invariant_exitsNeverBlocked() public {
        _assertProp(h.P_EXIT_STABLE());
        _assertProp(h.P_EXIT_PAIR());
        _assertProp(h.P_SP_WITHDRAW());
        (uint256 fails, string memory why) = h.bankRun();
        assertEq(fails, 0, why);
    }

    // ------------------------------------------------------------------ rounding, leverage, gates, rebalance

    function invariant_userOutputsNeverRoundedUp() public view {
        _assertProp(h.P_ROUNDING());
    }

    function invariant_leverageLimits() public view {
        _assertProp(h.P_LEVERAGE());
    }

    function invariant_modeGates() public view {
        _assertProp(h.P_MODE_GATE());
    }

    function invariant_rebalancePostConditions() public view {
        _assertProp(h.P_REBALANCE());
    }

    function invariant_maxMintStableIsMintable() public view {
        _assertProp(h.P_MAX_MINT());
    }

    function invariant_donationCappedAtDeficit() public view {
        _assertProp(h.P_DONATE());
    }

    function invariant_previewMatchesAction() public view {
        _assertProp(h.P_PREVIEW());
    }

    /// @notice §1 / §13.1.9: the views never revert, whatever the feed, oracle or calendar does.
    function invariant_viewsTotal() public view {
        _assertProp(h.P_TOTALITY());
        LeveragePool[3] memory ps = [pool, poolB, poolT];
        for (uint256 i; i < 3; ++i) {
            ps[i].state();
            ps[i].maxMintStable();
            ps[i].currentRisk();
            ps[i].previewRebalance();
        }
    }

    // ------------------------------------------------------------------ (5) risk params

    function invariant_riskParamsInsideClamps() public view {
        _assertEffective(NVDA);
        _assertEffective(TSLA);
        _assertEffective(keccak256("UNKNOWN"));
        if (!feed.revertOnRead()) _assertPoolEffective(pool);
    }

    // ------------------------------------------------------------------ (6) isolation

    /// @notice §13.1.10: actions on one pool never change another pool's books, supplies, balances or SP, even on
    ///         the same asset and feed; the factory registry is unchanged.
    function invariant_poolsIsolated() public view {
        _assertSnapEq(_snap(poolB), snapB, "poolB");
        _assertSnapEq(_snap(poolT), snapT, "poolT");
        assertEq(factory.poolCount(), poolCount0, "pool registry changed");
    }

    // ------------------------------------------------------------------ regressions (shrunk invariant failures)

    /// @notice SP epoch rollover with debt < totalDeposits (lossPerUnit rounds to 1e18) used to keep the old
    ///         epoch's lastLossError; the next offset then under-charged the new depositors (Σ deposits > total).
    function test_regression_spEpochRolloverResetsLossError() public {
        StabilityPool spool = StabilityPool(pool.stabilityPool());
        h.mintStable(0, 6);
        h.movePrice(0, type(int256).min + 1, false);
        h.movePrice(0, -1999816, false);
        h.rebalance(0);
        if (spool.currentEpoch() > 0) assertEq(spool.lastLossError(), 0, "loss error carried across epochs");
        h.spDeposit(0, 3537);
        h.rebalance(0);
        _assertSpSolvent(pool, actorList, carol);
        (uint256 fails, string memory why) = h.bankRun();
        assertEq(fails, 0, why);
    }

    /// @notice Same root cause, reached through a DEX fill, a jump and an SP sell; ended in an SP withdraw that
    ///         reverted ERC20InsufficientBalance during the bank run.
    function test_regression_spBankRunAfterEpochRollover() public {
        StabilityPool spool = StabilityPool(pool.stabilityPool());
        h.mintMax(561323);
        h.setFill(1400000000000000000, -100);
        h.warp(6140019548794655, false);
        h.movePrice(type(uint256).max, -1500, false);
        h.rebalance(1);
        if (spool.currentEpoch() > 0) assertEq(spool.lastLossError(), 0, "loss error carried across epochs");
        h.spDeposit(263549058141134161501327, 14065742589641097924756);
        h.rebalance(2026);
        h.warp(79228162514264337593543950335, false);
        _assertSpSolvent(pool, actorList, carol);
        (uint256 fails, string memory why) = h.bankRun();
        assertEq(fails, 0, why);
    }

    /// @notice A loss error built up on a large totalDeposits (~1.6e18 sUSD) was credited in full against a later
    ///         near-total offset on a tiny totalDeposits (~3e8 wei). The slack backing the error had shrunk with
    ///         that offset, so Σ compounded ended 1 wei above totalDeposits (39 > 38) and the last bank-run
    ///         withdraw reverted ERC20InsufficientBalance. The credit is now scaled by (1 - maxLossPerUnit).
    function test_regression_spLossErrorCreditAfterShrink() public {
        h.mintMax(0);
        h.redeemStable(0, 58469233243226697918265);
        h.movePrice(40, -8500, true);
        h.movePrice(18028, -20, false);
        h.movePrice(560000000000000000000, type(int256).min, true);
        h.rebalance(97499999990000000000);
        h.spDeposit(11200000000, 49000000000000000000);
        h.movePrice(1795789800, 24319, true);
        h.rebalance(1400000000000000001);
        h.spDeposit(16000000000, 9500000000);
        h.rebalance(20500);
        _assertSpSolvent(pool, actorList, carol);
        (uint256 fails, string memory why) = h.bankRun();
        assertEq(fails, 0, why);
    }

    // ------------------------------------------------------------------ helpers

    function _assertProp(uint256 id) internal view {
        assertEq(h.failures(id), 0, h.firstFailure(id));
    }

    function _snap(LeveragePool p) internal view returns (PoolSnap memory s) {
        (s.C, s.U) = p.reserves();
        s.S = IERC20(p.sUSD()).totalSupply();
        s.X = IERC20(p.xToken()).totalSupply();
        s.balA = IERC20(p.asset()).balanceOf(address(p));
        s.balU = usdc.balanceOf(address(p));
        StabilityPool spool = StabilityPool(p.stabilityPool());
        s.spTotal = spool.totalDeposits();
        s.spBal = IERC20(p.sUSD()).balanceOf(address(spool));
        s.spAsset = IERC20(p.asset()).balanceOf(address(spool));
        s.lastAccrualAt = p.lastAccrualAt();
        s.lastRebalanceAt = p.lastRebalanceAt();
        s.lastMode = uint256(p.lastMode());
        if (p == poolT) {
            (, int256 a,,,) = tslaFeed.latestRoundData();
            s.feedAnswer = uint256(a);
        }
    }

    function _assertSnapEq(PoolSnap memory a, PoolSnap memory b, string memory w) internal pure {
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)), string.concat(w, " changed"));
    }

    function afterInvariant() public view {
        console2.log("mintStable", h.calls("mintStable"), "mintMax", h.calls("mintMax"));
        console2.log("mintLever", h.calls("mintLever"), "redeemStable", h.calls("redeemStable"));
        console2.log("redeemLever", h.calls("redeemLever"), "redeemPair", h.calls("redeemPair"));
        console2.log("rt.stable", h.calls("roundTrip.stable"), "rt.lever", h.calls("roundTrip.lever"));
        console2.log("rt.pair", h.calls("roundTrip.pair"), "donate", h.calls("donate"));
        console2.log("sellDex", h.calls("rebalance.sellDex"), "sellSp", h.calls("rebalance.sellSp"));
        console2.log("buy", h.calls("rebalance.buy"), "warp", h.calls("warp"));
        console2.log("spDeposit", h.calls("spDeposit"), "spWithdraw", h.calls("spWithdraw"));
    }
}

/// @notice 18-decimal asset, 18-decimal mUSDC, 8-decimal feed; price moves, warps, pauses, router fills.
contract PoolInvariant18Test is PoolInvariantBase {
    function _usdcDecimals() internal pure override returns (uint8) {
        return 18;
    }

    function _priceMoves() internal pure override returns (bool) {
        return true;
    }
}

/// @notice 18-decimal asset, 6-decimal mUSDC, 8-decimal feed; price moves, warps, pauses, router fills.
contract PoolInvariant6Test is PoolInvariantBase {
    function _usdcDecimals() internal pure override returns (uint8) {
        return 6;
    }

    function _priceMoves() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Fixed price, no warp (so no funding, no staleness): no group of actors can end up with more value
///         than they put in, whatever sequence of mints, redeems, pair redeems and SP moves they run.
contract PoolFixedPriceInvariantTest is PoolInvariantBase {
    function _usdcDecimals() internal pure override returns (uint8) {
        return 6;
    }

    function _priceMoves() internal pure override returns (bool) {
        return false;
    }

    /// @notice (3) Mark-to-market wealth of all actors (wallet tokens + sUSD at min(1, CR) + x at xNAV + SP
    ///         deposits and gains) never exceeds the value of the asset they deposited.
    function invariant_noValueExtraction() public view {
        ILeveragePool.PoolState memory st = pool.state();
        uint256 P = st.price;
        if (P == 0) return;
        uint256 back = Math.min(WAD, st.collateralRatio);
        uint256 uS = 10 ** (18 - usdc.decimals());
        StabilityPool spool = StabilityPool(pool.stabilityPool());
        IERC20 sT = IERC20(pool.sUSD());
        IERC20 xT = IERC20(pool.xToken());
        uint256 wealth;
        for (uint256 i; i < actorList.length; ++i) {
            address a = actorList[i];
            (uint256 g1, uint256 g2) = spool.gainsOf(a);
            wealth += Math.mulDiv(asset.balanceOf(a) + g1, P, 1e18) + usdc.balanceOf(a) * uS
                + Math.mulDiv(sT.balanceOf(a) + spool.depositOf(a) + g2, back, WAD)
                + Math.mulDiv(xT.balanceOf(a), st.xNav, WAD);
        }
        uint256 deposited = Math.mulDiv(h.totalFunded(), P, 1e18);
        assertLe(wealth, deposited + actorList.length * 4, "actors extracted value at a fixed price");
    }
}

// =====================================================================================================
// RiskOracle invariants (task item 5)
// =====================================================================================================

contract RiskOracleInvariantTest is InvariantAsserts {
    RiskHandler internal rh;
    LeveragePool internal pool;
    IRiskOracle.RiskParams internal tslaRule0;
    bytes32 internal tslaSnap0;

    function setUp() public {
        _deployEnv(6);
        pool = _newPool(asset, feed, NVDA, "NVDA");
        _seedPool(pool, 10e18);
        rh = new RiskHandler(risk, NVDA);
        vm.startPrank(admin);
        risk.grantRole(Roles.POSTER_ROLE, address(rh));
        risk.grantRole(Roles.PROPOSER_ROLE, address(rh));
        risk.grantRole(Roles.GUARDIAN_ROLE, address(rh));
        risk.grantRole(risk.DEFAULT_ADMIN_ROLE(), address(rh));
        vm.stopPrank();
        targetContract(address(rh));
        bytes4[] memory s = new bytes4[](7);
        s[0] = RiskHandler.post.selector;
        s[1] = RiskHandler.propose.selector;
        s[2] = RiskHandler.applyProposal.selector;
        s[3] = RiskHandler.veto.selector;
        s[4] = RiskHandler.revokeOrRestore.selector;
        s[5] = RiskHandler.togglePause.selector;
        s[6] = RiskHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(rh), selectors: s}));
        tslaRule0 = risk.ruleParams(TSLA);
        tslaSnap0 = keccak256(abi.encode(risk.latestSnapshot(TSLA)));
    }

    function invariant_effectiveInsideClampsAndConservative() public view {
        _assertEffective(NVDA);
        _assertEffective(TSLA);
        _assertEffective(keccak256("UNKNOWN"));
    }

    /// @notice Stored rule values sit inside the clamps too, and the rule trigger moves <= caps.lev per post.
    function invariant_ruleInsideClampsAndStepCapped() public view {
        IRiskOracle.RiskParams memory r = risk.ruleParams(NVDA);
        IRiskOracle.Clamps memory c = risk.clamps();
        assertGe(r.triggerLev, c.minTriggerLev, "rule trigger < clamp");
        assertLe(r.triggerLev, c.maxTriggerLev, "rule trigger > clamp");
        assertGe(r.targetLev, c.minTargetLev, "rule target < clamp");
        assertGe(r.lowerTriggerLev, c.minLowerTriggerLev, "rule lower < clamp");
        assertGe(r.triggerLev, r.targetLev + c.minTriggerTargetGap, "rule gap");
        assertGe(r.targetLev, r.lowerTriggerLev + c.minTargetLowerGap, "rule lower gap");
        assertLe(r.openFeeBps, c.maxOpenFeeBps, "rule openFee > clamp");
        assertEq(rh.stepCapFailures(), 0, rh.firstStepCapFailure());
    }

    /// @notice Per-asset isolation inside the one RiskOracle: NVDA activity never touches TSLA's rule/snapshot.
    function invariant_assetsIsolatedInOracle() public view {
        assertEq(keccak256(abi.encode(risk.ruleParams(TSLA))), keccak256(abi.encode(tslaRule0)), "TSLA rule changed");
        assertEq(keccak256(abi.encode(risk.latestSnapshot(TSLA))), tslaSnap0, "TSLA snapshot changed");
    }

    function invariant_poolReadsEffectiveRisk() public view {
        _assertPoolEffective(pool);
        ILeveragePool.PoolState memory st = pool.state();
        assertEq(st.mintsPaused, risk.mintsPaused(NVDA), "pool mintsPaused != oracle pause");
        assertEq(uint256(st.riskSource), uint256(risk.source(NVDA)), "pool riskSource != oracle source");
    }

    function afterInvariant() public view {
        console2.log("post", rh.calls("post"), "applied", rh.calls("propose.applied"));
        console2.log("queued", rh.calls("propose.queued"), "apply", rh.calls("apply"));
        console2.log("veto", rh.calls("veto"), "revoke", rh.calls("revoke"));
    }
}

// =====================================================================================================
// Rounding fuzz: mulDiv never favours the user
// =====================================================================================================

abstract contract PoolRoundingFuzzBase is InvariantAsserts {
    LeveragePool internal pool;
    address internal carol = makeAddr("carol");
    uint256 internal aU = 1e18;
    uint256 internal uS;

    function _usdcDecimals() internal pure virtual returns (uint8);

    function setUp() public {
        _deployEnv(_usdcDecimals());
        uS = 10 ** (18 - _usdcDecimals());
        pool = _newPool(asset, feed, NVDA, "NVDA");
        vm.startPrank(carol);
        asset.approve(address(pool), MAX);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _setPrice(uint256 p8) internal {
        feed.setAnswer(int256(p8));
        _envPost(NVDA, p8 * 1e10);
    }

    /// @dev Seeds at price p8 with `seedC` and mints `stableC` sUSD for carol (if it fits under the cap).
    function _build(uint256 p8, uint256 seedC, uint256 stableC) internal returns (uint256 P) {
        p8 = bound(p8, 1e8, 1e12);
        _setPrice(p8);
        P = p8 * 1e10;
        // Seed value between $0.01 and $1e9.
        seedC = bound(seedC, Math.ceilDiv(1e34, P), 1e45 / P);
        _seedPool(pool, seedC);
        uint256 m = pool.maxMintStable();
        stableC = bound(stableC, 0, m);
        if (stableC > 0) {
            vm.prank(admin);
            asset.mint(carol, stableC);
            vm.prank(carol);
            try pool.mintStable(stableC, 0, block.timestamp) {} catch {}
        }
    }

    function _vnum(uint256 c, uint256 u, uint256 P) internal view returns (uint256) {
        return c * P + u * uS * aU;
    }

    function _fund(address who, uint256 amt) internal {
        vm.prank(admin);
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(pool), MAX);
    }

    // ------------------------------------------------------------------ pure helpers (§1)

    /// @notice val/amt/wu round as asked, and the derived L / CR / xNAV are the conservative estimates.
    function testFuzz_helpersRoundConservatively(uint256 C, uint256 U, uint256 S, uint256 X, uint256 P, uint8 dec)
        public
        view
    {
        PoolMath.Ctx memory c;
        c.aU = 10 ** bound(dec, 0, 18);
        c.uS = uS;
        c.P = bound(P, 1, type(uint96).max);
        c.C = bound(C, 0, 1e27);
        c.U = bound(U, 0, 1e27 / uS);
        c.S = bound(S, 0, 1e36);
        c.X = bound(X, 1, 1e36);
        c.usable = true;

        uint256 vf = PoolMath.val(c, c.C, Math.Rounding.Floor);
        uint256 vc = PoolMath.val(c, c.C, Math.Rounding.Ceil);
        assertLe(vf * c.aU, c.C * c.P, "val floor > exact");
        assertGe(vc * c.aU, c.C * c.P, "val ceil < exact");
        assertLe(vc - vf, 1, "val ceil - floor > 1");

        uint256 usd = c.S;
        uint256 af = PoolMath.amt(c, usd, Math.Rounding.Floor);
        uint256 ac = PoolMath.amt(c, usd, Math.Rounding.Ceil);
        assertLe(Math.mulDiv(af, c.P, 1), usd * c.aU, "amt floor > exact");
        assertGe(Math.mulDiv(ac, c.P, 1), usd * c.aU, "amt ceil < exact");

        assertLe(PoolMath.wu(c, usd, false) * c.uS, usd, "wu floor > exact");
        assertGe(PoolMath.wu(c, usd, true) * c.uS, usd, "wu ceil < exact");

        PoolMath.derive(c, 1.3e18);
        uint256 vnum = c.C * c.P + c.U * c.uS * c.aU; // V * aU exactly
        uint256 snum = c.S * c.aU;
        if (vnum > snum) {
            uint256 enumv = vnum - snum;
            // L is an upper estimate: L * E >= C*P.
            assertGe(Math.mulDiv(c.L, enumv, WAD), c.C * c.P, "L below exact");
            // xNAV is a lower estimate: xNAV * X <= E.
            assertLe(Math.mulDiv(c.xNav, c.X * c.aU, WAD, Math.Rounding.Ceil), enumv, "xNAV above exact");
        }
        if (c.S > 0) {
            // CR is a lower estimate: CR * S <= V.
            assertLe(Math.mulDiv(c.CR, snum, WAD, Math.Rounding.Ceil), vnum, "CR above exact");
        }
    }

    // ------------------------------------------------------------------ actions

    function testFuzz_mintStable_neverOverpays(uint256 p8, uint256 seedC, uint256 stableC, uint256 cIn) public {
        uint256 P = _build(p8, seedC, stableC);
        cIn = bound(cIn, 1, 1e30);
        ILeveragePool.PoolState memory b = pool.state();
        _fund(carol, cIn);
        vm.prank(carol);
        try pool.mintStable(cIn, 0, block.timestamp) returns (uint256 sOut) {
            assertLe(sOut, Math.mulDiv(cIn, P * (BPS - b.stableMintFeeBps), aU * BPS), "sOut > exact");
            assertLe(pool.state().leverage, b.maxMintLev, "L after mint > cap");
        } catch {}
    }

    function testFuzz_mintLever_neverOverpays(uint256 p8, uint256 seedC, uint256 stableC, uint256 cIn, int256 mv)
        public
    {
        uint256 P = _build(p8, seedC, stableC);
        // Move the price (within the 250 bps breaker) so E is not a round number.
        int256 bps = bound(mv, -240, 240);
        uint256 p2 = P * uint256(10_000 + bps) / 10_000 / 1e10;
        feed.setAnswer(int256(p2));
        P = p2 * 1e10;
        cIn = bound(cIn, 1, 1e30);
        ILeveragePool.PoolState memory b = pool.state();
        _fund(carol, cIn);
        vm.prank(carol);
        try pool.mintLever(cIn, 0, block.timestamp) returns (uint256 xOut) {
            uint256 enumv = _vnum(b.C, b.U, P) - b.S * aU;
            assertLe(xOut, Math.mulDiv(cIn * P * (BPS - b.leverMintFeeBps), b.X, enumv * BPS), "xOut > exact");
        } catch {}
    }

    function testFuzz_redeemStable_neverOverpays(uint256 p8, uint256 seedC, uint256 stableC, int256 mv, uint256 s)
        public
    {
        uint256 P = _build(p8, seedC, stableC);
        uint256 bal = IERC20(pool.sUSD()).balanceOf(carol);
        vm.assume(bal > 0);
        int256 bps = bound(mv, -8500, 10_000); // includes deep underwater
        uint256 p2 = Math.max(1, P * uint256(10_000 + bps) / 10_000 / 1e10);
        feed.setAnswer(int256(p2));
        P = p2 * 1e10;
        s = bound(s, 1, bal);
        ILeveragePool.PoolState memory b = pool.state();
        uint256 fee = pool.params().redeemFeeBps;
        vm.prank(carol);
        try pool.redeemStable(s, 0, 0) returns (uint256 cOut, uint256 uOut) {
            uint256 vnum = _vnum(b.C, b.U, P);
            uint256 sNum = s * (BPS - fee);
            if (vnum >= b.S * aU) {
                assertLe(cOut, Math.mulDiv(b.C * aU, sNum, vnum * BPS), "cOut > exact (V >= S)");
            } else {
                assertLe(cOut, Math.mulDiv(b.C, sNum, b.S * BPS), "cOut > exact (V < S)");
            }
            assertEq(uOut, 0);
            if (b.mode == ILeveragePool.Mode.UNDERWATER) {
                assertApproxEqAbs(cOut, Math.mulDiv(b.C, sNum / BPS, b.S), 1, "underwater: not sNet/S of C");
            }
        } catch (bytes memory err) {
            // Exits are never blocked: only dust may revert (ZeroOutput).
            assertEq(bytes4(err), ILeveragePool.ZeroOutput.selector, "redeemStable reverted for a non-dust amount");
        }
    }

    function testFuzz_redeemLever_neverOverpays(uint256 p8, uint256 seedC, uint256 stableC, int256 mv, uint256 x)
        public
    {
        uint256 P = _build(p8, seedC, stableC);
        int256 bps = bound(mv, -1500, 3000);
        uint256 p2 = Math.max(1, P * uint256(10_000 + bps) / 10_000 / 1e10);
        feed.setAnswer(int256(p2));
        P = p2 * 1e10;
        uint256 bal = IERC20(pool.xToken()).balanceOf(backstop);
        x = bound(x, 1, bal);
        ILeveragePool.PoolState memory b = pool.state();
        ILeveragePool.PoolParams memory pp = pool.params();
        uint256 fee = b.mode == ILeveragePool.Mode.STABILITY ? pp.stabilityRedeemFeeBps : pp.redeemFeeBps;
        vm.prank(backstop);
        try pool.redeemLever(x, 0, 0) returns (uint256 cOut, uint256 uOut) {
            uint256 enumv = _vnum(b.C, b.U, P) - b.S * aU;
            assertLe(_vnum(cOut, uOut, P), Math.mulDiv(x * (BPS - fee), enumv, b.X * BPS), "redeemLever paid > exact");
            assertLe(pool.state().leverage, b.triggerLev, "L after redeemLever > trigger");
        } catch {}
    }

    function testFuzz_redeemPair_neverBeatsProRata(
        uint256 p8,
        uint256 seedC,
        uint256 stableC,
        uint256 sAmt,
        uint256 xAmt,
        bool breakFeed
    ) public {
        _build(p8, seedC, stableC);
        uint256 sBal = IERC20(pool.sUSD()).balanceOf(carol);
        IERC20 xT = IERC20(pool.xToken());
        uint256 xBal = xT.balanceOf(backstop);
        vm.prank(backstop);
        xT.transfer(carol, xBal);
        if (breakFeed) feed.setRevertOnRead(true); // needs no oracle
        vm.prank(guardian);
        pool.setMintsPaused(true); // never paused
        uint256 sMax = sBal == 0 ? 0 : bound(sAmt, 1, sBal);
        uint256 xMax = bound(xAmt, 1, xBal);
        ILeveragePool.PoolState memory b = pool.state();
        uint256 fee = pool.params().redeemFeeBps;
        vm.prank(carol);
        try pool.redeemPair(sMax, xMax, 0, 0) returns (uint256 sB, uint256 xB, uint256 cOut, uint256 uOut) {
            assertLe(sB, sMax);
            assertLe(xB, xMax);
            assertEq(uOut, 0);
            assertLe(cOut, Math.mulDiv(b.C, xB * (BPS - fee), b.X * BPS), "cOut > x-share");
            if (b.S > 0) assertLe(cOut, Math.mulDiv(b.C, sB * (BPS - fee), b.S * BPS), "cOut > s-share");
            // The burn follows the S:X ratio: the non-binding side is rounded up (never below the ratio).
            if (b.S > 0) {
                bool xCeiled = xB * b.S >= sB * b.X && (xB - 1) * b.S < sB * b.X;
                bool sCeiled = sB > 0 && sB * b.X >= xB * b.S && (sB - 1) * b.X < xB * b.S;
                assertTrue(xCeiled || sCeiled, "burn not at the S:X ratio (ceil on the non-binding side)");
            }
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            assertTrue(
                sel == ILeveragePool.ZeroOutput.selector || sel == ILeveragePool.ZeroAmount.selector,
                "redeemPair reverted for a non-dust amount"
            );
        }
    }

    /// @notice §13.1.4: mint then an immediate redeem at the same P returns <= the input, for every path and
    ///         amount from dust to 1e30.
    function testFuzz_roundTrip_noProfit(uint256 p8, uint256 seedC, uint256 stableC, uint256 cIn, uint8 path) public {
        uint256 P = _build(p8, seedC, stableC);
        cIn = bound(cIn, 1, 1e30);
        address eve = makeAddr("eve");
        _fund(eve, cIn * 2);
        uint256 outNum;
        bool done;
        path %= 3;
        vm.startPrank(eve);
        if (path == 0) {
            try pool.mintStable(cIn, 0, block.timestamp) returns (uint256 sOut) {
                try pool.redeemStable(sOut, 0, 0) returns (uint256 c, uint256 u) {
                    outNum = _vnum(c, u, P);
                    done = true;
                } catch {}
            } catch {}
        } else if (path == 1) {
            try pool.mintLever(cIn, 0, block.timestamp) returns (uint256 xOut) {
                try pool.redeemLever(xOut, 0, 0) returns (uint256 c, uint256 u) {
                    outNum = _vnum(c, u, P);
                    done = true;
                } catch {}
            } catch {}
        } else {
            try pool.mintStable(cIn / 2 + 1, 0, block.timestamp) returns (uint256 sOut) {
                try pool.mintLever(cIn / 2 + 1, 0, block.timestamp) returns (uint256 xOut) {
                    try pool.redeemPair(sOut, xOut, 0, 0) returns (uint256, uint256, uint256 c, uint256 u) {
                        outNum = _vnum(c, u, P) + Math.mulDiv(IERC20(pool.sUSD()).balanceOf(eve), aU, 1)
                            + Math.mulDiv(IERC20(pool.xToken()).balanceOf(eve), pool.state().xNav * aU, WAD);
                        done = true;
                        cIn = 2 * (cIn / 2 + 1);
                    } catch {}
                } catch {}
            } catch {}
        }
        vm.stopPrank();
        if (done) assertLe(outNum, cIn * P, "round trip profit");
    }

    /// @notice §13.1.11: maxMintStable() is mintable; 1.01x + 1 is not when the fee is at its floor.
    function testFuzz_maxMintStable_isExactCap(uint256 p8, uint256 seedC, uint256 stableC) public {
        _build(p8, seedC, stableC);
        uint256 m = pool.maxMintStable();
        vm.assume(m > 0);
        ILeveragePool.PoolState memory b = pool.state();
        _fund(carol, m * 2 + 2);
        uint256 snap = vm.snapshotState();
        vm.prank(carol);
        pool.mintStable(m, 0, block.timestamp); // must not revert
        vm.revertToState(snap);
        if (b.stableMintFeeBps <= pool.params().minFeeBps) {
            vm.prank(carol);
            try pool.mintStable(m * 101 / 100 + 1, 0, block.timestamp) {
                fail();
            } catch (bytes memory err) {
                bytes4 sel = bytes4(err);
                assertTrue(
                    sel == ILeveragePool.LeverageTooHigh.selector || sel == ILeveragePool.CRTooLow.selector,
                    "1.01x maxMint reverted with an unexpected error"
                );
            }
        }
    }

    /// @notice Only the pool can mint or burn its tokens.
    function testFuzz_onlyPoolMintsOrBurns(address who, uint256 amt) public {
        vm.assume(who != address(pool));
        _build(100e8, 10e18, 0);
        ISplitToken sT = ISplitToken(pool.sUSD());
        ISplitToken xT = ISplitToken(pool.xToken());
        vm.startPrank(who);
        vm.expectRevert(ISplitToken.OnlyPool.selector);
        sT.mint(who, amt);
        vm.expectRevert(ISplitToken.OnlyPool.selector);
        xT.mint(who, amt);
        vm.expectRevert(ISplitToken.OnlyPool.selector);
        xT.burn(backstop, 1);
        vm.stopPrank();
    }
}

contract PoolRoundingFuzz18Test is PoolRoundingFuzzBase {
    function _usdcDecimals() internal pure override returns (uint8) {
        return 18;
    }
}

contract PoolRoundingFuzz6Test is PoolRoundingFuzzBase {
    function _usdcDecimals() internal pure override returns (uint8) {
        return 6;
    }
}
