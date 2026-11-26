// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";

contract SpTestToken is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Unit tests for StabilityPool rounding. This contract plays the LeveragePool (burns sUSD from the SP,
///         sends it asset, then calls offset / notifyReward).
contract StabilityPoolRoundingTest is Test {
    StabilityPool internal sp;
    SpTestToken internal sUSD;
    SpTestToken internal asset;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal cat = makeAddr("cat");

    function setUp() public {
        sUSD = new SpTestToken("sUSD");
        asset = new SpTestToken("ASSET");
        sp = StabilityPool(Clones.clone(address(new StabilityPool())));
        sp.initialize(address(this), address(sUSD), address(asset));
    }

    function _deposit(address u, uint256 amt) internal {
        sUSD.mint(u, amt);
        vm.startPrank(u);
        sUSD.approve(address(sp), amt);
        sp.deposit(amt);
        vm.stopPrank();
    }

    function _offset(uint256 burned, uint256 assetAdded) internal {
        sUSD.burn(address(sp), burned);
        asset.mint(address(sp), assetAdded);
        sp.offset(burned, assetAdded);
    }

    /// @dev External so a reverting offset (e.g. ProductUnderflow) also rolls back the burn, as in rebalance().
    function extOffset(uint256 burned, uint256 assetAdded) external {
        require(msg.sender == address(this));
        _offset(burned, assetAdded);
    }

    function _sumDeposits() internal view returns (uint256) {
        return sp.depositOf(alice) + sp.depositOf(bob) + sp.depositOf(cat);
    }

    function _bankRun() internal {
        address[3] memory us = [alice, bob, cat];
        for (uint256 i; i < 3; ++i) {
            vm.prank(us[i]);
            sp.withdraw(type(uint256).max); // must not revert
            assertEq(sp.depositOf(us[i]), 0, "deposit left after full withdraw");
        }
        assertLe(sp.totalDeposits(), sUSD.balanceOf(address(sp)), "totalDeposits > balance after bank run");
    }

    /// @notice Shrunk from PoolInvariant6Test: a loss error accumulated on ~1.58e18 of deposits was credited in
    ///         full against a near-total offset of ~3e8 wei of deposits, leaving Σ compounded > totalDeposits.
    function test_lossErrorCreditAfterTotalShrinks() public {
        _deposit(alice, 1580645161290322580);
        _offset(1580645161290322580 - 9, 1e18); // P -> 5e9, scale 1, big lastLossError, alice wiped by the guard
        assertGt(sp.lastLossError(), 1e18, "setup: expected a loss error > 1 wei");
        assertEq(sp.depositOf(alice), 0);

        _deposit(bob, 306451612);
        uint256 td = sp.totalDeposits();
        _offset(td - 38, 1e9);

        // Uncapped, bob's compounded deposit used to be 39 > totalDeposits = 38 (depositOf now also caps at
        // totalDeposits, so check the strict bound the fixed credit gives: 37 < 38).
        assertEq(sp.totalDeposits(), 38);
        assertLt(sp.depositOf(bob), sp.totalDeposits(), "loss-error credit over-applied");
        assertLe(_sumDeposits(), sp.totalDeposits(), "sum compounded deposits > totalDeposits");
        assertLe(sp.totalDeposits(), sUSD.balanceOf(address(sp)), "totalDeposits > sUSD balance");
        _bankRun();
    }

    /// @notice Fuzz counterexample against the old full credit (asset gains > asset balance by ~2.4e10 wei).
    function test_regression_fuzzSeed199() public {
        testFuzz_solvency(199);
    }

    /// @notice Random deposit / offset / reward / withdraw sequences: Σ compounded <= totalDeposits <= balance,
    ///         Σ rewards <= balance - totalDeposits, Σ asset gains <= asset balance, and a full bank run never reverts.
    function testFuzz_solvency(uint256 seed) public {
        address[3] memory us = [alice, bob, cat];
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 4;
            address u = us[(r >> 8) % 3];
            uint256 mag = 10 ** ((r >> 16) % 25); // 1 wei .. 1e24
            uint256 amt = 1 + (r >> 32) % mag;
            uint256 td = sp.totalDeposits();
            if (op == 0) {
                _deposit(u, amt);
            } else if (op == 1 && td > 0) {
                // offsets that leave anything from 0 to most of the pool, incl. near-total wipes
                uint256 keep = (r >> 96) % 3 == 0 ? (r >> 128) % 64 : (r >> 128) % td;
                uint256 burned = td > keep ? td - keep : td;
                if (burned == 0) burned = 1;
                try this.extOffset(burned, (r >> 160) % 1e24) {} catch {}
            } else if (op == 2 && td > 0) {
                sUSD.mint(address(sp), amt);
                sp.notifyReward(amt);
            } else if (op == 3) {
                vm.prank(u);
                sp.withdraw((r >> 200) % 2 == 0 ? type(uint256).max : amt);
            }
            uint256 sum;
            uint256 sumA;
            uint256 sumR;
            for (uint256 i; i < 3; ++i) {
                sum += sp.depositOf(us[i]);
                (uint256 a, uint256 g) = sp.gainsOf(us[i]);
                sumA += a;
                sumR += g;
            }
            uint256 bal = sUSD.balanceOf(address(sp));
            assertLe(sum, sp.totalDeposits(), "sum compounded > totalDeposits");
            assertLe(sp.totalDeposits(), bal, "totalDeposits > balance");
            assertLe(sumR, bal - sp.totalDeposits(), "rewards > balance - totalDeposits");
            assertLe(sumA, asset.balanceOf(address(sp)), "asset gains > asset balance");
        }
        _bankRun();
    }
}
