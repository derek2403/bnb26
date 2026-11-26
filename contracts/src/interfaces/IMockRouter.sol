// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV2Router02} from "./IUniswapV2Router02.sol";

/// @notice Router for ScenarioPool and sandboxes. Fills 2-hop-free swaps between a caller's asset and usdc at
///         that caller's feed price, adjusted by offsetBps and slippageBps. It burns the input and mints the
///         output (it holds MINTER_ROLE on the mock tokens), so it never touches the shared PCS pair and
///         needs no inventory. Only registered callers (pools) may quote or swap, so it cannot be used as a
///         free-mint faucet.
interface IMockRouter is IUniswapV2Router02 {
    struct CallerConfig {
        bool enabled;
        address feed; // IAggregatorV3 asset/USD
        address asset;
        address usdc;
        uint256 slippageBps; // haircut applied to every fill (default 0, max 5000)
        int256 offsetBps; // simulated pair-price offset vs feed (e.g. -100 = pair 1% below oracle), |x| < 5000
    }

    event CallerSet(address indexed caller, CallerConfig config);
    event MockSwap(address indexed caller, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address to);

    error NotAuthorized();
    error UnknownCaller(address caller);
    error BadPath();
    error Expired();
    error InsufficientOutput(uint256 out, uint256 min);
    error BadPrice();
    error BadConfig();
    error EthNotSupported();

    /// @notice Owner (DEFAULT_ADMIN_ROLE) or AUTHORIZER_ROLE.
    function setCaller(address caller, CallerConfig calldata config) external;

    /// @notice Owner or AUTHORIZER_ROLE. Tunes slippage/offset for tests and demos.
    function setFill(address caller, uint256 slippageBps, int256 offsetBps) external;

    function callerConfig(address caller) external view returns (CallerConfig memory);

    /// @notice Quote for an explicit caller (UI); getAmountsOut uses msg.sender.
    function quoteFor(address caller, uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256 amountOut);
}
