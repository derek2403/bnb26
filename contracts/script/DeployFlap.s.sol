// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {DeploymentsIO} from "./lib/DeploymentsIO.sol";

import {LaunchVaultAddresses} from "src/flap/LaunchVaultAddresses.sol";
import {SplitLauncherFactory} from "src/launch/SplitLauncherFactory.sol";
import {BackstopVaultFactory} from "src/launch/BackstopVaultFactory.sol";
import {SplitStockConfig} from "src/launch/SplitStockConfig.sol";
import {SplitPoolConfig} from "src/launch/ISplitLaunch.sol";
import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";

/// @notice Deploys the Flap trio on BSC testnet, in this order (one broadcaster, consecutive nonces):
///           nonce+0  SplitStockConfig(cfg, poolSymbol)   immutable pool target, built from the CURRENT core
///           nonce+1  BackstopVaultFactory(portal, guardian, predicted launcher factory)
///           nonce+2  SplitLauncherFactory(portal, guardian, vaultFactory, config)
///         and writes `flap.config`, `flap.configAdmin` (always 0x0: the config has no admin), `flap.vaultFactory`,
///         `flap.launcherFactory` (plus `flap.portal` / `flap.guardian`) into deployments/97.json.
///
///   The pool config is FIXED PER FACTORY PAIR (Flap review: only the Guardian may change where funds go, so nobody
///   can change it). The SplitStock core must therefore be deployed first; a later core redeploy means running this
///   script again and asking Flap to enable the NEW factory pair.
///
///   Reads (deployments/97.json): flap.portal, flap.guardian (defaults: LaunchVaultAddresses), core.poolFactory,
///   tokens.tNVDA, oracles.NVDA.mirror, dex.router (swap AND pool router), oracles.atlasBnbUsd,
///   pools[id == "nvda-scenario"] (`.pool` = ScenarioPool tranche, `.sUSD` = boost token).
///   Env (optional): FLAP_SCENARIO_POOL (override), FLAP_NO_SCENARIO=true (no ScenarioPool), FLAP_BOOST_TOKEN
///   (override), FLAP_NO_BOOST=true (boost off), FLAP_POOL_SYMBOL (default "NVDA"), ALLOW_NON_TESTNET.
///
///   Run:  forge script script/DeployFlap.s.sol --rpc-url $BSC_TESTNET_RPC --broadcast \
///           --out out-flap --cache-path cache-flap
///   After: send Flap the two factory addresses to enable (`setLauncherFactoryMultiplier(launcherFactory, <mult>,
///   true)`, and `setVaultFactoryMultiplier(vaultFactory, <mult>, true)`), then `make configure-registrar`.
contract DeployFlap is DeploymentsIO {
    function run() external {
        require(block.chainid == 97 || vm.envOr("ALLOW_NON_TESTNET", false), "DeployFlap: chain is not 97");
        string memory json = _readDeployments();

        address portal = _jAddr(json, ".flap.portal");
        address flapGuardian = _jAddr(json, ".flap.guardian");
        if (portal == address(0)) portal = LaunchVaultAddresses.hub();
        if (flapGuardian == address(0)) flapGuardian = LaunchVaultAddresses.guardian();
        // Both become immutables of the frozen factories: on 97 they must be Flap's own addresses.
        if (block.chainid == 97) {
            require(portal == LaunchVaultAddresses.hub(), "flap.portal is not the Flap Portal on 97");
            require(flapGuardian == LaunchVaultAddresses.guardian(), "flap.guardian is not the Flap Guardian on 97");
        }
        require(_hasCode(portal), "Portal has no code on this chain");

        // Pre-flight: the same checks the SplitStockConfig constructor runs, with readable messages.
        (SplitPoolConfig memory pc, string memory symbol) = _buildPoolConfig(json);

        address deployer = _startBroadcastTestnet();
        uint256 nonce = vm.getNonce(deployer);
        // nonce+0: config, nonce+1: vault factory, nonce+2: launcher factory. The vault factory must know the launcher
        // factory, which must know the vault factory: predict the third.
        address predictedLauncherFactory = vm.computeCreateAddress(deployer, nonce + 2);
        SplitStockConfig cfg = new SplitStockConfig(pc, symbol);
        BackstopVaultFactory vf = new BackstopVaultFactory(portal, flapGuardian, predictedLauncherFactory);
        SplitLauncherFactory lf = new SplitLauncherFactory(portal, flapGuardian, address(vf), address(cfg));
        vm.stopBroadcast();
        require(address(lf) == predictedLauncherFactory, "launcher factory address prediction failed");

        _writeSection(".flap.portal", _a(portal));
        _writeSection(".flap.guardian", _a(flapGuardian));
        _writeSection(".flap.config", _a(address(cfg)));
        _writeSection(".flap.configAdmin", _a(address(0))); // immutable config: no admin
        _writeSection(".flap.launcherFactory", _a(address(lf)));
        _writeSection(".flap.vaultFactory", _a(address(vf)));

        _log("SplitStockConfig (immutable)", address(cfg));
        _log("  poolFactory", pc.poolFactory);
        _log("  asset (tNVDA)", pc.asset);
        _log("  feed (NVDA mirror)", pc.feed);
        _log("  router (swap + pool)", pc.swapRouter);
        _log("  atlasBnbUsd", pc.atlasBnbUsd);
        _log("  scenarioPool", pc.scenarioPool);
        _log("  boostToken", pc.boostToken);
        console2.log("  poolSymbol", symbol);
        _log("BackstopVaultFactory", address(vf));
        _log("SplitLauncherFactory", address(lf));
        _log("  launcher beacon", lf.beacon());
        _log("  vault beacon", vf.beacon());
        (uint256 floorWei, bool known) = lf.creationFloor();
        if (known) console2.log("  creation floor (wei)", floorWei, "min pool quote (wei)", lf.minPoolQuote());
        else console2.log("  creation floor unknown (launchQuoteConfig read failed); the Portal still checks at launch");
        console2.log("NEXT 1: Flap enables both factories (setLauncherFactoryMultiplier / setVaultFactoryMultiplier)");
        console2.log("NEXT 2: make configure-registrar (allowlist the new launcher factory on CreatorRegistrar)");
    }

    /// @dev The pool target from the current core in deployments/97.json (formerly SetFlapConfig._build).
    function _buildPoolConfig(string memory json) internal view returns (SplitPoolConfig memory cfg, string memory symbol) {
        cfg.poolFactory = _jAddr(json, ".core.poolFactory");
        cfg.asset = _jAddr(json, ".tokens.tNVDA");
        cfg.feed = _jAddr(json, ".oracles.NVDA.mirror");
        cfg.atlasBnbUsd = _jAddr(json, ".oracles.atlasBnbUsd");
        cfg.swapRouter = _jAddr(json, ".dex.router");
        cfg.poolRouter = cfg.swapRouter;
        symbol = vm.envOr("FLAP_POOL_SYMBOL", string("NVDA"));
        cfg.assetId = keccak256(bytes(symbol));

        require(_hasCode(cfg.poolFactory), "core.poolFactory missing: run deploy-core first");
        require(_hasCode(cfg.asset), "tokens.tNVDA missing");
        require(_hasCode(cfg.feed), "oracles.NVDA.mirror missing");
        require(_hasCode(cfg.atlasBnbUsd), "oracles.atlasBnbUsd missing");
        require(_hasCode(cfg.swapRouter), "dex.router missing");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 10, "FLAP_POOL_SYMBOL must be 1..10 bytes");
        // BackstopVault.initialize reads usdc() during the Flap launch: a zero there reverts every final contribution.
        require(_hasCode(IPoolFactory(cfg.poolFactory).usdc()), "poolFactory.usdc missing");

        PoolEntry[] memory pools = _readPools(json);
        (bool found, uint256 idx) = _findPool(pools, "nvda-scenario");
        address scenario = vm.envOr("FLAP_SCENARIO_POOL", found ? pools[idx].pool : address(0));
        if (vm.envOr("FLAP_NO_SCENARIO", false)) scenario = address(0);
        if (scenario != address(0)) {
            require(IPoolFactory(cfg.poolFactory).isPool(scenario), "scenario pool is not a PoolFactory pool");
        }
        cfg.scenarioPool = scenario;
        cfg.boostToken = vm.envOr("FLAP_BOOST_TOKEN", found ? pools[idx].sUSD : address(0));
        if (vm.envOr("FLAP_NO_BOOST", false)) cfg.boostToken = address(0);
        if (cfg.boostToken != address(0)) require(_hasCode(cfg.boostToken), "boost token has no code");
    }
}
