// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {RiskOracle} from "../src/core/RiskOracle.sol";
import {LogAnchor} from "../src/core/LogAnchor.sol";
import {AtlasCmcAnchor} from "../src/oracle/AtlasCmcAnchor.sol";
import {NvdabLens} from "../src/oracle/NvdabLens.sol";
import {IRiskOracle} from "../src/interfaces/IRiskOracle.sol";
import {Roles} from "../src/interfaces/SplitConstants.sol";

import {DeploymentsIO} from "./lib/DeploymentsIO.sol";

/// @title DeployMainnet (BSC 56, read-only: no funds, no pool)
/// @notice Deploys AtlasCmcAnchor (reads Atlas NVDAB 0xf25af… in-tx), NvdabLens (PCS v3 NVDAB/USDT),
///         RiskOracle56 (NVDA configured) and LogAnchor56, grants the keeper roles and writes deployments/56.json.
/// @dev forge script script/DeployMainnet.s.sol:DeployMainnet --rpc-url bsc --broadcast --slow
///      Uses MAINNET_DEPLOYER_PRIVATE_KEY (else MAINNET_PRIVATE_KEY); never a testnet key. Admin stays with the
///      mainnet deployer (nothing on 56 holds value).
contract DeployMainnet is DeploymentsIO {
    bytes32 internal constant NVDA = keccak256("NVDA");

    address internal constant ATLAS_NVDAB = 0xf25Af12920D408bAf6211e9e90eDa89DF3D8CCDa;
    address internal constant ATLAS_MULTIFEED = 0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa;
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant PCS_V3_NVDAB_USDT = 0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C;
    address internal constant ERC8004_IDENTITY_56 = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant ERC8004_REPUTATION_56 = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    address internal deployer;
    address internal keeper;
    address internal anchorer;
    address internal guardian;
    address internal atlasFeed;
    address internal v3Pool;

    AtlasCmcAnchor internal cmcAnchor;
    NvdabLens internal lens;
    RiskOracle internal risk;
    LogAnchor internal logAnchor;

    function run() external {
        require(block.chainid == 56 || vm.envOr("ALLOW_NON_MAINNET", false), "DeployMainnet: chain is not 56");
        atlasFeed = vm.envOr("ATLAS_NVDA_SRC_FEED", ATLAS_NVDAB);
        v3Pool = vm.envOr("PCS_V3_NVDAB_USDT", PCS_V3_NVDAB_USDT);

        deployer = _startBroadcastMainnet();
        keeper = _roleAddr("MAINNET_KEEPER_ADDRESS", "RISK56_PRIVATE_KEY", deployer);
        anchorer = _roleAddr("ANCHOR56_ADDRESS", "ANCHOR56_PRIVATE_KEY", keeper);
        guardian = vm.envOr("MAINNET_GUARDIAN_ADDRESS", deployer);
        address agent56 = _roleAddr("AGENT56_ADDRESS", "", address(0));

        cmcAnchor = new AtlasCmcAnchor(deployer, keeper, atlasFeed);
        lens = new NvdabLens(v3Pool, vm.envOr("NVDAB", NVDAB));

        risk = new RiskOracle(deployer);
        risk.configureAsset(NVDA, _assetConfig());
        risk.grantRole(Roles.POSTER_ROLE, keeper);
        risk.grantRole(Roles.GUARDIAN_ROLE, guardian);
        if (agent56 != address(0)) risk.grantRole(Roles.PROPOSER_ROLE, agent56);

        logAnchor = new LogAnchor(deployer);
        logAnchor.grantRole(Roles.ANCHOR_ROLE, anchorer);

        vm.stopBroadcast();

        _write();
        _log("AtlasCmcAnchor", address(cmcAnchor));
        _log("NvdabLens", address(lens));
        _log("RiskOracle56", address(risk));
        _log("LogAnchor56", address(logAnchor));
        _log("keeper (KEEPER_ROLE + POSTER_ROLE)", keeper);
        _log("anchorer (ANCHOR_ROLE)", anchorer);
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

    function _write() internal {
        string memory path = _deploymentsPath();
        string memory agentId = "null";
        if (vm.isFile(path)) {
            (uint256 id, bool ok) = _jUint(vm.readFile(path), ".erc8004.agentId");
            if (ok) agentId = vm.toString(id);
        }
        string memory core = string.concat(
            "{", _kv("riskOracle", _a(address(risk))), ",", _kv("logAnchor", _a(address(logAnchor))), "}"
        );
        string memory mainnet = string.concat(
            "{",
            _kv("atlasCmcAnchor", _a(address(cmcAnchor))),
            ",",
            _kv("nvdabLens", _a(address(lens))),
            ",",
            _kv("nvdab", _a(lens.base())),
            ",",
            _kv("usdt", _a(lens.quote())),
            ",",
            _kv("atlasNvdabFeed", _a(atlasFeed)),
            ","
        );
        mainnet = string.concat(
            mainnet,
            _kv("atlasMultiFeed", _a(ATLAS_MULTIFEED)),
            ",",
            _kv("pcsV3NvdabUsdt", _a(v3Pool)),
            ",",
            _kv("keeper", _a(keeper)),
            "}"
        );
        string memory erc = string.concat(
            "{",
            _kv("identity", _a(ERC8004_IDENTITY_56)),
            ",",
            _kv("reputation", _a(ERC8004_REPUTATION_56)),
            ",",
            _kv("agentId", agentId),
            "}"
        );
        string memory full = string.concat(
            "{",
            _kv("chainId", vm.toString(block.chainid)),
            ",",
            _kv("updatedAt", _q(_isoNow())),
            ",",
            _kv("deployer", _a(deployer)),
            ",",
            _kv("core", core),
            ",",
            _kv("mainnet", mainnet),
            ",",
            _kv("erc8004", erc),
            "}"
        );
        vm.writeJson(full, path);
        console2.log("wrote", path);
    }
}
