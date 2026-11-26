// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {RiskOracle} from "../../src/core/RiskOracle.sol";

/// @notice Stateful fuzz handler for RiskOracle on one assetId: CMC posts, agent proposals (tighten and
///         loosen), apply / veto / revoke / restore, pauses and time warps. It holds POSTER, PROPOSER,
///         GUARDIAN and DEFAULT_ADMIN on the oracle.
contract RiskHandler is Test {
    RiskOracle public risk;
    bytes32 public id;

    uint256 public stepCapFailures;
    string public firstStepCapFailure;
    mapping(string => uint256) public calls;

    constructor(RiskOracle risk_, bytes32 id_) {
        risk = risk_;
        id = id_;
    }

    function post(uint256 volSeed, uint256 liqSeed, int256 premSeed, uint256 refSeed, uint256 dt) external {
        vm.warp(block.timestamp + _bound(dt, 1, 1200));
        IRiskOracle.Snapshot memory last = risk.latestSnapshot(id);
        bool had = last.snapshotId != 0;
        uint256 prevTrig = risk.ruleParams(id).triggerLev;
        uint256 vol = volSeed % 5 == 0 ? 0 : _bound(volSeed, 0, 40_000);
        uint256 liq = liqSeed % 5 == 0 ? 0 : _bound(liqSeed, 0, 1e9 * 1e18);
        try risk.post(
            id,
            IRiskOracle.Snapshot({
                refPrice: _bound(refSeed, 1, 1e24),
                volBps: vol,
                liqUsd: liq,
                premiumBps: _bound(premSeed, -2e6, 2e6),
                cmcTs: block.timestamp,
                snapshotId: last.snapshotId + 1,
                responseHash: bytes32(last.snapshotId + 1)
            })
        ) {
            calls["post"]++;
            uint256 trig = risk.ruleParams(id).triggerLev;
            uint256 cap = risk.stepCaps().lev;
            if (had && (trig > prevTrig + cap || trig + cap < prevTrig)) {
                if (stepCapFailures == 0) {
                    firstStepCapFailure =
                        string.concat("rule trigger moved ", vm.toString(prevTrig), " -> ", vm.toString(trig));
                }
                stepCapFailures++;
            }
        } catch {}
    }

    function propose(uint256 trig, uint256 tgt, uint256 lo, uint256 dev, uint256 fee, uint256 gg, uint256 hz)
        external
    {
        vm.roll(block.number + 21);
        IRiskOracle.AgentParams memory q;
        if (hz % 2 == 0) {
            // Tighten-only relative to the current effective values (applies immediately).
            IRiskOracle.RiskParams memory e = risk.params(id);
            q = IRiskOracle.AgentParams({
                triggerLev: e.triggerLev - _bound(trig, 0, 0.3e18),
                targetLev: e.targetLev - _bound(tgt, 0, 0.3e18),
                lowerTriggerLev: e.lowerTriggerLev - _bound(lo, 0, 0.3e18),
                maxDevBps: e.maxDevBps - _bound(dev, 0, 40),
                closedFeeBps: e.closedFeeBps + _bound(fee, 0, 100),
                gapGuardSec: e.gapGuardSec + _bound(gg, 0, 3600),
                horizonSec: _bound(hz, 300, 2 days)
            });
        } else {
            q = IRiskOracle.AgentParams({
                triggerLev: _bound(trig, 0, 5e18),
                targetLev: _bound(tgt, 0, 5e18),
                lowerTriggerLev: _bound(lo, 0, 5e18),
                maxDevBps: _bound(dev, 0, 2000),
                closedFeeBps: _bound(fee, 0, 2000),
                gapGuardSec: _bound(gg, 0, 1 days),
                horizonSec: _bound(hz, 300, 2 days)
            });
        }
        try risk.propose(
            id,
            q,
            bytes32("in"),
            bytes32("out"),
            bytes32("model"),
            "ipfs://r",
            0
        ) returns (uint256, bool applied) {
            calls[applied ? "propose.applied" : "propose.queued"]++;
        } catch {}
    }

    function applyProposal(uint256 idSeed, uint256 dt) external {
        uint256 n = risk.proposalCount();
        if (n == 0) return;
        vm.warp(block.timestamp + _bound(dt, 0, 3600));
        try risk.applyProposal(1 + idSeed % n) {
            calls["apply"]++;
        } catch {}
    }

    function veto(uint256 idSeed) external {
        uint256 n = risk.proposalCount();
        if (n == 0) return;
        try risk.veto(1 + idSeed % n) {
            calls["veto"]++;
        } catch {}
    }

    function revokeOrRestore(bool revoke) external {
        if (revoke) risk.revokeAgent();
        else risk.restoreAgent();
        calls[revoke ? "revoke" : "restore"]++;
    }

    function togglePause(bool global) external {
        bytes32 k = global ? bytes32(0) : id;
        risk.setMintsPaused(k, !risk.mintsPaused(global ? bytes32(uint256(1)) : id));
        calls["pause"]++;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + _bound(dt, 1, 3 hours));
        calls["warp"]++;
    }
}
