// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISplitStock (minimal, OpenFour side)
/// @notice ABI-exact subset of the SplitStock core interfaces in `contracts/src/interfaces/` (Foundry, solc 0.8.26).
///         Copied signatures only. The OpenFour kit compiles with solc 0.8.24 / viaIR and must not import the Foundry
///         tree, so this file re-declares the pieces the SplitStock Pool Launch preset calls. Struct field order and
///         enum order MUST stay identical to the originals (ABI decoding depends on it):
///           - IPoolFactory.createPool / isCreator / isAdmin / defaultParams / riskOracle / poolInfo
///           - ILeveragePool.seed / mintStable / maxMintStable / state / previewMintStable / setDonor / sUSD / xToken ...
///           - IRiskOracle.riskView (breaker inputs) and IAggregatorV3.latestRoundData (feed freshness)

interface IRiskOracle {
    enum Source {
        RULE,
        AGENT,
        FALLBACK
    }

    struct RiskParams {
        uint256 triggerLev;
        uint256 targetLev;
        uint256 lowerTriggerLev;
        uint256 maxDevBps;
        uint256 openFeeBps;
        uint256 closedFeeBps;
        uint256 gapGuardSec;
        uint256 maxSellChunkUsd;
    }

    struct RiskView {
        RiskParams params;
        Source source;
        uint256 refPrice;
        uint256 refTs;
        uint256 snapshotId;
        bool mintsPaused;
    }

    function riskView(bytes32 assetId) external view returns (RiskView memory);

    function mintsPaused(bytes32 assetId) external view returns (bool);
}

interface ILeveragePool {
    enum Mode {
        UNSEEDED,
        NORMAL,
        STABILITY,
        UNDERWATER,
        NO_PRICE
    }

    enum PoolKind {
        LIVE,
        SCENARIO,
        SANDBOX,
        DEV
    }

    struct PoolParams {
        uint256 redeemFeeBps;
        uint256 stabilityRedeemFeeBps;
        uint256 dynFeeMaxBps;
        uint256 minFeeBps;
        uint256 fundingRateBps;
        uint256 maxPriceAge;
        uint256 maxRedeemPriceAge;
        uint256 maxRefAge;
        uint256 maxSlipBps;
        uint256 spDiscountBps;
        uint256 rebalanceCooldown;
        uint256 minRebalanceUsd;
        uint256 stabilityCR;
        uint256 closedMaxLev;
        uint256 gapTargetLev;
        uint256 gapTriggerLev;
        uint256 levEpsilon;
    }

    struct PoolState {
        uint256 C;
        uint256 U;
        uint256 S;
        uint256 X;
        uint256 price;
        uint256 priceUpdatedAt;
        uint256 priceAge;
        bool priceFresh;
        bool feedHalted;
        uint256 V;
        int256 E;
        uint256 xNav;
        uint256 leverage;
        uint256 collateralRatio;
        Mode mode;
        bool marketOpen;
        bool gapGuard;
        bool mintsPaused;
        uint256 triggerLev;
        uint256 targetLev;
        uint256 lowerTriggerLev;
        uint256 maxMintLev;
        uint256 stableMintFeeBps;
        uint256 leverMintFeeBps;
        IRiskOracle.Source riskSource;
        uint256 snapshotId;
    }

    /// @notice Creator or admin, once, while X == 0 and S == 0 and C == 0 and U == 0.
    function seed(uint256 cIn, address to) external returns (uint256 xToRecipient);

    /// @notice Asset in, sUSD out = value(cIn) * (1 - stableMintFee).
    function mintStable(uint256 cIn, uint256 minOut, uint256 deadline) external returns (uint256 sOut);

    /// @notice One-call snapshot. Never reverts.
    function state() external view returns (PoolState memory);

    /// @notice Largest cIn for which mintStable passes the leverage cap. 0 when mintStable would revert.
    function maxMintStable() external view returns (uint256 cInMax);

    function previewMintStable(uint256 cIn) external view returns (uint256 sOut, uint256 feeBps);

    /// @notice Admin or this pool's creator (the launcher that opened it).
    function setDonor(address donor, bool allowed) external;

    function isDonor(address who) external view returns (bool);

    function params() external view returns (PoolParams memory);

    function asset() external view returns (address);

    function sUSD() external view returns (address);

    function xToken() external view returns (address);

    function stabilityPool() external view returns (address);

    function feed() external view returns (address);

    function creator() external view returns (address);
}

interface IPoolFactory {
    struct PoolInfo {
        address pool;
        address sUSD;
        address xToken;
        address stabilityPool;
        address asset;
        address feed;
        address router;
        bytes32 assetId;
        string symbol;
        address creator;
        ILeveragePool.PoolKind kind;
        uint256 createdAt;
    }

    /// @notice CREATOR_ROLE or DEFAULT_ADMIN_ROLE. msg.sender becomes the pool's creator (may seed it).
    function createPool(
        address asset,
        address feed,
        bytes32 assetId,
        string calldata symbol,
        address router,
        ILeveragePool.PoolKind kind
    ) external returns (address pool);

    function usdc() external view returns (address);

    function riskOracle() external view returns (address);

    function defaultParams() external view returns (ILeveragePool.PoolParams memory);

    function isPool(address pool) external view returns (bool);

    function poolInfo(address pool) external view returns (PoolInfo memory);

    function isAdmin(address who) external view returns (bool);

    function isCreator(address who) external view returns (bool);
}

/// @notice Chainlink AggregatorV3 (AtlasMirror / ScenarioFeed shape).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Optional feed extension (AtlasMirror, ScenarioFeed, MockAggregator). Read with a low-level staticcall.
interface IHaltableFeed {
    function halted() external view returns (bool);
}
