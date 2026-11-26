// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One RiskOracle for all assets, keyed by assetId = keccak256(bytes(symbol)) e.g. keccak256("NVDA").
///         Every pool on the same asset (live, scenario, sandboxes) reads the same effective params.
///
///         Effective params = conservative merge of
///           - RULE values computed on-chain from the latest CMC snapshot (or FALLBACK defaults when stale), and
///           - the AGENT values (AI Risk Steward) while active.
///         The agent can tighten immediately; loosening waits `loosenDelay` and can be vetoed by the Guardian.
///         The agent can never set funding, openFee, maxSellChunk, refPrice or move funds.
interface IRiskOracle {
    // ----------------------------------------------------------------- types

    enum Source {
        RULE, // fresh snapshot, no agent field binding
        AGENT, // fresh snapshot and at least one active agent value is strictly tighter than the rule value
        FALLBACK // no snapshot or snapshot older than staleAfter (agent tightening still applies on top)
    }

    enum ProposalStatus {
        NONE,
        APPLIED, // tighten-only, applied in propose()
        QUEUED, // loosening, waiting for eta
        EXECUTED, // queued proposal applied via applyProposal()
        VETOED, // Guardian veto
        CANCELLED // superseded by a newer proposal for the same asset, or agent revoked
    }

    /// @notice Effective risk params a pool consumes. Leverage values WAD, fees/deviation bps, USD WAD.
    struct RiskParams {
        uint256 triggerLev; // sell zone above this
        uint256 targetLev; // rebalance target
        uint256 lowerTriggerLev; // buy zone below this
        uint256 maxDevBps; // on-chain breaker |P - ref| / ref
        uint256 openFeeBps; // base mint fee while NYSE open
        uint256 closedFeeBps; // base mint fee while NYSE closed
        uint256 gapGuardSec; // gap-guard window before next open
        uint256 maxSellChunkUsd; // per-rebalance DEX chunk cap
    }

    /// @notice What the keeper posts (raw CMC-derived inputs; rule params are computed on-chain).
    struct Snapshot {
        uint256 refPrice; // WAD USD per 1 whole asset unit (median of CMC DEX / quotes / RWA)
        uint256 volBps; // annualised sigma of 1h log returns, bps. 0 = unknown -> keep previous rule leverage values
        uint256 liqUsd; // WAD USD DEX liquidity (`l`). 0 = unknown -> keep previous chunk
        int256 premiumBps; // underlying vs tokenized premium, signed bps
        uint256 cmcTs; // seconds (CMC status.timestamp converted). Strictly increasing per asset
        uint256 snapshotId; // strictly increasing per asset; matches off-chain log seq
        bytes32 responseHash; // keccak256 of the raw CMC bodies (published in logs.jsonl)
    }

    /// @notice What the agent proposes. Fields mirror the agent JSON output.
    struct AgentParams {
        uint256 triggerLev;
        uint256 targetLev;
        uint256 lowerTriggerLev;
        uint256 maxDevBps;
        uint256 closedFeeBps;
        uint256 gapGuardSec;
        uint256 horizonSec; // validity; effective ttl = min(horizonSec, timing.agentMaxTtl), >= 300
    }

    struct Proposal {
        bytes32 assetId;
        AgentParams params; // after clamps + step caps (what will be / was applied)
        uint256 agentId; // ERC-8004 agent id
        bytes32 inputsHash;
        bytes32 outputHash;
        bytes32 modelIdHash;
        uint256 createdAt;
        uint256 eta; // == createdAt when tightenOnly
        bool tightenOnly;
        ProposalStatus status;
    }

    /// @notice Per-asset rule constants (admin / Timelock).
    struct AssetConfig {
        bool enabled;
        uint256 baseTriggerLev; // 2.67e18
        uint256 baseTargetLev; // 2.0e18
        uint256 baseLowerTriggerLev; // 1.6e18
        uint256 volRefBps; // sigma0, e.g. 5000 (50% annualised)
        uint256 volSlopeLev; // WAD leverage cut per 1 bp of vol above volRefBps, e.g. 1e14 (0.1x per 1000 bps)
        uint256 maxDevBps; // 250 (provisional)
        uint256 closedFeeBps; // 100
        uint256 baseOpenFeeBps; // 30
        uint256 premiumFeeShareBps; // share of |premiumBps| added to the open fee, e.g. 5000 (half)
        uint256 gapGuardSec; // 3600
        uint256 chunkBpsOfLiq; // e.g. 200 = 2% of liqUsd per chunk
        uint256 minChunkUsd; // WAD
        uint256 maxChunkUsd; // WAD
    }

