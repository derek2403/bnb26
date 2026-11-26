// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IMockERC20} from "../interfaces/IMockERC20.sol";
import {Roles} from "../interfaces/SplitConstants.sol";

/// @title MockERC20Permit
/// @notice Testnet stand-in for tNVDA / tTSLA / mUSDC. ERC20 + EIP-2612 permit with configurable decimals,
///         a per-address rate-limited faucet and MINTER_ROLE mint/burn (MockRouter, SandboxFactory, deploy scripts).
/// @dev Not a clone: EIP-712 immutables are set in the constructor. Names should carry "(MOCK)".
contract MockERC20Permit is ERC20, ERC20Permit, AccessControl, IMockERC20 {
    /// @dev Thrown when the constructor admin is the zero address.
    error ZeroAdmin();

    uint8 private immutable _decimals;

    /// @inheritdoc IMockERC20
    uint256 public faucetAmount;
    /// @inheritdoc IMockERC20
    uint256 public faucetCooldown;
    /// @inheritdoc IMockERC20
    mapping(address who => uint256 ts) public lastFaucetAt;

    /// @param name_ token name (also the EIP-712 domain name)
    /// @param symbol_ token symbol
    /// @param decimals_ token decimals (6 and 18 are both exercised in tests)
    /// @param admin receives DEFAULT_ADMIN_ROLE and MINTER_ROLE (deploy scripts mint initial inventory)
    /// @param faucetAmount_ amount minted per faucet() call (0 disables the faucet in effect)
    /// @param faucetCooldown_ seconds between faucet() calls per address
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address admin,
        uint256 faucetAmount_,
        uint256 faucetCooldown_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (admin == address(0)) revert ZeroAdmin();
        _decimals = decimals_;
        faucetAmount = faucetAmount_;
        faucetCooldown = faucetCooldown_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.MINTER_ROLE, admin);
        emit FaucetConfigSet(faucetAmount_, faucetCooldown_);
    }

    // ------------------------------------------------------------------ faucet

    /// @inheritdoc IMockERC20
    function faucet() external returns (uint256 amount) {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + faucetCooldown) {
            revert FaucetCooldown(last + faucetCooldown - block.timestamp);
        }
        amount = faucetAmount;
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, amount);
    }

    /// @inheritdoc IMockERC20
    function setFaucet(uint256 amount, uint256 cooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        faucetAmount = amount;
        faucetCooldown = cooldown;
        emit FaucetConfigSet(amount, cooldown);
    }

    // ------------------------------------------------------------- mint / burn

    /// @inheritdoc IMockERC20
    function mint(address to, uint256 amount) external {
        if (!hasRole(Roles.MINTER_ROLE, msg.sender)) revert NotMinter();
        _mint(to, amount);
    }

    /// @inheritdoc IMockERC20
    function burn(address from, uint256 amount) external {
        if (!hasRole(Roles.MINTER_ROLE, msg.sender)) revert NotMinter();
        _burn(from, amount);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IERC20Metadata
    function decimals() public view override(ERC20, IERC20Metadata) returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc IERC20Permit
    function nonces(address owner) public view override(ERC20Permit, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }
}
