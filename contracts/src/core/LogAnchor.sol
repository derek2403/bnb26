// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ILogAnchor} from "../interfaces/ILogAnchor.sol";
import {Roles} from "../interfaces/SplitConstants.sol";

/// @title LogAnchor
/// @notice Stores Merkle roots of the hash-chained off-chain service log (CMC response bodies, keeper actions,
///         agent inputs/outputs) so judges can verify any logged entry against an on-chain commitment.
///         Ranges are contiguous and gap-free: every anchor starts at the previous anchor's toSeq + 1.
/// @dev No external calls are made, so no reentrancy guard is needed.
contract LogAnchor is AccessControl, ILogAnchor {
    /// @dev Thrown when the constructor admin is the zero address.
    error ZeroAdmin();
    /// @dev anchorAt() index past the end.
    error IndexOutOfRange(uint256 index, uint256 count);

    Anchor[] private _anchors;

    /// @inheritdoc ILogAnchor
    uint256 public nextSeq;

    /// @param admin DEFAULT_ADMIN_ROLE holder (Timelock); grants ANCHOR_ROLE to the K_ANCHOR keeper
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc ILogAnchor
    function anchor(bytes32 root, uint256 fromSeq, uint256 toSeq) external returns (uint256 index) {
        if (!hasRole(Roles.ANCHOR_ROLE, msg.sender)) revert NotAnchorer();
        if (root == bytes32(0)) revert ZeroRoot();
        uint256 expected = nextSeq;
        if (fromSeq != expected || toSeq < fromSeq) revert BadRange(expected, fromSeq, toSeq);

        index = _anchors.length;
        _anchors.push(Anchor({root: root, fromSeq: fromSeq, toSeq: toSeq, timestamp: block.timestamp}));
        nextSeq = toSeq + 1;
        emit Anchored(index, root, fromSeq, toSeq, block.timestamp);
    }

    /// @inheritdoc ILogAnchor
    function count() external view returns (uint256) {
        return _anchors.length;
    }

    /// @inheritdoc ILogAnchor
    function anchorAt(uint256 index) external view returns (Anchor memory) {
        uint256 n = _anchors.length;
        if (index >= n) revert IndexOutOfRange(index, n);
        return _anchors[index];
    }

    /// @inheritdoc ILogAnchor
    function latest() external view returns (Anchor memory a) {
        uint256 n = _anchors.length;
        if (n != 0) a = _anchors[n - 1];
    }
}
