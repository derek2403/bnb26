// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @notice tNVDA / tTSLA / mUSDC on testnet. ERC20 + EIP-2612 permit, configurable decimals,
///         capped faucet, MINTER_ROLE mint/burn. Names carry "(MOCK)".
interface IMockERC20 is IERC20Metadata, IERC20Permit {
    event FaucetConfigSet(uint256 amount, uint256 cooldown);

    error FaucetCooldown(uint256 secondsLeft);
    error NotMinter();

    /// @notice Mints faucetAmount() to msg.sender, at most once per faucetCooldown() per address.
    function faucet() external returns (uint256 amount);

    /// @notice MINTER_ROLE only.
    function mint(address to, uint256 amount) external;

    /// @notice MINTER_ROLE only. Burns without allowance (MockRouter burns its received input).
    function burn(address from, uint256 amount) external;

    /// @notice Admin only.
    function setFaucet(uint256 amount, uint256 cooldown) external;

    function faucetAmount() external view returns (uint256);

    function faucetCooldown() external view returns (uint256);

    function lastFaucetAt(address who) external view returns (uint256);
}
