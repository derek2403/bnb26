// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISplitPoolLaunch
/// @notice Read interfaces shared by the "SplitStock Pool Launch" preset modules (migrate <-> customData), and the
///         minimal PancakeSwap V2 surface the migrate module touches. Demo-only, unaudited
///         (derived from the openfour-docs FairLaunch starter).

/// @notice Branch ids used by `SplitPoolMigrateModule` (also its `migratedDataVersion`).
library SplitPoolBranch {
    uint8 internal constant NONE = 0;
    /// @dev New SplitStock pool opened; LP = meme/sUSD. encodedMigratedData = abi.encode(pair, sUSD, pool).
    uint8 internal constant POOL = 1;
    /// @dev Pool path failed or was skipped; LP = meme/stock. encodedMigratedData = abi.encode(pair, stock).
    uint8 internal constant FALLBACK = 2;
}

/// @notice Outcome of one graduation, stored by the migrate module and snapshotted by the customData module.
struct SplitPoolGraduation {
    uint8 branch; // SplitPoolBranch
    address pair; // PCS v2 pair that received the LP (LP minted to 0xdead)
    address pool; // new LeveragePool (0 on fallback)
    address sUSD; // pool's sUSD-<SYM> (0 on fallback)
    address xToken; // pool's x<SYM> (0 on fallback)
    address stabilityPool; // pool's StabilityPool (0 on fallback)
    uint256 quoteUsed; // stock units pulled from the vault
    uint256 tokenUsed; // meme units sent to the pair
    uint256 seedAmount; // stock units into pool.seed (first-loss, x to the BackstopTreasury)
    uint256 mintAmount; // stock units into pool.mintStable
    uint256 sUSDMinted; // sUSD paired with the meme
    uint256 xToTreasury; // x<SYM> minted to the BackstopTreasury by seed
    uint256 leftoverToTreasury; // stock units above the mintStable cap, sent to the BackstopTreasury
    uint256 liquidity; // LP minted to 0xdead
    uint256 price; // WAD USD per whole stock unit at graduation (pool.state().price); 0 on fallback if unread
    uint256 timestamp;
}

/// @notice Health + timing view shared by evaluate() and previewGraduation().
struct SplitPoolPreview {
    bool initialized;
    bool migrated;
    bool conditionsMet; // sold out || soft cap || expired
    bool healthy; // pool path expected to succeed (feed fresh, not halted, mints not paused, breaker ok, CREATOR_ROLE)
    bool forced; // grace window elapsed: migrate even if unhealthy (fallback branch)
    bool canMigrate;
    bool hasCreatorRole;
    bool feedFresh;
    bool mintsPaused;
    bool breakerOk;
    uint256 conditionsMetAt; // grace anchor (customData, or endTime once expired)
    uint256 forceAt; // conditionsMetAt + graceWindow (0 while no anchor)
    uint256 endTime;
    uint256 totalRaised;
    uint256 quoteToUse;
    uint256 seedAmount;
    uint256 mintAmount;
    uint256 price; // WAD
    uint256 priceAge;
    uint256 mintValueUsd; // WAD gross value of mintAmount at `price`
    uint256 minSusdOut; // mintValueUsd * minSusdOutBps / 1e4
    string reason;
}

/// @notice Implemented by `SplitPoolMigrateModule`.
interface ISplitPoolMigrateView {
    function conditionsMet(uint256 totalRaised, bool soldOut, uint256 timestamp) external view returns (bool);

    function lastGraduation() external view returns (SplitPoolGraduation memory);

    function previewGraduation(address token) external view returns (SplitPoolPreview memory);
}

/// @notice Implemented by `SplitPoolCustomDataModule`.
interface ISplitPoolDataView {
    function conditionsMetAt() external view returns (uint256);
}

interface IPancakeV2RouterLike {
    function factory() external view returns (address);
}

interface IPancakeV2FactoryLike2 {
    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IPancakeV2PairLike2 {
    function totalSupply() external view returns (uint256);

    function mint(address to) external returns (uint256 liquidity);

    function skim(address to) external;
}
