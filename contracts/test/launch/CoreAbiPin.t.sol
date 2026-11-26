// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {ILeveragePool} from "src/interfaces/ILeveragePool.sol";
import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";
import {IRiskOracle} from "src/interfaces/IRiskOracle.sol";

/// @notice Pins the SplitStock core ABI subset that the Flap factories' frozen bytecode (SplitLauncher and
///         BackstopVault implementations) calls. Once Flap enables the factories this subset can no longer change
///         without a new factory pair and a new enable request. If a core change makes this test fail, either revert
///         the change or plan a new Flap enable.
///
///   forge test --match-path test/launch/CoreAbiPin.t.sol --out out-flap --cache-path cache-flap
contract CoreAbiPinTest is Test {
    function test_poolFactorySelectors() public pure {
        assertEq(
            IPoolFactory.createPool.selector,
            bytes4(keccak256("createPool(address,address,bytes32,string,address,uint8)")),
            "createPool"
        );
        assertEq(IPoolFactory.usdc.selector, bytes4(keccak256("usdc()")), "usdc");
        assertEq(IPoolFactory.isPool.selector, bytes4(keccak256("isPool(address)")), "isPool (config validation)");
        // SplitStockConfig pins these at deploy and SplitLauncher.openPool re-checks them.
        assertEq(IPoolFactory.poolImpl.selector, bytes4(keccak256("poolImpl()")), "poolImpl");
        assertEq(IPoolFactory.tokenImpl.selector, bytes4(keccak256("tokenImpl()")), "tokenImpl");
        assertEq(IPoolFactory.stabilityPoolImpl.selector, bytes4(keccak256("stabilityPoolImpl()")), "stabilityPoolImpl");
        assertEq(uint8(ILeveragePool.PoolKind.LIVE), 0, "PoolKind.LIVE == 0");
    }

    function test_leveragePoolSelectors() public pure {
        assertEq(ILeveragePool.seed.selector, bytes4(keccak256("seed(uint256,address)")), "seed");
        assertEq(ILeveragePool.setDonor.selector, bytes4(keccak256("setDonor(address,bool)")), "setDonor");
        assertEq(ILeveragePool.isDonor.selector, bytes4(keccak256("isDonor(address)")), "isDonor");
        assertEq(ILeveragePool.xToken.selector, bytes4(keccak256("xToken()")), "xToken");
        assertEq(ILeveragePool.donate.selector, bytes4(keccak256("donate(uint256,uint256)")), "donate");
        assertEq(ILeveragePool.state.selector, bytes4(keccak256("state()")), "state");
        // cover-while-halted reads params().maxPriceAge; the redeem hold error is part of the pool ABI.
        assertEq(ILeveragePool.params.selector, bytes4(keccak256("params()")), "params");
        assertEq(ILeveragePool.RedeemHeld.selector, bytes4(keccak256("RedeemHeld()")), "RedeemHeld");
    }

    /// @dev BackstopVault decodes `state()` as the full static struct and reads S, price, priceAge, priceFresh,
    ///      feedHalted, V and collateralRatio. Pin the field count and every field's word position.
    function test_poolStateLayout() public pure {
        ILeveragePool.PoolState memory st;
        st.C = 1;
        st.U = 2;
        st.S = 3;
        st.X = 4;
        st.price = 5;
        st.priceUpdatedAt = 6;
        st.priceAge = 7;
        st.priceFresh = true;
        st.feedHalted = true;
        st.V = 10;
        st.E = 11;
        st.xNav = 12;
        st.leverage = 13;
        st.collateralRatio = 14;
        st.mode = ILeveragePool.Mode(1);
        st.marketOpen = true;
        st.gapGuard = true;
        st.mintsPaused = true;
        st.triggerLev = 19;
        st.targetLev = 20;
        st.lowerTriggerLev = 21;
        st.maxMintLev = 22;
        st.stableMintFeeBps = 23;
        st.leverMintFeeBps = 24;
        st.riskSource = IRiskOracle.Source(1);
        st.snapshotId = 26;

        bytes memory enc = abi.encode(st);
        assertEq(enc.length, 26 * 32, "PoolState is 26 static words");
        uint256[26] memory want = [uint256(1), 2, 3, 4, 5, 6, 7, 1, 1, 10, 11, 12, 13, 14, 1, 1, 1, 1, 19, 20, 21, 22, 23, 24, 1, 26];
        for (uint256 i; i < 26; ++i) {
            uint256 w;
            assembly ("memory-safe") {
                w := mload(add(add(enc, 0x20), mul(i, 0x20)))
            }
            assertEq(w, want[i], "PoolState field position");
        }
    }
}
