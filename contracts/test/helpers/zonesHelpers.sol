// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Settable RiskOracle stand-in (SPEC.md §13.2: "a risk stub with fees 0"). Only riskView is read by pools.
contract ZonesRiskStub {
    IRiskOracle.RiskView internal _v;

    function set(IRiskOracle.RiskView memory v) external {
        _v = v;
    }

    function setChunk(uint256 usd) external {
        _v.params.maxSellChunkUsd = usd;
    }

    function setRef(uint256 p, uint256 ts) external {
        _v.refPrice = p;
        _v.refTs = ts;
    }

    function riskView(bytes32) external view returns (IRiskOracle.RiskView memory) {
        return _v;
    }
}

/// @notice Minimal PancakeSwap-v2-style constant-product pair (25 bps fee, K check on balances).
contract ZonesV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;

    constructor(address a, address b) {
        (token0, token1) = (a, b);
    }

    function sync() external {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to) external {
        require(amount0Out > 0 || amount1Out > 0, "V2: INSUFFICIENT_OUTPUT");
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        require(amount0Out < r0 && amount1Out < r1, "V2: INSUFFICIENT_LIQUIDITY");
        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "V2: INSUFFICIENT_INPUT");
        uint256 b0a = b0 * 10000 - in0 * 25;
        uint256 b1a = b1 * 10000 - in1 * 25;
        require(b0a * b1a >= r0 * r1 * 1e8, "V2: K");
        (reserve0, reserve1) = (b0, b1);
    }
}

/// @notice Router for one ZonesV2Pair with the PancakeSwap v2 getAmountOut formula.
contract ZonesV2Router {
    ZonesV2Pair public immutable pair;

    constructor(ZonesV2Pair p) {
        pair = p;
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function WETH() external pure returns (address) {
        return address(0);
    }

    function _reserves(address tin, address tout) internal view returns (uint256 rIn, uint256 rOut) {
        if (tin == pair.token0() && tout == pair.token1()) return (pair.reserve0(), pair.reserve1());
        if (tin == pair.token1() && tout == pair.token0()) return (pair.reserve1(), pair.reserve0());
        revert("V2: BAD_PATH");
    }

    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        uint256 inFee = amountIn * 9975;
        return inFee * rOut / (rIn * 10000 + inFee);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        require(path.length == 2, "V2: BAD_PATH");
        (uint256 rIn, uint256 rOut) = _reserves(path[0], path[1]);
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = getAmountOut(amountIn, rIn, rOut);
    }

    function getAmountsIn(uint256, address[] calldata) external pure returns (uint256[] memory) {
        revert("unused");
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory a)
    {
        require(deadline >= block.timestamp, "V2: EXPIRED");
        require(path.length == 2, "V2: BAD_PATH");
        (uint256 rIn, uint256 rOut) = _reserves(path[0], path[1]);
        uint256 out = getAmountOut(amountIn, rIn, rOut);
        require(out >= minOut, "V2: INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[0]).transferFrom(msg.sender, address(pair), amountIn);
        if (path[0] == pair.token0()) pair.swap(0, out, to);
        else pair.swap(out, 0, to);
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = out;
    }

    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external
        payable
        returns (uint256[] memory)
    {
        revert("unused");
    }
}

/// @notice Router that quotes honestly at the feed price but can misbehave on settlement, to test that the pool
///         accounts by balance delta (SPEC.md §2.5 DEX route) and not by the router's return values.
contract ZonesEvilRouter {
    enum Mode {
        HONEST,
        SHORT_OUT, // delivers `extra` less than quoted, still returns the quote
        SHORT_PULL, // pulls 1 unit less than amountIn
        EXTRA_OUT, // delivers `extra` more than quoted, returns the quote
        UNDER_MIN // delivers amountOutMin - 1, returns the quote
    }

    address public immutable asset;
    address public immutable usdc;
    IAggregatorV3 public immutable feed;
    uint256 public immutable aU;
    uint256 public immutable uS;
    uint256 public immutable fS;
    Mode public mode;
    uint256 public extra;
    uint256 public lastAmountOutMin;

    constructor(address asset_, address usdc_, address feed_, uint8 aDec, uint8 uDec, uint8 fDec) {
        (asset, usdc, feed) = (asset_, usdc_, IAggregatorV3(feed_));
        aU = 10 ** aDec;
        uS = 10 ** (18 - uDec);
        fS = 10 ** (18 - fDec);
    }

    function setMode(Mode m, uint256 extra_) external {
        mode = m;
        extra = extra_;
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function WETH() external pure returns (address) {
        return address(0);
    }

    function _out(uint256 amountIn, address tin) internal view returns (uint256) {
        (, int256 ans,,,) = feed.latestRoundData();
        uint256 p = uint256(ans) * fS;
        if (tin == asset) return Math.mulDiv(amountIn, p, aU) / uS;
        return Math.mulDiv(amountIn * uS, aU, p);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = _out(amountIn, path[0]);
    }

    function getAmountsIn(uint256, address[] calldata) external pure returns (uint256[] memory) {
        revert("unused");
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256)
        external
        returns (uint256[] memory a)
    {
        lastAmountOutMin = minOut;
        uint256 q = _out(amountIn, path[0]);
        uint256 pull = mode == Mode.SHORT_PULL ? amountIn - 1 : amountIn;
        uint256 give = q;
        if (mode == Mode.SHORT_OUT) give = q - extra;
        else if (mode == Mode.EXTRA_OUT) give = q + extra;
        else if (mode == Mode.UNDER_MIN) give = minOut - 1;
        IERC20(path[0]).transferFrom(msg.sender, address(this), pull);
        IERC20(path[1]).transfer(to, give);
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = q;
    }

    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external
        payable
        returns (uint256[] memory)
    {
        revert("unused");
    }
}
