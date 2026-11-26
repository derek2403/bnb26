// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {CoreHandoff} from "./lib/CoreHandoff.sol";

/// @title HandoffAdmin (BSC testnet 97)
/// @notice Deferred last step of SPEC.md §14.1: DEFAULT_ADMIN_ROLE of PoolFactory, RiskOracle, MarketCalendar,
///         LogAnchor, both AtlasMirrors, MockRouter and the three mocks moves to `core.timelock`; the deployer
///         renounces it. Run after OpenDevPools and after Flap / OpenFour were granted CREATOR_ROLE.
/// @dev EXTRA_HANDOFF_TARGETS (comma-separated addresses) adds more AccessControl contracts (e.g. launch-side
///      contracts that use DEFAULT_ADMIN_ROLE). Irreversible without a 24 h Timelock operation.
contract HandoffAdmin is CoreHandoff {
    function run() external {
        string memory json = _readDeployments();
        address timelock = _jAddr(json, ".core.timelock");
        address[] memory core = _coreAdminTargets(json);
        address[] memory extra = vm.envOr("EXTRA_HANDOFF_TARGETS", ",", new address[](0));
        address[] memory all = new address[](core.length + extra.length);
        for (uint256 i; i < core.length; ++i) {
            all[i] = core[i];
        }
        for (uint256 i; i < extra.length; ++i) {
            all[core.length + i] = extra[i];
        }

        address deployer = _startBroadcastTestnet();
        _handoff(all, timelock, deployer);
        vm.stopBroadcast();
        console2.log("timelock", timelock);
    }
}
