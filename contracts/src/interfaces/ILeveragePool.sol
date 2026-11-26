// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRiskOracle} from "./IRiskOracle.sol";

/// @notice A SplitStock pool for one stock token (tNVDA, tTSLA, ...). Created as a clone by PoolFactory.
///         Holds C (asset) and U (mUSDC) as INTERNAL accounting (never balanceOf). Issues its own
///         sUSD-<SYM> (S = totalSupply, $1 claim) and x<SYM> (X = totalSupply, residual claim).
///           V = C*P + U          E = V - S (signed)       xNAV = E / X
///           L = C*P / E          CR = V / S
///         See contracts/SPEC.md for exact math, rounding and guards.
interface ILeveragePool {
    // ----------------------------------------------------------------- types

    enum Mode {
        UNSEEDED, // X == 0
        NORMAL,
        STABILITY, // CR < stabilityCR (sUSD mint off, xMint fee 0, xRedeem fee up, SP route first)
        UNDERWATER, // S > 0 and E <= 0 (V <= S): both mints off, redeemStable pro rata, redeemLever reverts
        NO_PRICE // feed read failed or answer <= 0
    }

    enum PoolKind {
        LIVE, // real launch pool (Flap NVDA, Four.meme TSLA)
        SCENARIO, // canonical demo pool on a ScenarioFeed + MockRouter
        SANDBOX, // per-viewer private pool from SandboxFactory
        DEV // admin test pool
    }

    enum Zone {
        NONE,
        SELL,
        BUY
    }

    enum Route {
        DEX,
        STABILITY_POOL
    }

    enum Action {
        MINT_STABLE,
        MINT_LEVER,
        REDEEM_STABLE,
        REDEEM_LEVER,
        REDEEM_PAIR
    }

    /// @notice Pool-local parameters (admin / Timelock, bounded; see SPEC.md §LeveragePool.params).
    struct PoolParams {
        uint256 redeemFeeBps; // 20: redeemStable, redeemLever, redeemPair
        uint256 stabilityRedeemFeeBps; // 100: redeemLever fee in STABILITY mode
        uint256 dynFeeMaxBps; // 50: max dynamic fee add/subtract
        uint256 minFeeBps; // 10: floor for a dynamically lowered mint fee (outside STABILITY)
        uint256 fundingRateBps; // 400 per year, [0, 1500]; agent cannot set
        uint256 maxPriceAge; // 120 s: mints, mintLever, redeemLever, rebalance, donate, seed, accrue
        uint256 maxRedeemPriceAge; // 86400 s: redeemStable only
        uint256 maxRefAge; // 3600 s: CMC refPrice age for the breaker; older -> mints fail closed
        uint256 maxSlipBps; // 50: DEX slippage budget per rebalance chunk
        uint256 spDiscountBps; // 100: StabilityPool buys stock at P*(1 - this)
        uint256 rebalanceCooldown; // 30 s between DEX rebalances
        uint256 minRebalanceUsd; // WAD dust floor (1e18)
        uint256 stabilityCR; // 1.3e18
        uint256 closedMaxLev; // 2.2e18: mintStable leverage cap while NYSE closed
        uint256 gapTargetLev; // 1.8e18
        uint256 gapTriggerLev; // 2.3e18
        uint256 levEpsilon; // 0.05e18: rebalance overshoot tolerance
    }

    /// @notice One-call snapshot for UI / keeper / OpenFour. state() NEVER reverts.
    struct PoolState {
        uint256 C; // asset units (asset decimals)
        uint256 U; // mUSDC units (usdc decimals)
        uint256 S; // sUSD supply (18 dec, == USD WAD)
        uint256 X; // x supply (18 dec)
        uint256 price; // P, WAD USD per whole asset unit; last answer even if stale; 0 if unusable
        uint256 priceUpdatedAt;
        uint256 priceAge; // saturating: 0 if updatedAt is in the future
        bool priceFresh; // usable && age <= maxPriceAge && !feedHalted
        bool feedHalted;
        uint256 V; // WAD USD, rounded down
        int256 E; // WAD USD, signed
        uint256 xNav; // WAD USD per 1e18 x. 1e18 if X == 0; 0 if E <= 0
        uint256 leverage; // WAD. type(uint256).max if E <= 0 and C > 0; 0 if C == 0 and E > 0
        uint256 collateralRatio; // WAD. type(uint256).max if S == 0
        Mode mode;
        bool marketOpen;
        bool gapGuard;
        bool mintsPaused; // local pause || RiskOracle pause || feed halted
        uint256 triggerLev; // effective (after gap guard)
        uint256 targetLev; // effective (after gap guard)
        uint256 lowerTriggerLev; // effective
        uint256 maxMintLev; // effective mintStable cap
        uint256 stableMintFeeBps; // current dynamic fee
        uint256 leverMintFeeBps; // current dynamic fee
        IRiskOracle.Source riskSource;
        uint256 snapshotId;
    }

