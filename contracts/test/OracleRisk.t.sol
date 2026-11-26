// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SplitConstants, Roles} from "../src/interfaces/SplitConstants.sol";
import {IRiskOracle} from "../src/interfaces/IRiskOracle.sol";
import {IAtlasMirror} from "../src/interfaces/IAtlasMirror.sol";
import {IScenarioFeed} from "../src/interfaces/IScenarioFeed.sol";
import {ILogAnchor} from "../src/interfaces/ILogAnchor.sol";
import {IMarketCalendar} from "../src/interfaces/IMarketCalendar.sol";

import {RiskOracle} from "../src/core/RiskOracle.sol";
import {MarketCalendar} from "../src/core/MarketCalendar.sol";
import {LogAnchor} from "../src/core/LogAnchor.sol";
import {AtlasMirror} from "../src/oracle/AtlasMirror.sol";
import {ScenarioFeed} from "../src/oracle/ScenarioFeed.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @dev Shared actors and helpers.
abstract contract OracleBase is Test {
    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal pusher = makeAddr("pusher");
    address internal poster = makeAddr("poster");
    address internal agentKey = makeAddr("agentKey");
    address internal anchorer = makeAddr("anchorer");
    address internal alice = makeAddr("alice");

    uint256 internal constant T0 = 1795700000; // Thu 2026-11-26 (Thanksgiving) 22:13 UTC
    uint256 internal constant MAX = type(uint256).max;

    function _unauth(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }
}

// =====================================================================================================
//                                              AtlasMirror
// =====================================================================================================

contract AtlasMirrorTest is OracleBase {
    AtlasMirror internal m;
    address internal constant SRC = address(0xA71A5);

    event Mirrored(
        uint256 indexed srcChainId,
        address indexed srcFeed,
        uint80 indexed srcRoundId,
        int256 answer,
        uint256 srcUpdatedAt,
        uint256 srcBlock,
        bytes32 srcTxHash
    );
    event Halted(uint80 indexed srcRoundId, int256 previous, int256 answer, uint256 changeBps, uint256 capBps);
    event HaltCleared(address indexed by, bool automatic);
    event LimitsUpdated(IAtlasMirror.Limits limits);

    function setUp() public {
        vm.warp(T0);
        m = new AtlasMirror(admin, 56, SRC, 8, "NVDA / USD");
        vm.startPrank(admin);
        m.grantRole(Roles.PUSHER_ROLE, pusher);
        m.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();
    }

    function _push(int256 a, uint80 id, uint256 upd) internal {
        vm.prank(pusher);
        m.push(a, id, upd, upd, 40_000_000 + id, keccak256(abi.encode(id)));
    }

    function _latest() internal view returns (uint80 id, int256 a, uint256 upd) {
        (id, a,, upd,) = m.latestRoundData();
    }

    // ------------------------------------------------------------- constructor / views

    function test_constructor_metadataAndDefaults() public view {
        assertEq(m.srcChainId(), 56);
        assertEq(m.srcFeed(), SRC);
        assertEq(m.decimals(), 8);
        assertEq(m.description(), "NVDA / USD");
        assertEq(m.version(), 1);
        assertEq(m.roundCount(), 0);
        assertFalse(m.halted());
        assertTrue(m.hasRole(m.DEFAULT_ADMIN_ROLE(), admin));
        IAtlasMirror.Limits memory l = m.limits();
        assertEq(l.maxStepBps, 500);
        assertEq(l.allowancePerHourBps, 100);
        assertEq(l.maxAllowanceBps, 2000);
        assertEq(l.confirmPushes, 3);
        assertEq(l.confirmMinSec, 300);
    }

    function test_constructor_reverts() public {
        vm.expectRevert(AtlasMirror.ZeroAddress.selector);
        new AtlasMirror(address(0), 56, SRC, 8, "x");
        vm.expectRevert(AtlasMirror.ZeroAddress.selector);
        new AtlasMirror(admin, 56, address(0), 8, "x");
        vm.expectRevert(abi.encodeWithSelector(AtlasMirror.UnsupportedDecimals.selector, uint8(19)));
        new AtlasMirror(admin, 56, SRC, 19, "x");
        // 18 is allowed
        new AtlasMirror(admin, 56, SRC, 18, "x");
    }

    function test_noData_beforeFirstPush() public {
        vm.expectRevert(IAtlasMirror.NoData.selector);
        m.latestRoundData();
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.UnknownRound.selector, uint80(1)));
        m.getRoundData(1);
    }

    // ------------------------------------------------------------------------- roles

    function test_push_onlyPusher() public {
        address[3] memory bad = [alice, admin, guardian];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(IAtlasMirror.NotPusher.selector);
            m.push(100e8, 1, T0, T0, 1, bytes32(0));
        }
    }

    function test_haltControls_onlyGuardianOrAdmin() public {
        _push(100e8, 1, T0);
        vm.prank(alice);
        vm.expectRevert(AtlasMirror.NotGuardianOrAdmin.selector);
        m.forceHalt();
        vm.prank(pusher);
        vm.expectRevert(AtlasMirror.NotGuardianOrAdmin.selector);
        m.forceHalt();
        vm.prank(alice);
        vm.expectRevert(AtlasMirror.NotGuardianOrAdmin.selector);
        m.clearHalt();

        vm.prank(admin);
        m.forceHalt();
        assertTrue(m.halted());
        vm.prank(admin);
        m.clearHalt();
        assertFalse(m.halted());
    }

    function test_setLimits_adminOnlyAndBounds() public {
        IAtlasMirror.Limits memory ok = IAtlasMirror.Limits(50, 0, 50, 1, 0);
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        m.setLimits(ok);
        vm.prank(guardian);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        m.setLimits(ok);

        vm.expectEmit(false, false, false, true, address(m));
        emit LimitsUpdated(ok);
        vm.prank(admin);
        m.setLimits(ok);

        vm.prank(admin);
        m.setLimits(IAtlasMirror.Limits(2000, 1000, 5000, 20, 1 days)); // upper edges

        IAtlasMirror.Limits[8] memory bad = [
            IAtlasMirror.Limits(49, 100, 2000, 3, 300), // maxStep < 50
            IAtlasMirror.Limits(2001, 100, 2001, 3, 300), // maxStep > 2000
            IAtlasMirror.Limits(500, 1001, 2000, 3, 300), // allowance > 1000
            IAtlasMirror.Limits(500, 100, 499, 3, 300), // maxAllowance < maxStep
            IAtlasMirror.Limits(500, 100, 5001, 3, 300), // maxAllowance > 5000
            IAtlasMirror.Limits(500, 100, 2000, 0, 300), // confirmPushes 0
            IAtlasMirror.Limits(500, 100, 2000, 21, 300), // confirmPushes > 20
            IAtlasMirror.Limits(500, 100, 2000, 3, 1 days + 1) // confirmMinSec > 1 day
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(IAtlasMirror.InvalidLimits.selector);
            m.setLimits(bad[i]);
        }
    }

    // ------------------------------------------------------------------------- push

    function test_push_storesRoundAndEmitsMirrored() public {
        vm.warp(T0 + 10);
        bytes32 tx_ = keccak256("tx");
        vm.expectEmit(true, true, true, true, address(m));
        emit Mirrored(56, SRC, 7, 123_45678900, T0 - 50, 4242, tx_);
        vm.prank(pusher);
        m.push(123_45678900, 7, T0 - 60, T0 - 50, 4242, tx_);

        (uint80 rid, int256 a, uint256 st, uint256 upd, uint80 air) = m.latestRoundData();
        assertEq(rid, 7);
        assertEq(a, 123_45678900);
        assertEq(st, T0 - 60);
        assertEq(upd, T0 - 50, "updatedAt must be the source (Atlas) time, not the push time");
        assertEq(air, 7);

        (rid, a, st, upd, air) = m.getRoundData(7);
        assertEq(rid, 7);
        assertEq(a, 123_45678900);
        assertEq(upd, T0 - 50);
        assertEq(air, 7);

        (uint80 lid, IAtlasMirror.MirrorRound memory r) = m.latestRound();
        assertEq(lid, 7);
        assertEq(r.pushedAt, T0 + 10);
        assertEq(r.srcBlock, 4242);
        assertEq(r.srcTxHash, tx_);
        assertEq(r.srcStartedAt, T0 - 60);
        assertEq(m.roundCount(), 1);

        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.UnknownRound.selector, uint80(6)));
        m.getRoundData(6);
    }

    function test_push_inputGuards() public {
        vm.startPrank(pusher);
        vm.expectRevert(IAtlasMirror.NonPositiveAnswer.selector);
        m.push(0, 1, T0, T0, 1, 0);
        vm.expectRevert(IAtlasMirror.NonPositiveAnswer.selector);
        m.push(-1, 1, T0, T0, 1, 0);
        vm.expectRevert(IAtlasMirror.StartedAfterUpdated.selector);
        m.push(1e8, 1, T0, T0 - 1, 1, 0);
        vm.expectRevert(); // updatedAt == 0 is never stored
        m.push(1e8, 1, 0, 0, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.FutureTimestamp.selector, T0 + 31, T0));
        m.push(1e8, 1, T0, T0 + 31, 1, 0);
        m.push(1e8, 1, T0, T0 + 30, 1, 0); // exactly MAX_FUTURE_SKEW is fine
        vm.stopPrank();
        (,, uint256 upd) = _latest();
        assertEq(upd, T0 + 30);
    }

    function test_push_monotonicRoundAndUpdatedAt() public {
        _push(100e8, 5, T0 - 100);
        vm.startPrank(pusher);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.RoundNotIncreasing.selector, uint80(5), uint80(5)));
        m.push(100e8, 5, T0, T0, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.RoundNotIncreasing.selector, uint80(5), uint80(4)));
        m.push(100e8, 4, T0, T0, 1, 0);
        // round check precedes the updatedAt check
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.RoundNotIncreasing.selector, uint80(5), uint80(5)));
        m.push(100e8, 5, T0 - 100, T0 - 100, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.UpdatedAtNotIncreasing.selector, T0 - 100, T0 - 100));
        m.push(100e8, 6, T0 - 100, T0 - 100, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.UpdatedAtNotIncreasing.selector, T0 - 100, T0 - 101));
        m.push(100e8, 6, T0 - 101, T0 - 101, 1, 0);
        // gaps in source round ids are fine
        m.push(100e8, 100, T0 - 99, T0 - 99, 1, 0);
        vm.stopPrank();
        (uint80 id,, uint256 upd) = _latest();
        assertEq(id, 100);
        assertEq(upd, T0 - 99);
        assertEq(m.roundCount(), 2);
        // the older round is still readable
        (, int256 a,,,) = m.getRoundData(5);
        assertEq(a, 100e8);
    }

    function testFuzz_push_monotonic(uint80[6] memory dIds, uint32[6] memory dTs, int64[6] memory moves) public {
        uint80 id = 1;
        uint256 ts = T0 - 1 days;
        int256 a = 100e8;
        _push(a, id, ts);
        for (uint256 i; i < 6; ++i) {
            uint80 nid = id + uint80(bound(dIds[i], 0, 1e6));
            uint256 nts = ts + bound(dTs[i], 0, 3 hours);
            int256 na = a + int256(bound(int256(moves[i]), -50e8, 50e8));
            if (na <= 0) na = 1;
            vm.prank(pusher);
            if (nid <= id) {
                vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.RoundNotIncreasing.selector, id, nid));
                m.push(na, nid, nts, nts, 1, 0);
                continue;
            }
            if (nts <= ts) {
                vm.expectRevert(abi.encodeWithSelector(IAtlasMirror.UpdatedAtNotIncreasing.selector, ts, nts));
                m.push(na, nid, nts, nts, 1, 0);
                continue;
            }
            m.push(na, nid, nts, nts, 1, 0);
            (uint80 rid, int256 ra, uint256 ru) = _latest();
            assertGt(rid, id);
            assertGt(ru, ts);
            assertEq(ra, na, "price is always stored, even when it halts");
            (id, ts, a) = (nid, nts, na);
        }
    }

    // --------------------------------------------------------------------- step cap

    function test_stepCap_exact5pct_noHalt_above_halts() public {
        _push(100e8, 1, T0 - 600);
        _push(105e8, 2, T0 - 500); // +5.00% == cap
        assertFalse(m.halted());
        _push(100e8, 3, T0 - 400); // -4.76%
        assertFalse(m.halted());
        _push(95e8, 4, T0 - 300); // -5.00%
        assertFalse(m.halted());

        // 95e8 * 1.05 = 99.75e8 is exactly 500 bps; one more unit is 501 bps (ceil)
        vm.expectEmit(true, false, false, true, address(m));
        emit Halted(5, 95e8, 99_75000001, 501, 500);
        _push(99_75000001, 5, T0 - 200);
        assertTrue(m.halted(), "move above 5% must auto-pause");
        assertEq(m.haltedAtSrc(), T0 - 200);
        (uint80 id, int256 a, uint256 upd) = _latest();
        assertEq(id, 5);
        assertEq(a, 99_75000001, "halting push is still stored");
        assertEq(upd, T0 - 200);
    }

    function test_stepCap_downMove_halts() public {
        _push(100e8, 1, T0 - 600);
        _push(94_99999999, 2, T0 - 500);
        assertTrue(m.halted());
    }

    function test_stepCap_hourlyAllowance() public {
        _push(100e8, 1, T0 - 10 hours);
        // 1h59m later: floor(hours) = 1 -> cap 600
        _push(106e8, 2, T0 - 10 hours + 1 hours + 59 minutes);
        assertFalse(m.halted());
        // 2h later: cap 700; 106e8 * 1.07 = 113.42e8
        _push(113_42000000, 3, T0 - 10 hours + 3 hours + 59 minutes);
        assertFalse(m.halted());
        // 1h later: cap 600 ; +6.01%
        vm.expectEmit(true, false, false, true, address(m));
        emit Halted(4, 113_42000000, 120_23654200, 601, 600);
        _push(120_23654200, 4, T0 - 10 hours + 4 hours + 59 minutes);
        assertTrue(m.halted());
    }

    function test_stepCap_maxAllowanceCaps() public {
        _push(100e8, 1, T0 - 200 hours);
        _push(120e8, 2, T0 - 100 hours); // 100h -> 500 + 10000 capped at 2000 -> +20% ok
        assertFalse(m.halted());
        vm.expectEmit(true, false, false, true, address(m));
        emit Halted(3, 120e8, 144_00000001, 2001, 2000);
        _push(144_00000001, 3, T0); // 100h later, +20.0000001%
        assertTrue(m.halted());
    }

    function test_setLimits_changesCap() public {
        vm.prank(admin);
        m.setLimits(IAtlasMirror.Limits(1000, 0, 1000, 3, 300));
        _push(100e8, 1, T0 - 100);
        _push(109e8, 2, T0 - 90);
        assertFalse(m.halted());
        _push(120e8, 3, T0 - 80); // +10.09%
        assertTrue(m.halted());
    }

    // --------------------------------------------------------------- auto clear

    function _haltAt(uint256 t) internal {
        _push(100e8, 1, t - 10);
        _push(110e8, 2, t);
        assertTrue(m.halted());
        assertEq(m.haltedAtSrc(), t);
    }

    function test_autoClear_after3InBandPushesAnd300s() public {
        uint256 t = T0 - 1000;
        _haltAt(t);
        _push(110e8, 3, t + 100);
        assertTrue(m.halted());
        assertEq(m.confirmCount(), 1);
        _push(111e8, 4, t + 200);
        assertTrue(m.halted());
        assertEq(m.confirmCount(), 2);
        vm.expectEmit(true, false, false, true, address(m));
        emit HaltCleared(pusher, true);
        _push(110e8, 5, t + 300);
        assertFalse(m.halted());
        assertEq(m.confirmCount(), 0);
    }

    function test_autoClear_requiresMinSourceTime() public {
        uint256 t = T0 - 1000;
        _haltAt(t);
        _push(110e8, 3, t + 10);
        _push(110e8, 4, t + 20);
        _push(110e8, 5, t + 30);
        assertTrue(m.halted(), "3 pushes but < confirmMinSec");
        _push(110e8, 6, t + 299);
        assertTrue(m.halted());
        _push(110e8, 7, t + 300);
        assertFalse(m.halted());
    }

    function test_autoClear_resetByNewJump() public {
        uint256 t = T0 - 2000;
        _haltAt(t);
        _push(110e8, 3, t + 400);
        _push(110e8, 4, t + 500);
        assertEq(m.confirmCount(), 2);
        _push(130e8, 5, t + 600); // another jump
        assertTrue(m.halted());
        assertEq(m.confirmCount(), 0);
        assertEq(m.haltedAtSrc(), t + 600);
        _push(130e8, 6, t + 700);
        _push(130e8, 7, t + 800);
        assertTrue(m.halted());
        _push(130e8, 8, t + 900);
        assertFalse(m.halted());
    }

    function test_forceHalt_neverAutoClears_clearHaltDoes() public {
        _push(100e8, 1, T0 - 5000);
        vm.expectEmit(true, false, false, true, address(m));
        emit Halted(1, 100e8, 100e8, 0, 0);
        vm.prank(guardian);
        m.forceHalt();
        assertTrue(m.halted());
        assertTrue(m.manualHalt());
        for (uint80 i = 2; i < 10; ++i) {
            _push(100e8, i, T0 - 5000 + uint256(i) * 400);
        }
        assertTrue(m.halted(), "manual halt must not auto-clear");

        vm.expectEmit(true, false, false, true, address(m));
        emit HaltCleared(guardian, false);
        vm.prank(guardian);
        m.clearHalt();
        assertFalse(m.halted());
        assertFalse(m.manualHalt());
    }

    function test_clearHalt_guardianClearsJumpHalt() public {
        _haltAt(T0 - 100);
        vm.prank(guardian);
        m.clearHalt();
        assertFalse(m.halted());
        // next in-band push compares against the stored (jumped) value
        _push(112e8, 3, T0 - 90);
        assertFalse(m.halted());
    }
}

