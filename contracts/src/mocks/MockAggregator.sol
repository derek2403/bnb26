// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAggregatorV3, IHaltableFeed} from "../interfaces/IAggregatorV3.sol";
import {IMockAggregator} from "../interfaces/IMockAggregator.sol";

/// @title MockAggregator
/// @notice Test-only settable AggregatorV3 with round history, a halt flag and a "revert on read" switch.
/// @dev No access control by design: it is never wired to a LIVE pool on a real chain. Any answer (including
///      0 or negative) and any updatedAt (past or future) may be set so pools' price-usability paths can be tested.
contract MockAggregator is IMockAggregator {
    /// @dev latestRoundData() was configured to revert.
    error ReadReverted();
    /// @dev getRoundData() for a round that was never written.
    error UnknownRound(uint80 roundId);

    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        bool exists;
    }

    /// @inheritdoc IAggregatorV3
    uint8 public immutable decimals;
    /// @inheritdoc IAggregatorV3
    string public description;
    /// @inheritdoc IHaltableFeed
    bool public halted;
    /// @notice When the current halt started (block time of setHalted(true)); 0 while not halted. Mirrors AtlasMirror.
    uint256 public haltedAtSrc;
    /// @notice When true latestRoundData() reverts.
    bool public revertOnRead;
    /// @notice Latest round id (starts at 1 with the constructor answer).
    uint80 public latestId;

    mapping(uint80 roundId => Round) private _rounds;

    /// @param decimals_ feed decimals (8 for Atlas / Chainlink style)
    /// @param initialAnswer first answer, written as round 1 with updatedAt = block.timestamp
    /// @param description_ human readable description
    constructor(uint8 decimals_, int256 initialAnswer, string memory description_) {
        decimals = decimals_;
        description = description_;
        _write(initialAnswer, block.timestamp);
    }

    // ---------------------------------------------------------------- setters

    /// @inheritdoc IMockAggregator
    function setAnswer(int256 a) external {
        _write(a, block.timestamp);
    }

    /// @inheritdoc IMockAggregator
    function setAnswerAt(int256 a, uint256 updatedAt) external {
        _write(a, updatedAt);
    }

    /// @inheritdoc IMockAggregator
    function setHalted(bool h) external {
        if (h && !halted) haltedAtSrc = block.timestamp;
        if (!h) haltedAtSrc = 0;
        halted = h;
    }

    /// @inheritdoc IMockAggregator
    function setRevertOnRead(bool r) external {
        revertOnRead = r;
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
        if (revertOnRead) revert ReadReverted();
        Round storage r = _rounds[latestId];
        return (latestId, r.answer, r.startedAt, r.updatedAt, latestId);
    }

    /// @inheritdoc IAggregatorV3
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round storage r = _rounds[roundId];
        if (!r.exists) revert UnknownRound(roundId);
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    // --------------------------------------------------------------- internal

    function _write(int256 a, uint256 updatedAt) private {
        uint80 id = latestId + 1;
        latestId = id;
        _rounds[id] = Round({answer: a, startedAt: updatedAt, updatedAt: updatedAt, exists: true});
    }
}
