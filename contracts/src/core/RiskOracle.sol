// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IRiskOracle} from "../interfaces/IRiskOracle.sol";
import {SplitConstants, Roles} from "../interfaces/SplitConstants.sol";

/// @title RiskOracle
/// @notice One risk oracle for every asset, keyed by assetId = keccak256(bytes(symbol)).
///         - RULE: the POSTER keeper posts raw CMC-derived inputs (ref price, vol, liquidity, premium); the rule
///           params are computed on-chain (clamps + a per-snapshot trigger step cap), so anyone can recompute
///           them from the CmcSnapshot event.
///         - FALLBACK: when no snapshot exists or it is older than `staleAfter`, conservative defaults apply
///           (merged with the last rule, field by field, toward the safer value).
///         - AGENT: the AI Risk Steward (PROPOSER) can tighten immediately; a loosening waits `loosenDelay` and
///           can be vetoed by the GUARDIAN. Effective = conservative merge(rule-or-fallback, agent-if-active),
///           so the agent can never loosen beyond the rule and never touches funding, openFee, maxSellChunk,
///           refPrice or funds.
/// @dev Every view is total (never reverts), including for unknown assetIds (they get FALLBACK values).
///      Values are clamped, never rejected; each clamp that bites emits `Clamped`.
///      After setClamps(), stored rule values that fall outside the new band are refreshed on the next post().
contract RiskOracle is AccessControl, ReentrancyGuard, IRiskOracle {
    /// @dev Thrown when the constructor admin is the zero address.
    error ZeroAdmin();
    /// @dev Caller is neither GUARDIAN nor admin.
    error NotGuardianOrAdmin();

    uint256 private constant BPS = SplitConstants.BPS;
    uint256 private constant MIN_HORIZON = 300;
    uint256 private constant MAX_ABS_PREMIUM_BPS = 1e6;
    uint256 private constant MAX_VOL_EXCESS_BPS = 1e12; // keeps (vol - ref) * slope far from overflow

    bytes32 private constant F_TRIGGER = "triggerLev";
    bytes32 private constant F_TARGET = "targetLev";
    bytes32 private constant F_LOWER = "lowerTriggerLev";
    bytes32 private constant F_MAXDEV = "maxDevBps";
    bytes32 private constant F_OPENFEE = "openFeeBps";
    bytes32 private constant F_CLOSEDFEE = "closedFeeBps";
    bytes32 private constant F_GAPGUARD = "gapGuardSec";

    struct AgentState {
        AgentParams q;
        uint256 expiresAt;
        uint256 proposalId;
        uint256 epoch;
    }

    // -------------------------------------------------------------- storage

    mapping(bytes32 assetId => AssetConfig) private _cfg;
    mapping(bytes32 assetId => Snapshot) private _snap;
    mapping(bytes32 assetId => bool) private _hasSnap;
    mapping(bytes32 assetId => RiskParams) private _rule;
    mapping(bytes32 assetId => AgentState) private _agent;

    mapping(uint256 id => Proposal) private _proposals;
    /// @notice agentEpoch at the time each proposal was created (revokeAgent invalidates older ones).
    mapping(uint256 id => uint256) public proposalEpoch;
    /// @inheritdoc IRiskOracle
    uint256 public proposalCount;
    /// @notice The QUEUED proposal of each asset (0 if none).
    mapping(bytes32 assetId => uint256 id) public queued;
    /// @notice Block of the last proposal per asset (rate limit).
    mapping(bytes32 assetId => uint256 blockNumber) public lastProposalBlock;

    Clamps private _clamps;
    StepCaps private _caps;
    Timing private _timing;
    Fallback private _fb;

    /// @inheritdoc IRiskOracle
    bool public agentEnabled;
    /// @notice Incremented by revokeAgent(); agent values and proposals from older epochs are dead.
    uint256 public agentEpoch;
    uint256 private _expectedAgentId;

    /// @notice Guardian global mint pause (assetId 0).
    bool public globalPaused;
    /// @notice Guardian per-asset mint pause.
    mapping(bytes32 assetId => bool) public assetPaused;

    /// @param admin DEFAULT_ADMIN_ROLE holder (Timelock). Defaults from SPEC.md §7.9 are installed.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        _setClamps(
            Clamps({
                minTriggerLev: 2.2e18,
                maxTriggerLev: 3.0e18,
                minTargetLev: 1.6e18,
                maxTargetLev: 2.2e18,
                minLowerTriggerLev: 1.2e18,
                maxLowerTriggerLev: 1.8e18,
                minTriggerTargetGap: 0.3e18,
                minTargetLowerGap: 0.2e18,
                minMaxDevBps: 50,
                maxMaxDevBps: 300,
                minOpenFeeBps: 10,
                maxOpenFeeBps: 150,
                minClosedFeeBps: 50,
                maxClosedFeeBps: 300,
                minGapGuardSec: 1800,
                maxGapGuardSec: 7200
            }),
            false
        );
        _setStepCaps(StepCaps({lev: 0.1e18, bps: 50, sec: 1800}));
        _setTiming(Timing({staleAfter: 900, agentMaxTtl: 7200, loosenDelay: 1800, minProposalGapBlocks: 20}));
        _setFallback(
            Fallback({
                triggerLev: 2.2e18,
                targetLev: 1.9e18,
                lowerTriggerLev: 1.5e18,
                maxDevBps: 150,
                feeBps: 100,
                gapGuardSec: 7200,
                maxSellChunkUsd: 1_000e18
            })
        );
        agentEnabled = true;
    }

    modifier onlyGuardianOrAdmin() {
        if (!hasRole(Roles.GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotGuardianOrAdmin();
        }
        _;
    }

    // ================================================================= POSTER

    /// @inheritdoc IRiskOracle
    function post(bytes32 assetId, Snapshot calldata s) external nonReentrant onlyRole(Roles.POSTER_ROLE) {
        AssetConfig memory cfg = _cfg[assetId];
        if (!cfg.enabled) revert AssetNotConfigured(assetId);
        if (s.refPrice == 0) revert ZeroRefPrice();
        if (s.cmcTs > block.timestamp + SplitConstants.MAX_FUTURE_SKEW) {
            revert FutureTimestamp(s.cmcTs, block.timestamp);
        }
        bool has = _hasSnap[assetId];
        if (has) {
            Snapshot storage prev = _snap[assetId];
            if (s.snapshotId <= prev.snapshotId) revert SnapshotNotIncreasing(prev.snapshotId, s.snapshotId);
            if (s.cmcTs <= prev.cmcTs) revert TimestampNotIncreasing(prev.cmcTs, s.cmcTs);
        }

        RiskParams memory r = _computeRule(assetId, cfg, s, has);

        _snap[assetId] = s;
        _hasSnap[assetId] = true;
        _rule[assetId] = r;
        emit CmcSnapshot(
            assetId, s.snapshotId, s.refPrice, s.volBps, s.liqUsd, s.premiumBps, s.cmcTs, s.responseHash, r
        );
    }

    /// @dev SPEC.md §7.3. The step cap applies only to the rule trigger; target and lower derive from it.
    function _computeRule(bytes32 id, AssetConfig memory cfg, Snapshot calldata s, bool has)
        private
        returns (RiskParams memory r)
    {
        Clamps memory c = _clamps;
        RiskParams memory prevRule;
        if (has) prevRule = _rule[id];

        if (s.volBps == 0 && has) {
            // Vol unknown: keep the previous leverage triple (re-clamped in case setClamps moved the band).
            r.triggerLev = _clamp(id, F_TRIGGER, prevRule.triggerLev, c.minTriggerLev, c.maxTriggerLev);
            r.targetLev = _clamp(id, F_TARGET, prevRule.targetLev, c.minTargetLev, c.maxTargetLev);
            r.lowerTriggerLev =
                _clamp(id, F_LOWER, prevRule.lowerTriggerLev, c.minLowerTriggerLev, c.maxLowerTriggerLev);
        } else {
            uint256 cut;
            if (s.volBps > cfg.volRefBps) {
                cut = Math.min(s.volBps - cfg.volRefBps, MAX_VOL_EXCESS_BPS) * cfg.volSlopeLev;
            }
            uint256 trig = cfg.baseTriggerLev > cut ? cfg.baseTriggerLev - cut : 0;
            trig = _clamp(id, F_TRIGGER, trig, c.minTriggerLev, c.maxTriggerLev);
            if (has) {
                trig = _step(id, F_TRIGGER, trig, prevRule.triggerLev, _caps.lev);
                // Re-clamp: after a clamp change the previous value may sit outside the new band.
                trig = _clamp(id, F_TRIGGER, trig, c.minTriggerLev, c.maxTriggerLev);
            }
            r.triggerLev = trig;
            r.targetLev = _clamp(
                id, F_TARGET, Math.min(cfg.baseTargetLev, trig - c.minTriggerTargetGap), c.minTargetLev, c.maxTargetLev
            );
            r.lowerTriggerLev =
                _clamp(id, F_LOWER, cfg.baseLowerTriggerLev, c.minLowerTriggerLev, c.maxLowerTriggerLev);
        }
        (r.targetLev, r.lowerTriggerLev) = _gaps(id, c, r.triggerLev, r.targetLev, r.lowerTriggerLev);

        r.maxDevBps = _clamp(id, F_MAXDEV, cfg.maxDevBps, c.minMaxDevBps, c.maxMaxDevBps);
        r.closedFeeBps = _clamp(id, F_CLOSEDFEE, cfg.closedFeeBps, c.minClosedFeeBps, c.maxClosedFeeBps);
        r.gapGuardSec = _clamp(id, F_GAPGUARD, cfg.gapGuardSec, c.minGapGuardSec, c.maxGapGuardSec);

        uint256 prem = Math.min(_abs(s.premiumBps), MAX_ABS_PREMIUM_BPS);
        r.openFeeBps = _clamp(
            id,
            F_OPENFEE,
            cfg.baseOpenFeeBps + Math.mulDiv(prem, cfg.premiumFeeShareBps, BPS, Math.Rounding.Floor),
            c.minOpenFeeBps,
            c.maxOpenFeeBps
        );

        if (s.liqUsd == 0 && has) {
            r.maxSellChunkUsd = prevRule.maxSellChunkUsd;
        } else {
            uint256 chunk = Math.mulDiv(s.liqUsd, cfg.chunkBpsOfLiq, BPS, Math.Rounding.Floor);
            r.maxSellChunkUsd = Math.min(Math.max(chunk, cfg.minChunkUsd), cfg.maxChunkUsd);
        }
    }

    // =============================================================== PROPOSER

    /// @inheritdoc IRiskOracle
    function propose(
        bytes32 assetId,
        AgentParams calldata params_,
        bytes32 inputsHash,
        bytes32 outputHash,
        bytes32 modelIdHash,
        string calldata rationaleURI,
        uint256 agentId_
    ) external nonReentrant onlyRole(Roles.PROPOSER_ROLE) returns (uint256 id, bool applied) {
        _checkPropose(assetId, params_.horizonSec, agentId_);
        (id, applied) = _createProposal(assetId, params_, agentId_, inputsHash, outputHash, modelIdHash);
        _emitProposal(id, rationaleURI);
    }

    /// @dev Bounds the values, classifies them, stores the proposal and applies it if tighten-only.
    function _createProposal(
        bytes32 assetId,
        AgentParams calldata params_,
        uint256 agentId_,
        bytes32 inputsHash,
        bytes32 outputHash,
        bytes32 modelIdHash
    ) private returns (uint256 id, bool applied) {
        AgentParams memory b = _baseline(assetId);
        AgentParams memory q = _boundAgent(assetId, params_, b);
        applied = _isTightenOnly(q, b);

        _cancelQueued(assetId);

        id = ++proposalCount;
        proposalEpoch[id] = agentEpoch;
        lastProposalBlock[assetId] = block.number;

        Proposal storage p = _proposals[id];
        p.assetId = assetId;
        p.params = q;
        p.agentId = agentId_;
        p.inputsHash = inputsHash;
        p.outputHash = outputHash;
        p.modelIdHash = modelIdHash;
        p.createdAt = block.timestamp;
        p.eta = applied ? block.timestamp : block.timestamp + _timing.loosenDelay;
        p.tightenOnly = applied;

        if (applied) {
            p.status = ProposalStatus.APPLIED;
            _applyAgent(assetId, id, q);
        } else {
            p.status = ProposalStatus.QUEUED;
            queued[assetId] = id;
        }
    }

    function _emitProposal(uint256 id, string calldata rationaleURI) private {
        Proposal storage p = _proposals[id];
        AgentParams memory q = p.params;
        emit AgentProposal(
            id,
            p.assetId,
            p.agentId,
            keccak256(abi.encode(q)),
            p.inputsHash,
            p.outputHash,
            p.modelIdHash,
            rationaleURI,
            p.tightenOnly,
            p.eta
        );
    }

    function _checkPropose(bytes32 assetId, uint256 horizonSec, uint256 agentId_) private view {
        if (!agentEnabled) revert AgentDisabled();
        uint256 expected = _expectedAgentId;
        if (expected != 0 && agentId_ != expected) revert WrongAgentId(expected, agentId_);
        if (!_cfg[assetId].enabled) revert AssetNotConfigured(assetId);
        if (horizonSec < MIN_HORIZON) revert HorizonTooShort(horizonSec);
        uint256 lastBlock = lastProposalBlock[assetId];
        uint256 gap = _timing.minProposalGapBlocks;
        if (lastBlock != 0 && block.number < lastBlock + gap) revert ProposalRateLimited(lastBlock + gap);
    }

    function _cancelQueued(bytes32 assetId) private {
        uint256 prev = queued[assetId];
        if (prev != 0) {
            _proposals[prev].status = ProposalStatus.CANCELLED;
            queued[assetId] = 0;
            emit ProposalCancelled(prev);
        }
    }

    /// @inheritdoc IRiskOracle
    function applyProposal(uint256 id) external nonReentrant {
        Proposal storage p = _proposals[id];
        if (p.status != ProposalStatus.QUEUED) revert NotQueued(id);
        if (block.timestamp < p.eta) revert TooEarly(p.eta);
        if (!agentEnabled || proposalEpoch[id] != agentEpoch) revert AgentDisabled();

        bytes32 assetId = p.assetId;
        AgentParams memory b = _baseline(assetId);
        // Re-run clamps, step caps and gaps against the baseline at execution time (no raw horizon check).
        AgentParams memory q = _boundAgent(assetId, p.params, b);

        p.params = q;
        p.status = ProposalStatus.EXECUTED;
        if (queued[assetId] == id) queued[assetId] = 0;
        _applyAgent(assetId, id, q);
    }

    function _applyAgent(bytes32 assetId, uint256 id, AgentParams memory q) private {
        uint256 expiresAt = block.timestamp + q.horizonSec;
        _agent[assetId] = AgentState({q: q, expiresAt: expiresAt, proposalId: id, epoch: agentEpoch});
        emit ParamsApplied(assetId, id, q, expiresAt);
    }

    /// @dev clamp -> step(baseline) -> re-clamp -> gaps; horizon = min(horizon, agentMaxTtl).
    function _boundAgent(bytes32 id, AgentParams memory raw, AgentParams memory b)
        private
        returns (AgentParams memory q)
    {
        Clamps memory c = _clamps;
        StepCaps memory k = _caps;
        q.triggerLev = _bound(id, F_TRIGGER, raw.triggerLev, b.triggerLev, k.lev, c.minTriggerLev, c.maxTriggerLev);
        q.targetLev = _bound(id, F_TARGET, raw.targetLev, b.targetLev, k.lev, c.minTargetLev, c.maxTargetLev);
        q.lowerTriggerLev = _bound(
            id, F_LOWER, raw.lowerTriggerLev, b.lowerTriggerLev, k.lev, c.minLowerTriggerLev, c.maxLowerTriggerLev
        );
        q.maxDevBps = _bound(id, F_MAXDEV, raw.maxDevBps, b.maxDevBps, k.bps, c.minMaxDevBps, c.maxMaxDevBps);
        q.closedFeeBps =
            _bound(id, F_CLOSEDFEE, raw.closedFeeBps, b.closedFeeBps, k.bps, c.minClosedFeeBps, c.maxClosedFeeBps);
        q.gapGuardSec =
            _bound(id, F_GAPGUARD, raw.gapGuardSec, b.gapGuardSec, k.sec, c.minGapGuardSec, c.maxGapGuardSec);
        (q.targetLev, q.lowerTriggerLev) = _gaps(id, c, q.triggerLev, q.targetLev, q.lowerTriggerLev);
        q.horizonSec = Math.min(raw.horizonSec, _timing.agentMaxTtl);
    }

    function _bound(bytes32 id, bytes32 f, uint256 x, uint256 prev, uint256 cap, uint256 lo, uint256 hi)
        private
        returns (uint256)
    {
        x = _clamp(id, f, x, lo, hi);
        x = _step(id, f, x, prev, cap);
        return _clamp(id, f, x, lo, hi);
    }

    function _isTightenOnly(AgentParams memory q, AgentParams memory b) private pure returns (bool) {
        return q.triggerLev <= b.triggerLev && q.targetLev <= b.targetLev && q.lowerTriggerLev <= b.lowerTriggerLev
            && q.maxDevBps <= b.maxDevBps && q.closedFeeBps >= b.closedFeeBps && q.gapGuardSec >= b.gapGuardSec;
    }

    /// @dev Proposal baseline: the active agent values, else the rule/fallback base (without agent).
    function _baseline(bytes32 assetId) private view returns (AgentParams memory b) {
        if (_agentActive(assetId)) return _agent[assetId].q;
        (RiskParams memory base,) = _base(assetId);
        b.triggerLev = base.triggerLev;
        b.targetLev = base.targetLev;
        b.lowerTriggerLev = base.lowerTriggerLev;
        b.maxDevBps = base.maxDevBps;
        b.closedFeeBps = base.closedFeeBps;
        b.gapGuardSec = base.gapGuardSec;
    }

    // =============================================================== GUARDIAN

    /// @inheritdoc IRiskOracle
    function veto(uint256 id) external onlyRole(Roles.GUARDIAN_ROLE) {
        Proposal storage p = _proposals[id];
        if (p.status != ProposalStatus.QUEUED) revert NotQueued(id);
        p.status = ProposalStatus.VETOED;
        if (queued[p.assetId] == id) queued[p.assetId] = 0;
        emit Vetoed(id, msg.sender);
    }

    /// @inheritdoc IRiskOracle
    function revokeAgent() external onlyRole(Roles.GUARDIAN_ROLE) {
        agentEnabled = false;
        ++agentEpoch;
        emit AgentRevoked(msg.sender);
    }

    /// @inheritdoc IRiskOracle
    function restoreAgent() external onlyRole(DEFAULT_ADMIN_ROLE) {
        agentEnabled = true;
        emit AgentRestored(msg.sender);
    }

    /// @inheritdoc IRiskOracle
    function setMintsPaused(bytes32 assetId, bool paused) external onlyGuardianOrAdmin {
        if (assetId == bytes32(0)) globalPaused = paused;
        else assetPaused[assetId] = paused;
        emit MintsPausedSet(assetId, paused, msg.sender);
    }

    // ================================================================== ADMIN

    /// @inheritdoc IRiskOracle
    function configureAsset(bytes32 assetId, AssetConfig calldata cfg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Clamps memory c = _clamps;
        if (
            assetId == bytes32(0) || !_within(cfg.baseTriggerLev, c.minTriggerLev, c.maxTriggerLev)
                || !_within(cfg.baseTargetLev, c.minTargetLev, c.maxTargetLev)
                || !_within(cfg.baseLowerTriggerLev, c.minLowerTriggerLev, c.maxLowerTriggerLev)
                || cfg.baseTriggerLev - c.minTriggerTargetGap < cfg.baseTargetLev
                || cfg.baseTargetLev - c.minTargetLowerGap < cfg.baseLowerTriggerLev
                || !_within(cfg.maxDevBps, c.minMaxDevBps, c.maxMaxDevBps)
                || !_within(cfg.closedFeeBps, c.minClosedFeeBps, c.maxClosedFeeBps)
                || !_within(cfg.baseOpenFeeBps, c.minOpenFeeBps, c.maxOpenFeeBps)
                || !_within(cfg.gapGuardSec, c.minGapGuardSec, c.maxGapGuardSec) || cfg.minChunkUsd == 0
                || cfg.minChunkUsd > cfg.maxChunkUsd || cfg.chunkBpsOfLiq > BPS || cfg.premiumFeeShareBps > BPS
                || cfg.volSlopeLev > 1e16
        ) revert InvalidConfig();
        _cfg[assetId] = cfg;
        emit AssetConfigured(assetId, cfg);
    }

    /// @inheritdoc IRiskOracle
    /// @dev Also requires the current fallback to sit inside the new clamps.
    function setClamps(Clamps calldata c) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setClamps(c, true);
    }

    /// @inheritdoc IRiskOracle
    function setStepCaps(StepCaps calldata k) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setStepCaps(k);
    }

    /// @inheritdoc IRiskOracle
    function setTiming(Timing calldata t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTiming(t);
    }

    /// @inheritdoc IRiskOracle
    function setFallback(Fallback calldata f) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFallback(f);
    }

    /// @inheritdoc IRiskOracle
    function setAgentId(uint256 agentId_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _expectedAgentId = agentId_;
        emit AgentIdSet(agentId_);
    }

    function _setClamps(Clamps memory c, bool checkFallback) private {
        if (
            c.minTriggerLev > c.maxTriggerLev || c.minTargetLev > c.maxTargetLev
                || c.minLowerTriggerLev > c.maxLowerTriggerLev || c.minMaxDevBps > c.maxMaxDevBps
                || c.minOpenFeeBps > c.maxOpenFeeBps || c.minClosedFeeBps > c.maxClosedFeeBps
                || c.minGapGuardSec > c.maxGapGuardSec || c.minTriggerLev < 1.5e18 || c.maxTriggerLev > 4e18
                || c.minLowerTriggerLev < 1.05e18 || c.minTriggerTargetGap < 0.1e18 || c.minTargetLowerGap < 0.1e18
                || c.minTriggerLev - c.minTriggerTargetGap < c.minTargetLev
                || c.minTargetLev - c.minTargetLowerGap < c.minLowerTriggerLev || c.maxMaxDevBps > 1000
                || c.maxOpenFeeBps > 1000 || c.maxClosedFeeBps > 1000 || c.maxGapGuardSec > 6 hours
        ) revert InvalidConfig();
        if (checkFallback) _validateFallback(_fb, c);
        _clamps = c;
        emit ClampsUpdated(c);
    }

    function _setStepCaps(StepCaps memory k) private {
        if (k.lev < 0.01e18 || k.lev > 0.5e18 || k.bps < 1 || k.bps > 500 || k.sec < 60 || k.sec > 6 hours) {
            revert InvalidConfig();
        }
        _caps = k;
        emit StepCapsUpdated(k);
    }

    function _setTiming(Timing memory t) private {
        if (
            t.staleAfter < 60 || t.staleAfter > 1 days || t.agentMaxTtl < 300 || t.agentMaxTtl > 1 days
                || t.loosenDelay < 60 || t.loosenDelay > 1 days || t.minProposalGapBlocks > 10_000
        ) revert InvalidConfig();
        _timing = t;
        emit TimingUpdated(t);
    }

    function _setFallback(Fallback memory f) private {
        _validateFallback(f, _clamps);
        _fb = f;
        emit FallbackUpdated(f);
    }

    /// @dev feeBps is used as both the open and the closed fee, so it must sit inside both fee clamps.
    function _validateFallback(Fallback memory f, Clamps memory c) private pure {
        if (
            !_within(f.triggerLev, c.minTriggerLev, c.maxTriggerLev)
                || !_within(f.targetLev, c.minTargetLev, c.maxTargetLev)
                || !_within(f.lowerTriggerLev, c.minLowerTriggerLev, c.maxLowerTriggerLev)
                || f.triggerLev - c.minTriggerTargetGap < f.targetLev
                || f.targetLev - c.minTargetLowerGap < f.lowerTriggerLev
                || !_within(f.maxDevBps, c.minMaxDevBps, c.maxMaxDevBps)
                || !_within(f.feeBps, c.minOpenFeeBps, c.maxOpenFeeBps)
                || !_within(f.feeBps, c.minClosedFeeBps, c.maxClosedFeeBps)
                || !_within(f.gapGuardSec, c.minGapGuardSec, c.maxGapGuardSec) || f.maxSellChunkUsd == 0
        ) revert InvalidConfig();
    }

    // ================================================================== VIEWS

    /// @inheritdoc IRiskOracle
    function params(bytes32 assetId) external view returns (RiskParams memory p) {
        (p,) = _eff(assetId);
    }

    /// @inheritdoc IRiskOracle
    function source(bytes32 assetId) external view returns (Source s) {
        (, s) = _eff(assetId);
    }

    /// @inheritdoc IRiskOracle
    function refPrice(bytes32 assetId) external view returns (uint256 price, uint256 ts) {
        if (_hasSnap[assetId]) {
            Snapshot storage s = _snap[assetId];
            return (s.refPrice, s.cmcTs);
        }
    }

    /// @inheritdoc IRiskOracle
    function riskView(bytes32 assetId) external view returns (RiskView memory v) {
        (v.params, v.source) = _eff(assetId);
        if (_hasSnap[assetId]) {
            Snapshot storage s = _snap[assetId];
            v.refPrice = s.refPrice;
            v.refTs = s.cmcTs;
            v.snapshotId = s.snapshotId;
        }
        v.mintsPaused = globalPaused || assetPaused[assetId];
    }

    /// @inheritdoc IRiskOracle
    function mintsPaused(bytes32 assetId) external view returns (bool) {
        return globalPaused || assetPaused[assetId];
    }

    /// @inheritdoc IRiskOracle
    function ruleParams(bytes32 assetId) external view returns (RiskParams memory) {
        return _rule[assetId];
    }

    /// @inheritdoc IRiskOracle
    function latestSnapshot(bytes32 assetId) external view returns (Snapshot memory) {
        return _snap[assetId];
    }

    /// @inheritdoc IRiskOracle
    function agentParams(bytes32 assetId)
        external
        view
        returns (AgentParams memory params_, bool active, uint256 expiresAt, uint256 proposalId)
    {
        active = _agentActive(assetId);
        if (active) {
            AgentState storage a = _agent[assetId];
            return (a.q, true, a.expiresAt, a.proposalId);
        }
    }

    /// @inheritdoc IRiskOracle
    function proposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// @inheritdoc IRiskOracle
    function assetConfig(bytes32 assetId) external view returns (AssetConfig memory) {
        return _cfg[assetId];
    }

    /// @inheritdoc IRiskOracle
    function clamps() external view returns (Clamps memory) {
        return _clamps;
    }

    /// @inheritdoc IRiskOracle
    function stepCaps() external view returns (StepCaps memory) {
        return _caps;
    }

    /// @inheritdoc IRiskOracle
    function timing() external view returns (Timing memory) {
        return _timing;
    }

    /// @inheritdoc IRiskOracle
    function fallbackParams() external view returns (Fallback memory) {
        return _fb;
    }

    /// @inheritdoc IRiskOracle
    function agentId() external view returns (uint256) {
        return _expectedAgentId;
    }

    // ======================================================= effective params

    /// @dev SPEC.md §7.4. Total: never reverts.
    function _eff(bytes32 assetId) private view returns (RiskParams memory eff, Source src) {
        bool stale;
        (eff, stale) = _base(assetId);
        bool active = _agentActive(assetId);
        bool agentBinds;
        if (active) {
            AgentParams memory q = _agent[assetId].q;
            if (!stale) agentBinds = _tighterThan(q, _rule[assetId]);
            eff.triggerLev = Math.min(eff.triggerLev, q.triggerLev);
            eff.targetLev = Math.min(eff.targetLev, q.targetLev);
            eff.lowerTriggerLev = Math.min(eff.lowerTriggerLev, q.lowerTriggerLev);
            eff.maxDevBps = Math.min(eff.maxDevBps, q.maxDevBps);
            eff.closedFeeBps = Math.max(eff.closedFeeBps, q.closedFeeBps);
            eff.gapGuardSec = Math.max(eff.gapGuardSec, q.gapGuardSec);
        }
        src = stale ? Source.FALLBACK : (agentBinds ? Source.AGENT : Source.RULE);
    }

    /// @dev Rule params, or (when missing/stale) the conservative merge of the last rule with the fallback.
    function _base(bytes32 assetId) private view returns (RiskParams memory base, bool stale) {
        bool has = _hasSnap[assetId];
        if (has) {
            uint256 ts = _snap[assetId].cmcTs;
            uint256 age = block.timestamp > ts ? block.timestamp - ts : 0;
            stale = age > _timing.staleAfter;
        } else {
            stale = true;
        }
        if (!stale) return (_rule[assetId], false);

        Fallback memory f = _fb;
        base = RiskParams({
            triggerLev: f.triggerLev,
            targetLev: f.targetLev,
            lowerTriggerLev: f.lowerTriggerLev,
            maxDevBps: f.maxDevBps,
            openFeeBps: f.feeBps,
            closedFeeBps: f.feeBps,
            gapGuardSec: f.gapGuardSec,
            maxSellChunkUsd: f.maxSellChunkUsd
        });
        if (has) {
            RiskParams memory r = _rule[assetId];
            base.triggerLev = Math.min(base.triggerLev, r.triggerLev);
            base.targetLev = Math.min(base.targetLev, r.targetLev);
            base.lowerTriggerLev = Math.min(base.lowerTriggerLev, r.lowerTriggerLev);
            base.maxDevBps = Math.min(base.maxDevBps, r.maxDevBps);
            base.openFeeBps = Math.max(base.openFeeBps, r.openFeeBps);
            base.closedFeeBps = Math.max(base.closedFeeBps, r.closedFeeBps);
            base.gapGuardSec = Math.max(base.gapGuardSec, r.gapGuardSec);
            base.maxSellChunkUsd = Math.min(base.maxSellChunkUsd, r.maxSellChunkUsd);
        }
    }

    function _agentActive(bytes32 assetId) private view returns (bool) {
        AgentState storage a = _agent[assetId];
        return agentEnabled && a.epoch == agentEpoch && a.proposalId != 0 && block.timestamp < a.expiresAt;
    }

    /// @dev True when at least one agent field is strictly more conservative than the rule.
    function _tighterThan(AgentParams memory q, RiskParams memory r) private pure returns (bool) {
        return q.triggerLev < r.triggerLev || q.targetLev < r.targetLev || q.lowerTriggerLev < r.lowerTriggerLev
            || q.maxDevBps < r.maxDevBps || q.closedFeeBps > r.closedFeeBps || q.gapGuardSec > r.gapGuardSec;
    }

    // ================================================================ helpers

    /// @dev Clamp to [lo, hi]; emits Clamped when it bites.
    function _clamp(bytes32 id, bytes32 field, uint256 x, uint256 lo, uint256 hi) private returns (uint256 y) {
        y = x < lo ? lo : (x > hi ? hi : x);
        if (y != x) emit Clamped(id, field, x, y);
    }

    /// @dev Limit x to [prev - cap, prev + cap] (saturating low end); emits Clamped when it bites.
    function _step(bytes32 id, bytes32 field, uint256 x, uint256 prev, uint256 cap) private returns (uint256) {
        uint256 lo = prev > cap ? prev - cap : 0;
        return _clamp(id, field, x, lo, prev + cap);
    }

    /// @dev target <= trigger - minTriggerTargetGap, lower <= target - minTargetLowerGap. Only ever tightens.
    ///      With trigger, target and lower inside the clamps, setClamps sanity guarantees no underflow and that
    ///      the results stay inside the clamps.
    function _gaps(bytes32 id, Clamps memory c, uint256 trig, uint256 tgt, uint256 lower)
        private
        returns (uint256, uint256)
    {
        uint256 t2 = Math.min(tgt, trig - c.minTriggerTargetGap);
        if (t2 != tgt) emit Clamped(id, F_TARGET, tgt, t2);
        uint256 l2 = Math.min(lower, t2 - c.minTargetLowerGap);
        if (l2 != lower) emit Clamped(id, F_LOWER, lower, l2);
        return (t2, l2);
    }

    function _within(uint256 x, uint256 lo, uint256 hi) private pure returns (bool) {
        return lo <= x && x <= hi;
    }

    function _abs(int256 x) private pure returns (uint256) {
        return x >= 0 ? uint256(x) : (x == type(int256).min ? uint256(type(int256).max) + 1 : uint256(-x));
    }
}
