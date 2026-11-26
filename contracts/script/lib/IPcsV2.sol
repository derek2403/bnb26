// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice PancakeSwap v2 router surface used by deploy scripts (liquidity seeding only).
interface IPcsV2RouterLiquidity {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IPcsV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}
