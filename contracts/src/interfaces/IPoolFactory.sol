// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILeveragePool} from "./ILeveragePool.sol";

/// @notice Opens a new SplitStock pool per launch. Holds the roles every pool checks
///         (DEFAULT_ADMIN_ROLE = Timelock, CREATOR_ROLE = registered launchers, GUARDIAN_ROLE = multisig).
///         Deploys EIP-1167 clones of LeveragePool, SplitToken (x2) and StabilityPool.
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

    event PoolCreated(
        address indexed pool,
        bytes32 indexed assetId,
        address indexed creator,
        address asset,
        address feed,
        address router,
        address sUSD,
        address xToken,
        address stabilityPool,
        string symbol,
        ILeveragePool.PoolKind kind
    );
    event DefaultParamsSet(ILeveragePool.PoolParams params);
    event ImplementationsSet(address poolImpl, address tokenImpl, address stabilityPoolImpl);

    error NotCreatorOrAdmin();
    error ZeroAddress();
    error NoCode(address target);
    error BadSymbol();
    error SameToken();
    error UnsupportedDecimals(address token, uint8 decimals);

    /// @notice CREATOR_ROLE or DEFAULT_ADMIN_ROLE. Deploys and initializes sUSD-<symbol>, x<symbol>,
    ///         StabilityPool and LeveragePool atomically; msg.sender becomes the pool's creator (may seed it
    ///         and set its donors). Token names: "SplitStock USD <symbol> (MOCK)" / "sUSD-<symbol>",
    ///         "SplitStock Lever <symbol> (MOCK)" / "x<symbol>".
    /// @param asset ERC20 stock token (tNVDA, tTSLA), decimals <= 18
    /// @param feed AggregatorV3 for asset/USD (AtlasMirror, ScenarioFeed), decimals <= 18
    /// @param assetId RiskOracle key, keccak256(bytes(symbol)) by convention
    /// @param symbol 1-10 bytes, e.g. "NVDA"
    /// @param router IUniswapV2Router02-compatible (PCS v2 or MockRouter)
    function createPool(
        address asset,
        address feed,
        bytes32 assetId,
        string calldata symbol,
        address router,
        ILeveragePool.PoolKind kind
    ) external returns (address pool);

    /// @notice Admin only. Applied to pools created afterwards.
    function setDefaultParams(ILeveragePool.PoolParams calldata p) external;

    /// @notice Admin only. Affects pools created afterwards.
    function setImplementations(address poolImpl, address tokenImpl, address stabilityPoolImpl) external;

    // views
    function usdc() external view returns (address);

    function riskOracle() external view returns (address);

    function calendar() external view returns (address);

    function poolImpl() external view returns (address);

    function tokenImpl() external view returns (address);

    function stabilityPoolImpl() external view returns (address);

    function defaultParams() external view returns (ILeveragePool.PoolParams memory);

    function isPool(address pool) external view returns (bool);

    function poolCount() external view returns (uint256);

    function poolAt(uint256 index) external view returns (address);

    function poolInfo(address pool) external view returns (PoolInfo memory);

    function poolsByAsset(bytes32 assetId) external view returns (address[] memory);

    function poolsByCreator(address creator) external view returns (address[] memory);

    /// @notice Convenience mirrors of AccessControl.hasRole for pools and UIs.
    function isAdmin(address who) external view returns (bool);

    function isGuardian(address who) external view returns (bool);

    function isCreator(address who) external view returns (bool);
}
