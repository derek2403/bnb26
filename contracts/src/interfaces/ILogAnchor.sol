// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Merkle roots of the hash-chained off-chain service log (CMC bodies, keeper actions, agent I/O).
interface ILogAnchor {
    struct Anchor {
        bytes32 root;
        uint256 fromSeq;
        uint256 toSeq;
        uint256 timestamp;
    }

    event Anchored(uint256 indexed index, bytes32 indexed root, uint256 fromSeq, uint256 toSeq, uint256 timestamp);

    error NotAnchorer();
    error ZeroRoot();
    error BadRange(uint256 expectedFrom, uint256 fromSeq, uint256 toSeq);

    /// @notice ANCHOR_ROLE only. Ranges are contiguous: fromSeq == nextSeq() and toSeq >= fromSeq.
    function anchor(bytes32 root, uint256 fromSeq, uint256 toSeq) external returns (uint256 index);

    /// @notice The fromSeq the next anchor must use (0 before the first anchor).
    function nextSeq() external view returns (uint256);

    function count() external view returns (uint256);

    function anchorAt(uint256 index) external view returns (Anchor memory);

    /// @notice The most recent anchor, or a zeroed struct when none exists. Never reverts.
    function latest() external view returns (Anchor memory);
}
