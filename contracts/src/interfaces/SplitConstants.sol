// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared numeric constants. All USD values are WAD (1e18 = $1). All leverage / ratio values are WAD
///         (2.0e18 = 2x). Fees and deviations are basis points (1e4 = 100%).
library SplitConstants {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;

    /// @dev Dead shares minted to DEAD on seed(). X can never return to 0 afterwards.
    uint256 internal constant MIN_X = 1e3;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev Max tolerated future skew on any timestamp read from a feed or posted by a keeper.
    uint256 internal constant MAX_FUTURE_SKEW = 30;

    /// @dev Funding accrual uses a 365-day year and caps a single accrual step at 1 day.
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_ACCRUAL_DT = 1 days;
    /// @dev Longest a feed halt can hold redeemStable on an underwater pool, from the feed's haltedAtSrc.
    uint256 internal constant MAX_REDEEM_HOLD = 6 hours;

    /// @dev Number of halvings rebalance() tries when the router quote exceeds the slippage budget.
    uint256 internal constant MAX_CHUNK_HALVINGS = 8;
}

/// @notice AccessControl role ids shared by every core contract. DEFAULT_ADMIN_ROLE (0x00) is the Timelock.
library Roles {
    /// @dev PoolFactory: may call createPool (Flap launchers, OpenFour module, SandboxFactory).
    bytes32 internal constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
    /// @dev PoolFactory: may grant (never revoke) CREATOR_ROLE through `PoolFactory.grantCreator`. Held by the
    ///      CreatorRegistrar, which only grants to verified Flap launchers and OpenFour migrate-module clones.
    bytes32 internal constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    /// @dev PoolFactory / RiskOracle / AtlasMirror: 2-of-3 multisig. Pause mints, veto, revoke agent, clear halt.
    ///      Can never move funds or block exits.
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @dev RiskOracle: keeper K_RISK posting CMC snapshots.
    bytes32 internal constant POSTER_ROLE = keccak256("POSTER_ROLE");
    /// @dev RiskOracle: AI Risk Steward key K_AGENT.
    bytes32 internal constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    /// @dev AtlasMirror: K_MIRROR primary + backup.
    bytes32 internal constant PUSHER_ROLE = keccak256("PUSHER_ROLE");
    /// @dev LogAnchor: K_ANCHOR.
    bytes32 internal constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");
    /// @dev MockRouter: may register pool callers (SandboxFactory).
    bytes32 internal constant AUTHORIZER_ROLE = keccak256("AUTHORIZER_ROLE");
    /// @dev MockERC20Permit: may mint/burn freely (MockRouter, SandboxFactory, deploy scripts).
    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");
}
