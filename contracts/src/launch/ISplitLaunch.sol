// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev FlapDirectTaxToken implementation the Portal clones: a launch token is CREATE2(impl, salt, Portal).
address constant FLAP_TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;

/// @notice Pool-opening configuration a SplitLauncher opens its SplitStock pool with (and its BackstopVault reads).
///         Held by `SplitStockConfig`, which is immutable: it is fixed per factory pair (no admin, no setter), so a
///         SplitStock core redeploy needs a new config + factory pair. Each Launcher copies it at `initialize()` and
///         never reads the config again.
///
///         FROZEN CORE ABI. The Launcher and BackstopVault implementations are part of the enabled factories'
///         bytecode, so the core calls they make are frozen: `IPoolFactory.createPool(address,address,bytes32,string,
///         address,uint8)` with PoolKind.LIVE == 0, `IPoolFactory.usdc()`, `poolImpl()`, `tokenImpl()`,
///         `stabilityPoolImpl()`, `ILeveragePool.seed(uint256,address)`,
///         `setDonor(address,bool)`, `isDonor(address)`, `xToken()`, `donate(uint256,uint256)` and the field order of
///         `ILeveragePool.PoolState` returned by `state()`. `test/launch/CoreAbiPin.t.sol` pins them; a core change
///         that breaks that test needs a new factory pair (and a new Flap enable request).
/// @param poolFactory  SplitStock PoolFactory. Every Launcher must hold its CREATOR_ROLE before `openPool()`.
/// @param asset        Stock token the new pool holds (tNVDA).
/// @param feed         asset/USD AggregatorV3 the new pool prices with (the NVDA AtlasMirror).
/// @param assetId      RiskOracle key, keccak256("NVDA").
/// @param poolRouter   Router the new pool rebalances through (PancakeSwap v2 testnet router).
/// @param swapRouter   PancakeSwap v2 router used by `openPool` (tBNB -> tNVDA) and `BackstopVault.cover` (tBNB -> mUSDC).
/// @param atlasBnbUsd  Atlas BNB/USD feed on BSC testnet (0x3957d289ee9c38272377786787ea34f9dd29788d).
/// @param scenarioPool The canonical demo ScenarioPool the vault may also cover from a capped tranche (0 = none).
/// @param boostToken   sUSD token accepted by `contributeBoosted()` escrow (0 = boost disabled).
struct SplitPoolConfig {
    address poolFactory;
    address asset;
    address feed;
    bytes32 assetId;
    address poolRouter;
    address swapRouter;
    address atlasBnbUsd;
    address scenarioPool;
    address boostToken;
}

/// @notice What Launchers, vaults and scripts read from their SplitLauncherFactory. `poolConfig()` / `poolSymbol()`
///         are the factory pair's fixed config (what every Launcher copies); an existing Launcher's own values are on
///         the Launcher (`ISplitLauncherView.poolConfig()`).
interface ISplitLauncherFactory {
    function hub() external view returns (address);
    function guardian() external view returns (address);
    function pairedVaultFactory() external view returns (address);
    function config() external view returns (address);
    function poolConfig() external view returns (SplitPoolConfig memory);
    function poolSymbol() external view returns (string memory);
}

/// @notice The read surface of `SplitStockConfig` the factory uses (immutable: `isConfigured()` is always true and
///         `version()` always 1).
interface ISplitStockConfig {
    function current() external view returns (SplitPoolConfig memory cfg, string memory poolSymbol, bool configured);
    function poolConfig() external view returns (SplitPoolConfig memory);
    function poolSymbol() external view returns (string memory);
    function isConfigured() external view returns (bool);
    function version() external view returns (uint256);
    function implementations() external view returns (address poolImpl, address tokenImpl, address stabilityPoolImpl);
}

/// @notice The slice of SplitLauncher that the vault factory and BackstopVault read.
interface ISplitLauncherView {
    function factory() external view returns (address);
    function creator() external view returns (address);
    function token() external view returns (address);
    function pool() external view returns (address);
    function launching() external view returns (bool);
    function launched() external view returns (bool);
    function raised() external view returns (uint256);
    function targetRaise() external view returns (uint256);
    /// @dev The Launcher's own snapshot, taken at `initialize()`.
    function poolConfig() external view returns (SplitPoolConfig memory);
}

/// @notice The slice of BackstopVault that the Launcher reads for display.
interface IBackstopVaultView {
    function bufferUsd() external view returns (uint256);
}

/// @notice Portal reads that are NOT in the copied `src/flap/IPortal.sol` subset. Kept outside `src/flap/` so that
///         directory stays byte-for-byte upstream. The return shape of `launchQuoteConfig` is not documented: we
///         read it with a low-level staticcall and take the first two words as (enabled, quotePriceUsd WAD).
interface IPortalQuoteLens {
    function launchQuoteConfig(uint8 kind, address quoteToken) external view returns (bool enabled, uint256 quotePriceUsd);
}

/// @notice PancakeSwap v2 factory surface (pair lookup only).
interface IUniswapV2FactoryLike {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}
