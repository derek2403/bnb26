// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolFactory} from "../src/interfaces/IPoolFactory.sol";
import {ILeveragePool} from "../src/interfaces/ILeveragePool.sol";
import {IMockRouter} from "../src/interfaces/IMockRouter.sol";
import {IMockERC20} from "../src/interfaces/IMockERC20.sol";

import {DeploymentsIO} from "./lib/DeploymentsIO.sol";

/// @title OpenDevPools (BSC testnet 97)
/// @notice The admin (deployer before handoff; see HANDOFF_ADMIN) opens and seeds:
///         - "nvda-dev"      kind DEV      tNVDA on the NVDA AtlasMirror, PCS v2 router (MockRouter if absent)
///         - "nvda-scenario" kind SCENARIO tNVDA on the NVDA ScenarioFeed, MockRouter
///         - "tsla-scenario" kind SCENARIO tTSLA on the TSLA ScenarioFeed, MockRouter
///         and upserts them into deployments/97.json `pools[]`.
/// @dev Idempotent: a pool already listed under the same id (and known to the factory) is reused; seeding runs
///      only while X == 0. seed() needs a fresh, unhalted price, so the dev pool is only seeded after the keeper
///      has pushed the mirror (<= maxPriceAge, 120 s); otherwise it is opened and left for a rerun.
///      ScenarioFeeds are always fresh, so scenario pools are seeded immediately.
contract OpenDevPools is DeploymentsIO {
    bytes32 internal constant NVDA = keccak256("NVDA");
    bytes32 internal constant TSLA = keccak256("TSLA");

    struct Spec {
        string id;
        string symbol;
        bytes32 assetId;
        string kind;
        ILeveragePool.PoolKind poolKind;
        address asset;
        address feed;
        address router;
        bool mockRouted;
        uint256 seedAmount;
    }

    address internal deployer;
    address internal seedTo;
    IPoolFactory internal factory;
    address internal mockRouter;
    address internal usdc;

    function run() external {
        string memory json = _readDeployments();
        factory = IPoolFactory(_jAddr(json, ".core.poolFactory"));
        mockRouter = _jAddr(json, ".dex.mockRouter");
        usdc = _jAddr(json, ".tokens.mUSDC");
        address pcsRouter = _jAddr(json, ".dex.router");
        require(_hasCode(address(factory)), "poolFactory missing");

        Spec[] memory specs = new Spec[](3);
        bool pcsOk = _hasCode(pcsRouter) && !vm.envOr("DEV_POOL_USE_MOCK_ROUTER", false);
        specs[0] = Spec({
            id: "nvda-dev",
            symbol: "NVDA",
            assetId: NVDA,
            kind: "dev",
            poolKind: ILeveragePool.PoolKind.DEV,
            asset: _jAddr(json, ".tokens.tNVDA"),
            feed: _jAddr(json, ".oracles.NVDA.mirror"),
            router: pcsOk ? pcsRouter : mockRouter,
            mockRouted: !pcsOk,
            seedAmount: vm.envOr("DEV_SEED_TNVDA", uint256(20e18))
        });
        specs[1] = Spec({
            id: "nvda-scenario",
            symbol: "NVDA",
            assetId: NVDA,
            kind: "scenario",
            poolKind: ILeveragePool.PoolKind.SCENARIO,
            asset: _jAddr(json, ".tokens.tNVDA"),
            feed: _jAddr(json, ".oracles.NVDA.scenarioFeed"),
            router: mockRouter,
            mockRouted: true,
            seedAmount: vm.envOr("SCENARIO_SEED_TNVDA", uint256(50e18))
        });
        specs[2] = Spec({
            id: "tsla-scenario",
            symbol: "TSLA",
            assetId: TSLA,
            kind: "scenario",
            poolKind: ILeveragePool.PoolKind.SCENARIO,
            asset: _jAddr(json, ".tokens.tTSLA"),
            feed: _jAddr(json, ".oracles.TSLA.scenarioFeed"),
            router: mockRouter,
            mockRouted: true,
            seedAmount: vm.envOr("SCENARIO_SEED_TTSLA", uint256(20e18))
        });

        PoolEntry[] memory existing = _readPools(json);

        deployer = _startBroadcastTestnet();
        seedTo = vm.envOr("DEV_SEED_RECIPIENT", deployer);
        require(factory.isAdmin(deployer), "deployer is not PoolFactory admin (already handed to Timelock?)");

        PoolEntry[] memory rows = new PoolEntry[](specs.length);
        for (uint256 i; i < specs.length; ++i) {
            rows[i] = _openOne(specs[i], existing);
        }
        vm.stopBroadcast();

        for (uint256 i; i < rows.length; ++i) {
            _upsertPool(rows[i]);
            console2.log(rows[i].id, rows[i].pool);
        }
    }

    function _openOne(Spec memory s, PoolEntry[] memory existing) internal returns (PoolEntry memory row) {
        require(_hasCode(s.asset) && _hasCode(s.feed) && _hasCode(s.router), string.concat(s.id, ": missing wiring"));
        address pool;
        (bool found, uint256 idx) = _findPool(existing, s.id);
        if (found && factory.isPool(existing[idx].pool)) {
            pool = existing[idx].pool;
            console2.log(string.concat(s.id, ": reusing"), pool);
        } else {
            pool = factory.createPool(s.asset, s.feed, s.assetId, s.symbol, s.router, s.poolKind);
            if (s.mockRouted) {
                IMockRouter(mockRouter).setCaller(
                    pool,
                    IMockRouter.CallerConfig({
                        enabled: true, feed: s.feed, asset: s.asset, usdc: usdc, slippageBps: 0, offsetBps: 0
                    })
                );
            }
        }
        _maybeSeed(s, pool);

        IPoolFactory.PoolInfo memory info = factory.poolInfo(pool);
        row = PoolEntry({
            id: s.id,
            symbol: s.symbol,
            assetId: s.assetId,
            kind: s.kind,
            pool: pool,
            sUSD: info.sUSD,
            xToken: info.xToken,
            stabilityPool: info.stabilityPool,
            feed: s.feed,
            openedBy: info.creator,
            openTx: found ? existing[idx].openTx : ""
        });
    }

    function _maybeSeed(Spec memory s, address pool) internal {
        ILeveragePool.PoolState memory st = ILeveragePool(pool).state();
        if (st.X != 0) {
            console2.log(string.concat(s.id, ": already seeded"));
            return;
        }
        if (!st.priceFresh || st.feedHalted || s.seedAmount == 0) {
            console2.log(string.concat(s.id, ": NOT seeded (price stale/halted; push the mirror and rerun)"));
            return;
        }
        IMockERC20(s.asset).mint(deployer, s.seedAmount);
        IERC20(s.asset).approve(pool, s.seedAmount);
        ILeveragePool(pool).seed(s.seedAmount, seedTo);
        console2.log(string.concat(s.id, ": seeded"), s.seedAmount);
    }
}
