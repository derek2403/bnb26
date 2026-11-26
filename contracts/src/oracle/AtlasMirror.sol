// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3, IHaltableFeed} from "../interfaces/IAggregatorV3.sol";
import {IAtlasMirror} from "../interfaces/IAtlasMirror.sol";
import {SplitConstants, Roles} from "../interfaces/SplitConstants.sol";

/// @title AtlasMirror
/// @notice BSC-testnet AggregatorV3 copy of one mainnet Atlas SingleFeed. PUSHER keys relay each mainnet round
///         with its source metadata. A push that moves more than the step cap is still stored, but sets
///         halted() = true: pools then pause mints, redeemLever and rebalance while redeemStable / redeemPair
///         keep working. The halt clears after `confirmPushes` consecutive in-band pushes spanning at least
///         `confirmMinSec` of source time, or by the Guardian. A manual forceHalt() only clears via clearHalt().
/// @dev Trusted relay disclosed as such; mainnet deployments read Atlas directly. latestRoundData().updatedAt is
///      the Atlas (source) time, never the push time. No external calls, so no reentrancy guard is needed.
contract AtlasMirror is AccessControl, IAtlasMirror {
    /// @dev Thrown when the constructor admin or source feed is zero.
    error ZeroAddress();
    /// @dev Feed decimals above 18 (pools reject them).
    error UnsupportedDecimals(uint8 decimals);
    /// @dev Caller is neither GUARDIAN nor admin.
    error NotGuardianOrAdmin();

    uint256 private constant BPS = SplitConstants.BPS;

    /// @inheritdoc IAtlasMirror
    uint256 public immutable srcChainId;
    /// @inheritdoc IAtlasMirror
    address public immutable srcFeed;
    /// @inheritdoc IAggregatorV3
    uint8 public immutable decimals;
    /// @inheritdoc IAggregatorV3
    string public description;

    /// @inheritdoc IHaltableFeed
    bool public halted;
    /// @notice True when the current halt was set by forceHalt(); such halts never auto-clear.
    bool public manualHalt;
    /// @notice Source updatedAt of the push that (last) triggered the halt.
    uint256 public haltedAtSrc;
    /// @notice Consecutive in-band pushes since the halt.
    uint256 public confirmCount;
    /// @notice Latest mirrored source round id (0 before the first push).
    uint80 public latestId;

    uint256 private _count;
    Limits private _limits;
    mapping(uint80 srcRoundId => MirrorRound) private _rounds;

    /// @param admin DEFAULT_ADMIN_ROLE holder (Timelock); grants PUSHER_ROLE / GUARDIAN_ROLE
    /// @param srcChainId_ chain id of the source feed (56 for BSC mainnet)
    /// @param srcFeed_ address of the source Atlas SingleFeed on that chain
    /// @param decimals_ the source feed's decimals (<= 18)
    /// @param description_ the source feed's description
    constructor(address admin, uint256 srcChainId_, address srcFeed_, uint8 decimals_, string memory description_) {
        if (admin == address(0) || srcFeed_ == address(0)) revert ZeroAddress();
        if (decimals_ > 18) revert UnsupportedDecimals(decimals_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        srcChainId = srcChainId_;
        srcFeed = srcFeed_;
        decimals = decimals_;
        description = description_;
        Limits memory l =
            Limits({maxStepBps: 500, allowancePerHourBps: 100, maxAllowanceBps: 2000, confirmPushes: 3, confirmMinSec: 300});
        _limits = l;
        emit LimitsUpdated(l);
    }

    modifier onlyGuardianOrAdmin() {
        if (!hasRole(Roles.GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotGuardianOrAdmin();
        }
        _;
    }

    // ------------------------------------------------------------------- push

    /// @inheritdoc IAtlasMirror
    function push(
        int256 answer,
        uint80 srcRoundId,
        uint256 srcStartedAt,
        uint256 srcUpdatedAt,
        uint256 srcBlock,
        bytes32 srcTxHash
    ) external {
        if (!hasRole(Roles.PUSHER_ROLE, msg.sender)) revert NotPusher();
        if (answer <= 0) revert NonPositiveAnswer();
        if (srcStartedAt > srcUpdatedAt) revert StartedAfterUpdated();
        // updatedAt == 0 means "no data" to every consumer; never store it.
        if (srcUpdatedAt == 0) revert UpdatedAtNotIncreasing(0, 0);
        if (srcUpdatedAt > block.timestamp + SplitConstants.MAX_FUTURE_SKEW) {
            revert FutureTimestamp(srcUpdatedAt, block.timestamp);
        }

        if (_count != 0) {
            uint80 lastId = latestId;
            MirrorRound storage last = _rounds[lastId];
            if (srcRoundId <= lastId) revert RoundNotIncreasing(lastId, srcRoundId);
            uint256 lastUpdated = last.srcUpdatedAt;
            if (srcUpdatedAt <= lastUpdated) revert UpdatedAtNotIncreasing(lastUpdated, srcUpdatedAt);
            _checkBand(srcRoundId, last.answer, answer, srcUpdatedAt, lastUpdated);
        }

        _rounds[srcRoundId] = MirrorRound({
            answer: answer,
            srcStartedAt: srcStartedAt,
            srcUpdatedAt: srcUpdatedAt,
            srcBlock: srcBlock,
            srcTxHash: srcTxHash,
            pushedAt: block.timestamp
        });
        latestId = srcRoundId;
        unchecked {
            ++_count;
        }
        emit Mirrored(srcChainId, srcFeed, srcRoundId, answer, srcUpdatedAt, srcBlock, srcTxHash);
    }

    /// @dev Halts on an out-of-band move; counts confirmations and auto-clears an automatic halt.
    function _checkBand(uint80 srcRoundId, int256 prev, int256 answer, uint256 srcUpdatedAt, uint256 lastUpdated)
        private
    {
        Limits memory l = _limits;
        uint256 prevU = uint256(prev);
        uint256 a = uint256(answer);
        uint256 diff = a > prevU ? a - prevU : prevU - a;
        uint256 changeBps = Math.mulDiv(diff, BPS, prevU, Math.Rounding.Ceil);
        uint256 hoursElapsed = (srcUpdatedAt - lastUpdated) / 1 hours;
        // allowancePerHourBps <= 1000 and maxAllowanceBps <= 5000: saturate hours to avoid overflow.
        uint256 cap = l.maxStepBps + Math.min(hoursElapsed, l.maxAllowanceBps) * l.allowancePerHourBps;
        if (cap > l.maxAllowanceBps) cap = l.maxAllowanceBps;

        if (changeBps > cap) {
            halted = true;
            haltedAtSrc = srcUpdatedAt;
            confirmCount = 0;
            emit Halted(srcRoundId, prev, answer, changeBps, cap);
        } else if (halted && !manualHalt) {
            uint256 c = confirmCount + 1;
            confirmCount = c;
            if (c >= l.confirmPushes && srcUpdatedAt >= haltedAtSrc + l.confirmMinSec) {
                halted = false;
                confirmCount = 0;
                emit HaltCleared(msg.sender, true);
            }
        }
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IAtlasMirror
    function clearHalt() external onlyGuardianOrAdmin {
        halted = false;
        manualHalt = false;
        confirmCount = 0;
        emit HaltCleared(msg.sender, false);
    }

    /// @inheritdoc IAtlasMirror
    function forceHalt() external onlyGuardianOrAdmin {
        halted = true;
        manualHalt = true;
        confirmCount = 0;
        uint80 id = latestId;
        int256 a = _rounds[id].answer;
        haltedAtSrc = _rounds[id].srcUpdatedAt;
        emit Halted(id, a, a, 0, 0);
    }

    /// @inheritdoc IAtlasMirror
    function setLimits(Limits calldata l) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            l.maxStepBps < 50 || l.maxStepBps > 2000 || l.allowancePerHourBps > 1000
                || l.maxAllowanceBps < l.maxStepBps || l.maxAllowanceBps > 5000 || l.confirmPushes == 0
                || l.confirmPushes > 20 || l.confirmMinSec > 1 days
        ) revert InvalidLimits();
        _limits = l;
        emit LimitsUpdated(l);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IAggregatorV3
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IAggregatorV3
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (_count == 0) revert NoData();
        uint80 id = latestId;
        MirrorRound storage r = _rounds[id];
        return (id, r.answer, r.srcStartedAt, r.srcUpdatedAt, id);
    }

    /// @inheritdoc IAggregatorV3
    function getRoundData(uint80 roundId_)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        MirrorRound storage r = _rounds[roundId_];
        if (r.srcUpdatedAt == 0) revert UnknownRound(roundId_);
        return (roundId_, r.answer, r.srcStartedAt, r.srcUpdatedAt, roundId_);
    }

    /// @inheritdoc IAtlasMirror
    function latestRound() external view returns (uint80 srcRoundId, MirrorRound memory round) {
        srcRoundId = latestId;
        round = _rounds[srcRoundId];
    }

    /// @inheritdoc IAtlasMirror
    function roundCount() external view returns (uint256) {
        return _count;
    }

    /// @inheritdoc IAtlasMirror
    function limits() external view returns (Limits memory) {
        return _limits;
    }
}
