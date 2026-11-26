// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {IPoolFactory} from "../interfaces/IPoolFactory.sol";
import {ILeveragePool} from "../interfaces/ILeveragePool.sol";
import {ISplitToken} from "../interfaces/ISplitToken.sol";
import {IStabilityPool} from "../interfaces/IStabilityPool.sol";
import {Roles} from "../interfaces/SplitConstants.sol";
import {PoolMath} from "./PoolMath.sol";

/// @title PoolFactory
/// @notice Opens one SplitStock pool per launch: EIP-1167 clones of SplitToken (sUSD-<SYM>, x<SYM>),
///         StabilityPool and LeveragePool, initialized atomically. Holds the roles every pool checks:
///         DEFAULT_ADMIN_ROLE (Timelock), CREATOR_ROLE (registered launchers, the OpenFour module, SandboxFactory)
///         and GUARDIAN_ROLE (multisig). Holds no funds. Pools are never removed.
contract PoolFactory is IPoolFactory, AccessControl {
    error ZeroAssetId();

    /// @inheritdoc IPoolFactory
    address public immutable usdc;
    /// @inheritdoc IPoolFactory
    address public immutable riskOracle;
    /// @inheritdoc IPoolFactory
    address public immutable calendar;

    /// @inheritdoc IPoolFactory
    address public poolImpl;
    /// @inheritdoc IPoolFactory
    address public tokenImpl;
    /// @inheritdoc IPoolFactory
    address public stabilityPoolImpl;

    ILeveragePool.PoolParams internal _defaults;

    address[] internal _pools;
    mapping(address => PoolInfo) internal _info;
    mapping(bytes32 => address[]) internal _byAsset;
    mapping(address => address[]) internal _byCreator;

    /// @param admin DEFAULT_ADMIN_ROLE holder (deployer first, then the Timelock)
    /// @param usdc_ mUSDC (decimals <= 18), valued at exactly $1
    /// @param riskOracle_ shared RiskOracle (keyed by assetId)
    /// @param calendar_ shared MarketCalendar
    /// @param poolImpl_ LeveragePool implementation
    /// @param tokenImpl_ SplitToken implementation
    /// @param stabilityPoolImpl_ StabilityPool implementation
    /// @param defaults PoolParams applied to new pools (validated against SPEC.md §2.6 bounds)
    constructor(
        address admin,
        address usdc_,
        address riskOracle_,
        address calendar_,
        address poolImpl_,
        address tokenImpl_,
        address stabilityPoolImpl_,
        ILeveragePool.PoolParams memory defaults
    ) {
        if (admin == address(0)) revert ZeroAddress();
        _requireCode(usdc_);
        _requireCode(riskOracle_);
        _requireCode(calendar_);
        _checkDecimals(usdc_);
        if (!PoolMath.paramsValid(defaults)) revert ILeveragePool.InvalidParams();

        usdc = usdc_;
        riskOracle = riskOracle_;
        calendar = calendar_;
        _setImplementations(poolImpl_, tokenImpl_, stabilityPoolImpl_);
        _defaults = defaults;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit DefaultParamsSet(defaults);
    }

    // ------------------------------------------------------------------ pool creation

    /// @inheritdoc IPoolFactory
    function createPool(
        address asset,
        address feed,
        bytes32 assetId,
        string calldata symbol,
        address router,
        ILeveragePool.PoolKind kind
    ) external returns (address pool) {
        if (!hasRole(Roles.CREATOR_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotCreatorOrAdmin();
        }
        _requireCode(asset);
        _requireCode(feed);
        _requireCode(router);
        if (asset == usdc) revert SameToken();
        uint256 len = bytes(symbol).length;
        if (len == 0 || len > 10) revert BadSymbol();
        if (assetId == bytes32(0)) revert ZeroAssetId();
        _checkDecimals(asset);
        _checkDecimals(feed);

        PoolInfo memory info;
        info.asset = asset;
        info.feed = feed;
        info.router = router;
        info.assetId = assetId;
        info.symbol = symbol;
        info.creator = msg.sender;
        info.kind = kind;
        info.createdAt = block.timestamp;
        _deploy(info);
        pool = info.pool;

        _pools.push(pool);
        _info[pool] = info;
        _byAsset[assetId].push(pool);
        _byCreator[msg.sender].push(pool);

        _emitCreated(info);
    }

    function _emitCreated(PoolInfo memory i) internal {
        emit PoolCreated(
            i.pool, i.assetId, i.creator, i.asset, i.feed, i.router, i.sUSD, i.xToken, i.stabilityPool, i.symbol, i.kind
        );
    }

    /// @dev Clones and initializes the four contracts of one pool; fills the addresses into `info`.
    function _deploy(PoolInfo memory info) internal {
        info.sUSD = Clones.clone(tokenImpl);
        info.xToken = Clones.clone(tokenImpl);
        info.stabilityPool = Clones.clone(stabilityPoolImpl);
        info.pool = Clones.clone(poolImpl);

        ISplitToken(info.sUSD).initialize(
            string.concat("SplitStock USD ", info.symbol, " (MOCK)"), string.concat("sUSD-", info.symbol), info.pool
        );
        ISplitToken(info.xToken).initialize(
            string.concat("SplitStock Lever ", info.symbol, " (MOCK)"), string.concat("x", info.symbol), info.pool
        );
        IStabilityPool(info.stabilityPool).initialize(info.pool, info.sUSD, info.asset);
        ILeveragePool(info.pool).initialize(
            ILeveragePool.InitArgs({
                factory: address(this),
                asset: info.asset,
                usdc: usdc,
                feed: info.feed,
                assetId: info.assetId,
                riskOracle: riskOracle,
                calendar: calendar,
                router: info.router,
                stable: info.sUSD,
                lever: info.xToken,
                stabilityPool: info.stabilityPool,
                creator: info.creator,
                kind: info.kind,
                params: _defaults
            })
        );
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IPoolFactory
    function setDefaultParams(ILeveragePool.PoolParams calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!PoolMath.paramsValid(p)) revert ILeveragePool.InvalidParams();
        _defaults = p;
        emit DefaultParamsSet(p);
    }

    /// @inheritdoc IPoolFactory
    function setImplementations(address poolImpl_, address tokenImpl_, address stabilityPoolImpl_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setImplementations(poolImpl_, tokenImpl_, stabilityPoolImpl_);
    }

    function _setImplementations(address poolImpl_, address tokenImpl_, address stabilityPoolImpl_) internal {
        _requireCode(poolImpl_);
        _requireCode(tokenImpl_);
        _requireCode(stabilityPoolImpl_);
        poolImpl = poolImpl_;
        tokenImpl = tokenImpl_;
        stabilityPoolImpl = stabilityPoolImpl_;
        emit ImplementationsSet(poolImpl_, tokenImpl_, stabilityPoolImpl_);
    }

    // ------------------------------------------------------------------ registrar

    /// @notice Emitted when a REGISTRAR_ROLE holder grants CREATOR_ROLE.
    event CreatorGranted(address indexed creator, address indexed registrar);

    /// @notice Grants CREATOR_ROLE to `who`. Callable by REGISTRAR_ROLE only (the CreatorRegistrar), so per-launch
    ///         grants for Flap launchers and OpenFour migrate clones need no Timelock operation after the handoff.
    ///         The registrar can never revoke; DEFAULT_ADMIN_ROLE (Timelock) still revokes through `revokeRole`.
    ///         Not part of IPoolFactory on purpose: that interface is compiled into the frozen Flap contracts.
    function grantCreator(address who) external onlyRole(Roles.REGISTRAR_ROLE) {
        if (who == address(0)) revert ZeroAddress();
        if (_grantRole(Roles.CREATOR_ROLE, who)) emit CreatorGranted(who, msg.sender);
    }

    /// @notice True when `who` holds REGISTRAR_ROLE.
    function isRegistrar(address who) external view returns (bool) {
        return hasRole(Roles.REGISTRAR_ROLE, who);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IPoolFactory
    function defaultParams() external view returns (ILeveragePool.PoolParams memory) {
        return _defaults;
    }

    /// @inheritdoc IPoolFactory
    function isPool(address pool) external view returns (bool) {
        return _info[pool].pool != address(0);
    }

    /// @inheritdoc IPoolFactory
    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    /// @inheritdoc IPoolFactory
    function poolAt(uint256 index) external view returns (address) {
        return _pools[index];
    }

    /// @inheritdoc IPoolFactory
    function poolInfo(address pool) external view returns (PoolInfo memory) {
        return _info[pool];
    }

    /// @inheritdoc IPoolFactory
    function poolsByAsset(bytes32 assetId) external view returns (address[] memory) {
        return _byAsset[assetId];
    }

    /// @inheritdoc IPoolFactory
    function poolsByCreator(address creator) external view returns (address[] memory) {
        return _byCreator[creator];
    }

    /// @inheritdoc IPoolFactory
    function isAdmin(address who) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, who);
    }

    /// @inheritdoc IPoolFactory
    function isGuardian(address who) external view returns (bool) {
        return hasRole(Roles.GUARDIAN_ROLE, who);
    }

    /// @inheritdoc IPoolFactory
    function isCreator(address who) external view returns (bool) {
        return hasRole(Roles.CREATOR_ROLE, who);
    }

    // ------------------------------------------------------------------ internals

    function _requireCode(address target) internal view {
        if (target == address(0)) revert ZeroAddress();
        if (target.code.length == 0) revert NoCode(target);
    }

    /// @dev decimals() via staticcall; must succeed and be <= 18.
    function _checkDecimals(address token) internal view {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || ret.length < 32) revert UnsupportedDecimals(token, 0);
        uint256 d = abi.decode(ret, (uint256));
        if (d > 18) revert UnsupportedDecimals(token, d > type(uint8).max ? type(uint8).max : uint8(d));
    }
}