    /// @notice Global clamp table (admin). Values outside are clamped (never reverted) and emit Clamped.
    struct Clamps {
        uint256 minTriggerLev; // 2.2e18
        uint256 maxTriggerLev; // 3.0e18
        uint256 minTargetLev; // 1.6e18
        uint256 maxTargetLev; // 2.2e18
        uint256 minLowerTriggerLev; // 1.2e18
        uint256 maxLowerTriggerLev; // 1.8e18
        uint256 minTriggerTargetGap; // 0.3e18
        uint256 minTargetLowerGap; // 0.2e18
        uint256 minMaxDevBps; // 50
        uint256 maxMaxDevBps; // 300
        uint256 minOpenFeeBps; // 10
        uint256 maxOpenFeeBps; // 150
        uint256 minClosedFeeBps; // 50
        uint256 maxClosedFeeBps; // 300
        uint256 minGapGuardSec; // 1800
        uint256 maxGapGuardSec; // 7200
    }

    /// @notice Max change per rule snapshot and per agent proposal vs the baseline (see SPEC.md).
    struct StepCaps {
        uint256 lev; // 0.1e18, applies to trigger, target, lowerTrigger
        uint256 bps; // 50, applies to maxDev and fees
        uint256 sec; // 1800, applies to gapGuardSec
    }

    struct Timing {
        uint256 staleAfter; // 900: snapshot older than this -> FALLBACK
        uint256 agentMaxTtl; // 7200: agent values expire after min(horizonSec, this)
        uint256 loosenDelay; // 1800: queue time for a loosening proposal
        uint256 minProposalGapBlocks; // 20: at most one proposal per N blocks per asset
    }

    /// @notice Conservative defaults used when the snapshot is missing or stale.
    struct Fallback {
        uint256 triggerLev; // 2.2e18
        uint256 targetLev; // 1.9e18
        uint256 lowerTriggerLev; // 1.5e18
        uint256 maxDevBps; // 150
        uint256 feeBps; // 100: used as BOTH openFeeBps and closedFeeBps (closed-market fee always)
        uint256 gapGuardSec; // 7200
        uint256 maxSellChunkUsd; // WAD, e.g. 1_000e18
    }

    /// @notice Everything a pool needs in one call.
    struct RiskView {
        RiskParams params;
        Source source;
        uint256 refPrice; // WAD; 0 if never posted
        uint256 refTs; // cmcTs of the snapshot; 0 if never posted
        uint256 snapshotId; // 0 if never posted
        bool mintsPaused; // global || per-asset Guardian pause
    }

    // ---------------------------------------------------------------- events

    event CmcSnapshot(
        bytes32 indexed assetId,
        uint256 indexed snapshotId,
        uint256 refPrice,
        uint256 volBps,
        uint256 liqUsd,
        int256 premiumBps,
        uint256 cmcTs,
        bytes32 responseHash,
        RiskParams rule
    );
    event AgentProposal(
        uint256 indexed id,
        bytes32 indexed assetId,
        uint256 indexed agentId,
        bytes32 paramsHash, // keccak256(abi.encode(params after clamps))
        bytes32 inputsHash,
        bytes32 outputHash,
        bytes32 modelIdHash,
        string rationaleURI,
        bool tightenOnly,
        uint256 eta
    );
    event ParamsApplied(bytes32 indexed assetId, uint256 indexed proposalId, AgentParams agent, uint256 expiresAt);
    event Vetoed(uint256 indexed id, address indexed by);
    event ProposalCancelled(uint256 indexed id);
    event Clamped(bytes32 indexed assetId, bytes32 indexed field, uint256 requested, uint256 applied);
    event AgentRevoked(address indexed by);
    event AgentRestored(address indexed by);
    event MintsPausedSet(bytes32 indexed assetId, bool paused, address indexed by); // assetId 0 = global
    event AssetConfigured(bytes32 indexed assetId, AssetConfig config);
    event ClampsUpdated(Clamps clamps);
    event StepCapsUpdated(StepCaps caps);
    event TimingUpdated(Timing timing);
    event FallbackUpdated(Fallback fallbackParams);
    event AgentIdSet(uint256 agentId);