// =====================================================================================================
//                                              ScenarioFeed
// =====================================================================================================

contract ScenarioFeedTest is OracleBase {
    MockAggregator internal ref;
    ScenarioFeed internal impl;
    ScenarioFeed internal feed; // operator-only
    address internal op = makeAddr("operator");

    function setUp() public {
        vm.warp(T0);
        ref = new MockAggregator(8, 100e8, "NVDA / USD");
        impl = new ScenarioFeed();
        feed = _clone(address(ref), op, false, 0);
    }

    function _clone(address r, address o, bool pub, int256 init) internal returns (ScenarioFeed f) {
        f = ScenarioFeed(Clones.clone(address(impl)));
        f.initialize(r, o, pub, init);
    }

    function _answer(ScenarioFeed f) internal view returns (int256 a) {
        (, a,,,) = f.latestRoundData();
    }

    function test_impl_initializerDisabled() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(ref), op, false, 1);
    }

    function test_clone_initializeOneShot() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        feed.initialize(address(ref), alice, true, 1);
        assertEq(feed.operator(), op);
    }

    function test_initialize_fromReference() public view {
        assertEq(feed.anchor(), 100e8);
        assertEq(_answer(feed), 100e8);
        assertEq(feed.roundId(), 1);
        assertEq(feed.decimals(), 8);
        assertEq(feed.referenceFeed(), address(ref));
        assertEq(feed.operator(), op);
        assertFalse(feed.publicSetter());
        assertEq(feed.staleBy(), 0);
        assertFalse(feed.halted());
        assertEq(feed.description(), "SCENARIO (team-set price)");
        assertEq(feed.version(), 1);
        (uint80 rid, int256 a, uint256 st, uint256 upd, uint80 air) = feed.latestRoundData();
        assertEq(rid, 1);
        assertEq(a, 100e8);
        assertEq(st, T0);
        assertEq(upd, T0);
        assertEq(air, 1);
    }

    function test_initialize_fallbacks() public {
        // no reference -> initialAnswer, 8 decimals
        ScenarioFeed f = _clone(address(0), op, false, 50e8);
        assertEq(f.anchor(), 50e8);
        assertEq(f.decimals(), 8);
        // reverting reference -> initialAnswer, decimals still read from the reference
        MockAggregator r6 = new MockAggregator(6, 100e6, "6dec");
        r6.setRevertOnRead(true);
        f = _clone(address(r6), op, false, 77e6);
        assertEq(f.anchor(), 77e6);
        assertEq(f.decimals(), 6);
        // non-positive reference answer -> initialAnswer
        MockAggregator r0 = new MockAggregator(8, 0, "zero");
        f = _clone(address(r0), op, false, 42e8);
        assertEq(f.anchor(), 42e8);
        // usable 18-dec reference wins over initialAnswer
        MockAggregator r18 = new MockAggregator(18, 200e18, "18dec");
        f = _clone(address(r18), op, false, 1);
        assertEq(f.anchor(), 200e18);
        assertEq(f.decimals(), 18);
        // nothing usable -> NoAnchor
        ScenarioFeed g = ScenarioFeed(Clones.clone(address(impl)));
        vm.expectRevert(IScenarioFeed.NoAnchor.selector);
        g.initialize(address(0), op, false, 0);
        vm.expectRevert(IScenarioFeed.NoAnchor.selector);
        g.initialize(address(r6), op, false, -5);
    }

    function test_bounds_exactEdges() public {
        // anchor 100e8: [40e8, 160e8]
        assertEq(feed.minAnswer(), 40e8);
        assertEq(feed.maxAnswer(), 160e8);
        vm.startPrank(op);
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(40e8 - 1), 40e8, 160e8));
        feed.setPrice(40e8 - 1);
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(160e8 + 1), 40e8, 160e8));
        feed.setPrice(160e8 + 1);
        feed.setPrice(40e8);
        assertEq(_answer(feed), 40e8);
        feed.setPrice(160e8);
        assertEq(_answer(feed), 160e8);
        vm.stopPrank();

        // rounding: min = ceil(anchor*0.4), max = floor(anchor*1.6)
        ScenarioFeed f = _clone(address(0), op, false, 333);
        assertEq(f.minAnswer(), 134); // ceil(133.2)
        assertEq(f.maxAnswer(), 532); // floor(532.8)
        vm.startPrank(op);
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(133), 134, 532));
        f.setPrice(133);
        f.setPrice(134);
        f.setPrice(532);
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(533), 134, 532));
        f.setPrice(533);
        vm.stopPrank();
    }

    function test_shock() public {
        vm.startPrank(op);
        feed.shock(-2200);
        assertEq(_answer(feed), 78e8);
        assertEq(feed.roundId(), 2);
        feed.shock(1000); // 78 * 1.1
        assertEq(_answer(feed), 85_80000000);
        vm.expectRevert(abi.encodeWithSelector(ScenarioFeed.BadShock.selector, int256(-1e4)));
        feed.shock(-1e4);
        vm.expectRevert(abi.encodeWithSelector(ScenarioFeed.BadShock.selector, int256(1e4)));
        feed.shock(1e4);
        // out-of-band shock reverts (R15), does not clamp
        // 85.8e8 * 1.9999 = 171.59142e8 > 160e8
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(171_59142000), 40e8, 160e8));
        feed.shock(9999);
        // 85.8e8 * 0.4 = 34.32e8 < 40e8
        vm.expectRevert(abi.encodeWithSelector(IScenarioFeed.OutOfBounds.selector, int256(34_32000000), 40e8, 160e8));
        feed.shock(-6000);
        assertEq(_answer(feed), 85_80000000, "rejected shock leaves the price unchanged");
        vm.stopPrank();
    }

    function test_roundIdIncrementsOnEveryPriceChange() public {
        vm.startPrank(op);
        feed.setPrice(90e8);
        assertEq(feed.roundId(), 2);
        feed.shock(100);
        assertEq(feed.roundId(), 3);
        feed.reset();
        assertEq(feed.roundId(), 4);
        vm.stopPrank();
        (uint80 rid, int256 a,,,) = feed.getRoundData(4);
        assertEq(rid, 4);
        assertEq(a, 100e8);
        vm.expectRevert(abi.encodeWithSelector(ScenarioFeed.UnknownRound.selector, uint80(3)));
        feed.getRoundData(3);
    }

    function test_reset_reanchorsAndClearsSimulation() public {
        vm.startPrank(op);
        feed.shock(-3000);
        feed.setStaleness(500);
        feed.setHalted(true);
        vm.stopPrank();
        ref.setAnswer(120e8);

        vm.prank(op);
        feed.reset();
        assertEq(feed.anchor(), 120e8);
        assertEq(_answer(feed), 120e8);
        assertEq(feed.staleBy(), 0);
        assertFalse(feed.halted());
        assertEq(feed.minAnswer(), 48e8);
        assertEq(feed.maxAnswer(), 192e8);

        // unusable reference keeps the old anchor
        vm.prank(op);
        feed.setPrice(150e8);
        ref.setRevertOnRead(true);
        vm.prank(op);
        feed.reset();
        assertEq(feed.anchor(), 120e8);
        assertEq(_answer(feed), 120e8);
    }

    function test_staleness() public {
        vm.prank(op);
        feed.setStaleness(500);
        (,, uint256 st, uint256 upd,) = feed.latestRoundData();
        assertEq(upd, T0 - 500);
        assertEq(st, T0 - 500);
        vm.prank(op);
        feed.setStaleness(T0 + 1);
        (,,, upd,) = feed.latestRoundData();
        assertEq(upd, 0, "saturates at 0");
        vm.warp(T0 + 10_000);
        vm.prank(op);
        feed.setStaleness(0);
        (,,, upd,) = feed.latestRoundData();
        assertEq(upd, T0 + 10_000);
    }

    function test_access_operatorVsPublicSetter() public {
        vm.startPrank(alice);
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        feed.setPrice(90e8);
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        feed.shock(-100);
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        feed.reset();
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        feed.setStaleness(1);
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        feed.setHalted(true);
        vm.stopPrank();

        ScenarioFeed pub = _clone(address(ref), op, true, 0);
        vm.startPrank(alice);
        pub.setPrice(90e8);
        pub.shock(-100);
        pub.reset();
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        pub.setStaleness(1);
        vm.expectRevert(IScenarioFeed.NotOperator.selector);
        pub.setHalted(true);
        vm.stopPrank();
        vm.prank(op);
        pub.setHalted(true);
        assertTrue(pub.halted());
    }

    function testFuzz_answerAlwaysWithinBounds(int256[5] memory bps) public {
        int256 lo = feed.minAnswer();
        int256 hi = feed.maxAnswer();
        for (uint256 i; i < 5; ++i) {
            int256 b = bound(bps[i], -9999, 9999);
            vm.prank(op);
            try feed.shock(b) {} catch {}
            int256 a = _answer(feed);
            assertGe(a, lo);
            assertLe(a, hi);
        }
    }
}

