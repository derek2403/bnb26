// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink AggregatorV3Interface (the shape Atlas SingleFeed exposes on BSC mainnet).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Optional extension implemented by AtlasMirror, ScenarioFeed and MockAggregator.
///         Pools read it with a low-level staticcall and treat a failed call or short return data as `false`,
///         so a plain AggregatorV3 (e.g. mainnet Atlas) also works as a pool feed.
interface IHaltableFeed {
    /// @return True while mints must be paused because the last push jumped beyond the step cap.
    function halted() external view returns (bool);
}

/// @notice Optional: when the current halt started (source time). AtlasMirror exposes it; pools read it with a
///         low-level staticcall and treat a failed call, short return data or 0 as "unknown" (no redeem hold).
interface IHaltTime {
    function haltedAtSrc() external view returns (uint256);
}
