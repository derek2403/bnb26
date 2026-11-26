// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ISandboxFactory} from "../interfaces/ISandboxFactory.sol";
import {IPoolFactory} from "../interfaces/IPoolFactory.sol";
import {ILeveragePool} from "../interfaces/ILeveragePool.sol";
import {IScenarioFeed} from "../interfaces/IScenarioFeed.sol";
import {IMockRouter} from "../interfaces/IMockRouter.sol";
import {IMockERC20} from "../interfaces/IMockERC20.sol";

/// @title SandboxFactory
/// @notice Gives each viewer (judge) one private SANDBOX pool: a ScenarioFeed clone they operate, a pool with its
///         own sUSD/x tokens and StabilityPool, routed through the shared MockRouter. The viewer receives the
///         first-loss x (seed) and, when the mint succeeds, the sUSD of an equal-value mintStable, which puts the
///         sandbox at L ≈ 2. Sandboxes read the real asset's RiskOracle entry on purpose (SPEC.md §6).
/// @dev Needs CREATOR_ROLE on PoolFactory, AUTHORIZER_ROLE on MockRouter and MINTER_ROLE on the mock asset.
contract SandboxFactory is ISandboxFactory, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error BadSymbol();

    /// @inheritdoc ISandboxFactory
    address public immutable poolFactory;
    /// @inheritdoc ISandboxFactory
    address public immutable mockRouter;
    /// @inheritdoc ISandboxFactory
    address public immutable feedImpl;
    /// @inheritdoc ISandboxFactory
    address public immutable asset;
    /// @notice mUSDC used by the pools (MockRouter caller config).
    address public immutable usdc;
    /// @inheritdoc ISandboxFactory
    bytes32 public immutable assetId;
    /// @inheritdoc ISandboxFactory
    address public immutable referenceFeed;
    /// @notice Anchor price used by the ScenarioFeed when the reference feed is unusable (feed decimals).
    int256 public immutable fallbackAnswer;
    /// @inheritdoc ISandboxFactory
    uint256 public immutable seedAssetAmount;
    /// @inheritdoc ISandboxFactory
    uint256 public immutable stableAssetAmount;

    /// @inheritdoc ISandboxFactory
    string public symbol;

    mapping(address => Sandbox) internal _sandboxes;
    /// @inheritdoc ISandboxFactory
    uint256 public sandboxCount;

    /// @notice First six constructor arguments (static, so ABI-encoded inline).
    struct Wiring {
        address poolFactory;
        address mockRouter;
        address feedImpl;
        address asset;
        address usdc;
        bytes32 assetId;
    }

    /// @notice Last four constructor arguments (static, so ABI-encoded inline).
    struct Amounts {
        address referenceFeed;
        int256 fallbackAnswer;
        uint256 seedAssetAmount;
        uint256 stableAssetAmount;
    }

    /// @dev ABI-identical to the frozen SPEC.md §0.1 signature
    ///      (address poolFactory, address mockRouter, address feedImpl, address asset, address usdc, bytes32 assetId,
    ///       string symbol, address referenceFeed, int256 fallbackAnswer, uint256 seedAssetAmount,
    ///       uint256 stableAssetAmount):
    ///      static structs encode in place, so `deployCode(..., abi.encode(<11 flat values>))` works unchanged.
    ///      The grouping only exists because the legacy code generator cannot decode 11 constructor arguments
    ///      without running out of stack.
    constructor(Wiring memory w, string memory symbol_, Amounts memory m) {
        if (
            w.poolFactory == address(0) || w.mockRouter == address(0) || w.feedImpl == address(0)
                || w.asset == address(0) || w.usdc == address(0)
        ) revert ZeroAddress();
        uint256 len = bytes(symbol_).length;
        if (len == 0 || len > 10) revert BadSymbol();
        if (m.seedAssetAmount == 0) revert ZeroAmount();
        poolFactory = w.poolFactory;
        mockRouter = w.mockRouter;
        feedImpl = w.feedImpl;
        asset = w.asset;
        usdc = w.usdc;
        assetId = w.assetId;
        symbol = symbol_;
        referenceFeed = m.referenceFeed; // may be zero: the feed then anchors to fallbackAnswer
        fallbackAnswer = m.fallbackAnswer;
        seedAssetAmount = m.seedAssetAmount;
        stableAssetAmount = m.stableAssetAmount;
    }

    /// @inheritdoc ISandboxFactory
    function create() external nonReentrant returns (address pool, address feed) {
        Sandbox storage existing = _sandboxes[msg.sender];
        if (existing.pool != address(0)) revert AlreadyHasSandbox(existing.pool);

        feed = Clones.clone(feedImpl);
        IScenarioFeed(feed).initialize(referenceFeed, msg.sender, false, fallbackAnswer);

        pool = IPoolFactory(poolFactory).createPool(
            asset, feed, assetId, symbol, mockRouter, ILeveragePool.PoolKind.SANDBOX
        );
        _sandboxes[msg.sender] = Sandbox({pool: pool, feed: feed, createdAt: block.timestamp});
        ++sandboxCount;

        IMockRouter(mockRouter).setCaller(
            pool,
            IMockRouter.CallerConfig({
                enabled: true,
                feed: feed,
                asset: asset,
                usdc: usdc,
                slippageBps: 0,
                offsetBps: 0
            })
        );

        uint256 seedC = seedAssetAmount;
        uint256 stableC = stableAssetAmount;
        IERC20 a = IERC20(asset);
        IMockERC20(asset).mint(address(this), seedC + stableC);
        a.forceApprove(pool, seedC + stableC);

        ILeveragePool(pool).seed(seedC, msg.sender);

        uint256 stableUsed;
        if (stableC > 0) {
            try ILeveragePool(pool).mintStable(stableC, 0, block.timestamp) returns (uint256 sOut) {
                stableUsed = stableC;
                IERC20(ILeveragePool(pool).sUSD()).safeTransfer(msg.sender, sOut);
            } catch {
                // e.g. the CMC breaker is tripped or stale: hand the unused stock to the viewer instead.
                a.safeTransfer(msg.sender, stableC);
            }
        }
        a.forceApprove(pool, 0);

        emit SandboxCreated(msg.sender, pool, feed, seedC, stableUsed);
    }

    /// @inheritdoc ISandboxFactory
    function sandboxOf(address owner) external view returns (Sandbox memory) {
        return _sandboxes[owner];
    }
}