// =====================================================================================================
//                                              RiskOracle
// =====================================================================================================

contract RiskOracleTest is OracleBase {
    RiskOracle internal ro;
    bytes32 internal constant NVDA = keccak256("NVDA");
    bytes32 internal constant TSLA = keccak256("TSLA");
    bytes32 internal constant UNKNOWN = keccak256("NOPE");

    event Clamped(bytes32 indexed assetId, bytes32 indexed field, uint256 requested, uint256 applied);
    event AgentProposal(
        uint256 indexed id,
        bytes32 indexed assetId,
        uint256 indexed agentId,
        bytes32 paramsHash,
        bytes32 inputsHash,
        bytes32 outputHash,
        bytes32 modelIdHash,
        string rationaleURI,
        bool tightenOnly,
        uint256 eta
    );
    event ParamsApplied(
        bytes32 indexed assetId, uint256 indexed proposalId, IRiskOracle.AgentParams agent, uint256 expiresAt
    );
    event Vetoed(uint256 indexed id, address indexed by);
    event ProposalCancelled(uint256 indexed id);
    event AgentRevoked(address indexed by);
    event MintsPausedSet(bytes32 indexed assetId, bool paused, address indexed by);

    uint256 internal seq;
    mapping(bytes32 => uint256) internal lastTs;

    function setUp() public {
        vm.warp(T0);
        vm.roll(1000);
        ro = new RiskOracle(admin);
        vm.startPrank(admin);
        ro.grantRole(Roles.POSTER_ROLE, poster);
        ro.grantRole(Roles.PROPOSER_ROLE, agentKey);
        ro.grantRole(Roles.GUARDIAN_ROLE, guardian);
        ro.configureAsset(NVDA, _cfg());
        ro.configureAsset(TSLA, _cfg());
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _cfg() internal pure returns (IRiskOracle.AssetConfig memory) {
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

    function _snapAt(uint256 vol, uint256 liq, int256 prem) internal returns (IRiskOracle.Snapshot memory) {
        ++seq;
        return IRiskOracle.Snapshot({
            refPrice: 100e18,
            volBps: vol,
            liqUsd: liq,
            premiumBps: prem,
            cmcTs: block.timestamp,
            snapshotId: seq,
            responseHash: keccak256(abi.encode(seq))
        });
    }

    function _post(bytes32 id, uint256 vol, uint256 liq, int256 prem) internal {
        if (block.timestamp <= lastTs[id]) vm.warp(lastTs[id] + 1);
        lastTs[id] = block.timestamp;
        IRiskOracle.Snapshot memory s = _snapAt(vol, liq, prem);
        vm.prank(poster);
        ro.post(id, s);
    }

    /// @dev Normal snapshot: vol at the reference, $1M liquidity, no premium -> rule {2.67, 2.0, 1.6, ...}.
    function _postNormal(bytes32 id) internal {
        _post(id, 5000, 1_000_000e18, 0);
    }

    function _ap(uint256 tr, uint256 tg, uint256 lo, uint256 dev, uint256 cf, uint256 gg, uint256 hz)
        internal
        pure
        returns (IRiskOracle.AgentParams memory)
    {
        return IRiskOracle.AgentParams(tr, tg, lo, dev, cf, gg, hz);
    }

    function _propose(bytes32 id, IRiskOracle.AgentParams memory q) internal returns (uint256 pid, bool applied) {
        vm.prank(agentKey);
        (pid, applied) = ro.propose(id, q, bytes32("in"), bytes32("out"), bytes32("model"), "ipfs://r", 0);
        vm.roll(block.number + 20); // clear the rate limit for the next call
    }

    function _assertParams(
        IRiskOracle.RiskParams memory p,
        uint256 tr,
        uint256 tg,
        uint256 lo,
        uint256 dev,
        uint256 openFee,
        uint256 closedFee,
        uint256 gg,
        uint256 chunk
    ) internal pure {
        assertEq(p.triggerLev, tr, "triggerLev");
        assertEq(p.targetLev, tg, "targetLev");
        assertEq(p.lowerTriggerLev, lo, "lowerTriggerLev");
        assertEq(p.maxDevBps, dev, "maxDevBps");
        assertEq(p.openFeeBps, openFee, "openFeeBps");
        assertEq(p.closedFeeBps, closedFee, "closedFeeBps");
        assertEq(p.gapGuardSec, gg, "gapGuardSec");
        assertEq(p.maxSellChunkUsd, chunk, "maxSellChunkUsd");
    }

    function _hasClamped(Vm.Log[] memory logs, bytes32 id, bytes32 field, uint256 req, uint256 app)
        internal
        view
        returns (bool)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (
                l.emitter == address(ro) && l.topics.length == 3 && l.topics[0] == Clamped.selector && l.topics[1] == id
                    && l.topics[2] == field
            ) {
                (uint256 r, uint256 a) = abi.decode(l.data, (uint256, uint256));
                if (r == req && a == app) return true;
            }
        }
        return false;
    }

    function _assertInClamps(IRiskOracle.RiskParams memory p) internal view {
        IRiskOracle.Clamps memory c = ro.clamps();
        assertGe(p.triggerLev, c.minTriggerLev);
        assertLe(p.triggerLev, c.maxTriggerLev);
        assertGe(p.targetLev, c.minTargetLev);
        assertLe(p.targetLev, c.maxTargetLev);
        assertGe(p.lowerTriggerLev, c.minLowerTriggerLev);
        assertLe(p.lowerTriggerLev, c.maxLowerTriggerLev);
        assertGe(p.maxDevBps, c.minMaxDevBps);
        assertLe(p.maxDevBps, c.maxMaxDevBps);
        assertGe(p.openFeeBps, c.minOpenFeeBps);
        assertLe(p.openFeeBps, c.maxOpenFeeBps);
        assertGe(p.closedFeeBps, c.minClosedFeeBps);
        assertLe(p.closedFeeBps, c.maxClosedFeeBps);
        assertGe(p.gapGuardSec, c.minGapGuardSec);
        assertLe(p.gapGuardSec, c.maxGapGuardSec);
        assertGe(p.triggerLev - p.targetLev, c.minTriggerTargetGap, "trigger-target gap");
        assertGe(p.targetLev - p.lowerTriggerLev, c.minTargetLowerGap, "target-lower gap");
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_defaults() public {
        IRiskOracle.Clamps memory c = ro.clamps();
        assertEq(c.minTriggerLev, 2.2e18);
        assertEq(c.maxTriggerLev, 3.0e18);
        assertEq(c.minTargetLev, 1.6e18);
        assertEq(c.maxTargetLev, 2.2e18);
        assertEq(c.minLowerTriggerLev, 1.2e18);
        assertEq(c.maxLowerTriggerLev, 1.8e18);
        assertEq(c.minTriggerTargetGap, 0.3e18);
        assertEq(c.minTargetLowerGap, 0.2e18);
        assertEq(c.minMaxDevBps, 50);
        assertEq(c.maxMaxDevBps, 300);
        assertEq(c.minOpenFeeBps, 10);
        assertEq(c.maxOpenFeeBps, 150);
        assertEq(c.minClosedFeeBps, 50);
        assertEq(c.maxClosedFeeBps, 300);
        assertEq(c.minGapGuardSec, 1800);
        assertEq(c.maxGapGuardSec, 7200);
        IRiskOracle.StepCaps memory k = ro.stepCaps();
        assertEq(k.lev, 0.1e18);
        assertEq(k.bps, 50);
        assertEq(k.sec, 1800);
        IRiskOracle.Timing memory t = ro.timing();
        assertEq(t.staleAfter, 900);
        assertEq(t.agentMaxTtl, 7200);
        assertEq(t.loosenDelay, 1800);
        assertEq(t.minProposalGapBlocks, 20);
        IRiskOracle.Fallback memory f = ro.fallbackParams();
        assertEq(f.triggerLev, 2.2e18);
        assertEq(f.targetLev, 1.9e18);
        assertEq(f.lowerTriggerLev, 1.5e18);
        assertEq(f.maxDevBps, 150);
        assertEq(f.feeBps, 100);
        assertEq(f.gapGuardSec, 7200);
        assertEq(f.maxSellChunkUsd, 1_000e18);
        assertTrue(ro.agentEnabled());
        assertEq(ro.agentId(), 0);
        assertEq(ro.proposalCount(), 0);

        vm.expectRevert(RiskOracle.ZeroAdmin.selector);
        new RiskOracle(address(0));
    }

    // ------------------------------------------------------------------- roles

    function test_roles_post_propose_guardian_admin() public {
        IRiskOracle.Snapshot memory s = _snapAt(5000, 1e24, 0);
        vm.prank(alice);
        vm.expectRevert(_unauth(alice, Roles.POSTER_ROLE));
        ro.post(NVDA, s);
        vm.prank(admin);
        vm.expectRevert(_unauth(admin, Roles.POSTER_ROLE));
        ro.post(NVDA, s);

        IRiskOracle.AgentParams memory q = _ap(2.6e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600);
        vm.prank(poster);
        vm.expectRevert(_unauth(poster, Roles.PROPOSER_ROLE));
        ro.propose(NVDA, q, 0, 0, 0, "", 0);

        vm.prank(alice);
        vm.expectRevert(_unauth(alice, Roles.GUARDIAN_ROLE));
        ro.veto(1);
        vm.prank(agentKey);
        vm.expectRevert(_unauth(agentKey, Roles.GUARDIAN_ROLE));
        ro.revokeAgent();
        vm.prank(guardian);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.restoreAgent();

        vm.prank(alice);
        vm.expectRevert(RiskOracle.NotGuardianOrAdmin.selector);
        ro.setMintsPaused(NVDA, true);

        IRiskOracle.Clamps memory c = ro.clamps();
        IRiskOracle.StepCaps memory k = ro.stepCaps();
        IRiskOracle.Timing memory t = ro.timing();
        IRiskOracle.Fallback memory f = ro.fallbackParams();
        vm.startPrank(guardian);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.configureAsset(NVDA, _cfg());
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.setClamps(c);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.setStepCaps(k);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.setTiming(t);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.setFallback(f);
        vm.expectRevert(_unauth(guardian, bytes32(0)));
        ro.setAgentId(1);
        vm.stopPrank();
    }

    function test_setMintsPaused_perAssetAndGlobal() public {
        vm.expectEmit(true, true, false, true, address(ro));
        emit MintsPausedSet(NVDA, true, guardian);
        vm.prank(guardian);
        ro.setMintsPaused(NVDA, true);
        assertTrue(ro.mintsPaused(NVDA));
        assertFalse(ro.mintsPaused(TSLA));
        assertTrue(ro.riskView(NVDA).mintsPaused);
        assertFalse(ro.riskView(TSLA).mintsPaused);

        vm.prank(admin);
        ro.setMintsPaused(bytes32(0), true);
        assertTrue(ro.mintsPaused(TSLA));
        assertTrue(ro.mintsPaused(UNKNOWN));
        vm.prank(guardian);
        ro.setMintsPaused(bytes32(0), false);
        assertFalse(ro.mintsPaused(TSLA));
        assertTrue(ro.mintsPaused(NVDA));
    }

    // -------------------------------------------------------------------- post

    function test_post_guards() public {
        IRiskOracle.Snapshot memory s = _snapAt(5000, 1e24, 0);
        vm.startPrank(poster);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.AssetNotConfigured.selector, UNKNOWN));
        ro.post(UNKNOWN, s);

        s.refPrice = 0;
        vm.expectRevert(IRiskOracle.ZeroRefPrice.selector);
        ro.post(NVDA, s);
        s.refPrice = 100e18;

        s.cmcTs = T0 + 31;
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.FutureTimestamp.selector, T0 + 31, T0));
        ro.post(NVDA, s);
        s.cmcTs = T0 + 30; // allowed skew
        ro.post(NVDA, s);

        // snapshotId and cmcTs strictly increasing
        IRiskOracle.Snapshot memory s2 =
            IRiskOracle.Snapshot(s.refPrice, s.volBps, s.liqUsd, s.premiumBps, s.cmcTs, s.snapshotId, s.responseHash);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.SnapshotNotIncreasing.selector, s.snapshotId, s.snapshotId));
        ro.post(NVDA, s2);
        s2.snapshotId = s.snapshotId + 1;
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.TimestampNotIncreasing.selector, T0 + 30, T0 + 30));
        ro.post(NVDA, s2);
        vm.warp(T0 + 1);
        s2.cmcTs = T0 + 31;
        ro.post(NVDA, s2);
        vm.stopPrank();
        assertEq(ro.latestSnapshot(NVDA).snapshotId, s.snapshotId + 1);
    }

    function test_post_firstSnapshot_ruleValues() public {
        _postNormal(NVDA);
        IRiskOracle.RiskParams memory r = ro.ruleParams(NVDA);
        // chunk = 2% of $1M = $20k, inside [100, 50k]
        _assertParams(r, 2.67e18, 2.0e18, 1.6e18, 250, 30, 100, 3600, 20_000e18);
        _assertParams(ro.params(NVDA), 2.67e18, 2.0e18, 1.6e18, 250, 30, 100, 3600, 20_000e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));
        (uint256 p, uint256 ts) = ro.refPrice(NVDA);
        assertEq(p, 100e18);
        assertEq(ts, T0);
        IRiskOracle.RiskView memory v = ro.riskView(NVDA);
        assertEq(v.refPrice, 100e18);
        assertEq(v.refTs, T0);
        assertEq(v.snapshotId, seq);
        assertEq(uint8(v.source), uint8(IRiskOracle.Source.RULE));
        assertFalse(v.mintsPaused);
    }

    function test_post_firstSnapshot_highVolNotStepCapped() public {
        // no previous snapshot -> no step cap; cut = (10000-5000)*1e14 = 0.5 -> 2.17 -> clamp 2.2
        vm.recordLogs();
        _post(NVDA, 10_000, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_hasClamped(logs, NVDA, "triggerLev", 2.17e18, 2.2e18), "Clamped(triggerLev)");
        IRiskOracle.RiskParams memory r = ro.ruleParams(NVDA);
        assertEq(r.triggerLev, 2.2e18);
        assertEq(r.targetLev, 1.9e18); // min(2.0, 2.2 - 0.3)
        assertEq(r.lowerTriggerLev, 1.6e18); // min(1.6, 1.9 - 0.2)
        assertEq(r.maxSellChunkUsd, 100e18, "liq 0 on first snapshot -> minChunk");
    }

    function test_post_triggerStepCap_andClampedEvents() public {
        _postNormal(NVDA);
        vm.recordLogs();
        _post(NVDA, 10_000, 1_000_000e18, 0); // wants 2.2, step-capped to 2.57
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_hasClamped(logs, NVDA, "triggerLev", 2.17e18, 2.2e18), "clamp event");
        assertTrue(_hasClamped(logs, NVDA, "triggerLev", 2.2e18, 2.57e18), "step-cap event");
        IRiskOracle.RiskParams memory r = ro.ruleParams(NVDA);
        assertEq(r.triggerLev, 2.57e18);
        assertEq(r.targetLev, 2.0e18);
        assertEq(r.lowerTriggerLev, 1.6e18);

        uint256[4] memory expTrig = [uint256(2.47e18), 2.37e18, 2.27e18, 2.2e18];
        uint256[4] memory expTgt = [uint256(2.0e18), 2.0e18, 1.97e18, 1.9e18];
        for (uint256 i; i < 4; ++i) {
            _post(NVDA, 10_000, 1_000_000e18, 0);
            r = ro.ruleParams(NVDA);
            assertEq(r.triggerLev, expTrig[i]);
            assertEq(r.targetLev, expTgt[i], "target derived from trigger - gap");
            assertEq(r.lowerTriggerLev, 1.6e18);
        }
        // and back up, also step-capped
        _postNormal(NVDA);
        assertEq(ro.ruleParams(NVDA).triggerLev, 2.3e18);
        assertEq(ro.ruleParams(NVDA).targetLev, 2.0e18);
    }

    function test_post_volZeroKeepsTriple_liqZeroKeepsChunk() public {
        _post(NVDA, 10_000, 1_000_000e18, 0); // first: 2.2 / 1.9 / 1.6, chunk 20k
        _post(NVDA, 0, 0, 0);
        IRiskOracle.RiskParams memory r = ro.ruleParams(NVDA);
        assertEq(r.triggerLev, 2.2e18);
        assertEq(r.targetLev, 1.9e18);
        assertEq(r.lowerTriggerLev, 1.6e18);
        assertEq(r.maxSellChunkUsd, 20_000e18);
        // chunk bounds: tiny liquidity -> minChunk; huge -> maxChunk
        _post(NVDA, 0, 1e18, 0);
        assertEq(ro.ruleParams(NVDA).maxSellChunkUsd, 100e18);
        _post(NVDA, 0, 1e30, 0);
        assertEq(ro.ruleParams(NVDA).maxSellChunkUsd, 50_000e18);
    }

    function test_post_premiumRaisesOpenFee_clamped() public {
        _post(NVDA, 5000, 1e24, -100); // 30 + 100*0.5 = 80
        assertEq(ro.ruleParams(NVDA).openFeeBps, 80);
        vm.recordLogs();
        _post(NVDA, 5000, 1e24, 400); // 30 + 200 = 230 -> 150
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_hasClamped(logs, NVDA, "openFeeBps", 230, 150));
        assertEq(ro.ruleParams(NVDA).openFeeBps, 150);
        _post(NVDA, 5000, 1e24, type(int256).min); // extreme input, |p| capped at 1e6
        assertEq(ro.ruleParams(NVDA).openFeeBps, 150);
    }

    function testFuzz_post_ruleInsideClampsAndStepCapped(
        uint256[4] memory vols,
        uint256[4] memory liqs,
        int256[4] memory prems
    ) public {
        uint256 prevTrig;
        for (uint256 i; i < 4; ++i) {
            uint256 v = bound(vols[i], 0, 1e7);
            uint256 l = bound(liqs[i], 0, 1e33);
            int256 pr = bound(prems[i], -1e9, 1e9);
            _post(NVDA, v, l, pr);
            IRiskOracle.RiskParams memory r = ro.ruleParams(NVDA);
            _assertInClamps(r);
            assertGe(r.maxSellChunkUsd, 100e18);
            assertLe(r.maxSellChunkUsd, 50_000e18);
            if (i > 0) {
                uint256 d = r.triggerLev > prevTrig ? r.triggerLev - prevTrig : prevTrig - r.triggerLev;
                assertLe(d, 0.1e18, "rule trigger moves <= caps.lev per snapshot");
            }
            prevTrig = r.triggerLev;
            _assertInClamps(ro.params(NVDA));
        }
    }

    // -------------------------------------------------------------- staleness

    function test_stale_fallbackMerge() public {
        _postNormal(NVDA); // at T0
        vm.warp(T0 + 900);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE), "exactly staleAfter is fresh");
        vm.warp(T0 + 901);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.FALLBACK));
        // merge(rule, fb): trigger/target/lower/maxDev/chunk min; fees/gapGuard max
        _assertParams(ro.params(NVDA), 2.2e18, 1.9e18, 1.5e18, 150, 100, 100, 7200, 1_000e18);
        // rule itself is untouched
        assertEq(ro.ruleParams(NVDA).triggerLev, 2.67e18);
        // ref price is still reported (pools apply their own maxRefAge)
        (uint256 p, uint256 ts) = ro.refPrice(NVDA);
        assertEq(p, 100e18);
        assertEq(ts, T0);
    }

    function test_stale_mergeKeepsRuleWhenRuleIsTighter() public {
        // rule: trigger 2.2 / target 1.9, openFee 150 via premium, chunk 100 via tiny liq
        _post(NVDA, 10_000, 1e18, 400);
        vm.warp(block.timestamp + 901);
        IRiskOracle.RiskParams memory p = ro.params(NVDA);
        assertEq(p.openFeeBps, 150, "max(rule 150, fb 100)");
        assertEq(p.maxSellChunkUsd, 100e18, "min(rule 100, fb 1000)");
        assertEq(p.lowerTriggerLev, 1.5e18);
        IRiskOracle.Fallback memory f = ro.fallbackParams();
        assertLe(p.triggerLev, f.triggerLev);
        assertLe(p.targetLev, f.targetLev);
        assertLe(p.lowerTriggerLev, f.lowerTriggerLev);
        assertLe(p.maxDevBps, f.maxDevBps);
        assertGe(p.closedFeeBps, f.feeBps);
        assertGe(p.openFeeBps, f.feeBps);
        assertGe(p.gapGuardSec, f.gapGuardSec);
        assertLe(p.maxSellChunkUsd, f.maxSellChunkUsd);
    }

    function test_unknownAsset_viewsTotalAndFallback() public view {
        _assertParams(ro.params(UNKNOWN), 2.2e18, 1.9e18, 1.5e18, 150, 100, 100, 7200, 1_000e18);
        assertEq(uint8(ro.source(UNKNOWN)), uint8(IRiskOracle.Source.FALLBACK));
        (uint256 p, uint256 ts) = ro.refPrice(UNKNOWN);
        assertEq(p, 0);
        assertEq(ts, 0);
        IRiskOracle.RiskView memory v = ro.riskView(UNKNOWN);
        assertEq(v.refPrice, 0);
        assertEq(v.refTs, 0);
        assertEq(v.snapshotId, 0);
        assertFalse(v.mintsPaused);
        (, bool active,,) = ro.agentParams(UNKNOWN);
        assertFalse(active);
        assertFalse(ro.mintsPaused(UNKNOWN));
        ro.ruleParams(UNKNOWN);
        ro.latestSnapshot(UNKNOWN);
        ro.proposal(12345);
        ro.assetConfig(UNKNOWN);
        // also for a configured asset that never posted
        assertEq(uint8(ro.source(TSLA)), uint8(IRiskOracle.Source.FALLBACK));
        assertEq(ro.params(TSLA).triggerLev, 2.2e18);
    }

    function test_setFallback_changesStaleValues() public {
        vm.prank(admin);
        ro.setFallback(IRiskOracle.Fallback(2.4e18, 1.8e18, 1.4e18, 100, 120, 3600, 500e18));
        _assertParams(ro.params(UNKNOWN), 2.4e18, 1.8e18, 1.4e18, 100, 120, 120, 3600, 500e18);
    }

    // ------------------------------------------------------------------- agent

    function test_propose_tightenAppliesImmediately_stepCapped() public {
        _postNormal(NVDA);
        IRiskOracle.AgentParams memory raw = _ap(2.4e18, 1.9e18, 1.6e18, 10, 100, 3600, 3600);
        // bounded: trigger 2.67-0.1 = 2.57; maxDev clamp 50 then step 250-50 = 200
        IRiskOracle.AgentParams memory q = _ap(2.57e18, 1.9e18, 1.6e18, 200, 100, 3600, 3600);

        vm.expectEmit(true, true, false, true, address(ro));
        emit ParamsApplied(NVDA, 1, q, T0 + 3600);
        vm.expectEmit(true, true, true, true, address(ro));
        emit AgentProposal(1, NVDA, 0, keccak256(abi.encode(q)), "in", "out", "model", "ipfs://r", true, T0);
        vm.recordLogs();
        (uint256 id, bool applied) = _propose(NVDA, raw);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_hasClamped(logs, NVDA, "triggerLev", 2.4e18, 2.57e18), "trigger step-cap event");
        assertTrue(_hasClamped(logs, NVDA, "maxDevBps", 10, 50), "maxDev clamp event");
        assertTrue(_hasClamped(logs, NVDA, "maxDevBps", 50, 200), "maxDev step event");

        assertEq(id, 1);
        assertTrue(applied);
        IRiskOracle.Proposal memory p = ro.proposal(1);
        assertEq(uint8(p.status), uint8(IRiskOracle.ProposalStatus.APPLIED));
        assertTrue(p.tightenOnly);
        assertEq(p.eta, T0);
        assertEq(p.createdAt, T0);
        assertEq(p.params.triggerLev, 2.57e18);
        assertEq(p.assetId, NVDA);
        assertEq(ro.queued(NVDA), 0);

        _assertParams(ro.params(NVDA), 2.57e18, 1.9e18, 1.6e18, 200, 30, 100, 3600, 20_000e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.AGENT));
        (IRiskOracle.AgentParams memory a, bool active, uint256 exp, uint256 pid) = ro.agentParams(NVDA);
        assertTrue(active);
        assertEq(exp, T0 + 3600);
        assertEq(pid, 1);
        assertEq(a.triggerLev, 2.57e18);
        // rule unchanged
        assertEq(ro.ruleParams(NVDA).triggerLev, 2.67e18);
    }

    function test_propose_equalToBaseline_appliesButSourceRule() public {
        _postNormal(NVDA);
        (, bool applied) = _propose(NVDA, _ap(2.67e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600));
        assertTrue(applied);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE), "no field strictly tighter");
    }

    function test_propose_agentNeverTouchesOpenFeeOrChunk() public {
        _postNormal(NVDA);
        _propose(NVDA, _ap(2.2e18, 1.6e18, 1.2e18, 50, 300, 7200, 7200));
        IRiskOracle.RiskParams memory p = ro.params(NVDA);
        assertEq(p.openFeeBps, 30);
        assertEq(p.maxSellChunkUsd, 20_000e18);
        // closedFee/gapGuard step caps: 100+50, 3600+1800
        assertEq(p.closedFeeBps, 150);
        assertEq(p.gapGuardSec, 5400);
        (uint256 rp,) = ro.refPrice(NVDA);
        assertEq(rp, 100e18);
    }

    function test_propose_gapEnforcementMayExceedStepCap() public {
        _postNormal(NVDA);
        vm.prank(admin);
        ro.setStepCaps(IRiskOracle.StepCaps(0.5e18, 50, 1800));
        vm.recordLogs();
        _propose(NVDA, _ap(2.2e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_hasClamped(logs, NVDA, "targetLev", 2.0e18, 1.9e18), "gap clamp on target");
        (IRiskOracle.AgentParams memory a,,,) = ro.agentParams(NVDA);
        assertEq(a.triggerLev, 2.2e18);
        assertEq(a.targetLev, 1.9e18);
        assertEq(a.lowerTriggerLev, 1.6e18);
        _assertInClamps(ro.params(NVDA));
    }

    function test_propose_loosenQueued_applyAfterDelay() public {
        _postNormal(NVDA);
        _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200)); // tighten
        uint256 t1 = block.timestamp;
        (uint256 id, bool applied) = _propose(NVDA, _ap(2.67e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        assertFalse(applied);
        IRiskOracle.Proposal memory p = ro.proposal(id);
        assertEq(uint8(p.status), uint8(IRiskOracle.ProposalStatus.QUEUED));
        assertFalse(p.tightenOnly);
        assertEq(p.eta, t1 + 1800);
        assertEq(ro.queued(NVDA), id);
        // still the tight value meanwhile
        assertEq(ro.params(NVDA).triggerLev, 2.57e18);

        vm.warp(t1 + 1799);
        _postNormal(NVDA); // keep the rule fresh
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.TooEarly.selector, t1 + 1800));
        vm.prank(alice);
        ro.applyProposal(id);

        vm.warp(t1 + 1800);
        vm.expectEmit(true, true, false, true, address(ro));
        emit ParamsApplied(NVDA, id, _ap(2.67e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200), t1 + 1800 + 7200);
        vm.prank(alice); // anyone
        ro.applyProposal(id);
        assertEq(uint8(ro.proposal(id).status), uint8(IRiskOracle.ProposalStatus.EXECUTED));
        assertEq(ro.queued(NVDA), 0);
        assertEq(ro.params(NVDA).triggerLev, 2.67e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));

        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.NotQueued.selector, id));
        ro.applyProposal(id);
    }

    function test_propose_loosenBeyondRule_neverEffective() public {
        _postNormal(NVDA);
        // looser than rule on maxDev (+50) and gapGuard (shorter): queued
        (uint256 id, bool applied) = _propose(NVDA, _ap(2.67e18, 2.0e18, 1.6e18, 300, 100, 1800, 3600));
        assertFalse(applied);
        vm.warp(block.timestamp + 1800);
        _postNormal(NVDA);
        ro.applyProposal(id);
        (IRiskOracle.AgentParams memory a, bool active,,) = ro.agentParams(NVDA);
        assertTrue(active);
        assertEq(a.maxDevBps, 300);
        assertEq(a.gapGuardSec, 1800);
        IRiskOracle.RiskParams memory p = ro.params(NVDA);
        assertEq(p.maxDevBps, 250, "agent can never loosen beyond the rule");
        assertEq(p.gapGuardSec, 3600);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));
    }

    function test_effective_perFieldConservativeMerge() public {
        _postNormal(NVDA);
        // agent: trigger 2.57, closedFee 150, others equal to rule
        _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 150, 3600, 7200));
        // rule tightens past the agent on trigger (two high-vol posts: 2.57 then 2.47)
        _post(NVDA, 10_000, 1_000_000e18, 0);
        _post(NVDA, 10_000, 1_000_000e18, 0);
        assertEq(ro.ruleParams(NVDA).triggerLev, 2.47e18);
        IRiskOracle.RiskParams memory p = ro.params(NVDA);
        assertEq(p.triggerLev, 2.47e18, "rule wins on trigger");
        assertEq(p.closedFeeBps, 150, "agent wins on closedFee");
        assertEq(p.targetLev, 2.0e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.AGENT), "closedFee strictly tighter");
    }

    function test_agent_staleStillApplies_sourceFallback() public {
        _postNormal(NVDA);
        _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 150, 5400, 7200));
        vm.warp(block.timestamp + 901);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.FALLBACK));
        IRiskOracle.RiskParams memory p = ro.params(NVDA);
        assertEq(p.triggerLev, 2.2e18);
        assertEq(p.closedFeeBps, 150, "agent tightening survives staleness");
        assertEq(p.gapGuardSec, 7200);
        assertEq(p.openFeeBps, 100);
    }

    function test_agent_expiry_ttlCapped() public {
        _postNormal(NVDA);
        uint256 t = block.timestamp;
        (uint256 id,) = _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 100_000));
        assertEq(ro.proposal(id).params.horizonSec, 7200, "min(horizon, agentMaxTtl)");
        (,, uint256 exp,) = ro.agentParams(NVDA);
        assertEq(exp, t + 7200);
        vm.warp(t + 7199);
        _postNormal(NVDA);
        assertEq(ro.params(NVDA).triggerLev, 2.57e18);
        vm.warp(t + 7200);
        _postNormal(NVDA);
        (, bool active,,) = ro.agentParams(NVDA);
        assertFalse(active);
        assertEq(ro.params(NVDA).triggerLev, 2.67e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));
    }

    function test_propose_staleBaselineIsFallbackMerge() public {
        // TSLA never posted: baseline = fallback (trigger 2.2). 2.67 is a loosening, step-capped to 2.3.
        (uint256 id, bool applied) = _propose(TSLA, _ap(2.67e18, 1.9e18, 1.5e18, 150, 100, 7200, 3600));
        assertFalse(applied);
        assertEq(ro.proposal(id).params.triggerLev, 2.3e18);
        vm.warp(block.timestamp + 1800);
        ro.applyProposal(id);
        assertEq(ro.params(TSLA).triggerLev, 2.2e18, "fallback still binds");
        assertEq(uint8(ro.source(TSLA)), uint8(IRiskOracle.Source.FALLBACK));
        // a tightening while stale applies immediately on top of the fallback
        (, applied) = _propose(TSLA, _ap(2.2e18, 1.9e18, 1.5e18, 100, 150, 7200, 3600));
        assertTrue(applied);
        IRiskOracle.RiskParams memory p = ro.params(TSLA);
        assertEq(p.maxDevBps, 100);
        assertEq(p.closedFeeBps, 150);
    }

    function test_propose_guards() public {
        IRiskOracle.AgentParams memory q = _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600);
        vm.startPrank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.AssetNotConfigured.selector, UNKNOWN));
        ro.propose(UNKNOWN, q, 0, 0, 0, "", 0);
        q.horizonSec = 299;
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.HorizonTooShort.selector, 299));
        ro.propose(NVDA, q, 0, 0, 0, "", 0);
        q.horizonSec = 300;
        ro.propose(NVDA, q, 0, 0, 0, "", 0);
        vm.stopPrank();

        vm.prank(admin);
        ro.setAgentId(42);
        assertEq(ro.agentId(), 42);
        vm.roll(block.number + 20);
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.WrongAgentId.selector, 42, 7));
        ro.propose(NVDA, q, 0, 0, 0, "", 7);
        vm.prank(agentKey);
        ro.propose(NVDA, q, 0, 0, 0, "", 42);
    }

    function test_propose_rateLimitPerAssetByBlocks() public {
        _postNormal(NVDA);
        IRiskOracle.AgentParams memory q = _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600);
        uint256 b = block.number;
        vm.prank(agentKey);
        ro.propose(NVDA, q, 0, 0, 0, "", 0);
        assertEq(ro.lastProposalBlock(NVDA), b);
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.ProposalRateLimited.selector, b + 20));
        ro.propose(NVDA, q, 0, 0, 0, "", 0);
        // other asset is independent
        vm.prank(agentKey);
        ro.propose(TSLA, q, 0, 0, 0, "", 0);
        vm.roll(b + 19);
        vm.prank(agentKey);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.ProposalRateLimited.selector, b + 20));
        ro.propose(NVDA, q, 0, 0, 0, "", 0);
        vm.roll(b + 20);
        vm.prank(agentKey);
        ro.propose(NVDA, q, 0, 0, 0, "", 0);
    }

    function test_veto_blocksQueued() public {
        _postNormal(NVDA);
        _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        (uint256 id,) = _propose(NVDA, _ap(2.67e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        vm.expectEmit(true, true, false, true, address(ro));
        emit Vetoed(id, guardian);
        vm.prank(guardian);
        ro.veto(id);
        assertEq(uint8(ro.proposal(id).status), uint8(IRiskOracle.ProposalStatus.VETOED));
        assertEq(ro.queued(NVDA), 0);
        vm.warp(block.timestamp + 1800);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.NotQueued.selector, id));
        ro.applyProposal(id);
        // vetoing an applied (non-queued) proposal reverts
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.NotQueued.selector, 1));
        ro.veto(1);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.NotQueued.selector, id));
        ro.veto(id);
    }

    function test_newProposalCancelsQueued() public {
        _postNormal(NVDA);
        (uint256 q1,) = _propose(NVDA, _ap(2.67e18, 2.0e18, 1.6e18, 300, 100, 3600, 7200)); // loosen -> queued
        assertEq(ro.queued(NVDA), q1);
        // a TSLA proposal does not touch the NVDA queue
        _propose(TSLA, _ap(2.2e18, 1.9e18, 1.5e18, 150, 100, 7200, 7200));
        assertEq(ro.queued(NVDA), q1);
        vm.expectEmit(true, false, false, false, address(ro));
        emit ProposalCancelled(q1);
        (uint256 q2, bool applied) = _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        assertTrue(applied);
        assertEq(uint8(ro.proposal(q1).status), uint8(IRiskOracle.ProposalStatus.CANCELLED));
        assertEq(ro.queued(NVDA), 0);
        assertEq(q2, q1 + 2);
        vm.warp(block.timestamp + 1800);
        vm.expectRevert(abi.encodeWithSelector(IRiskOracle.NotQueued.selector, q1));
        ro.applyProposal(q1);
    }

    function test_applyProposal_reboundsAgainstCurrentClamps() public {
        _postNormal(NVDA);
        _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        (uint256 id,) = _propose(NVDA, _ap(2.67e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        IRiskOracle.Clamps memory c = ro.clamps();
        c.maxTriggerLev = 2.6e18;
        vm.prank(admin);
        ro.setClamps(c);
        vm.warp(block.timestamp + 1800);
        ro.applyProposal(id);
        (IRiskOracle.AgentParams memory a,,,) = ro.agentParams(NVDA);
        assertEq(a.triggerLev, 2.6e18, "re-clamped at execution time");
        assertEq(ro.proposal(id).params.triggerLev, 2.6e18);
    }

    function test_revokeAgent_removesInfluenceImmediately() public {
        _postNormal(NVDA);
        _propose(NVDA, _ap(2.57e18, 1.9e18, 1.6e18, 200, 150, 5400, 7200));
        (uint256 queuedId,) = _propose(NVDA, _ap(2.67e18, 1.9e18, 1.6e18, 200, 150, 5400, 7200));
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.AGENT));

        vm.expectEmit(true, false, false, false, address(ro));
        emit AgentRevoked(guardian);
        vm.prank(guardian);
        ro.revokeAgent();
        assertFalse(ro.agentEnabled());
        _assertParams(ro.params(NVDA), 2.67e18, 2.0e18, 1.6e18, 250, 30, 100, 3600, 20_000e18);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.RULE));
        (, bool active,,) = ro.agentParams(NVDA);
        assertFalse(active);

        vm.prank(agentKey);
        vm.expectRevert(IRiskOracle.AgentDisabled.selector);
        ro.propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600), 0, 0, 0, "", 0);
        vm.warp(block.timestamp + 1800);
        _postNormal(NVDA);
        vm.expectRevert(IRiskOracle.AgentDisabled.selector);
        ro.applyProposal(queuedId);

        // restore does not resurrect old values or old proposals
        vm.prank(admin);
        ro.restoreAgent();
        assertTrue(ro.agentEnabled());
        (, active,,) = ro.agentParams(NVDA);
        assertFalse(active);
        assertEq(ro.params(NVDA).triggerLev, 2.67e18);
        vm.expectRevert(IRiskOracle.AgentDisabled.selector);
        ro.applyProposal(queuedId);
        // new proposals work again
        (, bool applied) = _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 3600));
        assertTrue(applied);
        assertEq(ro.params(NVDA).triggerLev, 2.57e18);
    }

    function test_perAssetIsolation() public {
        _postNormal(NVDA);
        _post(TSLA, 10_000, 1e18, 400);
        _propose(NVDA, _ap(2.57e18, 1.9e18, 1.6e18, 200, 150, 5400, 7200));
        IRiskOracle.RiskParams memory t = ro.params(TSLA);
        assertEq(t.triggerLev, 2.2e18);
        assertEq(t.maxDevBps, 250);
        assertEq(t.closedFeeBps, 100);
        assertEq(uint8(ro.source(TSLA)), uint8(IRiskOracle.Source.RULE));
        (, bool active,,) = ro.agentParams(TSLA);
        assertFalse(active);
        assertEq(ro.params(NVDA).triggerLev, 2.57e18);
        assertEq(ro.ruleParams(NVDA).openFeeBps, 30);
        assertEq(ro.ruleParams(TSLA).openFeeBps, 150);
        // snapshot sequences are per asset
        assertEq(ro.latestSnapshot(TSLA).cmcTs, lastTs[TSLA]);
        // NVDA going stale does not make TSLA stale and vice versa
        vm.warp(lastTs[NVDA] + 901);
        _postNormal(TSLA);
        assertEq(uint8(ro.source(NVDA)), uint8(IRiskOracle.Source.FALLBACK));
        assertEq(uint8(ro.source(TSLA)), uint8(IRiskOracle.Source.RULE));
    }

    function testFuzz_propose_boundedAndClassified(
        uint256 tr,
        uint256 tg,
        uint256 lo,
        uint256 dev,
        uint256 cf,
        uint256 gg,
        uint256 hz
    ) public {
        _postNormal(NVDA);
        IRiskOracle.AgentParams memory raw = _ap(
            bound(tr, 0, 5e18),
            bound(tg, 0, 5e18),
            bound(lo, 0, 5e18),
            bound(dev, 0, 2000),
            bound(cf, 0, 2000),
            bound(gg, 0, 30_000),
            bound(hz, 300, 1e6)
        );
        IRiskOracle.RiskParams memory b = ro.params(NVDA); // baseline = rule (no agent yet)
        (uint256 id, bool applied) = _propose(NVDA, raw);
        IRiskOracle.AgentParams memory q = ro.proposal(id).params;

        IRiskOracle.Clamps memory c = ro.clamps();
        assertGe(q.triggerLev, c.minTriggerLev);
        assertLe(q.triggerLev, c.maxTriggerLev);
        assertGe(q.targetLev, c.minTargetLev);
        assertLe(q.targetLev, c.maxTargetLev);
        assertGe(q.lowerTriggerLev, c.minLowerTriggerLev);
        assertLe(q.lowerTriggerLev, c.maxLowerTriggerLev);
        assertGe(q.maxDevBps, c.minMaxDevBps);
        assertLe(q.maxDevBps, c.maxMaxDevBps);
        assertGe(q.closedFeeBps, c.minClosedFeeBps);
        assertLe(q.closedFeeBps, c.maxClosedFeeBps);
        assertGe(q.gapGuardSec, c.minGapGuardSec);
        assertLe(q.gapGuardSec, c.maxGapGuardSec);
        assertGe(q.triggerLev - q.targetLev, c.minTriggerTargetGap);
        assertGe(q.targetLev - q.lowerTriggerLev, c.minTargetLowerGap);
        // step caps (gap enforcement may only push target/lower further down)
        assertLe(_absDiff(q.triggerLev, b.triggerLev), 0.1e18);
        assertLe(q.targetLev, b.targetLev + 0.1e18);
        assertLe(q.lowerTriggerLev, b.lowerTriggerLev + 0.1e18);
        assertLe(_absDiff(q.maxDevBps, b.maxDevBps), 50);
        assertLe(_absDiff(q.closedFeeBps, b.closedFeeBps), 50);
        assertLe(_absDiff(q.gapGuardSec, b.gapGuardSec), 1800);
        assertLe(q.horizonSec, 7200);

        bool tight = q.triggerLev <= b.triggerLev && q.targetLev <= b.targetLev
            && q.lowerTriggerLev <= b.lowerTriggerLev && q.maxDevBps <= b.maxDevBps && q.closedFeeBps >= b.closedFeeBps
            && q.gapGuardSec >= b.gapGuardSec;
        assertEq(applied, tight);
        assertEq(ro.proposal(id).tightenOnly, tight);

        // effective is always no looser than the rule, and in clamps
        IRiskOracle.RiskParams memory e = ro.params(NVDA);
        _assertInClamps(e);
        assertLe(e.triggerLev, b.triggerLev);
        assertLe(e.targetLev, b.targetLev);
        assertLe(e.lowerTriggerLev, b.lowerTriggerLev);
        assertLe(e.maxDevBps, b.maxDevBps);
        assertGe(e.closedFeeBps, b.closedFeeBps);
        assertGe(e.gapGuardSec, b.gapGuardSec);
        assertEq(e.openFeeBps, b.openFeeBps);
        assertEq(e.maxSellChunkUsd, b.maxSellChunkUsd);
        if (applied) {
            assertEq(e.triggerLev, q.triggerLev);
            assertEq(e.closedFeeBps, q.closedFeeBps);
        }
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    // ------------------------------------------------------------- admin setters

    function test_setClamps_validation() public {
        IRiskOracle.Clamps memory good = ro.clamps();
        vm.prank(admin);
        ro.setClamps(good);

        IRiskOracle.Clamps memory c;
        c = good; // min > max
        c.minTriggerLev = 3.1e18;
        _expectBadClamps(c);
        c = good;
        c.minTriggerLev = 1.4e18;
        c.minTargetLev = 1.1e18;
        c.minLowerTriggerLev = 1.05e18;
        _expectBadClamps(c);
        c = good;
        c.maxTriggerLev = 4.1e18;
        _expectBadClamps(c);
        c = good;
        c.minLowerTriggerLev = 1.0e18;
        _expectBadClamps(c);
        c = good;
        c.minTriggerTargetGap = 0.09e18;
        _expectBadClamps(c);
        c = good;
        c.minTargetLowerGap = 0.09e18;
        _expectBadClamps(c);
        c = good; // 2.2 - 0.3 < 2.0
        c.minTargetLev = 2.0e18;
        _expectBadClamps(c);
        c = good; // 1.6 - 0.2 < 1.5
        c.minLowerTriggerLev = 1.5e18;
        _expectBadClamps(c);
        c = good;
        c.maxMaxDevBps = 1001;
        _expectBadClamps(c);
        c = good;
        c.maxOpenFeeBps = 1001;
        _expectBadClamps(c);
        c = good;
        c.maxClosedFeeBps = 1001;
        _expectBadClamps(c);
        c = good;
        c.maxGapGuardSec = 6 hours + 1;
        _expectBadClamps(c);
        // R13: a band that excludes the current fallback (trigger 2.2) is refused
        c = good;
        c.minTriggerLev = 2.3e18;
        _expectBadClamps(c);
    }

    function _expectBadClamps(IRiskOracle.Clamps memory c) internal {
        vm.prank(admin);
        vm.expectRevert(IRiskOracle.InvalidConfig.selector);
        ro.setClamps(c);
    }

    function test_setStepCaps_setTiming_validation() public {
        IRiskOracle.StepCaps[6] memory badK = [
            IRiskOracle.StepCaps(0.01e18 - 1, 50, 1800),
            IRiskOracle.StepCaps(0.5e18 + 1, 50, 1800),
            IRiskOracle.StepCaps(0.1e18, 0, 1800),
            IRiskOracle.StepCaps(0.1e18, 501, 1800),
            IRiskOracle.StepCaps(0.1e18, 50, 59),
            IRiskOracle.StepCaps(0.1e18, 50, 6 hours + 1)
        ];
        for (uint256 i; i < badK.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(IRiskOracle.InvalidConfig.selector);
            ro.setStepCaps(badK[i]);
        }
        vm.startPrank(admin);
        ro.setStepCaps(IRiskOracle.StepCaps(0.01e18, 1, 60));
        ro.setStepCaps(IRiskOracle.StepCaps(0.5e18, 500, 6 hours));
        vm.stopPrank();

        IRiskOracle.Timing[7] memory badT = [
            IRiskOracle.Timing(59, 7200, 1800, 20),
            IRiskOracle.Timing(1 days + 1, 7200, 1800, 20),
            IRiskOracle.Timing(900, 299, 1800, 20),
            IRiskOracle.Timing(900, 1 days + 1, 1800, 20),
            IRiskOracle.Timing(900, 7200, 59, 20),
            IRiskOracle.Timing(900, 7200, 1 days + 1, 20),
            IRiskOracle.Timing(900, 7200, 1800, 10_001)
        ];
        for (uint256 i; i < badT.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(IRiskOracle.InvalidConfig.selector);
            ro.setTiming(badT[i]);
        }
        vm.startPrank(admin);
        ro.setTiming(IRiskOracle.Timing(60, 300, 60, 0));
        ro.setTiming(IRiskOracle.Timing(1 days, 1 days, 1 days, 10_000));
        vm.stopPrank();
    }

    function test_setTiming_agentMaxTtl900_matchesPlan() public {
        vm.prank(admin);
        ro.setTiming(IRiskOracle.Timing(900, 900, 1800, 20));
        _postNormal(NVDA);
        (uint256 id,) = _propose(NVDA, _ap(2.57e18, 2.0e18, 1.6e18, 250, 100, 3600, 7200));
        assertEq(ro.proposal(id).params.horizonSec, 900);
    }

    function test_setFallback_validation() public {
        IRiskOracle.Fallback memory good = ro.fallbackParams();
        IRiskOracle.Fallback memory f;
        f = good;
        f.triggerLev = 3.1e18;
        _expectBadFallback(f);
        f = good; // 2.2 - 0.3 < 2.0
        f.targetLev = 2.0e18;
        _expectBadFallback(f);
        f = good; // 1.9 - 0.2 < 1.8
        f.lowerTriggerLev = 1.8e18;
        _expectBadFallback(f);
        f = good;
        f.maxDevBps = 301;
        _expectBadFallback(f);
        f = good; // below closed-fee clamp (50)
        f.feeBps = 40;
        _expectBadFallback(f);
        f = good; // above open-fee clamp (150)
        f.feeBps = 151;
        _expectBadFallback(f);
        f = good;
        f.gapGuardSec = 1799;
        _expectBadFallback(f);
        f = good;
        f.maxSellChunkUsd = 0;
        _expectBadFallback(f);
    }

    function _expectBadFallback(IRiskOracle.Fallback memory f) internal {
        vm.prank(admin);
        vm.expectRevert(IRiskOracle.InvalidConfig.selector);
        ro.setFallback(f);
    }

    function test_configureAsset_validation() public {
        IRiskOracle.AssetConfig memory c;
        c = _cfg();
        c.baseTriggerLev = 3.1e18;
        _expectBadCfg(c);
        c = _cfg();
        c.baseTargetLev = 2.5e18;
        _expectBadCfg(c);
        c = _cfg(); // 2.25 - 0.3 < 2.0
        c.baseTriggerLev = 2.25e18;
        _expectBadCfg(c);
        c = _cfg();
        c.baseLowerTriggerLev = 1.85e18;
        _expectBadCfg(c);
        c = _cfg();
        c.baseLowerTriggerLev = 1.81e18;
        c.baseTargetLev = 2.0e18;
        _expectBadCfg(c);
        c = _cfg();
        c.maxDevBps = 301;
        _expectBadCfg(c);
        c = _cfg();
        c.closedFeeBps = 49;
        _expectBadCfg(c);
        c = _cfg();
        c.baseOpenFeeBps = 151;
        _expectBadCfg(c);
        c = _cfg();
        c.gapGuardSec = 7201;
        _expectBadCfg(c);
        c = _cfg();
        c.minChunkUsd = 60_000e18;
        _expectBadCfg(c);
        c = _cfg();
        c.chunkBpsOfLiq = 10_001;
        _expectBadCfg(c);
        c = _cfg();
        c.premiumFeeShareBps = 10_001;
        _expectBadCfg(c);
        c = _cfg();
        c.volSlopeLev = 1e16 + 1;
        _expectBadCfg(c);
        // edges accepted
        c = _cfg();
        c.volSlopeLev = 1e16;
        c.chunkBpsOfLiq = 10_000;
        c.premiumFeeShareBps = 10_000;
        vm.prank(admin);
        ro.configureAsset(keccak256("EDGE"), c);
        assertTrue(ro.assetConfig(keccak256("EDGE")).enabled);
    }

    function _expectBadCfg(IRiskOracle.AssetConfig memory c) internal {
        vm.prank(admin);
        vm.expectRevert(IRiskOracle.InvalidConfig.selector);
        ro.configureAsset(keccak256("BAD"), c);
    }
}

