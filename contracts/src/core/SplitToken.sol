// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ISplitToken} from "../interfaces/ISplitToken.sol";

/// @title SplitToken
/// @notice sUSD-<SYM> ($1 claim) and x<SYM> (residual claim) of one SplitStock pool. Deployed as an EIP-1167
///         clone by PoolFactory and initialized in the same transaction. 18 decimals. Only the owning pool can
///         mint or burn. No permit, no owner, no pause.
/// @dev OZ ERC20 keeps name/symbol in private storage set by its constructor, which a clone never runs, so the
///      clone stores its own copies and overrides name() and symbol().
contract SplitToken is ISplitToken, ERC20, Initializable {
    string private _tokenName;
    string private _tokenSymbol;

    /// @inheritdoc ISplitToken
    address public pool;

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    /// @dev The implementation itself can never be initialized.
    constructor() ERC20("", "") {
        _disableInitializers();
    }

    /// @inheritdoc ISplitToken
    function initialize(string calldata name_, string calldata symbol_, address pool_) external initializer {
        if (pool_ == address(0)) revert ZeroPool();
        _tokenName = name_;
        _tokenSymbol = symbol_;
        pool = pool_;
    }

    /// @inheritdoc ISplitToken
    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    /// @inheritdoc ISplitToken
    function burn(address from, uint256 amount) external onlyPool {
        _burn(from, amount);
    }

    /// @notice Token name, e.g. "SplitStock USD NVDA (MOCK)".
    function name() public view override(ERC20, IERC20Metadata) returns (string memory) {
        return _tokenName;
    }

    /// @notice Token symbol, e.g. "sUSD-NVDA".
    function symbol() public view override(ERC20, IERC20Metadata) returns (string memory) {
        return _tokenSymbol;
    }
}
