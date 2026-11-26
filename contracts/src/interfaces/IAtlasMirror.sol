// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3, IHaltableFeed} from "./IAggregatorV3.sol";

/// @notice Testnet AggregatorV3 copy of one mainnet Atlas SingleFeed (one mirror per asset feed).
///         Trusted relay: PUSHER keys copy each mainnet round; mainnet deployments read Atlas directly.
interface IAtlasMirror is IAggregatorV3, IHaltableFeed {
    struct Limits {
        uint256 maxStepBps; // base per-push change cap (default 500 = 5%)
        uint256 allowancePerHourBps; // extra allowance per hour of source time since previous push (default 100)
        uint256 maxAllowanceBps; // total cap incl. allowance (default 2000)
        uint256 confirmPushes; // consecutive in-band pushes that auto-clear a halt (default 3)
        uint256 confirmMinSec; // and source time elapsed since the halting push (default 300)
    }

    struct MirrorRound {
        int256 answer;
        uint256 srcStartedAt;
        uint256 srcUpdatedAt;
        uint256 srcBlock;
        bytes32 srcTxHash;
        uint256 pushedAt; // block.timestamp of the testnet push (informational only)
    }

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
    event LimitsUpdated(Limits limits);

    error NotPusher();
    error NonPositiveAnswer();
    error RoundNotIncreasing(uint80 last, uint80 given);
    error UpdatedAtNotIncreasing(uint256 last, uint256 given);
    error FutureTimestamp(uint256 srcUpdatedAt, uint256 nowTs);
    error StartedAfterUpdated();
    error InvalidLimits();
    error NoData();
    error UnknownRound(uint80 roundId);

    /// @notice PUSHER only. Records one source round. Never reverts on a large move: it accepts the value and
    ///         sets halted()=true (mints pause; redeems keep working).
    function push(
        int256 answer,
        uint80 srcRoundId,
        uint256 srcStartedAt,
        uint256 srcUpdatedAt,
        uint256 srcBlock,
        bytes32 srcTxHash
    ) external;

    /// @notice GUARDIAN or admin.
    function clearHalt() external;

    /// @notice GUARDIAN or admin. Manually halt (e.g. corporate action detected).
    function forceHalt() external;

    /// @notice Admin only, bounded (see SPEC.md).
    function setLimits(Limits calldata limits) external;

    function limits() external view returns (Limits memory);

    function srcChainId() external view returns (uint256);

    function srcFeed() external view returns (address);

    function latestRound() external view returns (uint80 srcRoundId, MirrorRound memory round);

    function roundCount() external view returns (uint256);
}
