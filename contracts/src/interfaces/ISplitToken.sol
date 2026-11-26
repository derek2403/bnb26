// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice sUSD-<SYM> and x<SYM>. One pair per pool, deployed as EIP-1167 clones by PoolFactory.
///         18 decimals. Only the owning pool can mint or burn. No permit (EIP-712 immutables break under clones).
interface ISplitToken is IERC20Metadata {
    error OnlyPool();
    error ZeroPool();

    /// @notice One-shot initializer (clone). Called by PoolFactory in the same tx as the clone.
    function initialize(string calldata name_, string calldata symbol_, address pool_) external;

    /// @notice The pool that may mint/burn. Set once in initialize, never changes.
    function pool() external view returns (address);

    /// @notice Pool only.
    function mint(address to, uint256 amount) external;

    /// @notice Pool only. Burns without allowance. The pool only ever burns from msg.sender of a redeem or
    ///         from its own StabilityPool during an offset.
    function burn(address from, uint256 amount) external;
}
