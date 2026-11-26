// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";

/// @notice Settable RiskOracle stand-in for LeveragePool tests. Only riskView() is consumed by the pool.
///         Lets tests set values the real oracle's clamps forbid (fees 0, very high trigger), and revert.
contract PoolRiskStub {
    IRiskOracle.RiskView internal _v;
    bool public reverts;

    constructor() {
        _v.params = IRiskOracle.RiskParams({
            triggerLev: 2.67e18,
            targetLev: 2.0e18,
            lowerTriggerLev: 1.6e18,
            maxDevBps: 250,
            openFeeBps: 30,
            closedFeeBps: 100,
            gapGuardSec: 3600,
            maxSellChunkUsd: 50_000e18
        });
        _v.source = IRiskOracle.Source.RULE;
        _v.snapshotId = 1;
    }

    function setParams(IRiskOracle.RiskParams memory p) external {
        _v.params = p;
    }

    function setLevels(uint256 trigger, uint256 target, uint256 lower) external {
        _v.params.triggerLev = trigger;
        _v.params.targetLev = target;
        _v.params.lowerTriggerLev = lower;
    }

    function setFees(uint256 openFee, uint256 closedFee) external {
        _v.params.openFeeBps = openFee;
        _v.params.closedFeeBps = closedFee;
    }

    function setMaxDev(uint256 d) external {
        _v.params.maxDevBps = d;
    }

    function setRef(uint256 price, uint256 ts) external {
        _v.refPrice = price;
        _v.refTs = ts;
    }

    function setMintsPaused(bool p) external {
        _v.mintsPaused = p;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function riskView(bytes32) external view returns (IRiskOracle.RiskView memory) {
        require(!reverts, "risk down");
        return _v;
    }
}

/// @notice Settable calendar stand-in (isOpen / inGapGuard only), with revert switches.
contract PoolCalendarStub {
    bool public open = true;
    bool public gap;
    bool public revertOpen;
    bool public revertGap;

    function set(bool open_, bool gap_) external {
        open = open_;
        gap = gap_;
    }

    function setReverts(bool o, bool g) external {
        revertOpen = o;
        revertGap = g;
    }

    function isOpen(uint256) external view returns (bool) {
        require(!revertOpen, "cal down");
        return open;
    }

    function inGapGuard(uint256, uint256) external view returns (bool) {
        require(!revertGap, "cal down");
        return gap;
    }
}

/// @notice A feed whose latestRoundData()/halted() return 64 bytes of zeros (short return data), and which
///         exposes decimals() so PoolFactory accepts it.
contract PoolShortFeed {
    uint8 public constant decimals = 8;

    fallback() external {
        assembly {
            mstore(0, 0)
            mstore(32, 0)
            return(0, 64)
        }
    }
}

/// @notice A feed with latestRoundData() but no halted() function (halted must then read as false).
contract PoolNoHaltFeed {
    uint8 public constant decimals = 8;
    int256 public answer = 100e8;
    uint256 public updatedAt;

    constructor() {
        updatedAt = block.timestamp;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
