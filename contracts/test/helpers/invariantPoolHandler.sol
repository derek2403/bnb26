// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILeveragePool} from "../../src/interfaces/ILeveragePool.sol";
import {IRiskOracle} from "../../src/interfaces/IRiskOracle.sol";
import {SplitConstants} from "../../src/interfaces/SplitConstants.sol";
import {LeveragePool} from "../../src/core/LeveragePool.sol";
import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {RiskOracle} from "../../src/core/RiskOracle.sol";
import {MockERC20Permit} from "../../src/mocks/MockERC20Permit.sol";
import {MockRouter} from "../../src/mocks/MockRouter.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";

/// @notice Stateful fuzz handler for one LeveragePool (SPEC.md §13.1). Every user action is wrapped in
///         try/catch; when an action succeeds, the handler checks its outcome against the spec and records
///         violations per property id. The invariant contract asserts every counter is zero.
/// @dev Value arithmetic uses the "num" scale: USD WAD * aU (asset units * P + usdc units * uS * aU), which is
///      exact (no rounding) for the bounded amounts used here.
contract PoolHandler is Test {
    using Math for uint256;

    uint256 internal constant BPS = 1e4;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX = type(uint256).max;

    // ----------------------------------------------------------------- property ids
    uint256 public constant P_ROUND_TRIP = 1; // mint -> immediate redeem never profits
    uint256 public constant P_EXIT_STABLE = 2; // redeemStable never blocked for holders (pause/halt/any mode), except the bounded halt hold (RedeemHeld)
    uint256 public constant P_EXIT_PAIR = 3; // redeemPair never blocked for holders (no oracle needed)
    uint256 public constant P_DILUTION = 4; // at fixed P no user action lowers xNAV or min(1, CR)
    uint256 public constant P_ROUNDING = 5; // every user output <= the exact (unrounded) entitlement
    uint256 public constant P_LEVERAGE = 6; // §13.1.6 leverage limits
    uint256 public constant P_MODE_GATE = 7; // §13.1.8 underwater / stability gates
    uint256 public constant P_REBALANCE = 8; // §13.1.7 rebalance post-conditions
    uint256 public constant P_MAX_MINT = 9; // §13.1.11 maxMintStable is mintable
    uint256 public constant P_DONATE = 10; // donation capped at deficit, never gifts x holders
    uint256 public constant P_SP_WITHDRAW = 11; // SP withdraw never blocked
    uint256 public constant P_PREVIEW = 12; // preview / action consistency
    uint256 public constant P_TOTALITY = 13; // accrue never reverts
    uint256 public constant N_PROPS = 14;

    mapping(uint256 => uint256) public failures;
    mapping(uint256 => string) public firstFailure;
    mapping(string => uint256) public calls;

    LeveragePool public pool;
    MockERC20Permit public asset;
    MockERC20Permit public usdc;
    MockAggregator public feed;
    RiskOracle public risk;
    MockRouter public router;
    StabilityPool public sp;
    IERC20 public sUSD;
    IERC20 public xT;
    address public donor;
    address public backstop;
    bytes32 public assetId;
    bool public priceMoves;
    uint256 public aU;
    uint256 public uS;
    int256 public lastAnswer;

    address[] internal _actors;
    mapping(address => uint256) public funded; // asset units minted to an actor by the handler
    uint256 public totalFunded;

    constructor(
        LeveragePool pool_,
        MockAggregator feed_,
        RiskOracle risk_,
        MockRouter router_,
        address donor_,
        address backstop_,
        address[] memory actors_,
        bool priceMoves_
    ) {
        pool = pool_;
        feed = feed_;
        risk = risk_;
        router = router_;
        donor = donor_;
        backstop = backstop_;
        priceMoves = priceMoves_;
        asset = MockERC20Permit(pool_.asset());
        usdc = MockERC20Permit(pool_.usdc());
        sp = StabilityPool(pool_.stabilityPool());
        sUSD = IERC20(pool_.sUSD());
        xT = IERC20(pool_.xToken());
        assetId = pool_.assetId();
        aU = 10 ** asset.decimals();
        uS = 10 ** (18 - usdc.decimals());
        (, lastAnswer,,,) = feed_.latestRoundData();
        for (uint256 i; i < actors_.length; ++i) {
            address a = actors_[i];
            _actors.push(a);
            vm.startPrank(a);
            asset.approve(address(pool_), MAX);
            sUSD.approve(address(sp), MAX);
            vm.stopPrank();
        }
        vm.startPrank(donor_);
        asset.approve(address(pool_), MAX);
        usdc.approve(address(pool_), MAX);
        vm.stopPrank();
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    // ================================================================ user actions

    function mintStable(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        ILeveragePool.PoolState memory b = _prep();
        uint256 cIn = _mintAmt(amtSeed);
        _fund(a, cIn);
        vm.prank(a);
        try pool.mintStable(cIn, 0, block.timestamp) returns (uint256 sOut) {
            calls["mintStable"]++;
            _afterMintStable(b, cIn, sOut, "mintStable");
        } catch {}
    }

    /// @notice §13.1.11: when maxMintStable() > 0, mintStable(maxMintStable()) succeeds.
    function mintMax(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        ILeveragePool.PoolState memory b = _prep();
        uint256 m = pool.maxMintStable();
        if (m == 0 || m > 1e30) return;
        _fund(a, m);
        vm.prank(a);
        try pool.mintStable(m, 0, block.timestamp) returns (uint256 sOut) {
            calls["mintMax"]++;
            _afterMintStable(b, m, sOut, "mintMax");
        } catch (bytes memory err) {
            _fail(
                P_MAX_MINT,
                string.concat(
                    "mintStable(maxMintStable()=", vm.toString(m), ") reverted ", vm.toString(err), " L=",
                    vm.toString(b.leverage), " cap=", vm.toString(b.maxMintLev)
                )
            );
        }
    }

    function mintLever(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        ILeveragePool.PoolState memory b = _prep();
        uint256 cIn = _logAmt(amtSeed, 1, 1e24);
        _fund(a, cIn);
        vm.prank(a);
        try pool.mintLever(cIn, 0, block.timestamp) returns (uint256 xOut) {
            calls["mintLever"]++;
            _afterMintLever(b, cIn, xOut);
        } catch {}
    }

    function redeemStable(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 bal = sUSD.balanceOf(a);
        if (bal == 0) return;
        ILeveragePool.PoolState memory b = _prep();
        uint256 s = _logAmt(amtSeed, 1, bal);
        vm.prank(a);
        try pool.redeemStable(s, 0, 0) returns (uint256 cOut, uint256 uOut) {
            calls["redeemStable"]++;
            _afterRedeemStable(b, s, cOut, uOut);
        } catch (bytes memory err) {
            // The halt hold (halted + under water, at most MAX_REDEEM_HOLD) is a bounded, specified block.
            if (!(bytes4(err) == ILeveragePool.RedeemHeld.selector && b.feedHalted && b.V < b.S) && _stableExitExpected(b, s)) {
                _fail(P_EXIT_STABLE, string.concat("redeemStable(", vm.toString(s), ") reverted ", vm.toString(err)));
            }
        }
    }

    function redeemLever(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 bal = xT.balanceOf(a);
        if (bal == 0) return;
        ILeveragePool.PoolState memory b = _prep();
        uint256 x = _logAmt(amtSeed, 1, bal);
        vm.prank(a);
        try pool.redeemLever(x, 0, 0) returns (uint256 cOut, uint256 uOut) {
            calls["redeemLever"]++;
            _afterRedeemLever(b, x, cOut, uOut);
        } catch {}
    }

    function redeemPair(uint256 actorSeed, uint256 sSeed, uint256 xSeed) external {
        address a = _actor(actorSeed);
        uint256 sb = sUSD.balanceOf(a);
        uint256 xb = xT.balanceOf(a);
        if (xb == 0) return;
        ILeveragePool.PoolState memory b = _prep();
        uint256 sMax = (b.S == 0 || sb == 0) ? 0 : _logAmt(sSeed, 1, sb);
        uint256 xMax = _logAmt(xSeed, 1, xb);
        vm.prank(a);
        try pool.redeemPair(sMax, xMax, 0, 0) returns (uint256 sB, uint256 xB, uint256 cOut, uint256 uOut) {
            calls["redeemPair"]++;
            _afterRedeemPair(b, sB, xB, cOut, uOut);
        } catch (bytes memory err) {
            if (_pairExitExpected(b, sMax, xMax)) {
                _fail(
                    P_EXIT_PAIR,
                    string.concat(
                        "redeemPair(", vm.toString(sMax), ",", vm.toString(xMax), ") reverted ", vm.toString(err)
                    )
                );
            }
        }
    }

    /// @notice SPEC.md §13.1.4: mint then an immediate redeem at the same P returns <= the input.
    function roundTrip(uint256 actorSeed, uint256 amtSeed, uint256 path) external {
        address a = _actor(actorSeed);
        ILeveragePool.PoolState memory b = _prep();
        if (b.price == 0) return;
        uint256 cIn = _mintAmt(amtSeed);
        path %= 3;
        if (path == 0) {
            _fund(a, cIn);
            vm.prank(a);
            try pool.mintStable(cIn, 0, block.timestamp) returns (uint256 sOut) {
                vm.prank(a);
                try pool.redeemStable(sOut, 0, 0) returns (uint256 c, uint256 u) {
                    calls["roundTrip.stable"]++;
                    _checkRoundTrip(cIn, c, u, 0, b.price, "mintStable->redeemStable");
                } catch {}
            } catch {}
        } else if (path == 1) {
            _fund(a, cIn);
            vm.prank(a);
            try pool.mintLever(cIn, 0, block.timestamp) returns (uint256 xOut) {
                vm.prank(a);
                try pool.redeemLever(xOut, 0, 0) returns (uint256 c, uint256 u) {
                    calls["roundTrip.lever"]++;
                    _checkRoundTrip(cIn, c, u, 0, b.price, "mintLever->redeemLever");
                } catch {}
            } catch {}
        } else {
            uint256 c2 = _logAmt(uint256(keccak256(abi.encode(amtSeed))), 1, 1e22);
            _fund(a, cIn + c2);
            _pairRoundTrip(a, cIn, c2, b.price);
        }
    }

    function _pairRoundTrip(address a, uint256 c1, uint256 c2, uint256 P) internal {
        vm.prank(a);
        try pool.mintStable(c1, 0, block.timestamp) returns (uint256 sOut) {
            vm.prank(a);
            try pool.mintLever(c2, 0, block.timestamp) returns (uint256 xOut) {
                vm.prank(a);
                try pool.redeemPair(sOut, xOut, 0, 0) returns (uint256 sB, uint256 xB, uint256 c, uint256 u) {
                    calls["roundTrip.pair"]++;
                    // Leftover tokens valued at their mark-to-market claim (an upper bound of their exit value).
                    ILeveragePool.PoolState memory st = pool.state();
                    uint256 leftWad = Math.mulDiv(sOut - sB, Math.min(WAD, st.collateralRatio), WAD)
                        + Math.mulDiv(xOut - xB, st.xNav, WAD);
                    _checkRoundTrip(c1 + c2, c, u, leftWad, P, "mintStable+mintLever->redeemPair");
                } catch {}
            } catch {}
        } catch {}
    }

    function donate(uint256 uSeed, uint256 cSeed) external {
        ILeveragePool.PoolState memory b = _prep();
        uint256 uAmt = _logAmt(uSeed, 0, 1e12 * 1e18 / uS);
        uint256 cAmt = _logAmt(cSeed, 0, 1e24);
        if (usdc.balanceOf(donor) < uAmt) usdc.mint(donor, uAmt);
        if (asset.balanceOf(donor) < cAmt) asset.mint(donor, cAmt);
        vm.prank(donor);
        try pool.donate(uAmt, cAmt) returns (uint256 uAcc, uint256 cAcc) {
            calls["donate"]++;
            if (b.S <= b.V) {
                _fail(P_DONATE, string.concat("donate accepted while V >= S: V=", vm.toString(b.V), " S=", vm.toString(b.S)));
            }
            if (uAcc > uAmt || cAcc > cAmt) _fail(P_DONATE, "donate accepted more than offered");
            ILeveragePool.PoolState memory a = pool.state();
            if (a.E > 1) {
                _fail(P_DONATE, string.concat("donation overfilled the deficit: E after = ", vm.toString(a.E)));
            }
            if (a.collateralRatio < b.collateralRatio) _fail(P_DONATE, "donation lowered CR");
        } catch {}
    }

    function rebalance(uint256) external {
        ILeveragePool.PoolState memory b = _prep();
        ILeveragePool.RebalancePreview memory pv = pool.previewRebalance();
        uint256 spD = sp.totalDeposits();
        (IRiskOracle.RiskParams memory rp,) = pool.currentRisk();
        try pool.rebalance() returns (ILeveragePool.Zone z, ILeveragePool.Route r, uint256 amtIn, uint256) {
            calls[z == ILeveragePool.Zone.SELL ? (r == ILeveragePool.Route.DEX ? "rebalance.sellDex" : "rebalance.sellSp") : "rebalance.buy"]++;
            _afterRebalance(b, pv, rp, spD, z, r, amtIn);
        } catch (bytes memory err) {
            if (pv.executable) {
                _fail(P_PREVIEW, string.concat("previewRebalance executable but rebalance reverted ", vm.toString(err)));
            }
            // §13.1.7 / R5: inside the band (Lo <= L <= Tr) with a fresh, unhalted price the revert is NotInZone,
            // checked before the cooldown.
            if (
                b.X > 0 && b.priceFresh && b.leverage >= b.lowerTriggerLev && b.leverage <= b.triggerLev
                    && bytes4(err) != ILeveragePool.NotInZone.selector
            ) {
                _fail(P_REBALANCE, string.concat("in-band rebalance reverted with ", vm.toString(err), " not NotInZone"));
            }
        }
    }

    function accrue() external {
        try pool.accrue() {
            calls["accrue"]++;
        } catch (bytes memory err) {
            _fail(P_TOTALITY, string.concat("accrue reverted ", vm.toString(err)));
        }
    }

    function spDeposit(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 bal = sUSD.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = _logAmt(amtSeed, 1, bal);
        vm.prank(a);
        try sp.deposit(amt) {
            calls["spDeposit"]++;
        } catch {}
    }

    function spWithdraw(uint256 actorSeed, uint256 amtSeed) external {
        address a = _actor(actorSeed);
        uint256 d = sp.depositOf(a);
        (uint256 g1, uint256 g2) = sp.gainsOf(a);
        if (d == 0 && g1 == 0 && g2 == 0) return;
        uint256 amt = (d == 0 || amtSeed % 4 == 0) ? MAX : _logAmt(amtSeed, 1, d);
        vm.prank(a);
        try sp.withdraw(amt) {
            calls["spWithdraw"]++;
        } catch (bytes memory err) {
            _fail(P_SP_WITHDRAW, string.concat("SP withdraw reverted ", vm.toString(err)));
        }
    }

    // ================================================================ environment actions

    /// @notice Bounded random walk (+-5%) or jump (-60%..+60%), clamped to [$1, $10,000]; optionally re-posts
    ///         the CMC reference at the new price so the breaker passes.
    function movePrice(uint256 kind, int256 bpsSeed, bool postRef) external {
        if (!priceMoves) return;
        int256 bps = kind % 4 == 0 ? _bound(bpsSeed, -6000, 6000) : _bound(bpsSeed, -500, 500);
        int256 n = lastAnswer * (10_000 + bps) / 10_000;
        if (n < 1e8) n = 1e8;
        if (n > 1e12) n = 1e12;
        lastAnswer = n;
        feed.setAnswer(n);
        calls["movePrice"]++;
        if (postRef) _postRef(uint256(n) * 1e10);
    }

    function warp(uint256 secs, bool refresh) external {
        if (!priceMoves) return;
        secs = secs % 16 == 0 ? _bound(secs, 1 hours, 3 days) : _bound(secs, 1, 2 hours);
        vm.warp(block.timestamp + secs);
        calls["warp"]++;
        if (refresh) {
            feed.setAnswer(lastAnswer);
            _postRef(uint256(lastAnswer) * 1e10);
        }
    }

    /// @notice Pause / halt toggles. None of them may block redeemStable, redeemPair, rebalance or SP withdraw.
    function togglePause(uint256 which) external {
        which %= 8;
        if (which == 0) pool.setMintsPaused(!pool.localMintsPaused());
        else if (which == 1) risk.setMintsPaused(assetId, !risk.mintsPaused(assetId));
        else if (which == 2) feed.setHalted(!feed.halted());
        else if (which == 3 && priceMoves) feed.setRevertOnRead(!feed.revertOnRead());
        else {
            // clear everything
            if (pool.localMintsPaused()) pool.setMintsPaused(false);
            if (risk.mintsPaused(assetId)) risk.setMintsPaused(assetId, false);
            if (feed.halted()) feed.setHalted(false);
            if (feed.revertOnRead()) feed.setRevertOnRead(false);
        }
        calls["togglePause"]++;
    }

    function setFill(uint256 slipSeed, int256 offSeed) external {
        if (!priceMoves) return;
        router.setFill(address(pool), _bound(slipSeed, 0, 100), _bound(offSeed, -100, 100));
        calls["setFill"]++;
    }

    // ================================================================ bank run (called by invariants)

    /// @notice Every holder exits at once (SP first, then redeemPair, then redeemStable), then the state is
    ///         restored. Returns the number of exits that reverted although the spec says they must not.
    function bankRun() external returns (uint256 fails, string memory why) {
        uint256 snap = vm.snapshotState();
        try pool.accrue() {} catch {}
        for (uint256 i; i < _actors.length; ++i) {
            address a = _actors[i];
            (uint256 g1, uint256 g2) = sp.gainsOf(a);
            if (sp.depositOf(a) == 0 && g1 == 0 && g2 == 0) continue;
            vm.prank(a);
            try sp.withdraw(MAX) {} catch (bytes memory err) {
                fails++;
                why = string.concat("bankRun SP withdraw reverted ", vm.toString(err));
            }
        }
        uint256 n = _actors.length + 1;
        for (uint256 i; i < n; ++i) {
            address h = i < _actors.length ? _actors[i] : backstop;
            ILeveragePool.PoolState memory b = pool.state();
            uint256 s = sUSD.balanceOf(h);
            uint256 x = xT.balanceOf(h);
            if (x > 0 && (s > 0 || b.S == 0)) {
                uint256 sMax = b.S == 0 ? 0 : s;
                vm.prank(h);
                try pool.redeemPair(sMax, x, 0, 0) {} catch (bytes memory err) {
                    if (_pairExitExpected(b, sMax, x)) {
                        fails++;
                        why = string.concat("bankRun redeemPair reverted ", vm.toString(err));
                    }
                }
            }
            s = sUSD.balanceOf(h);
            if (s > 0) {
                b = pool.state();
                vm.prank(h);
                try pool.redeemStable(s, 0, 0) {} catch (bytes memory err) {
                    if (!(bytes4(err) == ILeveragePool.RedeemHeld.selector && b.feedHalted && b.V < b.S) && _stableExitExpected(b, s)) {
                        fails++;
                        why = string.concat("bankRun redeemStable(", vm.toString(s), ") reverted ", vm.toString(err));
                    }
                }
            }
        }
        vm.revertToState(snap);
    }

    // ================================================================ post-action checks

    function _afterMintStable(ILeveragePool.PoolState memory b, uint256 cIn, uint256 sOut, string memory what)
        internal
    {
        if (b.mode != ILeveragePool.Mode.NORMAL) {
            _fail(P_MODE_GATE, string.concat(what, " succeeded in mode ", vm.toString(uint256(b.mode))));
        }
        uint256 ideal = Math.mulDiv(cIn, b.price * (BPS - b.stableMintFeeBps), aU * BPS);
        if (sOut > ideal) {
            _fail(P_ROUNDING, string.concat(what, " sOut ", vm.toString(sOut), " > exact ", vm.toString(ideal)));
        }
        ILeveragePool.PoolState memory a = pool.state();
        if (a.leverage > b.maxMintLev) {
            _fail(
                P_LEVERAGE,
                string.concat(what, " L after ", vm.toString(a.leverage), " > maxMintLev ", vm.toString(b.maxMintLev))
            );
        }
        if (a.collateralRatio < pool.params().stabilityCR) {
            _fail(P_LEVERAGE, string.concat(what, " CR after ", vm.toString(a.collateralRatio), " < stabilityCR"));
        }
        _checkNoDilution(b, a, what);
    }

    function _afterMintLever(ILeveragePool.PoolState memory b, uint256 cIn, uint256 xOut) internal {
        uint256 vnum = _vnum(b.C, b.U, b.price);
        if (b.mode == ILeveragePool.Mode.UNDERWATER || vnum <= b.S * aU) {
            _fail(P_MODE_GATE, "mintLever succeeded with E <= 0");
            return;
        }
        uint256 eNum = vnum - b.S * aU;
        uint256 ideal = Math.mulDiv(cIn * b.price * (BPS - b.leverMintFeeBps), b.X, eNum * BPS);
        if (xOut > ideal) {
            _fail(P_ROUNDING, string.concat("mintLever xOut ", vm.toString(xOut), " > exact ", vm.toString(ideal)));
        }
        ILeveragePool.PoolState memory a = pool.state();
        // Moves L toward 1 (with a fee f, the fixed point is 1/(1-f)); never above max(Lb, 1/(1-f)).
        uint256 lim = Math.max(b.leverage, Math.mulDiv(WAD, BPS, BPS - b.leverMintFeeBps, Math.Rounding.Ceil));
        if (b.leverage != MAX && a.leverage > lim + 1) {
            _fail(
                P_LEVERAGE,
                string.concat("mintLever raised L ", vm.toString(b.leverage), " -> ", vm.toString(a.leverage))
            );
        }
        _checkNoDilution(b, a, "mintLever");
    }

    function _afterRedeemStable(ILeveragePool.PoolState memory b, uint256 s, uint256 cOut, uint256 uOut) internal {
        uint256 fee = pool.params().redeemFeeBps;
        uint256 sNum = s * (BPS - fee);
        uint256 cMax;
        uint256 uMax;
        if (b.price > 0) {
            uint256 vnum = _vnum(b.C, b.U, b.price);
            if (vnum >= b.S * aU) {
                // V >= S: a share worth sNet of the exact V.
                cMax = Math.mulDiv(b.C * aU, sNum, vnum * BPS);
                uMax = Math.mulDiv(b.U * aU, sNum, vnum * BPS);
            } else {
                cMax = Math.mulDiv(b.C, sNum, b.S * BPS);
                uMax = Math.mulDiv(b.U, sNum, b.S * BPS);
            }
            if (cOut > cMax || uOut > uMax) {
                _fail(
                    P_ROUNDING,
                    string.concat(
                        "redeemStable paid (", vm.toString(cOut), ",", vm.toString(uOut), ") > exact (",
                        vm.toString(cMax), ",", vm.toString(uMax), ")"
                    )
                );
            }
        }
        if (b.mode == ILeveragePool.Mode.UNDERWATER) {
            uint256 sNet = sNum / BPS;
            uint256 cExp = Math.mulDiv(b.C, sNet, b.S);
            uint256 uExp = Math.mulDiv(b.U, sNet, b.S);
            if (_absDiff(cOut, cExp) > 1 || _absDiff(uOut, uExp) > 1) {
                _fail(
                    P_MODE_GATE,
                    string.concat(
                        "underwater redeemStable not sNet/S pro rata: c ", vm.toString(cOut), " vs ",
                        vm.toString(cExp), ", u ", vm.toString(uOut), " vs ", vm.toString(uExp)
                    )
                );
            }
        }
        _checkNoDilution(b, pool.state(), "redeemStable");
    }

    function _afterRedeemLever(ILeveragePool.PoolState memory b, uint256 x, uint256 cOut, uint256 uOut) internal {
        uint256 vnum = _vnum(b.C, b.U, b.price);
        if (b.mode == ILeveragePool.Mode.UNDERWATER || b.E <= 0 || vnum <= b.S * aU) {
            _fail(P_MODE_GATE, "redeemLever succeeded with E <= 0");
            return;
        }
        ILeveragePool.PoolParams memory p = pool.params();
        uint256 fee = b.mode == ILeveragePool.Mode.STABILITY ? p.stabilityRedeemFeeBps : p.redeemFeeBps;
        uint256 maxNum = Math.mulDiv(x * (BPS - fee), vnum - b.S * aU, b.X * BPS);
        uint256 paid = _vnum(cOut, uOut, b.price);
        if (paid > maxNum) {
            _fail(
                P_ROUNDING,
                string.concat("redeemLever paid value ", vm.toString(paid / aU), " > exact ", vm.toString(maxNum / aU))
            );
        }
        ILeveragePool.PoolState memory a = pool.state();
        if (a.leverage > b.triggerLev) {
            _fail(
                P_LEVERAGE,
                string.concat("redeemLever L after ", vm.toString(a.leverage), " > trigger ", vm.toString(b.triggerLev))
            );
        }
        _checkNoDilution(b, a, "redeemLever");
    }

    function _afterRedeemPair(ILeveragePool.PoolState memory b, uint256 sB, uint256 xB, uint256 cOut, uint256 uOut)
        internal
    {
        uint256 fee = pool.params().redeemFeeBps;
        uint256 cMax = Math.mulDiv(b.C, xB * (BPS - fee), b.X * BPS);
        uint256 uMax = Math.mulDiv(b.U, xB * (BPS - fee), b.X * BPS);
        if (b.S > 0) {
            cMax = Math.min(cMax, Math.mulDiv(b.C, sB * (BPS - fee), b.S * BPS));
            uMax = Math.min(uMax, Math.mulDiv(b.U, sB * (BPS - fee), b.S * BPS));
        } else if (sB != 0) {
            _fail(P_ROUNDING, "redeemPair burned sUSD while S == 0");
        }
        if (cOut > cMax || uOut > uMax) {
            _fail(
                P_ROUNDING,
                string.concat(
                    "redeemPair paid (", vm.toString(cOut), ",", vm.toString(uOut), ") > pro-rata of the smaller burn (",
                    vm.toString(cMax), ",", vm.toString(uMax), ")"
                )
            );
        }
        ILeveragePool.PoolState memory a = pool.state();
        if (b.price > 0 && b.E > 0 && a.E > 0 && b.leverage != MAX && a.leverage != MAX && a.X >= 1e15) {
            // L never rises (rounding retained in the pool lowers it), beyond 1e-12 relative noise.
            if (a.leverage > b.leverage + b.leverage / 1e12 + 10) {
                _fail(
                    P_LEVERAGE,
                    string.concat("redeemPair raised L ", vm.toString(b.leverage), " -> ", vm.toString(a.leverage))
                );
            }
            // For a burn of at most half the supply, L moves by the retained fee only (§13.1.6, §2.5 redeemPair).
            if (xB * 2 <= b.X && uint256(b.E) >= 1e18) {
                uint256 lMin = _pairFeeOnlyMinL(b, sB, xB, fee);
                if (a.leverage + lMin / 1e4 + 10 < lMin) {
                    _fail(
                        P_LEVERAGE,
                        string.concat(
                            "redeemPair (<=50% burn) moved L by more than the fee: ", vm.toString(b.leverage), " -> ",
                            vm.toString(a.leverage), " (fee-only floor ", vm.toString(lMin), ")"
                        )
                    );
                }
            }
        }
        _checkNoDilution(b, a, "redeemPair");
    }

    /// @dev Fee-only prediction of L after redeemPair. With payout share k and fee f, C and V shrink by
    ///      k(1-f) while S shrinks by k, so E' = E(1-k) + k f V and L'/L = (1-k+kf) / (1-k+kf·V/E). With V/E
    ///      about 2 (L ~ 2, the SPEC §13.1.6 "<= 0.5%" case) this is a drop of ~0.1-0.2% at the 20 bps default;
    ///      near CR 1 (V/E large) the same fee legitimately moves L much more, so a fixed 0.5% bound is wrong
    ///      there. The check allows 0.01% (plus the measurement rounding of L) below this floor.
    function _pairFeeOnlyMinL(ILeveragePool.PoolState memory b, uint256 sB, uint256 xB, uint256 fee)
        internal
        pure
        returns (uint256)
    {
        uint256 kW = Math.mulDiv(xB, WAD, b.X);
        if (b.S > 0) kW = Math.min(kW, Math.mulDiv(sB, WAD, b.S));
        uint256 keep = (WAD - kW) * BPS;
        uint256 num = keep + kW * fee;
        uint256 den = keep + Math.mulDiv(kW * fee, b.V, uint256(b.E), Math.Rounding.Ceil);
        return Math.mulDiv(b.leverage, num, den);
    }

    function _afterRebalance(
        ILeveragePool.PoolState memory b,
        ILeveragePool.RebalancePreview memory pv,
        IRiskOracle.RiskParams memory rp,
        uint256 spD,
        ILeveragePool.Zone z,
        ILeveragePool.Route r,
        uint256 amtIn
    ) internal {
        bool isSp = r == ILeveragePool.Route.STABILITY_POOL;
        if (isSp && b.mode == ILeveragePool.Mode.UNDERWATER) _fail(P_MODE_GATE, "SP route used while UNDERWATER");
        if (isSp && spD == 0) _fail(P_REBALANCE, "SP route with no deposits");
        if (amtIn != pv.amountIn) {
            _fail(
                P_PREVIEW,
                string.concat("rebalance amountIn ", vm.toString(amtIn), " != preview ", vm.toString(pv.amountIn))
            );
        }
        uint256 value;
        if (z == ILeveragePool.Zone.SELL) {
            value = Math.mulDiv(amtIn, b.price, aU);
            _checkSell(b, isSp, value, pv.sizeUsd, rp.maxSellChunkUsd);
        } else {
            value = amtIn * uS;
            _checkBuy(b);
        }
        ILeveragePool.PoolParams memory p = pool.params();
        uint256 s = isSp ? p.spDiscountBps : p.maxSlipBps;
        int256 loss = b.E - pool.state().E;
        if (loss > 0 && uint256(loss) > Math.mulDiv(value, s, BPS, Math.Rounding.Ceil) + 2) {
            _fail(P_REBALANCE, string.concat("rebalance E loss ", vm.toString(loss), " above slippage budget"));
        }
    }

    function _checkSell(ILeveragePool.PoolState memory b, bool isSp, uint256 value, uint256 sizeUsd, uint256 chunk)
        internal
    {
        uint256 la = pool.state().leverage;
        uint256 eps = pool.params().levEpsilon;
        if (b.leverage <= b.triggerLev) _fail(P_REBALANCE, "sell zone fired with L <= trigger");
        if (b.E > 0) {
            if (la >= b.leverage) _fail(P_REBALANCE, "sell did not lower L");
            if (la + eps < b.targetLev) {
                _fail(
                    P_REBALANCE,
                    string.concat("sell overshoot: La ", vm.toString(la), " < T - eps, T=", vm.toString(b.targetLev))
                );
            }
        }
        if (value > sizeUsd + 1) _fail(P_REBALANCE, "sold more than D");
        if (!isSp && value > chunk + 1) _fail(P_REBALANCE, "DEX sell above the chunk cap");
    }

    function _checkBuy(ILeveragePool.PoolState memory b) internal {
        uint256 la = pool.state().leverage;
        if (b.leverage >= b.lowerTriggerLev) _fail(P_REBALANCE, "buy zone fired with L >= lower trigger");
        if (la <= b.leverage) _fail(P_REBALANCE, "buy did not raise L");
        if (la > b.targetLev + pool.params().levEpsilon) _fail(P_REBALANCE, "buy overshoot above T + eps");
    }

    function _checkRoundTrip(uint256 cIn, uint256 cOut, uint256 uOut, uint256 leftWad, uint256 P, string memory what)
        internal
    {
        uint256 outNum = _vnum(cOut, uOut, P) + leftWad * aU;
        uint256 inNum = cIn * P;
        if (outNum > inNum + aU) {
            _fail(
                P_ROUND_TRIP,
                string.concat(what, " profit: in ", vm.toString(inNum / aU), " out ", vm.toString(outNum / aU), " (USD wei)")
            );
        }
    }

    /// @dev §13.1.3: at a fixed P no user action lowers xNAV (-1 wei, plus the E_f floor measurement noise of
    ///      1e18/X) or the sUSD backing min(1e18, CR).
    function _checkNoDilution(ILeveragePool.PoolState memory b, ILeveragePool.PoolState memory a, string memory what)
        internal
    {
        if (b.price == 0 || a.price != b.price || a.X == 0) return;
        uint256 tolX = 1 + Math.ceilDiv(WAD, a.X);
        if (a.xNav + tolX < b.xNav) {
            _fail(
                P_DILUTION,
                string.concat(what, " lowered xNAV ", vm.toString(b.xNav), " -> ", vm.toString(a.xNav))
            );
        }
        uint256 bb = Math.min(WAD, b.collateralRatio);
        uint256 ab = Math.min(WAD, a.collateralRatio);
        uint256 tolS = a.S == 0 ? 0 : 1 + Math.ceilDiv(2 * WAD, a.S);
        if (ab + tolS < bb) {
            _fail(
                P_DILUTION,
                string.concat(what, " lowered sUSD backing ", vm.toString(bb), " -> ", vm.toString(ab))
            );
        }
    }

    // ================================================================ expectations

    /// @dev redeemStable must work for any holder while the price is usable and <= maxRedeemPriceAge old,
    ///      regardless of pauses, halts or mode, for any amount that is not dust.
    function _stableExitExpected(ILeveragePool.PoolState memory b, uint256 s) internal view returns (bool) {
        if (b.price == 0) return false;
        if (b.priceAge > pool.params().maxRedeemPriceAge) return false;
        if (b.priceUpdatedAt > block.timestamp + SplitConstants.MAX_FUTURE_SKEW) return false;
        if (b.V < 1e18 || b.S == 0) return false;
        return Math.mulDiv(s, b.V, Math.max(b.V, b.S)) >= 1e15;
    }

    /// @dev redeemPair needs no oracle at all: it must work whenever the pro-rata payout is not dust.
    function _pairExitExpected(ILeveragePool.PoolState memory b, uint256 sMax, uint256 xMax)
        internal
        pure
        returns (bool)
    {
        if (b.X == 0 || xMax == 0) return false;
        uint256 share;
        if (b.S == 0) {
            share = Math.mulDiv(Math.min(xMax, b.X), WAD, b.X);
        } else {
            if (sMax == 0) return false;
            share = Math.min(Math.mulDiv(Math.min(sMax, b.S), WAD, b.S), Math.mulDiv(Math.min(xMax, b.X), WAD, b.X));
        }
        return Math.mulDiv(b.C, share, WAD) >= 1e6 || Math.mulDiv(b.U, share, WAD) >= 1e6;
    }

    // ================================================================ helpers

    function _prep() internal returns (ILeveragePool.PoolState memory) {
        try pool.accrue() {} catch (bytes memory err) {
            _fail(P_TOTALITY, string.concat("accrue reverted ", vm.toString(err)));
        }
        return pool.state();
    }

    function _postRef(uint256 ref) internal {
        IRiskOracle.Snapshot memory last = risk.latestSnapshot(assetId);
        if (block.timestamp <= last.cmcTs) return;
        risk.post(
            assetId,
            IRiskOracle.Snapshot({
                refPrice: ref,
                volBps: 5000,
                liqUsd: 1_000_000e18,
                premiumBps: 0,
                cmcTs: block.timestamp,
                snapshotId: last.snapshotId + 1,
                responseHash: bytes32(last.snapshotId + 1)
            })
        );
    }

    function _fund(address a, uint256 amt) internal {
        uint256 bal = asset.balanceOf(a);
        if (bal < amt) {
            uint256 d = amt - bal;
            asset.mint(a, d);
            funded[a] += d;
            totalFunded += d;
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[seed % _actors.length];
    }

    /// @dev Half the time a mint that fits under maxMintStable (so actions mostly succeed), else dust..1e24.
    function _mintAmt(uint256 seed) internal view returns (uint256) {
        if (seed % 2 == 0) {
            uint256 m = pool.maxMintStable();
            if (m > 1) return _bound(seed / 2, 1, m);
        }
        return _logAmt(seed, 1, 1e24);
    }

    /// @dev Log-uniform-ish amount in [lo, hi]: picks a magnitude 10^0..10^30 first.
    function _logAmt(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 digits = seed % 31;
        uint256 cap = 10 ** digits;
        if (cap > hi) cap = hi;
        if (cap < lo) cap = lo;
        return _bound(seed / 31, lo, cap);
    }

    function _vnum(uint256 c, uint256 u, uint256 P) internal view returns (uint256) {
        return c * P + u * uS * aU;
    }

    function _absDiff(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x - y : y - x;
    }

    function _fail(uint256 id, string memory why) internal {
        if (failures[id] == 0) firstFailure[id] = why;
        failures[id]++;
    }
}