    // ---------------------------------------------------------------- errors

    error AssetNotConfigured(bytes32 assetId);
    error ZeroRefPrice();
    error SnapshotNotIncreasing(uint256 lastId, uint256 givenId);
    error TimestampNotIncreasing(uint256 lastTs, uint256 givenTs);
    error FutureTimestamp(uint256 ts, uint256 nowTs);
    error AgentDisabled();
    error WrongAgentId(uint256 expected, uint256 given);
    error ProposalRateLimited(uint256 nextBlock);
    error HorizonTooShort(uint256 horizonSec);
    error NotQueued(uint256 id);
    error TooEarly(uint256 eta);
    error InvalidConfig();

    // ------------------------------------------------------------- mutations

    /// @notice POSTER only. Stores the snapshot and recomputes the rule params (clamps + step caps).
    function post(bytes32 assetId, Snapshot calldata s) external;

    /// @notice PROPOSER only. Clamps + step-caps the values, classifies tighten/loosen against the baseline,
    ///         applies a tighten-only proposal immediately, queues a loosening one for loosenDelay.
    ///         A new proposal cancels any QUEUED proposal of the same asset.
    function propose(
        bytes32 assetId,
        AgentParams calldata params,
        bytes32 inputsHash,
        bytes32 outputHash,
        bytes32 modelIdHash,
        string calldata rationaleURI,
        uint256 agentId
    ) external returns (uint256 id, bool applied);

    /// @notice Anyone, once block.timestamp >= eta and status == QUEUED and agent enabled.
    ///         Re-applies clamps and step caps against the baseline at execution time.
    function applyProposal(uint256 id) external;

    /// @notice GUARDIAN only. QUEUED -> VETOED.
    function veto(uint256 id) external;

    /// @notice GUARDIAN only. Disables propose/apply, clears all active agent values, cancels queued proposals
    ///         lazily (applyProposal reverts AgentDisabled).
    function revokeAgent() external;

    /// @notice Admin only.
    function restoreAgent() external;

    /// @notice GUARDIAN or admin. assetId == bytes32(0) toggles the global pause.
    function setMintsPaused(bytes32 assetId, bool paused) external;

    /// @notice Admin only (Timelock).
    function configureAsset(bytes32 assetId, AssetConfig calldata config) external;

    function setClamps(Clamps calldata clamps) external;

    function setStepCaps(StepCaps calldata caps) external;

    function setTiming(Timing calldata timing) external;

    function setFallback(Fallback calldata fallbackParams) external;

    /// @notice Admin only. 0 = accept any agentId.
    function setAgentId(uint256 agentId) external;

    // ----------------------------------------------------------------- views
    // Every view below is total: it never reverts, including for unknown assetIds (they get FALLBACK).

    /// @notice Effective params after the conservative merge.
    function params(bytes32 assetId) external view returns (RiskParams memory);

    function source(bytes32 assetId) external view returns (Source);

    function refPrice(bytes32 assetId) external view returns (uint256 price, uint256 ts);

    function riskView(bytes32 assetId) external view returns (RiskView memory);

    function mintsPaused(bytes32 assetId) external view returns (bool);

    /// @notice Rule params from the latest snapshot (ignores staleness and agent).
    function ruleParams(bytes32 assetId) external view returns (RiskParams memory);

    function latestSnapshot(bytes32 assetId) external view returns (Snapshot memory);

    /// @notice Active agent values; active == false when none, expired, or agent revoked.
    function agentParams(bytes32 assetId)
        external
        view
        returns (AgentParams memory params_, bool active, uint256 expiresAt, uint256 proposalId);

    function proposal(uint256 id) external view returns (Proposal memory);

    function proposalCount() external view returns (uint256);

    function assetConfig(bytes32 assetId) external view returns (AssetConfig memory);

    function clamps() external view returns (Clamps memory);

    function stepCaps() external view returns (StepCaps memory);

    function timing() external view returns (Timing memory);

    function fallbackParams() external view returns (Fallback memory);

    function agentEnabled() external view returns (bool);

    function agentId() external view returns (uint256);
}
