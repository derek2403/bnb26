// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SplitPoolConfig} from "src/launch/ISplitLaunch.sol";

/// @dev The PoolFactory reads the config validates with (kept local so this contract has no core import).
interface IPoolFactoryConfigLens {
    function usdc() external view returns (address);
    function isPool(address pool) external view returns (bool);
    function poolImpl() external view returns (address);
    function tokenImpl() external view returns (address);
    function stabilityPoolImpl() external view returns (address);
}

/// @title SplitStockConfig
/// @notice The SplitStock pool target (PoolFactory, stock token, feeds, routers, ScenarioPool, boost token) that every
///         Launcher of ONE factory pair opens its pool with. `SplitLauncherFactory` keeps an immutable pointer to this
///         contract, and this contract is itself fully immutable:
///           - the config and pool symbol are set once in the constructor (validated there) and stored as immutables;
///           - there is NO admin, NO setter, NO pending/queued change and NO Guardian power here: nobody, including
///             the team and the Flap Guardian, can change where a Launcher's seed or a vault's buffer goes;
///           - it pins the PoolFactory's three clone implementations (LeveragePool, SplitToken, StabilityPool) as
///             they are at deployment. `PoolFactory.setImplementations` is a core-admin function, so `openPool`
///             refuses to run if they have changed: the core admin cannot swap in a pool implementation that takes
///             the seed. The Launcher then falls back to `releaseSeed` (seed to the BackstopVault after 14 days);
///           - it holds no funds, has no payable function and makes no external call except the view checks in
///             the constructor.
///         Changing the SplitStock core therefore means deploying a NEW config + factory pair (and a new Flap enable
///         request). Each Launcher still snapshots the config at `initialize()`, so its pool target is on the Launcher.
contract SplitStockConfig {
    address internal immutable _poolFactory;
    address internal immutable _asset;
    address internal immutable _feed;
    bytes32 internal immutable _assetId;
    address internal immutable _poolRouter;
    address internal immutable _swapRouter;
    address internal immutable _atlasBnbUsd;
    address internal immutable _scenarioPool;
    address internal immutable _boostToken;
    /// @dev PoolFactory clone implementations at deployment (see `implementations()`).
    address internal immutable _poolImpl;
    address internal immutable _tokenImpl;
    address internal immutable _stabilityPoolImpl;
    /// @dev The pool symbol (1..10 bytes), left-aligned in one word, and its length.
    bytes32 internal immutable _symbolWord;
    uint256 internal immutable _symbolLength;

    /// @notice Always 1: the only config this contract will ever hold.
    uint256 public constant version = 1;
    uint256 public constant MAX_SYMBOL_BYTES = 10;

    /// @notice Emitted once, at deployment.
    event ConfigFixed(SplitPoolConfig cfg, string poolSymbol);

    error ZeroAddress();
    error NoCode(address target);
    error EmptyAssetId();
    error BadSymbol();
    error NoPoolFactoryUsdc();
    error NotAPool(address pool);
    error NoPoolFactoryImplementations();

    constructor(SplitPoolConfig memory cfg, string memory poolSymbol_) {
        _validate(cfg, poolSymbol_);
        _poolFactory = cfg.poolFactory;
        _asset = cfg.asset;
        _feed = cfg.feed;
        _assetId = cfg.assetId;
        _poolRouter = cfg.poolRouter;
        _swapRouter = cfg.swapRouter;
        _atlasBnbUsd = cfg.atlasBnbUsd;
        _scenarioPool = cfg.scenarioPool;
        _boostToken = cfg.boostToken;
        (_poolImpl, _tokenImpl, _stabilityPoolImpl) = _readImplementations(cfg.poolFactory);
        // Safe: `_validate` capped the symbol at MAX_SYMBOL_BYTES (10) < 32, so nothing is truncated.
        // forge-lint: disable-next-line(unsafe-typecast)
        _symbolWord = bytes32(bytes(poolSymbol_));
        _symbolLength = bytes(poolSymbol_).length;
        emit ConfigFixed(cfg, poolSymbol_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views (the surface SplitLauncherFactory reads)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Always true: the config is set at deployment and can never be unset or changed.
    function isConfigured() external pure returns (bool) {
        return true;
    }

    function poolConfig() public view returns (SplitPoolConfig memory cfg) {
        cfg = SplitPoolConfig({
            poolFactory: _poolFactory,
            asset: _asset,
            feed: _feed,
            assetId: _assetId,
            poolRouter: _poolRouter,
            swapRouter: _swapRouter,
            atlasBnbUsd: _atlasBnbUsd,
            scenarioPool: _scenarioPool,
            boostToken: _boostToken
        });
    }

    function poolSymbol() public view returns (string memory s) {
        uint256 len = _symbolLength;
        bytes32 word = _symbolWord;
        s = new string(len);
        assembly ("memory-safe") {
            mstore(add(s, 0x20), word)
        }
    }

    /// @notice The PoolFactory clone implementations pinned at deployment. `SplitLauncher.openPool` requires the
    ///         PoolFactory to still report exactly these, so a later `PoolFactory.setImplementations` (core admin)
    ///         cannot change the code that receives a Launcher's seed.
    function implementations() external view returns (address poolImpl, address tokenImpl, address stabilityPoolImpl) {
        return (_poolImpl, _tokenImpl, _stabilityPoolImpl);
    }

    /// @notice The config and symbol every Launcher of this factory pair copies (`configured` is always true).
    function current() external view returns (SplitPoolConfig memory cfg, string memory poolSymbol_, bool configured) {
        return (poolConfig(), poolSymbol(), true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Every core address must be a contract, the PoolFactory must report a USDC contract (BackstopVault reads
    ///      it at launch, and a zero there would revert every final contribution), and a ScenarioPool, when set, must
    ///      be a pool of that PoolFactory. `boostToken` may be zero (boost off) but must be a contract when set.
    function _validate(SplitPoolConfig memory cfg, string memory poolSymbol_) internal view {
        _requireCode(cfg.poolFactory);
        _requireCode(cfg.asset);
        _requireCode(cfg.feed);
        _requireCode(cfg.poolRouter);
        _requireCode(cfg.swapRouter);
        _requireCode(cfg.atlasBnbUsd);
        if (cfg.boostToken != address(0)) _requireCode(cfg.boostToken);
        if (cfg.assetId == bytes32(0)) revert EmptyAssetId();
        uint256 sl = bytes(poolSymbol_).length;
        if (sl == 0 || sl > MAX_SYMBOL_BYTES) revert BadSymbol();

        address usdc;
        try IPoolFactoryConfigLens(cfg.poolFactory).usdc() returns (address u) {
            usdc = u;
        } catch {}
        if (usdc == address(0) || usdc.code.length == 0) revert NoPoolFactoryUsdc();

        if (cfg.scenarioPool != address(0)) {
            bool isPool;
            try IPoolFactoryConfigLens(cfg.poolFactory).isPool(cfg.scenarioPool) returns (bool p) {
                isPool = p;
            } catch {}
            if (!isPool) revert NotAPool(cfg.scenarioPool);
        }
    }

    function _readImplementations(address poolFactory) internal view returns (address p, address t, address sp) {
        IPoolFactoryConfigLens f = IPoolFactoryConfigLens(poolFactory);
        try f.poolImpl() returns (address a) {
            p = a;
        } catch {}
        try f.tokenImpl() returns (address a) {
            t = a;
        } catch {}
        try f.stabilityPoolImpl() returns (address a) {
            sp = a;
        } catch {}
        if (p.code.length == 0 || t.code.length == 0 || sp.code.length == 0) revert NoPoolFactoryImplementations();
    }

    function _requireCode(address a) internal view {
        if (a == address(0)) revert ZeroAddress();
        if (a.code.length == 0) revert NoCode(a);
    }
}