    /// @notice What rebalance() would do now. Never reverts.
    struct RebalancePreview {
        Zone zone;
        Route route;
        uint256 sizeUsd; // full target size D (sell) or B (buy), WAD
        uint256 chunkUsd; // what one call would execute, WAD
        uint256 amountIn; // token units in (asset for SELL/SP, usdc for BUY)
        uint256 minOut; // token units out the call will require
        uint256 cooldownLeft; // seconds until a DEX chunk is allowed
        bool executable; // the call would not revert (best effort)
    }

    /// @notice Initialize arguments (clone). Built by PoolFactory.
    struct InitArgs {
        address factory;
        address asset;
        address usdc;
        address feed;
        bytes32 assetId;
        address riskOracle;
        address calendar;
        address router;
        address stable;
        address lever;
        address stabilityPool;
        address creator;
        PoolKind kind;
        PoolParams params;
    }

    // ---------------------------------------------------------------- events

    event Seeded(address indexed by, address indexed to, uint256 cIn, uint256 xMinted, uint256 deadX, uint256 price);
    event Minted(
        address indexed user, Action indexed action, uint256 cIn, uint256 out, uint256 feeBps, uint256 price
    );
    event Redeemed(
        address indexed user,
        Action indexed action,
        uint256 sBurned,
        uint256 xBurned,
        uint256 cOut,
        uint256 uOut,
        uint256 feeBps,
        uint256 price // 0 for REDEEM_PAIR (no oracle)
    );
    event SellZone(
        uint256 levBefore,
        uint256 levAfter,
        uint256 sold, // asset units sold
        uint256 out, // usdc units received (DEX) or sUSD burned (SP)
        uint256 trigger,
        uint256 snapshotId,
        Route route
    );
    event BuyZone(
        uint256 levBefore,
        uint256 levAfter,
        uint256 spent, // usdc units
        uint256 out, // asset units received
        uint256 lowerTrigger,
        uint256 snapshotId,
        Route route
    );
    event Donated(
        address indexed donor, uint256 usdcIn, uint256 assetIn, uint256 crBefore, uint256 crAfter
    );
    event ModeChanged(Mode indexed previous, Mode indexed current);
    event FundingAccrued(uint256 minted, uint256 rateBps, uint256 dt);
    event ParamsUpdated(PoolParams params);
    event MintsPaused(bool paused, address indexed by);
    event DonorSet(address indexed donor, bool allowed, address indexed by);
    event RouterSet(address indexed router);

    // ---------------------------------------------------------------- errors

    error NotAdmin();
    error NotAdminOrGuardian();
    error NotCreatorOrAdmin();
    error NotDonor();
    error AlreadySeeded();
    error NotSeeded();
    error SeedNotEmpty();
    error SeedTooSmall();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroOutput();
    error Expired(uint256 deadline);
    error Slippage(uint256 got, uint256 min);
    error SlippageC(uint256 got, uint256 min);
    error SlippageU(uint256 got, uint256 min);
    error StalePrice(uint256 age, uint256 maxAge);
    error NoPrice();
    error FeedHalted();
    /// @notice redeemStable is held: the feed is halted, the pool is under water by more than 1 bp (V < S) and the halt started less
    ///         than MAX_REDEEM_HOLD (6 h) ago, so a cover can land before anyone redeems at the haircut.
    error RedeemHeld();
    error MintsArePaused();
    error StaleRefPrice(uint256 age, uint256 maxAge);
    error BreakerTripped(uint256 devBps, uint256 maxDevBps);
    error StabilityMode();
    error Underwater();
    error NotUnderwater();
    error LeverageTooHigh(uint256 levAfter, uint256 cap);
    error CRTooLow(uint256 crAfter, uint256 min);
    error InsufficientReserves();
    error NotInZone(uint256 lev);
    error Cooldown(uint256 secondsLeft);
    error BelowDust(uint256 usd, uint256 minUsd);
    error RebalanceCheckFailed(uint256 code);
    error BadPairRatio();
    error InvalidParams();
    error UnsupportedDecimals();

    // ------------------------------------------------------------- lifecycle

    /// @notice One-shot initializer (clone). Factory only (enforced by Initializable + factory deploys+inits atomically).
    function initialize(InitArgs calldata args) external;

    /// @notice Creator or admin, once, while X == 0 and S == 0 and C == 0 and U == 0.
    ///         Pulls cIn asset, mints value(cIn) x total at xNAV = $1: MIN_X to DEAD, rest to `to`.
    ///         Requires a fresh, non-halted price. No fee, no breaker.
    function seed(uint256 cIn, address to) external returns (uint256 xToRecipient);

    // ---------------------------------------------------------------- mints

    /// @notice Asset in, sUSD out = value(cIn) * (1 - stableMintFee). See SPEC.md for guards.
    function mintStable(uint256 cIn, uint256 minOut, uint256 deadline) external returns (uint256 sOut);

    /// @notice Asset in, x out = value(cIn) * (1 - leverMintFee) / xNAV.
    function mintLever(uint256 cIn, uint256 minOut, uint256 deadline) external returns (uint256 xOut);

