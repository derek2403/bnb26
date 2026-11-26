// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3, IHaltableFeed} from "./IAggregatorV3.sol";

/// @notice Team/viewer-set demo price for ScenarioPool and sandboxes (clone). Never used by a LIVE pool.
///         Price bounded to [0.4, 1.6] x anchor, where anchor = reference (AtlasMirror) answer captured at
///         initialize()/reset(). latestRoundData().updatedAt = block.timestamp - staleBy (always "fresh"
///         unless the operator simulates staleness). Decimals = reference decimals (or 8 when no reference).
interface IScenarioFeed is IAggregatorV3, IHaltableFeed {
    event PriceSet(uint80 indexed roundId, int256 answer, address indexed by);
    event AnchorReset(int256 anchor, address indexed by);
    event StalenessSet(uint256 staleBy);
    event HaltSet(bool halted);

    error NotOperator();
    error OutOfBounds(int256 answer, int256 min, int256 max);
    error NoAnchor();

    /// @param reference_ feed to anchor to (AtlasMirror); may be address(0) to use initialAnswer
    /// @param operator_ who may set prices (sandbox owner / team)
    /// @param publicSetter_ if true anyone may setPrice/shock/reset (canonical ScenarioPool)
    /// @param initialAnswer used as anchor when reference is zero or unusable; must be > 0 in that case
    function initialize(address reference_, address operator_, bool publicSetter_, int256 initialAnswer) external;

    /// @notice Operator (or anyone if publicSetter). Bounded to [anchor*4000/1e4, anchor*16000/1e4].
    function setPrice(int256 answer) external;

    /// @notice Operator (or anyone if publicSetter). price * (1e4 + bps) / 1e4, then bounded. bps in (-1e4, +1e4).
    function shock(int256 bps) external;

    /// @notice Operator (or anyone if publicSetter). Re-reads reference as new anchor (keeps old anchor if the
    ///         reference is unusable), sets price = anchor, staleBy = 0, halted = false.
    function reset() external;

    /// @notice Operator only. Simulate a stale feed: updatedAt = block.timestamp - staleBy.
    function setStaleness(uint256 staleBy) external;

    /// @notice Operator only. Simulate a mirror halt.
    function setHalted(bool halted_) external;

    function anchor() external view returns (int256);

    function operator() external view returns (address);

    function publicSetter() external view returns (bool);

    function referenceFeed() external view returns (address);

    function staleBy() external view returns (uint256);
}
