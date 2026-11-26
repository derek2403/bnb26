// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeploymentsIO} from "./lib/DeploymentsIO.sol";
import {BackstopTreasury} from "src/backstop/BackstopTreasury.sol";

/// @notice Deploys the OpenFour-side BackstopTreasury and writes `openfour.backstopTreasury` into deployments/97.json.
///
///   Reads: core.poolFactory, tokens.tTSLA (first quote asset), oracles.TSLA.mirror (its USD feed),
///   openfour.feeRouter (may still be 0x0; set later with `setFeeRouter`), openfour.registry (set once if present).
///   Env (optional): TREASURY_ADMIN (default deployer; hand over to the Timelock with transferAdmin/acceptAdmin),
///   TREASURY_QUOTE_ASSET (default tTSLA), TREASURY_QUOTE_FEED (default the TSLA mirror).
///
///   Run:  make deploy-backstop-treasury   (or: forge script script/DeployBackstopTreasury.s.sol --rpc-url bsc_testnet --broadcast)
contract DeployBackstopTreasury is DeploymentsIO {
    function run() external {
        require(block.chainid == 97 || vm.envOr("ALLOW_NON_TESTNET", false), "DeployBackstopTreasury: chain is not 97");
        string memory json = _readDeployments();

        address poolFactory = _jAddr(json, ".core.poolFactory");
        require(_hasCode(poolFactory), "core.poolFactory missing");
        address quote = vm.envOr("TREASURY_QUOTE_ASSET", _jAddr(json, ".tokens.tTSLA"));
        address quoteFeed = vm.envOr("TREASURY_QUOTE_FEED", _jAddr(json, ".oracles.TSLA.mirror"));
        address feeRouter = _jAddr(json, ".openfour.feeRouter");
        if (!_hasCode(feeRouter)) feeRouter = address(0);
        address registry = _jAddr(json, ".openfour.registry");

        address deployer = _startBroadcastTestnet();
        address admin = vm.envOr("TREASURY_ADMIN", deployer);
        BackstopTreasury t = new BackstopTreasury(admin, poolFactory, feeRouter, quote, quoteFeed);
        if (admin == deployer && _hasCode(registry)) t.setRegistry(registry);
        vm.stopBroadcast();

        _writeSection(".openfour.backstopTreasury", _a(address(t)));
        _log("BackstopTreasury", address(t));
        _log("  feeRouter", feeRouter);
        _log("  quote asset", quote);
    }
}