// =====================================================================================================
//                                              MarketCalendar
// =====================================================================================================

contract MarketCalendarTest is OracleBase {
    MarketCalendar internal cal;

    uint256 internal constant COV_FROM = 1767243600;
    uint256 internal constant COV_TO = 1830315600;
    uint256 internal constant FIRST_DAY = 20454; // 2026-01-01

    /// @dev Independent table (generated from NYSE rules + IANA tz with Python zoneinfo), one byte per local
    ///      day from 2026-01-01 to 2027-12-31: 0 closed, 1 full EST, 2 full EDT, 3 half-day EST, 4 half-day EDT.
    bytes internal constant TABLE =
        hex"00010000010101010100000101010101000000010101010000010101010100000101010101000001010101010000000101010100000101010101000001010101010000020202020200000202020202000002020202020000020202020000000202020202000002020202020000020202020200000202020202000002020202020000020202020200000202020202000000020202020000020202020200000202020202000002020202000000020202020200000202020200000002020202020000020202020200000202020202000002020202020000020202020200000202020202000002020202020000020202020200000202020202000000020202020000020202020200000202020202000002020202020000020202020200000202020202000002020202020000020202020200000101010101000001010101010000010101010100000101010003000001010101010000010101010100000101010101000001010103000000010101010000000101010101000001010101010000000101010100000101010101000001010101010000010101010100000001010101000001010101010000010101010100000101010101000002020202020000020202020000000202020202000002020202020000020202020200000202020202000002020202020000020202020200000202020202000002020202020000020202020200000002020202000002020202020000020202020000000202020202000002020202020000000202020200000202020202000002020202020000020202020200000202020202000002020202020000020202020200000202020202000002020202020000000202020200000202020202000002020202020000020202020200000202020202000002020202020000020202020200000202020202000002020202020000010101010100000101010101000001010100030000010101010100000101010101000001010101010000010101010000000101010101";

    function setUp() public {
        cal = new MarketCalendar(admin);
    }

    function _expected(uint256 d) internal pure returns (uint256 o, uint256 c) {
        uint8 code = uint8(TABLE[d - FIRST_DAY]);
        if (code == 0) return (0, 0);
        uint256 off = (code == 2 || code == 4) ? 14400 : 18000;
        uint256 closeMin = code >= 3 ? 780 : 960;
        o = d * 86400 + 570 * 60 + off;
        c = d * 86400 + closeMin * 60 + off;
    }

    // --------------------------------------------------------------- spec vectors

    function test_specVectors() public view {
        assertEq(cal.nextOpen(1795723200), 1795789800, "Thanksgiving -> Fri 27 Nov 09:30 EST");
        assertTrue(cal.isOpen(1795789800));
        assertEq(cal.nextClose(1795789800), 1795802400, "13:00 half day");
        assertFalse(cal.isOpen(1795802400), "half-open interval");
        assertEq(cal.nextOpen(1795802400), 1796049000, "Mon 30 Nov");
        assertTrue(cal.isOpen(1772807400), "Fri 6 Mar 14:30 UTC (EST)");
        assertFalse(cal.isOpen(1772807400 - 1));
        assertTrue(cal.isOpen(1773063000), "Mon 9 Mar 13:30 UTC (EDT)");
        assertFalse(cal.isOpen(1773063000 - 1));
        assertEq(cal.nextOpen(1772807400 + 8 hours), 1773063000);
        (uint256 o, uint256 c) = cal.sessionOf(cal.dayIndexOf(1782999000));
        assertEq(o, 1782999000, "Thu 2 Jul 2026 open");
        assertEq(c, 1783022400, "Thu 2 Jul 2026 normal close");
        assertTrue(cal.isOpen(1793629800), "Mon 2 Nov open (EST again)");
        assertFalse(cal.isOpen(1793629800 - 1));
        (o, c) = cal.sessionOf(cal.dayIndexOf(1830263400));
        assertEq(o, 1830263400, "Fri 31 Dec 2027 open");
        assertEq(c, 1830286800, "Fri 31 Dec 2027 close");
        assertFalse(cal.isOpen(1830315600));
        assertEq(cal.nextOpen(1830315600), MAX, "uncovered");
        assertTrue(cal.inGapGuard(1795789800 - 3600, 3600));
        assertFalse(cal.inGapGuard(1795789800 - 3601, 3600));
    }

    function test_thanksgiving2026_closed_and_halfDay() public view {
        assertTrue(cal.isHoliday(20783));
        (uint256 o, uint256 c) = cal.sessionOf(20783);
        assertEq(o, 0);
        assertEq(c, 0);
        assertEq(cal.dayIndexOf(1795723200), 20783);
        // whole holiday (00:00 .. 23:59 EST) is closed
        for (uint256 t = 20783 * 86400 + 18000; t < 20784 * 86400 + 18000; t += 1800) {
            assertFalse(cal.isOpen(t));
        }
        assertEq(cal.nextClose(1795723200), 1795802400, "closed: close of the next session");

        assertEq(cal.earlyCloseMinute(20784), 780);
        (o, c) = cal.sessionOf(20784);
        assertEq(o, 1795789800);
        assertEq(c, 1795802400);
        assertTrue(cal.isOpen(1795802400 - 1));
        assertFalse(cal.isOpen(1795802400 + 3 hours - 1), "15:59 on the half day is closed");
        // weekend after
        (o,) = cal.sessionOf(20785);
        assertEq(o, 0, "Sat");
        (o,) = cal.sessionOf(20786);
        assertEq(o, 0, "Sun");
        assertFalse(cal.isOpen(1795885200), "Sat 28 Nov noon");
        assertEq(cal.nextOpen(1795885200), 1796049000);
        assertEq(cal.nextClose(1795885200), 1796049000 + 23400);
        // gap guard across the weekend: 2h window opens Mon 07:30 ET
        assertFalse(cal.inGapGuard(1796049000 - 7201, 7200));
        assertTrue(cal.inGapGuard(1796049000 - 7200, 7200));
        assertTrue(cal.inGapGuard(1796049000 - 1, 7200));
        assertFalse(cal.inGapGuard(1796049000, 7200), "open -> not in gap guard");
    }

    function test_otherEarlyCloses() public view {
        (, uint256 c) = cal.sessionOf(20811);
        assertEq(c, 1798135200, "2026-12-24 13:00 EST");
        (, c) = cal.sessionOf(21148);
        assertEq(c, 1827252000, "2027-11-26 13:00 EST");
        assertEq(cal.nextOpen(1798135200), 1798468200, "Christmas -> Mon 28 Dec");
    }

    function test_dstBoundaries() public view {
        // 2026 spring forward: 2026-03-08 07:00 UTC
        assertEq(cal.utcOffset(1772953199), 18000);
        assertEq(cal.utcOffset(1772953200), 14400);
        assertEq(cal.dayIndexOf(1772953199), 20520);
        assertEq(cal.dayIndexOf(1772953200), 20520);
        assertEq(cal.dayIndexOf(20520 * 86400 + 18000), 20520, "Mar 8 00:00 EST");
        assertEq(cal.dayIndexOf(20520 * 86400 + 18000 - 1), 20519);
        assertEq(cal.dayIndexOf(20521 * 86400 + 14400), 20521, "Mar 9 00:00 EDT");
        assertEq(cal.dayIndexOf(20521 * 86400 + 14400 - 1), 20520);
        // 2026 fall back: 2026-11-01 06:00 UTC
        assertEq(cal.utcOffset(1793512799), 14400);
        assertEq(cal.utcOffset(1793512800), 18000);
        assertEq(cal.dayIndexOf(1793512799), 20758);
        assertEq(cal.dayIndexOf(1793512800), 20758);
        assertEq(cal.dayIndexOf(20759 * 86400 + 18000), 20759, "Nov 2 00:00 EST");
        assertEq(cal.dayIndexOf(20759 * 86400 + 18000 - 1), 20758);
        // Fri before (EDT) -> Mon after (EST)
        (uint256 o, uint256 c) = cal.sessionOf(cal.dayIndexOf(1793367000));
        assertEq(o, 1793367000, "Fri 30 Oct 09:30 EDT");
        assertEq(c, 1793390400);
        assertEq(cal.nextOpen(1793390400), 1793629800);
        // 2027 windows
        assertEq(cal.utcOffset(1805007599), 18000);
        assertEq(cal.utcOffset(1805007600), 14400);
        assertEq(cal.utcOffset(1825567199), 14400);
        assertEq(cal.utcOffset(1825567200), 18000);
        assertTrue(cal.isOpen(1804861800), "Fri 12 Mar 2027 EST");
        assertEq(cal.nextOpen(1804861800), 1805117400, "Mon 15 Mar 2027 EDT");
        assertTrue(cal.isOpen(1825421400), "Fri 5 Nov 2027 EDT");
        assertEq(cal.nextOpen(1825421400), 1825684200, "Mon 8 Nov 2027 EST");
        // between DST windows (winter) is EST
        assertEq(cal.utcOffset(1800000000), 18000);
    }

    function test_coverageEdges() public view {
        (uint256 f, uint256 t) = cal.coverage();
        assertEq(f, COV_FROM);
        assertEq(t, COV_TO);
        assertFalse(cal.covered(COV_FROM - 1));
        assertTrue(cal.covered(COV_FROM));
        assertTrue(cal.covered(COV_TO - 1));
        assertFalse(cal.covered(COV_TO));
        assertEq(cal.nextOpen(COV_FROM - 1), MAX);
        assertEq(cal.nextClose(COV_FROM - 1), MAX);
        assertFalse(cal.inGapGuard(COV_FROM - 1, 1 days));
        // Jan 1 2026 holiday -> Fri Jan 2 09:30 EST
        assertEq(cal.nextOpen(COV_FROM), 20455 * 86400 + 34200 + 18000);
        // after the last covered close
        assertEq(cal.nextOpen(1830286800), MAX);
        assertEq(cal.nextClose(1830286800), MAX);
        assertFalse(cal.inGapGuard(1830286800, 7 days));
        // views never revert on extreme inputs
        assertFalse(cal.isOpen(0));
        assertFalse(cal.isOpen(MAX));
        assertEq(cal.nextOpen(MAX), MAX);
        assertFalse(cal.inGapGuard(MAX, MAX));
        cal.dayIndexOf(MAX);
        cal.sessionOf(MAX);
        cal.utcOffset(MAX);
    }

    /// @dev Every day of 2026-2027 against the independently generated table.
    function test_fullCoverageSweep() public view {
        uint256 n = TABLE.length;
        assertEq(n, 730);
        for (uint256 i; i < n; ++i) {
            uint256 d = FIRST_DAY + i;
            (uint256 eo, uint256 ec) = _expected(d);
            (uint256 o, uint256 c) = cal.sessionOf(d);
            assertEq(o, eo, "open");
            assertEq(c, ec, "close");
            if (eo == 0) {
                assertFalse(cal.isOpen(d * 86400 + 16 hours), "closed day, 11:00/12:00 local");
            } else {
                assertTrue(cal.isOpen(eo));
                assertFalse(cal.isOpen(eo - 1));
                assertTrue(cal.isOpen(ec - 1));
                assertFalse(cal.isOpen(ec));
                assertEq(cal.nextClose(eo), ec);
                assertEq(cal.nextOpen(eo - 1), eo);
                assertEq(cal.dayIndexOf(eo), d);
            }
            // nextOpen from 22:00 UTC of this day (after any close) = the next table session
            uint256 want = MAX;
            for (uint256 j = i + 1; j < n; ++j) {
                (uint256 no,) = _expected(FIRST_DAY + j);
                if (no != 0) {
                    want = no;
                    break;
                }
            }
            assertEq(cal.nextOpen(d * 86400 + 22 hours), want, "nextOpen after close");
        }
    }

    function testFuzz_openImpliesFutureBounds(uint256 ts) public view {
        ts = bound(ts, COV_FROM - 30 days, COV_TO + 30 days);
        uint256 n = cal.nextOpen(ts);
        if (n != MAX) {
            assertGt(n, ts);
            assertTrue(cal.isOpen(n));
            assertFalse(cal.isOpen(n - 1));
        }
        if (cal.isOpen(ts)) {
            assertTrue(cal.covered(ts));
            uint256 c = cal.nextClose(ts);
            assertGt(c, ts);
            assertLe(c - ts, 23400);
            assertGt(n, ts);
            assertFalse(cal.inGapGuard(ts, MAX));
        } else if (n != MAX) {
            assertTrue(cal.inGapGuard(ts, n - ts));
            assertFalse(cal.inGapGuard(ts, n - ts - 1));
        }
    }

    // ----------------------------------------------------------------- admin

    function test_admin_onlyAndValidation() public {
        vm.startPrank(alice);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        cal.setHoliday(20790, true);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        cal.setEarlyClose(20790, 780);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        cal.setDst(2028, 1, 2);
        vm.expectRevert(_unauth(alice, bytes32(0)));
        cal.setCoverage(1, 2);
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IMarketCalendar.BadMinute.selector, 570));
        cal.setEarlyClose(20790, 570);
        vm.expectRevert(abi.encodeWithSelector(IMarketCalendar.BadMinute.selector, 961));
        cal.setEarlyClose(20790, 961);
        cal.setEarlyClose(20790, 571);
        cal.setEarlyClose(20790, 960);
        cal.setEarlyClose(20790, 0);
        vm.expectRevert(IMarketCalendar.BadDst.selector);
        cal.setDst(2028, 100, 100);
        vm.expectRevert(IMarketCalendar.BadCoverage.selector);
        cal.setCoverage(100, 100);

        // Tue 1 Dec 2026 becomes a holiday
        uint256 d = 20788;
        (uint256 o,) = cal.sessionOf(d);
        assertGt(o, 0);
        cal.setHoliday(d, true);
        (o,) = cal.sessionOf(d);
        assertEq(o, 0);
        assertFalse(cal.isOpen(d * 86400 + 18000 + 12 hours));
        cal.setHoliday(d, false);
        cal.setEarlyClose(d, 600); // 10:00
        (, uint256 c) = cal.sessionOf(d);
        assertEq(c, d * 86400 + 600 * 60 + 18000);

        // removing the 2026 DST window makes a July session EST-based
        cal.setDst(2026, 0, 0);
        (o,) = cal.sessionOf(cal.dayIndexOf(1782999000));
        assertEq(o, 1782999000 + 3600);
        assertEq(cal.dstYears().length, 1);
        cal.setDst(2026, 1772953200, 1793512800);
        (o,) = cal.sessionOf(cal.dayIndexOf(1782999000));
        assertEq(o, 1782999000);
        vm.stopPrank();
    }
}

