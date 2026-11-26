// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IMockERC20} from "../interfaces/IMockERC20.sol";
import {IMockRouter} from "../interfaces/IMockRouter.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {SplitConstants, Roles} from "../interfaces/SplitConstants.sol";

/// @title MockRouter
/// @notice IUniswapV2Router02-compatible router for ScenarioPool and sandboxes. Fills asset<->usdc swaps at the
///         calling pool's feed price adjusted by a configurable pair offset and slippage haircut. It burns the
///         input and mints the output (needs MINTER_ROLE on both mock tokens), so it never touches the shared
///         PancakeSwap pair and needs no inventory. Only registered callers may quote or swap.
/// @dev Price normalisation matches the pool: P = answer * 10**(18 - feedDecimals) (WAD USD per whole asset
///      unit); mUSDC is valued at $1. Staleness is deliberately ignored (the pool enforces it).
contract MockRouter is AccessControl, ReentrancyGuard, IMockRouter {
    using SafeERC20 for IERC20;

    /// @dev Thrown when the constructor admin is the zero address.
    error ZeroAdmin();

    uint256 private constant BPS = SplitConstants.BPS;
    uint256 private constant MAX_SLIPPAGE_BPS = 5000;
    int256 private constant MAX_ABS_OFFSET_BPS = 5000; // exclusive

    /// @dev Scale factors cached at setCaller (token / feed decimals are immutable for the mocks).
    struct Scales {
        uint256 aU; // 10**assetDecimals
        uint256 uS; // 10**(18 - usdcDecimals)
        uint256 fS; // 10**(18 - feedDecimals)
    }

    mapping(address caller => CallerConfig) private _configs;
    mapping(address caller => Scales) private _scales;

    /// @param admin DEFAULT_ADMIN_ROLE holder (deployer, later Timelock); grants AUTHORIZER_ROLE to SandboxFactory
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyAuthorized() {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(Roles.AUTHORIZER_ROLE, msg.sender)) {
            revert NotAuthorized();
        }
        _;
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IMockRouter
    /// @dev A disabled config (enabled == false) is accepted without validation to deregister a caller.
    function setCaller(address caller, CallerConfig calldata config) external onlyAuthorized {
        if (caller == address(0)) revert BadConfig();
        if (config.enabled) {
            if (config.feed == address(0) || config.asset == address(0) || config.usdc == address(0)) {
                revert BadConfig();
            }
            if (config.asset == config.usdc) revert BadConfig();
            _checkFill(config.slippageBps, config.offsetBps);
            _scales[caller] = Scales({
                aU: 10 ** _decimalsOf(config.asset),
                uS: 10 ** (18 - _decimalsOf(config.usdc)),
                fS: 10 ** (18 - _decimalsOf(config.feed))
            });
        }
        _configs[caller] = config;
        emit CallerSet(caller, config);
    }

    /// @inheritdoc IMockRouter
    function setFill(address caller, uint256 slippageBps, int256 offsetBps) external onlyAuthorized {
        CallerConfig storage c = _configs[caller];
        if (!c.enabled) revert UnknownCaller(caller);
        _checkFill(slippageBps, offsetBps);
        c.slippageBps = slippageBps;
        c.offsetBps = offsetBps;
        emit CallerSet(caller, c);
    }

    // ------------------------------------------------------------------ swaps

    /// @inheritdoc IUniswapV2Router02
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        if (deadline < block.timestamp) revert Expired();
        uint256 out = _quoteOut(msg.sender, amountIn, path);
        if (out < amountOutMin) revert InsufficientOutput(out, amountOutMin);

        address tokenIn = path[0];
        // Pull then burn the input; mint the output. No router state changes, so CEI is trivially satisfied.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IMockERC20(tokenIn).burn(address(this), amountIn);
        IMockERC20(path[1]).mint(to, out);

        emit MockSwap(msg.sender, tokenIn, amountIn, out, to);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }

    /// @inheritdoc IUniswapV2Router02
    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external
        payable
        returns (uint256[] memory)
    {
        revert EthNotSupported();
    }

    // ------------------------------------------------------------------ quotes

    /// @inheritdoc IUniswapV2Router02
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _quoteOut(msg.sender, amountIn, path);
    }

    /// @inheritdoc IUniswapV2Router02
    /// @dev Inverse of getAmountsOut, every step rounded up, so getAmountsOut(amounts[0]) >= amountOut.
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        (CallerConfig storage c, Scales storage sc, bool assetToUsdc, uint256 pEff) = _load(msg.sender, path);
        uint256 keep = BPS - c.slippageBps;
        uint256 amountIn;
        if (assetToUsdc) {
            uint256 v = Math.mulDiv(amountOut * sc.uS, BPS, keep, Math.Rounding.Ceil);
            amountIn = Math.mulDiv(v, sc.aU, pEff, Math.Rounding.Ceil);
        } else {
            uint256 v = Math.mulDiv(amountOut, pEff, sc.aU, Math.Rounding.Ceil);
            uint256 w = Math.mulDiv(v, BPS, keep, Math.Rounding.Ceil);
            amountIn = Math.ceilDiv(w, sc.uS);
        }
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    /// @inheritdoc IMockRouter
    function quoteFor(address caller, uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256 amountOut)
    {
        return _quoteOut(caller, amountIn, path);
    }

    /// @inheritdoc IMockRouter
    function callerConfig(address caller) external view returns (CallerConfig memory) {
        return _configs[caller];
    }

    /// @inheritdoc IUniswapV2Router02
    function factory() external view returns (address) {
        return address(this);
    }

    /// @inheritdoc IUniswapV2Router02
    function WETH() external pure returns (address) {
        return address(0);
    }

    // --------------------------------------------------------------- internal

    function _quoteOut(address caller, uint256 amountIn, address[] calldata path) internal view returns (uint256) {
        (CallerConfig storage c, Scales storage sc, bool assetToUsdc, uint256 pEff) = _load(caller, path);
        uint256 keep = BPS - c.slippageBps;
        if (assetToUsdc) {
            uint256 usd = Math.mulDiv(amountIn, pEff, sc.aU, Math.Rounding.Floor);
            return Math.mulDiv(usd, keep, BPS, Math.Rounding.Floor) / sc.uS;
        }
        uint256 usdNet = Math.mulDiv(amountIn * sc.uS, keep, BPS, Math.Rounding.Floor);
        return Math.mulDiv(usdNet, sc.aU, pEff, Math.Rounding.Floor);
    }

    /// @dev Loads the caller config, validates the path and returns the offset-adjusted WAD price.
    function _load(address caller, address[] calldata path)
        internal
        view
        returns (CallerConfig storage c, Scales storage sc, bool assetToUsdc, uint256 pEff)
    {
        c = _configs[caller];
        if (!c.enabled) revert UnknownCaller(caller);
        sc = _scales[caller];
        if (path.length != 2) revert BadPath();
        if (path[0] == c.asset && path[1] == c.usdc) assetToUsdc = true;
        else if (!(path[0] == c.usdc && path[1] == c.asset)) revert BadPath();

        (bool ok, bytes memory ret) = c.feed.staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!ok || ret.length < 160) revert BadPrice();
        (, int256 answer,,,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        if (answer <= 0) revert BadPrice();
        uint256 p = uint256(answer) * sc.fS;
        // |offsetBps| < 5000, so BPS + offset is in (5000, 15000).
        pEff = Math.mulDiv(p, uint256(int256(BPS) + c.offsetBps), BPS, Math.Rounding.Floor);
        if (pEff == 0) revert BadPrice();
    }

    function _checkFill(uint256 slippageBps, int256 offsetBps) private pure {
        if (slippageBps > MAX_SLIPPAGE_BPS) revert BadConfig();
        if (offsetBps >= MAX_ABS_OFFSET_BPS || offsetBps <= -MAX_ABS_OFFSET_BPS) revert BadConfig();
    }

    /// @dev Reads decimals() and requires <= 18; reverts BadConfig otherwise.
    function _decimalsOf(address token) private view returns (uint256 d) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!ok || ret.length < 32) revert BadConfig();
        d = abi.decode(ret, (uint256));
        if (d > 18) revert BadConfig();
    }
}
