// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ILeveragePool} from "../../src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {IMockRouter} from "../../src/interfaces/IMockRouter.sol";
import {Roles} from "../../src/interfaces/SplitConstants.sol";

import {LeveragePool} from "../../src/core/LeveragePool.sol";
import {SplitToken} from "../../src/core/SplitToken.sol";
import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {PoolFactory} from "../../src/core/PoolFactory.sol";
import {PoolMath} from "../../src/core/PoolMath.sol";
import {RiskOracle} from "../../src/core/RiskOracle.sol";
import {MarketCalendar} from "../../src/core/MarketCalendar.sol";
import {MockERC20Permit} from "../../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../../src/mocks/MockRouter.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";

/// @notice Shared deployment for the pool invariant / fuzz suites: the real core stack (no stubs).
///         18-decimal asset, configurable mUSDC decimals (18 or 6), 8-decimal feeds, default PoolParams,
///         the SPEC.md §7.9 NVDA config (also used for TSLA) and the real NYSE calendar.
abstract contract InvariantEnv is Test {
    bytes32 internal constant NVDA = keccak256("NVDA");
    bytes32 internal constant TSLA = keccak256("TSLA");
    /// Thu 2026-07-02 10:30 EDT (NYSE open).
    uint256 internal constant T_OPEN = 1782999000 + 3600;

    MockERC20Permit internal asset;
    MockERC20Permit internal tsla;
    MockERC20Permit internal usdc;
    MockAggregator internal feed;
    MockAggregator internal tslaFeed;
    RiskOracle internal risk;
    MarketCalendar internal cal;
    MockRouter internal router;
    PoolFactory internal factory;

    address internal admin = makeAddr("admin");
    address internal poster = makeAddr("poster");
    address internal agent = makeAddr("agent");
    address internal guardian = makeAddr("guardian");
    address internal launcher = makeAddr("launcher");
    address internal backstop = makeAddr("backstop");
    address internal donor = makeAddr("donor");

    mapping(bytes32 => uint256) internal envSnapId;

    function _deployEnv(uint8 usdcDec) internal {
        vm.warp(T_OPEN);
        vm.startPrank(admin);
        asset = new MockERC20Permit("Test NVDA (MOCK)", "tNVDA", 18, admin, 100e18, 1 days);
        tsla = new MockERC20Permit("Test TSLA (MOCK)", "tTSLA", 18, admin, 100e18, 1 days);
        usdc = new MockERC20Permit("Mock USDC (MOCK)", "mUSDC", usdcDec, admin, 1000 * 10 ** usdcDec, 1 days);
        feed = new MockAggregator(8, 100e8, "NVDA / USD (mock)");
        tslaFeed = new MockAggregator(8, 250e8, "TSLA / USD (mock)");
        risk = new RiskOracle(admin);
        cal = new MarketCalendar(admin);
        router = new MockRouter(admin);

        risk.configureAsset(NVDA, _assetConfig());
        risk.configureAsset(TSLA, _assetConfig());
        risk.grantRole(Roles.POSTER_ROLE, poster);
        risk.grantRole(Roles.PROPOSER_ROLE, agent);
        risk.grantRole(Roles.GUARDIAN_ROLE, guardian);
        asset.grantRole(Roles.MINTER_ROLE, address(router));
        tsla.grantRole(Roles.MINTER_ROLE, address(router));
        usdc.grantRole(Roles.MINTER_ROLE, address(router));

        factory = new PoolFactory(
            admin,
            address(usdc),
            address(risk),
            address(cal),
            address(new LeveragePool()),
            address(new SplitToken()),
            address(new StabilityPool()),
            PoolMath.defaultParams()
        );
        factory.grantRole(Roles.CREATOR_ROLE, launcher);
        factory.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();

        _envPost(NVDA, 100e18);
        _envPost(TSLA, 250e18);
    }

    function _assetConfig() internal pure returns (IRiskOracle.AssetConfig memory) {
        return IRiskOracle.AssetConfig({
            enabled: true,
            baseTriggerLev: 2.67e18,
            baseTargetLev: 2.0e18,
            baseLowerTriggerLev: 1.6e18,
            volRefBps: 5000,
            volSlopeLev: 1e14,
            maxDevBps: 250,
            closedFeeBps: 100,
            baseOpenFeeBps: 30,
            premiumFeeShareBps: 5000,
            gapGuardSec: 3600,
            chunkBpsOfLiq: 200,
            minChunkUsd: 100e18,
            maxChunkUsd: 50_000e18
        });
    }

    function _envPost(bytes32 id, uint256 ref) internal {
        IRiskOracle.Snapshot memory last = risk.latestSnapshot(id);
        if (last.snapshotId != 0 && block.timestamp <= last.cmcTs) vm.warp(last.cmcTs + 1);
        vm.prank(poster);
        risk.post(
            id,
            IRiskOracle.Snapshot({
                refPrice: ref,
                volBps: 5000,
                liqUsd: 1_000_000e18,
                premiumBps: 0,
                cmcTs: block.timestamp,
                snapshotId: last.snapshotId + 1,
                responseHash: keccak256(abi.encode(id, last.snapshotId + 1))
            })
        );
    }

    function _newPool(MockERC20Permit a, MockAggregator f, bytes32 id, string memory sym)
        internal
        returns (LeveragePool p)
    {
        vm.prank(launcher);
        p = LeveragePool(factory.createPool(address(a), address(f), id, sym, address(router), ILeveragePool.PoolKind.LIVE));
        vm.prank(admin);
        router.setCaller(
            address(p),
            IMockRouter.CallerConfig({
                enabled: true, feed: address(f), asset: address(a), usdc: address(usdc), slippageBps: 0, offsetBps: 0
            })
        );
    }

    function _seedPool(LeveragePool p, uint256 cIn) internal {
        MockERC20Permit a = MockERC20Permit(p.asset());
        vm.prank(admin);
        a.mint(launcher, cIn);
        vm.startPrank(launcher);
        a.approve(address(p), type(uint256).max);
        p.seed(cIn, backstop);
        vm.stopPrank();
    }

    /// @dev Mints `cIn` asset to `who` and mints sUSD with it; optionally deposits `spAmount` into the SP.
    function _mintStableAs(LeveragePool p, address who, uint256 cIn, uint256 spAmount) internal returns (uint256 s) {
        MockERC20Permit a = MockERC20Permit(p.asset());
        vm.prank(admin);
        a.mint(who, cIn);
        vm.startPrank(who);
        a.approve(address(p), type(uint256).max);
        s = p.mintStable(cIn, 0, block.timestamp);
        if (spAmount > 0) {
            IERC20(p.sUSD()).approve(p.stabilityPool(), type(uint256).max);
            StabilityPool(p.stabilityPool()).deposit(spAmount);
        }
        vm.stopPrank();
    }
}
