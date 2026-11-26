// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Minimal PancakeSwap v3 pool surface. PCS v3 `slot0.feeProtocol` is uint32 (Uniswap v3 uses uint8).
interface IPancakeV3PoolLike {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint32 feeProtocol,
            bool unlocked
        );
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IERC20DecimalsLike {
    function decimals() external view returns (uint8);
}

/// @title NvdabLens (BSC mainnet, view only)
/// @notice Quotes the real PancakeSwap v3 NVDAB/USDT pool (0x8fb4243b553ac29ba088acf00b9b7da24bd6690c; token0 NVDAB
///         0x02fca66c…7436, token1 BSC-USD 0x55d398…7955, fee 2500) from `slot0` and in-range liquidity.
///         Everything is a view: no QuoterV2 (it quotes by reverting and is not a view).
/// @dev The swap estimate assumes the trade stays inside the current tick range (no tick crossing); it is an
///      upper bound on output for larger trades and is labelled as such.
contract NvdabLens {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant WAD = 1e18;

    struct Snapshot {
        uint256 priceWad; // quote (USDT) per 1 whole base (NVDAB), WAD
        uint160 sqrtPriceX96;
        int24 tick;
        uint128 liquidity;
        uint24 fee; // hundredths of a bip (2500 = 0.25%)
        uint256 virtualBase; // in-range virtual reserve of base, base units
        uint256 virtualQuote; // in-range virtual reserve of quote, quote units
        bool unlocked;
        uint256 blockNumber;
        uint256 blockTimestamp;
    }

    error ZeroAddress();
    error BaseNotInPool();
    error UnsupportedDecimals();

    address public immutable pool;
    /// @notice NVDAB
    address public immutable base;
    /// @notice USDT (BSC-USD)
    address public immutable quote;
    /// @notice true when base is token0
    bool public immutable baseIsToken0;
    uint8 public immutable baseDecimals;
    uint8 public immutable quoteDecimals;

    constructor(address pool_, address base_) {
        if (pool_ == address(0) || base_ == address(0)) revert ZeroAddress();
        address t0 = IPancakeV3PoolLike(pool_).token0();
        address t1 = IPancakeV3PoolLike(pool_).token1();
        if (base_ != t0 && base_ != t1) revert BaseNotInPool();
        pool = pool_;
        base = base_;
        baseIsToken0 = base_ == t0;
        quote = base_ == t0 ? t1 : t0;
        uint8 bd = IERC20DecimalsLike(base_).decimals();
        uint8 qd = IERC20DecimalsLike(base_ == t0 ? t1 : t0).decimals();
        if (bd > 36 || qd > 36) revert UnsupportedDecimals();
        baseDecimals = bd;
        quoteDecimals = qd;
    }

    /// @notice Spot price, USDT per NVDAB, WAD (USDT is treated as $1).
    function spotPriceWad() public view returns (uint256) {
        (uint160 sp,,,,,,) = IPancakeV3PoolLike(pool).slot0();
        return _priceWad(sp);
    }

    /// @notice One-call pool snapshot for the keeper, agent and /risk page.
    function snapshot() external view returns (Snapshot memory s) {
        IPancakeV3PoolLike p = IPancakeV3PoolLike(pool);
        (uint160 sp, int24 tick,,,,, bool unlocked) = p.slot0();
        uint128 liq = p.liquidity();
        s.priceWad = _priceWad(sp);
        s.sqrtPriceX96 = sp;
        s.tick = tick;
        s.liquidity = liq;
        s.fee = p.fee();
        s.unlocked = unlocked;
        s.blockNumber = block.number;
        s.blockTimestamp = block.timestamp;
        if (sp != 0) {
            // x = L * Q96 / sqrtP (token0), y = L * sqrtP / Q96 (token1)
            uint256 x = Math.mulDiv(uint256(liq), Q96, sp);
            uint256 y = Math.mulDiv(uint256(liq), sp, Q96);
            (s.virtualBase, s.virtualQuote) = baseIsToken0 ? (x, y) : (y, x);
        }
    }

    /// @notice In-range estimate of selling `baseIn` NVDAB for USDT (fee applied, no tick crossing).
    /// @return quoteOut USDT units out
    /// @return priceImpactBps (spot - execution) / spot, bps
    function quoteSellBase(uint256 baseIn) external view returns (uint256 quoteOut, uint256 priceImpactBps) {
        return _quote(baseIn, true);
    }

    /// @notice In-range estimate of buying NVDAB with `quoteIn` USDT (fee applied, no tick crossing).
    /// @return baseOut NVDAB units out
    /// @return priceImpactBps (execution - spot) / spot, bps
    function quoteBuyBase(uint256 quoteIn) external view returns (uint256 baseOut, uint256 priceImpactBps) {
        return _quote(quoteIn, false);
    }

    // ---------------------------------------------------------------- internals

    /// @dev price1per0 = sqrtP^2 / 2^192, in raw units; converted to WAD per whole unit of base.
    function _priceWad(uint160 sp) internal view returns (uint256) {
        if (sp == 0) return 0;
        // raw token1 per raw token0, X128 fixed point; sp^2 / 2^64 fits in 256 bits for sp < 2^160.
        uint256 pX128 = Math.mulDiv(uint256(sp), uint256(sp), 1 << 64);
        if (baseIsToken0) {
            // quote per base = p * 10^bd / 10^qd
            return Math.mulDiv(pX128, WAD * 10 ** baseDecimals, (10 ** quoteDecimals) << 128);
        }
        // base is token1: quote per base = 1/p * 10^bd / 10^qd
        if (pX128 == 0) return 0;
        return Math.mulDiv(WAD * 10 ** baseDecimals, 1 << 128, pX128) / 10 ** quoteDecimals;
    }

    function _quote(uint256 amountIn, bool sellBase) internal view returns (uint256 out, uint256 impactBps) {
        IPancakeV3PoolLike p = IPancakeV3PoolLike(pool);
        (uint160 sp,,,,,,) = p.slot0();
        uint256 liq = p.liquidity();
        if (sp == 0 || liq == 0 || amountIn == 0) return (0, 0);
        uint256 inNet = Math.mulDiv(amountIn, 1e6 - uint256(p.fee()), 1e6);
        // zeroForOne when the input token is token0
        bool zeroForOne = sellBase == baseIsToken0;
        uint256 s = uint256(sp);
        uint256 rawOut;
        if (zeroForOne) {
            // sqrtP' = L*sqrtP / (L + in*sqrtP/Q96); out1 = L*(sqrtP - sqrtP')/Q96
            uint256 denom = liq + Math.mulDiv(inNet, s, Q96);
            uint256 sNew = Math.mulDiv(liq, s, denom);
            rawOut = Math.mulDiv(liq, s - sNew, Q96);
        } else {
            // sqrtP' = sqrtP + in*Q96/L; out0 = L*Q96*(sqrtP' - sqrtP)/(sqrtP*sqrtP')
            uint256 sNew = s + Math.mulDiv(inNet, Q96, liq);
            rawOut = Math.mulDiv(Math.mulDiv(liq, Q96, s), sNew - s, sNew);
        }
        out = rawOut;
        impactBps = _impactBps(_priceWad(sp), amountIn, out, sellBase);
    }

    /// @dev |execution - spot| / spot in bps; prices are quote per base, WAD.
    function _impactBps(uint256 spot, uint256 amountIn, uint256 out, bool sellBase) internal view returns (uint256) {
        if (spot == 0 || out == 0) return 0;
        (uint256 baseAmt, uint256 quoteAmt) = sellBase ? (amountIn, out) : (out, amountIn);
        uint256 exec = Math.mulDiv(quoteAmt * 10 ** baseDecimals, WAD, baseAmt * 10 ** quoteDecimals);
        uint256 diff = exec > spot ? exec - spot : spot - exec;
        return Math.mulDiv(diff, 1e4, spot);
    }
}
