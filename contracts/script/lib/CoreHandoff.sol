// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {console2} from "forge-std/Script.sol";

import {DeploymentsIO} from "./DeploymentsIO.sol";

/// @title CoreHandoff
/// @notice Moves DEFAULT_ADMIN_ROLE of every core AccessControl contract to the TimelockController and renounces
///         the deployer's admin (SPEC.md §14.1, last step). Used by DeployCore (HANDOFF_ADMIN=true) and by
///         HandoffAdmin.s.sol (deferred handoff after the demo setup).
abstract contract CoreHandoff is DeploymentsIO {
    bytes32 internal constant DEFAULT_ADMIN = 0x00;

    /// @dev Must run inside a broadcast from `deployer`. Contracts where the deployer is no longer admin are
    ///      skipped (idempotent). The deployer keeps MINTER_ROLE on the mocks (faucet top-ups) and all
    ///      non-admin roles it was given; the Timelock can revoke them.
    function _handoff(address[] memory targets, address timelock, address deployer) internal {
        require(_hasCode(timelock), "handoff: timelock has no code");
        for (uint256 i; i < targets.length; ++i) {
            address t = targets[i];
            if (!_hasCode(t)) continue;
            IAccessControl ac = IAccessControl(t);
            if (!ac.hasRole(DEFAULT_ADMIN, deployer)) {
                console2.log("handoff: skip (deployer not admin)", t);
                continue;
            }
            if (!ac.hasRole(DEFAULT_ADMIN, timelock)) ac.grantRole(DEFAULT_ADMIN, timelock);
            ac.renounceRole(DEFAULT_ADMIN, deployer);
            console2.log("handoff: admin -> timelock", t);
        }
    }

    /// @dev The AccessControl contracts listed in a 97.json written by DeployCore.
    function _coreAdminTargets(string memory json) internal view returns (address[] memory t) {
        t = new address[](11);
        t[10] = _jAddr(json, ".core.creatorRegistrar");
        t[0] = _jAddr(json, ".core.poolFactory");
        t[1] = _jAddr(json, ".core.riskOracle");
        t[2] = _jAddr(json, ".core.marketCalendar");
        t[3] = _jAddr(json, ".core.logAnchor");
        t[4] = _jAddr(json, ".oracles.NVDA.mirror");
        t[5] = _jAddr(json, ".oracles.TSLA.mirror");
        t[6] = _jAddr(json, ".dex.mockRouter");
        t[7] = _jAddr(json, ".tokens.tNVDA");
        t[8] = _jAddr(json, ".tokens.tTSLA");
        t[9] = _jAddr(json, ".tokens.mUSDC");
    }
}