    /// @notice permit() on the asset wrapped in try/catch (front-run tolerant), then mintStable.
    function mintStableWithPermit(
        uint256 cIn,
        uint256 minOut,
        uint256 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 sOut);

    function mintLeverWithPermit(
        uint256 cIn,
        uint256 minOut,
        uint256 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 xOut);

    // -------------------------------------------------------------- redeems
    // Pause NEVER blocks redeemStable, redeemPair or rebalance.

    /// @notice Burns s sUSD; pays f = s*(1-fee)/max(V,S) of C and of U. Uses maxRedeemPriceAge.
    function redeemStable(uint256 s, uint256 minC, uint256 minU) external returns (uint256 cOut, uint256 uOut);

    /// @notice Burns x; pays x*xNAV*(1-fee), stock first then U. Requires E > 0 and L_after <= trigger.
    function redeemLever(uint256 x, uint256 minC, uint256 minU) external returns (uint256 cOut, uint256 uOut);

    /// @notice Burns sUSD and x in the current S:X ratio (binding side = the smaller share) for a pro-rata
    ///         share of C and U, minus redeemFee. No oracle, never paused. When S == 0, sMax must be 0.
    function redeemPair(uint256 sMax, uint256 xMax, uint256 minC, uint256 minU)
        external
        returns (uint256 sBurned, uint256 xBurned, uint256 cOut, uint256 uOut);

    // ------------------------------------------------------------ keeper ops

    /// @notice Permissionless. Sell zone (L > trigger) or buy zone (L < lowerTrigger), one chunk per call.
    function rebalance() external returns (Zone zone, Route route, uint256 amountIn, uint256 amountOut);

    /// @notice Permissionless. Mints funding sUSD to the StabilityPool. Also run at the start of every mutation.
    function accrue() external returns (uint256 minted);

    /// @notice Allowlisted donors only, only while V < S, capped at the deficit S - V.
    ///         Takes usdc first, then asset for the remaining deficit. Returns what was actually pulled.
    function donate(uint256 usdcAmount, uint256 assetAmount)
        external
        returns (uint256 usdcAccepted, uint256 assetAccepted);

    // ----------------------------------------------------------------- admin

    /// @notice Admin only (factory DEFAULT_ADMIN_ROLE). Bounded; accrues first.
    function setParams(PoolParams calldata p) external;

    /// @notice Admin or Guardian (factory GUARDIAN_ROLE).
    function setMintsPaused(bool paused) external;

    /// @notice Admin or this pool's creator (the launcher that opened it).
    function setDonor(address donor, bool allowed) external;

    /// @notice Admin only.
    function setRouter(address router_) external;

    // ----------------------------------------------------------------- views
    // state(), maxMintStable(), currentRisk(), previewRebalance() never revert.

    function state() external view returns (PoolState memory);

    /// @notice Largest cIn (asset units) for which mintStable passes the leverage cap, with a 1 bp margin.
    ///         0 whenever mintStable would revert for a non-amount reason (stale, halted, paused, breaker,
    ///         not NORMAL, unseeded).
    function maxMintStable() external view returns (uint256 cInMax);

    /// @notice Effective risk for this pool after gap guard and pool overrides.
    function currentRisk() external view returns (IRiskOracle.RiskParams memory risk, uint256 maxMintLev);

    function previewRebalance() external view returns (RebalancePreview memory);

    /// @notice Exact output the action would deliver now. May revert with the action's errors
    ///         (except balance, allowance, minOut, deadline checks).
    function previewMintStable(uint256 cIn) external view returns (uint256 sOut, uint256 feeBps);

    function previewMintLever(uint256 cIn) external view returns (uint256 xOut, uint256 feeBps);

    function previewRedeemStable(uint256 s) external view returns (uint256 cOut, uint256 uOut, uint256 feeBps);

    function previewRedeemLever(uint256 x) external view returns (uint256 cOut, uint256 uOut, uint256 feeBps);

    function previewRedeemPair(uint256 sMax, uint256 xMax)
        external
        view
        returns (uint256 sBurned, uint256 xBurned, uint256 cOut, uint256 uOut);

    function params() external view returns (PoolParams memory);

    function reserves() external view returns (uint256 c, uint256 u);

    function factory() external view returns (address);

    function asset() external view returns (address);

    function usdc() external view returns (address);

    /// @notice This pool's sUSD-<SYM> token.
    function sUSD() external view returns (address);

    /// @notice This pool's x<SYM> token.
    function xToken() external view returns (address);

    function stabilityPool() external view returns (address);

    function feed() external view returns (address);

    function assetId() external view returns (bytes32);

    function riskOracle() external view returns (address);

    function calendar() external view returns (address);

    function router() external view returns (address);

    function creator() external view returns (address);

    function kind() external view returns (PoolKind);

    function isDonor(address who) external view returns (bool);

    function localMintsPaused() external view returns (bool);

    function lastRebalanceAt() external view returns (uint256);

    function lastAccrualAt() external view returns (uint256);

    function lastMode() external view returns (Mode);
}
