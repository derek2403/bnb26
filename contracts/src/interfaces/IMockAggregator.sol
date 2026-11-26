// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3, IHaltableFeed} from "./IAggregatorV3.sol";

/// @notice Test-only settable AggregatorV3 (no access control; never used by a LIVE pool on a real chain).
interface IMockAggregator is IAggregatorV3, IHaltableFeed {
    /// @notice roundId += 1; answer = a; startedAt = updatedAt = block.timestamp.
    function setAnswer(int256 a) external;

    /// @notice roundId += 1 with an explicit updatedAt (may be in the past or the future).
    function setAnswerAt(int256 a, uint256 updatedAt) external;

    function setHalted(bool h) external;

    /// @notice When true, latestRoundData() reverts (to test state() totality).
    function setRevertOnRead(bool r) external;
}
