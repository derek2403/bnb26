// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILeveragePool} from "../interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../interfaces/IRiskOracle.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {IHaltTime} from "../interfaces/IAggregatorV3.sol";
import {SplitConstants} from "../interfaces/SplitConstants.sol";

/// @title PoolMath
/// @notice Pure accounting math for LeveragePool (SPEC.md §1, §2.2, §2.3, §2.5, §2.6). Every helper takes an
///         explicit rounding direction: user outputs round down, required inputs round up, and every L / CR used
///         in a check rounds toward the stricter side.
library PoolMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant MAX = type(uint256).max;

    /// @notice Working snapshot of one pool for one call. Built once, then passed around in memory.
    struct Ctx {
        // scales
        uint256 aU; // 10**assetDecimals
        uint256 uS; // 10**(18 - usdcDecimals)
        // books
        uint256 C;
        uint256 U;
        uint256 S;
        uint256 X;
        // price
        bool usable;
        bool halted;
        bool future; // updatedAt > now + MAX_FUTURE_SKEW
        uint256 P; // WAD USD per whole asset unit; 0 when unusable
        uint256 updatedAt;
        uint256 age;
        // derived (§2.2)
        uint256 cpF;
        uint256 cpC;
        uint256 vF;
        uint256 vC;
        int256 eF;
        int256 eC;
        uint256 xNav;
        uint256 L;
        uint256 CR;
        ILeveragePool.Mode mode;
        // funding simulated into S
        uint256 funding;
        uint256 fundingDt;
        // risk and market (§2.3)
        bool riskLoaded;
        IRiskOracle.RiskView rv;
        bool open;
        bool gap;
        uint256 T;
        uint256 Tr;
        uint256 Lo;
        uint256 maxMintLev;
        uint256 baseFee;
        uint256 stableFee;
        uint256 leverFee;
        bool localPaused; // pool-local pause
        bool paused; // local || oracle || halted
    }

    // ------------------------------------------------------------------ unit helpers

    /// @dev asset units -> WAD USD
    function val(Ctx memory c, uint256 amount, Math.Rounding r) internal pure returns (uint256) {
        return Math.mulDiv(amount, c.P, c.aU, r);
    }

    /// @dev WAD USD -> asset units. Callers must ensure P > 0.
    function amt(Ctx memory c, uint256 usd, Math.Rounding r) internal pure returns (uint256) {
        return Math.mulDiv(usd, c.aU, c.P, r);
    }

    /// @dev usdc units -> WAD USD (exact)
    function uw(Ctx memory c, uint256 u) internal pure returns (uint256) {
        return u * c.uS;
    }

    /// @dev WAD USD -> usdc units
    function wu(Ctx memory c, uint256 w, bool ceil) internal pure returns (uint256) {
        return ceil ? Math.ceilDiv(w, c.uS) : w / c.uS;
    }

    // ------------------------------------------------------------------ derived values

    /// @notice Fills cpF..mode for the books currently in `c`.
    function derive(Ctx memory c, uint256 stabilityCR) internal pure {
        c.cpF = val(c, c.C, Math.Rounding.Floor);
        c.cpC = val(c, c.C, Math.Rounding.Ceil);
        uint256 u = uw(c, c.U);
        c.vF = c.cpF + u;
        c.vC = c.cpC + u;
        c.eF = int256(c.vF) - int256(c.S);
        c.eC = int256(c.vC) - int256(c.S);
        c.xNav = c.X == 0 ? WAD : (c.eF <= 0 ? 0 : Math.mulDiv(uint256(c.eF), WAD, c.X, Math.Rounding.Floor));
        c.L = levFrom(c.C, c.cpC, c.eF);
        c.CR = crFrom(c.vF, c.S);
        c.mode = modeOf(c, stabilityCR);
    }

    function modeOf(Ctx memory c, uint256 stabilityCR) internal pure returns (ILeveragePool.Mode) {
        if (c.X == 0) return ILeveragePool.Mode.UNSEEDED;
        if (!c.usable) return ILeveragePool.Mode.NO_PRICE;
        if (c.S > 0 && c.eF <= 0) return ILeveragePool.Mode.UNDERWATER;
        if (c.CR < stabilityCR) return ILeveragePool.Mode.STABILITY;
        return ILeveragePool.Mode.NORMAL;
    }

    /// @dev Upper estimate of L. MAX when E <= 0 with stock held, 0 with no stock.
    function levFrom(uint256 C, uint256 cpC, int256 eF) internal pure returns (uint256) {
        if (eF <= 0) return C == 0 ? 0 : MAX;
        return Math.mulDiv(cpC, WAD, uint256(eF), Math.Rounding.Ceil);
    }

    /// @dev Lower estimate of CR. MAX when S == 0.
    function crFrom(uint256 vF, uint256 S) internal pure returns (uint256) {
        return S == 0 ? MAX : Math.mulDiv(vF, WAD, S, Math.Rounding.Floor);
    }

    /// @notice E_f for hypothetical books at the context price.
    function eAt(Ctx memory c, uint256 C, uint256 U, uint256 S) internal pure returns (int256) {
        return int256(val(c, C, Math.Rounding.Floor) + uw(c, U)) - int256(S);
    }

    /// @notice L (upper estimate) for hypothetical books at the context price.
    function levAt(Ctx memory c, uint256 C, uint256 U, uint256 S) internal pure returns (uint256) {
        return levFrom(C, val(c, C, Math.Rounding.Ceil), eAt(c, C, U, S));
    }

    /// @notice CR (lower estimate) for hypothetical books at the context price.
    function crAt(Ctx memory c, uint256 C, uint256 U, uint256 S) internal pure returns (uint256) {
        return crFrom(val(c, C, Math.Rounding.Floor) + uw(c, U), S);
    }

    // ------------------------------------------------------------------ effective risk + fees (§2.3)

    function effective(Ctx memory c, ILeveragePool.PoolParams storage p) internal view {
        IRiskOracle.RiskParams memory r = c.rv.params;
        uint256 T = r.targetLev;
        uint256 Tr = r.triggerLev;
        uint256 Lo = r.lowerTriggerLev;
        if (c.gap) {
            T = Math.min(T, p.gapTargetLev);
            Tr = Math.min(Tr, p.gapTriggerLev);
        }
        Lo = Math.min(Lo, T > 0.2e18 ? T - 0.2e18 : 0);
        uint256 mm = (T + Tr) / 2;
        if (!c.open) mm = Math.min(mm, p.closedMaxLev);
        c.T = T;
        c.Tr = Tr;
        c.Lo = Lo;
        c.maxMintLev = mm;
        uint256 base = c.open ? r.openFeeBps : r.closedFeeBps;
        c.baseFee = base;

        uint256 minFee = p.minFeeBps;
        uint256 dynMax = p.dynFeeMaxBps;
        uint256 L = c.L;
        uint256 u;
        if (L >= T) {
            if (L == MAX || Tr <= T) u = BPS;
            else u = Math.min(BPS, Math.mulDiv(L - T, BPS, Tr - T));
            uint256 d = dynMax * u / BPS;
            c.stableFee = base + d;
            c.leverFee = _lower(base, d, minFee);
        } else {
            u = T > Lo ? Math.min(BPS, Math.mulDiv(T - L, BPS, T - Lo)) : BPS;
            uint256 d = dynMax * u / BPS;
            c.leverFee = base + d;
            c.stableFee = _lower(base, d, minFee);
        }
        if (c.mode == ILeveragePool.Mode.STABILITY) c.leverFee = 0;
    }

    function _lower(uint256 b, uint256 d, uint256 minFee) private pure returns (uint256) {
        if (b <= minFee) return b;
        return Math.max(minFee, b > d ? b - d : 0);
    }

    /// @dev Applies a fee in bps, rounding the result down. Fees >= 100% give 0.
    function net(uint256 x, uint256 feeBps) internal pure returns (uint256) {
        return feeBps >= BPS ? 0 : Math.mulDiv(x, BPS - feeBps, BPS, Math.Rounding.Floor);
    }

    // ------------------------------------------------------------------ rebalance sizing (§2.5)

    /// @notice USD of stock to sell so L lands on T: D = (C·P − T·E)/(1 − T·s), rounded down.
    function sellSize(Ctx memory c, uint256 s) internal pure returns (uint256) {
        if (c.eF <= 0) return c.cpF;
        uint256 te = Math.mulDiv(c.T, uint256(c.eF), WAD, Math.Rounding.Floor);
        if (c.cpF <= te) return 0;
        uint256 ts = Math.mulDiv(c.T, s, BPS, Math.Rounding.Ceil);
        if (ts >= WAD) return c.cpF;
        return Math.mulDiv(c.cpF - te, WAD, WAD - ts, Math.Rounding.Floor);
    }

    /// @notice USD of stock to buy so L lands on T: B = (T·E − C·P)/(1 + (T − 1)·s), rounded down.
    function buySize(Ctx memory c, uint256 s) internal pure returns (uint256) {
        if (c.eF <= 0) return 0;
        uint256 te = Math.mulDiv(c.T, uint256(c.eF), WAD, Math.Rounding.Floor);
        if (te <= c.cpC) return 0;
        uint256 t1 = c.T > WAD ? c.T - WAD : 0;
        return Math.mulDiv(te - c.cpC, WAD, WAD + Math.mulDiv(t1, s, BPS, Math.Rounding.Ceil), Math.Rounding.Floor);
    }

    // ------------------------------------------------------------------ params bounds (§2.6)

    /// @notice True iff every field is inside the hard bounds of SPEC.md §2.6.
    function paramsValid(ILeveragePool.PoolParams memory p) internal pure returns (bool) {
        return p.redeemFeeBps <= 100 && p.stabilityRedeemFeeBps >= p.redeemFeeBps && p.stabilityRedeemFeeBps <= 300
            && p.dynFeeMaxBps <= 200 && p.minFeeBps <= 100 && p.fundingRateBps <= 1500 && p.maxPriceAge >= 30
            && p.maxPriceAge <= 3600 && p.maxRedeemPriceAge >= p.maxPriceAge && p.maxRedeemPriceAge <= 7 days
            && p.maxRefAge >= 300 && p.maxRefAge <= 7200 && p.maxSlipBps >= 10 && p.maxSlipBps <= 200
            && p.spDiscountBps <= 300 && p.rebalanceCooldown <= 3600 && p.minRebalanceUsd <= 1000e18
            && p.stabilityCR >= 1.1e18 && p.stabilityCR <= 2e18 && p.closedMaxLev >= 1.5e18 && p.closedMaxLev <= 3e18
            && p.gapTargetLev >= 1.4e18 && p.gapTargetLev <= 2.2e18 && p.gapTriggerLev >= p.gapTargetLev + 0.3e18
            && p.gapTriggerLev <= 3e18 && p.levEpsilon >= 0.001e18 && p.levEpsilon <= 0.2e18;
    }

    /// @notice SPEC.md §2.6 defaults.
    function defaultParams() internal pure returns (ILeveragePool.PoolParams memory p) {
        p = ILeveragePool.PoolParams({
            redeemFeeBps: 20,
            stabilityRedeemFeeBps: 100,
            dynFeeMaxBps: 50,
            minFeeBps: 10,
            fundingRateBps: 400,
            maxPriceAge: 120,
            maxRedeemPriceAge: 86400,
            maxRefAge: 3600,
            maxSlipBps: 50,
            spDiscountBps: 100,
            rebalanceCooldown: 30,
            minRebalanceUsd: 1e18,
            stabilityCR: 1.3e18,
            closedMaxLev: 2.2e18,
            gapTargetLev: 1.8e18,
            gapTriggerLev: 2.3e18,
            levEpsilon: 0.05e18
        });
    }

    /// @notice Built-in risk fallback used when RiskOracle.riskView reverts (§2.3): mints paused, no ref price.
    function fallbackView() internal pure returns (IRiskOracle.RiskView memory v) {
        v.params = IRiskOracle.RiskParams({
            triggerLev: 2.2e18,
            targetLev: 1.9e18,
            lowerTriggerLev: 1.5e18,
            maxDevBps: 150,
            openFeeBps: 100,
            closedFeeBps: 100,
            gapGuardSec: 7200,
            maxSellChunkUsd: 1_000e18
        });
        v.source = IRiskOracle.Source.FALLBACK;
        v.mintsPaused = true;
    }
}

