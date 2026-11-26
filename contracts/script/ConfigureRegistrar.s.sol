// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {DeploymentsIO} from "./lib/DeploymentsIO.sol";
import {CreatorRegistrar} from "src/periphery/CreatorRegistrar.sol";

/// @title ConfigureRegistrar (BSC testnet 97)
/// @notice Allowlists the deployed SplitLauncherFactory (`flap.launcherFactory`) and the OpenFour fork Core + SplitStock
///         preset (`openfour.core`, `openfour.presetId`) on `core.creatorRegistrar`, so that every later Flap launcher
///         and OpenFour migrate module can get CREATOR_ROLE permissionlessly (`registerFlapLauncher(factory, salt)`,
///         `registerOpenFourToken(core, token)`), also after the Timelock handoff. Run after DeployFlap and
///         register-splitstock.js, before `make handoff`. Idempotent; entries that are not deployed yet are skipped.
/// @dev Env overrides: REGISTRAR_FLAP_FACTORY, REGISTRAR_OPENFOUR_CORE, REGISTRAR_OPENFOUR_PRESET_ID.
contract ConfigureRegistrar is DeploymentsIO {
    function run() external {
        string memory json = _readDeployments();
        CreatorRegistrar reg = CreatorRegistrar(_jAddr(json, ".core.creatorRegistrar"));
        require(_hasCode(address(reg)), "core.creatorRegistrar missing: re-run deploy-core");

        address flapFactory = vm.envOr("REGISTRAR_FLAP_FACTORY", _jAddr(json, ".flap.launcherFactory"));
        address core = vm.envOr("REGISTRAR_OPENFOUR_CORE", _jAddr(json, ".openfour.core"));
        (uint256 presetFromJson, bool havePreset) = _jUint(json, ".openfour.presetId");
        if (!havePreset) {
            string memory s = _jStr(json, ".openfour.presetId");
            if (bytes(s).length != 0) {
                presetFromJson = vm.parseUint(s);
                havePreset = true;
            }
        }
        uint256 presetId = vm.envOr("REGISTRAR_OPENFOUR_PRESET_ID", presetFromJson);
        if (vm.envOr("REGISTRAR_OPENFOUR_PRESET_ID", uint256(0)) != 0) havePreset = true;

        _startBroadcastTestnet();
        if (_hasCode(flapFactory)) {
            if (!reg.flapFactoryAllowed(flapFactory)) reg.setFlapFactory(flapFactory, true);
            console2.log("registrar: flap factory allowed", flapFactory);
        } else {
            console2.log("registrar: skip flap (flap.launcherFactory not deployed)");
        }
        if (_hasCode(core) && havePreset) {
            if (!reg.openFourPresetAllowed(core, presetId)) reg.setOpenFourPreset(core, presetId, true);
            console2.log("registrar: openfour core allowed", core);
            console2.log("registrar: openfour presetId", presetId);
        } else {
            console2.log("registrar: skip openfour (openfour.core / presetId missing)");
        }
        vm.stopBroadcast();
    }
}