// =====================================================================================================
//                                              LogAnchor
// =====================================================================================================

contract LogAnchorTest is OracleBase {
    LogAnchor internal la;

    event Anchored(uint256 indexed index, bytes32 indexed root, uint256 fromSeq, uint256 toSeq, uint256 timestamp);

    function setUp() public {
        vm.warp(T0);
        la = new LogAnchor(admin);
        vm.prank(admin);
        la.grantRole(Roles.ANCHOR_ROLE, anchorer);
    }

    function test_emptyState() public {
        ILogAnchor.Anchor memory a = la.latest();
        assertEq(a.root, bytes32(0));
        assertEq(a.fromSeq, 0);
        assertEq(a.toSeq, 0);
        assertEq(a.timestamp, 0);
        assertEq(la.count(), 0);
        assertEq(la.nextSeq(), 0);
        vm.expectRevert(abi.encodeWithSelector(LogAnchor.IndexOutOfRange.selector, 0, 0));
        la.anchorAt(0);
        vm.expectRevert(LogAnchor.ZeroAdmin.selector);
        new LogAnchor(address(0));
    }

    function test_guards() public {
        vm.prank(alice);
        vm.expectRevert(ILogAnchor.NotAnchorer.selector);
        la.anchor(bytes32("r"), 0, 0);
        vm.prank(admin);
        vm.expectRevert(ILogAnchor.NotAnchorer.selector);
        la.anchor(bytes32("r"), 0, 0);

        vm.startPrank(anchorer);
        vm.expectRevert(ILogAnchor.ZeroRoot.selector);
        la.anchor(bytes32(0), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ILogAnchor.BadRange.selector, 0, 1, 5));
        la.anchor(bytes32("r"), 1, 5);
        la.anchor(bytes32("r"), 0, 9);
        vm.expectRevert(abi.encodeWithSelector(ILogAnchor.BadRange.selector, 10, 10, 9));
        la.anchor(bytes32("r"), 10, 9);
        vm.expectRevert(abi.encodeWithSelector(ILogAnchor.BadRange.selector, 10, 11, 20));
        la.anchor(bytes32("r"), 11, 20); // gap
        vm.expectRevert(abi.encodeWithSelector(ILogAnchor.BadRange.selector, 10, 9, 20));
        la.anchor(bytes32("r"), 9, 20); // overlap
        vm.stopPrank();
    }

    function test_contiguity() public {
        vm.expectEmit(true, true, false, true, address(la));
        emit Anchored(0, bytes32("a"), 0, 9, T0);
        vm.prank(anchorer);
        assertEq(la.anchor(bytes32("a"), 0, 9), 0);
        vm.warp(T0 + 60);
        vm.prank(anchorer);
        assertEq(la.anchor(bytes32("b"), 10, 10), 1); // single entry
        vm.warp(T0 + 120);
        vm.prank(anchorer);
        assertEq(la.anchor(bytes32("c"), 11, 100), 2);

        assertEq(la.count(), 3);
        assertEq(la.nextSeq(), 101);
        ILogAnchor.Anchor memory a = la.anchorAt(1);
        assertEq(a.root, bytes32("b"));
        assertEq(a.fromSeq, 10);
        assertEq(a.toSeq, 10);
        assertEq(a.timestamp, T0 + 60);
        a = la.latest();
        assertEq(a.root, bytes32("c"));
        assertEq(a.fromSeq, 11);
        assertEq(a.toSeq, 100);
        assertEq(a.timestamp, T0 + 120);
        vm.expectRevert(abi.encodeWithSelector(LogAnchor.IndexOutOfRange.selector, 3, 3));
        la.anchorAt(3);
    }

    function testFuzz_contiguousChain(uint16[8] memory lens) public {
        uint256 next;
        for (uint256 i; i < 8; ++i) {
            uint256 to = next + uint256(lens[i]);
            vm.prank(anchorer);
            la.anchor(keccak256(abi.encode(i)), next, to);
            ILogAnchor.Anchor memory a = la.anchorAt(i);
            if (i > 0) assertEq(a.fromSeq, la.anchorAt(i - 1).toSeq + 1);
            next = to + 1;
            assertEq(la.nextSeq(), next);
        }
        assertEq(la.count(), 8);
    }
}