/// @title PoolLogic
/// @notice Action quotes (shared by LeveragePool's actions and preview* views), maxMintStable, rebalance planning
///         and post-trade checks (SPEC.md §2.4, §2.5). Deployed as an external library (DELEGATECALL) to keep
///         LeveragePool under the 24,576-byte limit. Nothing here writes state: router quotes are view calls
///         wrapped in try/catch, and the quote functions revert with ILeveragePool's custom errors.
library PoolLogic {
    using PoolMath for PoolMath.Ctx;

    uint256 internal constant BPS = 1e4;
    uint256 internal constant WAD = 1e18;

    // Plan error codes; LeveragePool maps them to its custom errors.
    uint256 internal constant E_NOT_SEEDED = 1;
    uint256 internal constant E_NO_PRICE = 2;
    uint256 internal constant E_STALE = 3; // (age, maxAge)
    uint256 internal constant E_HALTED = 4;
    uint256 internal constant E_NOT_IN_ZONE = 5; // (lev)
    uint256 internal constant E_COOLDOWN = 6; // (secondsLeft)
    uint256 internal constant E_DUST = 7; // (usd, minUsd)
    uint256 internal constant E_CHECK = 8; // (code)
    uint256 internal constant E_ZERO_OUT = 9;

    /// @notice One rebalance step, computed without side effects.
    struct Plan {
        ILeveragePool.Zone zone;
        ILeveragePool.Route route;
        uint256 sizeUsd; // full target size D (sell) or B (buy), WAD
        uint256 chunkUsd;
        uint256 amountIn; // asset (sell) or usdc (buy)
        uint256 minOut; // router minOut, or sBurn for the SP route
        uint256 cooldownLeft;
        uint256 value; // WAD USD of amountIn
        uint256 s; // slippage (DEX) or discount (SP) budget, bps
        uint256 quote; // expected out (router quote, or sBurn for SP)
        uint256 err;
        uint256 e1;
        uint256 e2;
    }

    /// @notice Pool context the planner cannot read from Ctx.
    struct Env {
        uint256 spDeposits;
        uint256 cooldownLeft;
        address router;
        address asset;
        address usdc;
    }

    /// @notice §2.2 derived values for the books in `c`, as computed by PoolMath.derive.
    struct Derived {
        uint256 cpF;
        uint256 cpC;
        uint256 vF;
        uint256 vC;
        int256 eF;
        int256 eC;
        uint256 xNav;
        uint256 L;
        uint256 CR;
        ILeveragePool.Mode mode;
    }

    function derived(PoolMath.Ctx memory c, uint256 stabilityCR) public pure returns (Derived memory) {
        c.derive(stabilityCR);
        return Derived(c.cpF, c.cpC, c.vF, c.vC, c.eF, c.eC, c.xNav, c.L, c.CR, c.mode);
    }

    /// @notice Effective trigger/target/lower, mint cap and dynamic fees (SPEC.md §2.3), as computed by
    ///         PoolMath.effective on a copy of the context.
    struct Eff {
        uint256 T;
        uint256 Tr;
        uint256 Lo;
        uint256 maxMintLev;
        uint256 baseFee;
        uint256 stableFee;
        uint256 leverFee;
    }

    function effective(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p) public view returns (Eff memory) {
        c.effective(p);
        return Eff(c.T, c.Tr, c.Lo, c.maxMintLev, c.baseFee, c.stableFee, c.leverFee);
    }

    /// @notice Plans one rebalance chunk. Never reverts for oracle/router behaviour; failures are in pl.err.
    function plan(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, Env memory env)
        public
        view
        returns (Plan memory pl)
    {
        if (c.X == 0) return _fail(pl, E_NOT_SEEDED, 0, 0);
        if (!c.usable) return _fail(pl, E_NO_PRICE, 0, 0);
        if (c.future || c.age > p.maxPriceAge) return _fail(pl, E_STALE, c.age, p.maxPriceAge);
        if (c.halted) return _fail(pl, E_HALTED, 0, 0);

        if (c.L > c.Tr) {
            pl.zone = ILeveragePool.Zone.SELL;
            _planSell(c, p, env, pl);
        } else if (c.L < c.Lo && c.U > 0 && c.eF > 0 && c.mode == ILeveragePool.Mode.NORMAL && !c.gap) {
            pl.zone = ILeveragePool.Zone.BUY;
            _planBuy(c, p, env, pl);
        } else {
            _fail(pl, E_NOT_IN_ZONE, c.L, 0);
        }
    }

    /// @notice plan(), reverting with the matching ILeveragePool error when the plan fails.
    function planOrRevert(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, Env memory env)
        public
        view
        returns (Plan memory pl)
    {
        pl = plan(c, p, env);
        uint256 e = pl.err;
        if (e == 0) return pl;
        if (e == E_NOT_SEEDED) revert ILeveragePool.NotSeeded();
        if (e == E_NO_PRICE) revert ILeveragePool.NoPrice();
        if (e == E_STALE) revert ILeveragePool.StalePrice(pl.e1, pl.e2);
        if (e == E_HALTED) revert ILeveragePool.FeedHalted();
        if (e == E_NOT_IN_ZONE) revert ILeveragePool.NotInZone(pl.e1);
        if (e == E_COOLDOWN) revert ILeveragePool.Cooldown(pl.e1);
        if (e == E_DUST) revert ILeveragePool.BelowDust(pl.e1, pl.e2);
        if (e == E_ZERO_OUT) revert ILeveragePool.ZeroOutput();
        revert ILeveragePool.RebalanceCheckFailed(pl.e1);
    }

    /// @notice What rebalance() would do now; `executable` also runs the post-trade checks on the quoted fill.
    function previewRebalance(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, Env memory env)
        public
        view
        returns (ILeveragePool.RebalancePreview memory r)
    {
        Plan memory pl = plan(c, p, env);
        r.zone = pl.zone;
        r.route = pl.route;
        r.sizeUsd = pl.sizeUsd;
        r.chunkUsd = pl.chunkUsd;
        r.amountIn = pl.amountIn;
        r.minOut = pl.minOut;
        r.cooldownLeft = pl.cooldownLeft;
        if (pl.err == 0) {
            uint256 ca = c.C;
            uint256 ua = c.U;
            uint256 sa = c.S;
            if (pl.zone == ILeveragePool.Zone.SELL) {
                ca -= pl.amountIn;
                if (pl.route == ILeveragePool.Route.STABILITY_POOL) sa -= pl.quote;
                else ua += pl.quote;
            } else {
                ua -= pl.amountIn;
                ca += pl.quote;
            }
            (uint256 code,) = postCheck(c, pl, p.levEpsilon, ca, ua, sa);
            r.executable = code == 0;
        }
    }

    /// @notice Post-trade checks on the books after the trade. Returns (code, La); code 0 = pass.
    ///         2: L did not move the right way; 3: overshoot past target ± levEpsilon; 4: E loss above budget.
    function postCheck(PoolMath.Ctx memory c, Plan memory pl, uint256 eps, uint256 ca, uint256 ua, uint256 sa)
        public
        pure
        returns (uint256 code, uint256 la)
    {
        la = c.levAt(ca, ua, sa);
        int256 ea = c.eAt(ca, ua, sa);
        uint256 loss = c.eF > ea ? uint256(c.eF - ea) : 0;
        uint256 tol = Math.mulDiv(pl.value, pl.s, BPS, Math.Rounding.Ceil) + 2;
        if (pl.zone == ILeveragePool.Zone.SELL) {
            // With E <= 0 before the trade L is unbounded, so direction and overshoot are not meaningful.
            if (c.eF > 0) {
                if (la >= c.L) return (2, la);
                if (la < (c.T > eps ? c.T - eps : 0)) return (3, la);
            }
        } else {
            if (la <= c.L) return (2, la);
            if (la > c.T + eps) return (3, la);
        }
        if (loss > tol) return (4, la);
    }

    function _planSell(
        PoolMath.Ctx memory c,
        ILeveragePool.PoolParams storage p,
        Env memory env,
        Plan memory pl
    ) private view {
        uint256 spD = env.spDeposits;
        // Never absorb at par while underwater: it would move value from remaining sUSD holders to depositors.
        bool spEligible = spD > 0 && c.mode != ILeveragePool.Mode.UNDERWATER;
        if (
            spEligible
                && (c.mode == ILeveragePool.Mode.STABILITY || (c.mode == ILeveragePool.Mode.NORMAL && !c.open))
        ) {
            _planSp(c, p, spD, pl);
            return;
        }

        pl.route = ILeveragePool.Route.DEX;
        pl.cooldownLeft = env.cooldownLeft;
        if (env.cooldownLeft > 0) {
            _fail(pl, E_COOLDOWN, env.cooldownLeft, 0);
            return;
        }
        uint256 s = p.maxSlipBps;
        pl.s = s;
        pl.sizeUsd = c.sellSize(s);
        uint256 chunk = Math.min(pl.sizeUsd, c.rv.params.maxSellChunkUsd);
        uint256 minUsd = p.minRebalanceUsd;
        if (chunk < minUsd) {
            _fail(pl, E_DUST, chunk, minUsd);
            return;
        }
        for (uint256 i; i < SplitConstants.MAX_CHUNK_HALVINGS; ++i) {
            uint256 cSold = Math.min(c.C, c.amt(chunk, Math.Rounding.Floor));
            if (cSold == 0) break;
            uint256 value = c.val(cSold, Math.Rounding.Floor);
            uint256 minOut = c.wu(Math.mulDiv(value, BPS - s, BPS, Math.Rounding.Ceil), true);
            uint256 q = _quote(env.router, cSold, env.asset, env.usdc);
            if (q > 0 && q >= minOut) {
                pl.chunkUsd = chunk;
                pl.amountIn = cSold;
                pl.minOut = minOut;
                pl.value = value;
                pl.quote = q;
                return;
            }
            chunk /= 2;
            if (chunk < minUsd) break;
        }
        if (spEligible) {
            _planSp(c, p, spD, pl);
            return;
        }
        _fail(pl, E_CHECK, 1, 0);
    }

    function _planSp(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 spD, Plan memory pl)
        private
        view
    {
        uint256 disc = p.spDiscountBps;
        pl.route = ILeveragePool.Route.STABILITY_POOL;
        pl.s = disc;
        pl.sizeUsd = c.sellSize(disc);
        uint256 chunk = Math.min(pl.sizeUsd, Math.mulDiv(spD, BPS, BPS - disc, Math.Rounding.Floor));
        uint256 cSold = Math.min(c.C, c.amt(chunk, Math.Rounding.Floor));
        uint256 value = c.val(cSold, Math.Rounding.Floor);
        uint256 sBurn = Math.min(spD, Math.mulDiv(value, BPS - disc, BPS, Math.Rounding.Ceil));
        if (cSold == 0 || sBurn == 0) {
            _fail(pl, E_ZERO_OUT, 0, 0);
            return;
        }
        pl.chunkUsd = chunk;
        pl.amountIn = cSold;
        pl.minOut = sBurn;
        pl.value = value;
        pl.quote = sBurn;
    }

    function _planBuy(
        PoolMath.Ctx memory c,
        ILeveragePool.PoolParams storage p,
        Env memory env,
        Plan memory pl
    ) private view {
        pl.route = ILeveragePool.Route.DEX;
        pl.cooldownLeft = env.cooldownLeft;
        if (env.cooldownLeft > 0) {
            _fail(pl, E_COOLDOWN, env.cooldownLeft, 0);
            return;
        }
        uint256 s = p.maxSlipBps;
        pl.s = s;
        pl.sizeUsd = c.buySize(s);
        uint256 chunk = Math.min(Math.min(pl.sizeUsd, c.uw(c.U)), c.rv.params.maxSellChunkUsd);
        uint256 minUsd = p.minRebalanceUsd;
        if (chunk < minUsd) {
            _fail(pl, E_DUST, chunk, minUsd);
            return;
        }
        for (uint256 i; i < SplitConstants.MAX_CHUNK_HALVINGS; ++i) {
            uint256 uIn = Math.min(c.U, c.wu(chunk, false));
            if (uIn == 0) break;
            uint256 value = c.uw(uIn);
            uint256 minOut = c.amt(Math.mulDiv(value, BPS - s, BPS, Math.Rounding.Ceil), Math.Rounding.Ceil);
            uint256 q = _quote(env.router, uIn, env.usdc, env.asset);
            if (q > 0 && q >= minOut) {
                pl.chunkUsd = chunk;
                pl.amountIn = uIn;
                pl.minOut = minOut;
                pl.value = value;
                pl.quote = q;
                return;
            }
            chunk /= 2;
            if (chunk < minUsd) break;
        }
        _fail(pl, E_CHECK, 1, 0);
    }

    function _quote(address router, uint256 amountIn, address from, address to) private view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        try IUniswapV2Router02(router).getAmountsOut(amountIn, path) returns (uint256[] memory a) {
            if (a.length >= 2) return a[1];
        } catch {}
        return 0;
    }

    function _fail(Plan memory pl, uint256 err, uint256 e1, uint256 e2) private pure returns (Plan memory) {
        pl.err = err;
        pl.e1 = e1;
        pl.e2 = e2;
        return pl;
    }

    // ------------------------------------------------------------------ action quotes (SPEC.md §2.4, §2.5)
    // Shared by the actions and the preview* views. They revert with ILeveragePool's errors.

    /// @notice seed() checks and x minted to the recipient (SPEC.md §2.5 seed). 1 x = $1 at seed.
    function quoteSeed(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 cIn, address to)
        public
        view
        returns (uint256 xToRecipient)
    {
        if (c.X > 0) revert ILeveragePool.AlreadySeeded();
        if (c.S != 0 || c.C != 0 || c.U != 0) revert ILeveragePool.SeedNotEmpty();
        if (to == address(0)) revert ILeveragePool.ZeroAddress();
        if (cIn == 0) revert ILeveragePool.ZeroAmount();
        _requireFresh(c, p);
        if (c.halted) revert ILeveragePool.FeedHalted();
        uint256 xTotal = c.val(cIn, Math.Rounding.Floor);
        if (xTotal <= SplitConstants.MIN_X) revert ILeveragePool.SeedTooSmall();
        xToRecipient = xTotal - SplitConstants.MIN_X;
    }

    /// @notice donate() acceptance: usdc first, then asset, capped at the deficit S − V (V rounded up), only
    ///         while V < S. Returns the accepted amounts and CR after.
    function quoteDonate(
        PoolMath.Ctx memory c,
        ILeveragePool.PoolParams storage p,
        uint256 usdcAmount,
        uint256 assetAmount
    ) public view returns (uint256 usdcAccepted, uint256 assetAccepted, uint256 crAfter) {
        // Allowed while the feed is halted (at the latest, halted price) so a cover can land during the redeem hold.
        _requireFresh(c, p);
        if (c.S <= c.vC) revert ILeveragePool.NotUnderwater();
        uint256 deficit = c.S - c.vC;
        usdcAccepted = Math.min(usdcAmount, c.wu(deficit, false));
        deficit -= c.uw(usdcAccepted);
        assetAccepted = Math.min(assetAmount, c.amt(deficit, Math.Rounding.Floor));
        if (usdcAccepted == 0 && assetAccepted == 0) revert ILeveragePool.ZeroAmount();
        crAfter = c.crAt(c.C + assetAccepted, c.U + usdcAccepted, c.S);
    }

    /// @notice SPEC.md §2.5 maxMintStable: 0 unless mintStable could pass for a non-amount reason.
    function maxMintStable(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p) public view returns (uint256) {
        if (
            c.X == 0 || c.mode != ILeveragePool.Mode.NORMAL || !_fresh(c, p.maxPriceAge) || c.halted || c.paused
                || c.eF <= 0
        ) return 0;
        (uint256 code,,) = _breaker(c, p);
        if (code != 0) return 0;

        uint256 mE = Math.mulDiv(c.maxMintLev, uint256(c.eF), WAD, Math.Rounding.Floor);
        uint256 aL = mE > c.cpC ? mE - c.cpC : 0;
        uint256 k = p.stabilityCR;
        uint256 kS = Math.mulDiv(k, c.S, WAD, Math.Rounding.Ceil);
        uint256 aCR = c.vF > kS ? Math.mulDiv(c.vF - kS, WAD, k - WAD, Math.Rounding.Floor) : 0;
        uint256 a = Math.mulDiv(Math.min(aL, aCR), BPS - 1, BPS, Math.Rounding.Floor);
        return c.amt(a, Math.Rounding.Floor);
    }

    function _fresh(PoolMath.Ctx memory c, uint256 maxAge) private pure returns (bool) {
        return c.usable && c.age <= maxAge && !c.future;
    }

    function _requireFresh(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p) private view {
        if (!c.usable) revert ILeveragePool.NoPrice();
        uint256 maxAge = p.maxPriceAge;
        if (!_fresh(c, maxAge)) revert ILeveragePool.StalePrice(c.age, maxAge);
    }

    function quoteMintStable(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 cIn) public view returns (uint256 sOut, uint256 fee) {
        _mintGuards(c, p, cIn);
        if (c.mode == ILeveragePool.Mode.STABILITY) revert ILeveragePool.StabilityMode();
        if (c.mode != ILeveragePool.Mode.NORMAL) revert ILeveragePool.Underwater();
        fee = c.stableFee;
        sOut = PoolMath.net(c.val(cIn, Math.Rounding.Floor), fee);
        if (sOut == 0) revert ILeveragePool.ZeroOutput();

        uint256 lp = c.levAt(c.C + cIn, c.U, c.S + sOut);
        if (lp > c.maxMintLev) revert ILeveragePool.LeverageTooHigh(lp, c.maxMintLev);
        uint256 crp = c.crAt(c.C + cIn, c.U, c.S + sOut);
        if (crp < p.stabilityCR) revert ILeveragePool.CRTooLow(crp, p.stabilityCR);
    }

    function quoteMintLever(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 cIn) public view returns (uint256 xOut, uint256 fee) {
        _mintGuards(c, p, cIn);
        if (c.mode == ILeveragePool.Mode.UNDERWATER || c.eC <= 0) revert ILeveragePool.Underwater();
        fee = c.leverFee;
        uint256 vNet = PoolMath.net(c.val(cIn, Math.Rounding.Floor), fee);
        // E rounded up so that fewer x are minted.
        xOut = Math.mulDiv(vNet, c.X, uint256(c.eC), Math.Rounding.Floor);
        if (xOut == 0) revert ILeveragePool.ZeroOutput();
    }

    function quoteRedeemStable(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 s, address feed)
        public
        view
        returns (uint256 cOut, uint256 uOut, uint256 fee)
    {
        if (s == 0) revert ILeveragePool.ZeroAmount();
        if (!c.usable) revert ILeveragePool.NoPrice();
        uint256 maxAge = p.maxRedeemPriceAge;
        if (!_fresh(c, maxAge)) revert ILeveragePool.StalePrice(c.age, maxAge);
        // Halt hold: under water by more than 1 bp (a cover rounds to whole usdc units, so dust never holds).
        if (c.halted && c.vC + c.S / BPS < c.S && _holdActive(feed)) revert ILeveragePool.RedeemHeld();
        fee = p.redeemFeeBps;
        uint256 sNet = PoolMath.net(s, fee);
        uint256 den = Math.max(c.vC, c.S);
        if (den == 0) revert ILeveragePool.ZeroOutput();
        cOut = Math.mulDiv(c.C, sNet, den, Math.Rounding.Floor);
        uOut = Math.mulDiv(c.U, sNet, den, Math.Rounding.Floor);
        if (cOut + uOut == 0) revert ILeveragePool.ZeroOutput();
    }

    /// @dev True while block.timestamp < feed.haltedAtSrc() + MAX_REDEEM_HOLD. No hold when the read fails or is 0.
    function _holdActive(address feed) private view returns (bool) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSelector(IHaltTime.haltedAtSrc.selector));
        if (!ok || ret.length < 32) return false;
        uint256 t = abi.decode(ret, (uint256));
        return t != 0 && t <= type(uint64).max && block.timestamp < t + SplitConstants.MAX_REDEEM_HOLD;
    }

    function quoteRedeemLever(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 x)
        internal
        view
        returns (uint256 cOut, uint256 uOut, uint256 fee)
    {
        if (x == 0) revert ILeveragePool.ZeroAmount();
        _requireFresh(c, p);
        if (c.halted) revert ILeveragePool.FeedHalted();
        if (c.eF <= 0) revert ILeveragePool.Underwater();
        fee = c.mode == ILeveragePool.Mode.STABILITY ? p.stabilityRedeemFeeBps : p.redeemFeeBps;

        uint256 valueNet = PoolMath.net(Math.mulDiv(x, uint256(c.eF), c.X, Math.Rounding.Floor), fee);
        cOut = Math.min(c.C, c.amt(valueNet, Math.Rounding.Floor)); // stock first
        uint256 paid = c.val(cOut, Math.Rounding.Ceil);
        uint256 rem = valueNet > paid ? valueNet - paid : 0;
        uOut = Math.min(c.U, c.wu(rem, false));
        if (cOut + uOut == 0) revert ILeveragePool.ZeroOutput();

        uint256 lp = c.levAt(c.C - cOut, c.U - uOut, c.S);
        if (lp > c.Tr) revert ILeveragePool.LeverageTooHigh(lp, c.Tr);
    }

    function quoteRedeemPair(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 sMax, uint256 xMax)
        internal
        view
        returns (uint256 sBurn, uint256 xBurn, uint256 cOut, uint256 uOut)
    {
        uint256 S = c.S;
        uint256 X = c.X;
        if (X == 0) revert ILeveragePool.NotSeeded();
        uint256 num;
        uint256 den;
        if (S == 0) {
            if (sMax != 0) revert ILeveragePool.BadPairRatio();
            xBurn = Math.min(xMax, X);
            (num, den) = (xBurn, X);
        } else {
            // Amounts above supply can never be burned; capping keeps the products below 2**256.
            sMax = Math.min(sMax, S);
            xMax = Math.min(xMax, X);
            if (sMax * X <= xMax * S) {
                sBurn = sMax;
                xBurn = Math.mulDiv(sMax, X, S, Math.Rounding.Ceil);
                (num, den) = (sBurn, S);
            } else {
                xBurn = xMax;
                sBurn = Math.mulDiv(xMax, S, X, Math.Rounding.Ceil);
                (num, den) = (xBurn, X);
            }
        }
        if (xBurn == 0 && sBurn == 0) revert ILeveragePool.ZeroAmount();
        uint256 fee = p.redeemFeeBps;
        cOut = PoolMath.net(Math.mulDiv(c.C, num, den, Math.Rounding.Floor), fee);
        uOut = PoolMath.net(Math.mulDiv(c.U, num, den, Math.Rounding.Floor), fee);
        if (cOut + uOut == 0) revert ILeveragePool.ZeroOutput();
    }

    /// @dev SPEC.md §2.4 checks 2-8 (the deadline is checked by the action).
    function _mintGuards(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p, uint256 cIn) public view {
        if (cIn == 0) revert ILeveragePool.ZeroAmount();
        if (c.X == 0) revert ILeveragePool.NotSeeded();
        if (c.localPaused || c.rv.mintsPaused) revert ILeveragePool.MintsArePaused();
        _requireFresh(c, p);
        if (c.halted) revert ILeveragePool.FeedHalted();
        (uint256 code, uint256 a, uint256 b) = _breaker(c, p);
        if (code == 1) revert ILeveragePool.StaleRefPrice(a, b);
        if (code == 2) revert ILeveragePool.BreakerTripped(a, b);
    }

    /// @dev CMC reference breaker. code 0 = pass, 1 = stale/missing ref (age, max), 2 = tripped (dev, max).
    function _breaker(PoolMath.Ctx memory c, ILeveragePool.PoolParams storage p) private view returns (uint256 code, uint256 a, uint256 b) {
        uint256 ref = c.rv.refPrice;
        uint256 maxRefAge = p.maxRefAge;
        if (ref == 0) return (1, type(uint256).max, maxRefAge);
        uint256 ts = c.rv.refTs;
        uint256 refAge = block.timestamp > ts ? block.timestamp - ts : 0;
        if (refAge > maxRefAge) return (1, refAge, maxRefAge);
        uint256 diff = c.P > ref ? c.P - ref : ref - c.P;
        uint256 dev = Math.mulDiv(diff, BPS, ref, Math.Rounding.Ceil);
        uint256 maxDev = c.rv.params.maxDevBps;
        if (dev > maxDev) return (2, dev, maxDev);
    }
}
