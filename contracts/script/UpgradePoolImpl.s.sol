// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {DeploymentsIO} from "./lib/DeploymentsIO.sol";
import {LeveragePool} from "src/core/LeveragePool.sol";
import {PoolFactory} from "src/core/PoolFactory.sol";

/// @title UpgradePoolImpl (BSC testnet 97)
/// @notice Deploys a new LeveragePool implementation (forge deploys and links a new PoolLogic first) and points
///         `PoolFactory` at it with `setImplementations(newPoolImpl, tokenImpl, stabilityPoolImpl)`, keeping the
///         current token and StabilityPool implementations (read from the factory). Pools created before this run
///         are EIP-1167 clones of the old implementation and keep the old logic; only pools created afterwards
///         (Flap `openPool`, OpenFour graduation) use the new one. Writes `core.poolImpl` and `core.poolLogic`.
/// @dev Needs DEFAULT_ADMIN_ROLE on PoolFactory (before `make handoff`; afterwards it is a Timelock operation).
///      Override the detected library address with POOL_LOGIC if ever ambiguous.
contract UpgradePoolImpl is DeploymentsIO {
    function run() external {
        require(block.chainid == 97 || vm.envOr("ALLOW_NON_TESTNET", false), "testnet only");
        string memory json = _readDeployments();
        PoolFactory factory = PoolFactory(_jAddr(json, ".core.poolFactory"));
        require(_hasCode(address(factory)), "core.poolFactory missing");

        address oldPoolImpl = factory.poolImpl();
        address tokenImpl = factory.tokenImpl();
        address spImpl = factory.stabilityPoolImpl();
        console2.log("old poolImpl", oldPoolImpl);
        console2.log("tokenImpl (kept)", tokenImpl);
        console2.log("stabilityPoolImpl (kept)", spImpl);

        address who = _startBroadcastTestnet();
        require(factory.hasRole(bytes32(0), who), "broadcaster is not PoolFactory admin");
        // `new LeveragePool()` makes forge deploy and link a fresh PoolLogic first.
        address newPoolImpl = address(new LeveragePool());
        factory.setImplementations(newPoolImpl, tokenImpl, spImpl);
        vm.stopBroadcast();

        require(factory.poolImpl() == newPoolImpl, "setImplementations did not apply");
        address poolLogic = vm.envOr("POOL_LOGIC", _findLinkedLibrary(newPoolImpl));

        _writeSection(".core.poolImpl", _a(newPoolImpl));
        _writeSection(".core.poolLogic", _a(poolLogic));
        _log("LeveragePool impl", newPoolImpl);
        _log("PoolLogic", poolLogic);
    }

    /// @dev Same walk as DeployCore._findLinkedLibrary: the first PUSH20 operand that is not `impl` and has code.
    function _findLinkedLibrary(address impl) internal view returns (address) {
        bytes memory code = impl.code;
        uint256 n = code.length;
        uint256 i;
        while (i < n) {
            uint8 op = uint8(code[i]);
            if (op == 0x73 && i + 20 < n) {
                address cand;
                assembly ("memory-safe") {
                    cand := shr(96, mload(add(add(code, 33), i)))
                }
                if (cand != impl && cand.code.length > 1000) return cand;
            }
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
            ++i;
        }
        revert("PoolLogic address not found in LeveragePool code; set POOL_LOGIC");
    }
}
