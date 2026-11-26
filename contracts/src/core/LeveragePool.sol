// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILeveragePool} from "../interfaces/ILeveragePool.sol";
import {IPoolFactory} from "../interfaces/IPoolFactory.sol";
import {IRiskOracle} from "../interfaces/IRiskOracle.sol";
import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";
import {IAggregatorV3, IHaltableFeed} from "../interfaces/IAggregatorV3.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {ISplitToken} from "../interfaces/ISplitToken.sol";
import {IStabilityPool} from "../interfaces/IStabilityPool.sol";
import {SplitConstants} from "../interfaces/SplitConstants.sol";
import {PoolMath, PoolLogic} from "./PoolMath.sol";

/// @title LeveragePool
/// @notice One SplitStock pool for one stock token. Splits deposited stock (C) into a $1 claim (sUSD-<SYM>, S)
///         and a levered residual claim (x<SYM>, X). Holds C (asset) and U (mUSDC) as internal accounting.
///           V = C·P + U     E = V − S     L = C·P / E     CR = V / S     xNAV = E / X
///         A permissionless rebalance keeps L between the lower trigger and the trigger by selling stock to a
///         DEX or to the pool's StabilityPool, or buying stock back. Exits never depend on a pause:
///         redeemStable works with a price up to a day old, redeemPair needs no oracle at all.
/// @dev EIP-1167 clone created and initialized by PoolFactory. Roles live on the factory (isAdmin/isGuardian).
///      Exact math, rounding and guards: contracts/SPEC.md §2.
contract LeveragePool is ILeveragePool, Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolMath for PoolMath.Ctx;

    /// @notice A token pull delivered a different amount than requested (fee-on-transfer tokens are rejected).
    error TransferAmountMismatch(uint256 received, uint256 expected);

    /// @dev Prices above this (WAD USD per whole unit) are treated as unusable so all arithmetic stays bounded.
    uint256 internal constant MAX_PRICE = type(uint96).max;
    uint256 internal constant BPS = 1e4;

    // ------------------------------------------------------------------ storage

    /// @inheritdoc ILeveragePool
    address public factory;
    /// @inheritdoc ILeveragePool
    address public asset;
    /// @inheritdoc ILeveragePool
    address public usdc;
    /// @inheritdoc ILeveragePool
    address public feed;
    /// @inheritdoc ILeveragePool
    bytes32 public assetId;
    /// @inheritdoc ILeveragePool
    address public riskOracle;
    /// @inheritdoc ILeveragePool
    address public calendar;
    /// @inheritdoc ILeveragePool
    address public router;
    /// @inheritdoc ILeveragePool
    address public sUSD;
    /// @inheritdoc ILeveragePool
    address public xToken;
    /// @inheritdoc ILeveragePool
    address public stabilityPool;
    /// @inheritdoc ILeveragePool
    address public creator;
    /// @inheritdoc ILeveragePool
    PoolKind public kind;

    uint256 internal aU; // 10**assetDecimals
    uint256 internal uS; // 10**(18 - usdcDecimals)
    uint256 internal fS; // 10**(18 - feedDecimals)

    PoolParams internal _p;
    uint256 internal _C;
    uint256 internal _U;

    /// @inheritdoc ILeveragePool
    bool public localMintsPaused;
    /// @inheritdoc ILeveragePool
    mapping(address => bool) public isDonor;
    /// @inheritdoc ILeveragePool
    uint256 public lastRebalanceAt;
    /// @inheritdoc ILeveragePool
    uint256 public lastAccrualAt;
    /// @inheritdoc ILeveragePool
    Mode public lastMode;

    // ------------------------------------------------------------------ lifecycle

    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc ILeveragePool
    function initialize(InitArgs calldata a) external initializer {
        if (
            a.factory == address(0) || a.asset == address(0) || a.usdc == address(0) || a.feed == address(0)
                || a.riskOracle == address(0) || a.calendar == address(0) || a.router == address(0)
                || a.stable == address(0) || a.lever == address(0) || a.stabilityPool == address(0)
                || a.creator == address(0)
        ) revert ZeroAddress();
        if (!PoolMath.paramsValid(a.params)) revert InvalidParams();

        aU = 10 ** _decimals(a.asset);
        uS = 10 ** (18 - _decimals(a.usdc));
        fS = 10 ** (18 - _decimals(a.feed));

        factory = a.factory;
        asset = a.asset;
        usdc = a.usdc;
        feed = a.feed;
        assetId = a.assetId;
        riskOracle = a.riskOracle;
        calendar = a.calendar;
        router = a.router;
        sUSD = a.stable;
        xToken = a.lever;
        stabilityPool = a.stabilityPool;
        creator = a.creator;
        kind = a.kind;
        _p = a.params;
        lastAccrualAt = block.timestamp;
        lastMode = Mode.UNSEEDED;
    }

    /// @inheritdoc ILeveragePool
    function seed(uint256 cIn, address to) external nonReentrant returns (uint256 xToRecipient) {
        if (msg.sender != creator && !IPoolFactory(factory).isAdmin(msg.sender)) revert NotCreatorOrAdmin();
        PoolMath.Ctx memory c = _load(false, false);
        xToRecipient = PoolLogic.quoteSeed(c, _p, cIn, to);

        _pull(asset, cIn);
        _C = cIn;
        lastAccrualAt = block.timestamp;
        ISplitToken(xToken).mint(SplitConstants.DEAD, SplitConstants.MIN_X);
        ISplitToken(xToken).mint(to, xToRecipient);

        emit Seeded(msg.sender, to, cIn, xToRecipient, SplitConstants.MIN_X, c.P);
        _syncMode(c);
    }

    // ------------------------------------------------------------------ mints

    /// @inheritdoc ILeveragePool
    function mintStable(uint256 cIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256) {
        return _mintStable(cIn, minOut, deadline);
    }

    /// @inheritdoc ILeveragePool
    function mintLever(uint256 cIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256) {
        return _mintLever(cIn, minOut, deadline);
    }

    /// @inheritdoc ILeveragePool
    function mintStableWithPermit(
        uint256 cIn,
        uint256 minOut,
        uint256 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        try IERC20Permit(asset).permit(msg.sender, address(this), cIn, permitDeadline, v, r, s) {} catch {}
        return _mintStable(cIn, minOut, deadline);
    }

    /// @inheritdoc ILeveragePool
    function mintLeverWithPermit(
        uint256 cIn,
        uint256 minOut,
        uint256 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        try IERC20Permit(asset).permit(msg.sender, address(this), cIn, permitDeadline, v, r, s) {} catch {}
        return _mintLever(cIn, minOut, deadline);
    }

    function _mintStable(uint256 cIn, uint256 minOut, uint256 deadline) internal returns (uint256 sOut) {
        if (deadline < block.timestamp) revert Expired(deadline);
        PoolMath.Ctx memory c = _load(true, true);
        _applyFunding(c);
        uint256 fee;
        (sOut, fee) = PoolLogic.quoteMintStable(c, _p, cIn);
        if (sOut < minOut) revert Slippage(sOut, minOut);

        _pull(asset, cIn);
        _C += cIn;
        ISplitToken(sUSD).mint(msg.sender, sOut);

        emit Minted(msg.sender, Action.MINT_STABLE, cIn, sOut, fee, c.P);
        _syncMode(c);
    }

    function _mintLever(uint256 cIn, uint256 minOut, uint256 deadline) internal returns (uint256 xOut) {
        if (deadline < block.timestamp) revert Expired(deadline);
        PoolMath.Ctx memory c = _load(true, true);
        _applyFunding(c);
        uint256 fee;
        (xOut, fee) = PoolLogic.quoteMintLever(c, _p, cIn);
        if (xOut < minOut) revert Slippage(xOut, minOut);

        _pull(asset, cIn);
        _C += cIn;
        ISplitToken(xToken).mint(msg.sender, xOut);

        emit Minted(msg.sender, Action.MINT_LEVER, cIn, xOut, fee, c.P);
        _syncMode(c);
    }

    // ------------------------------------------------------------------ redeems

    /// @inheritdoc ILeveragePool
    function redeemStable(uint256 s, uint256 minC, uint256 minU)
        external
        nonReentrant
        returns (uint256 cOut, uint256 uOut)
    {
        PoolMath.Ctx memory c = _load(true, false);
        _applyFunding(c);
        uint256 fee;
        (cOut, uOut, fee) = PoolLogic.quoteRedeemStable(c, _p, s, feed);
        _checkSlippage(cOut, uOut, minC, minU);

        ISplitToken(sUSD).burn(msg.sender, s);
        _payOut(cOut, uOut);

        emit Redeemed(msg.sender, Action.REDEEM_STABLE, s, 0, cOut, uOut, fee, c.P);
        _syncMode(c);
    }

    /// @inheritdoc ILeveragePool
    function redeemLever(uint256 x, uint256 minC, uint256 minU)
        external
        nonReentrant
        returns (uint256 cOut, uint256 uOut)
    {
        PoolMath.Ctx memory c = _load(true, true);
        _applyFunding(c);
        uint256 fee;
        (cOut, uOut, fee) = PoolLogic.quoteRedeemLever(c, _p, x);
        _checkSlippage(cOut, uOut, minC, minU);

        ISplitToken(xToken).burn(msg.sender, x);
        _payOut(cOut, uOut);

        emit Redeemed(msg.sender, Action.REDEEM_LEVER, 0, x, cOut, uOut, fee, c.P);
        _syncMode(c);
    }

    /// @inheritdoc ILeveragePool
    function redeemPair(uint256 sMax, uint256 xMax, uint256 minC, uint256 minU)
        external
        nonReentrant
        returns (uint256 sBurned, uint256 xBurned, uint256 cOut, uint256 uOut)
    {
        PoolMath.Ctx memory c = _load(true, false);
        _applyFunding(c);
        (sBurned, xBurned, cOut, uOut) = PoolLogic.quoteRedeemPair(c, _p, sMax, xMax);
        _checkSlippage(cOut, uOut, minC, minU);

        if (sBurned > 0) ISplitToken(sUSD).burn(msg.sender, sBurned);
        if (xBurned > 0) ISplitToken(xToken).burn(msg.sender, xBurned);
        _payOut(cOut, uOut);

        emit Redeemed(msg.sender, Action.REDEEM_PAIR, sBurned, xBurned, cOut, uOut, _p.redeemFeeBps, 0);
        _syncMode(c);
    }

    // ------------------------------------------------------------------ keeper ops

    /// @inheritdoc ILeveragePool
    function rebalance() external nonReentrant returns (Zone zone, Route route, uint256 amountIn, uint256 amountOut) {
        PoolMath.Ctx memory c = _load(true, true);
        _applyFunding(c);
        PoolLogic.Plan memory pl = PoolLogic.planOrRevert(c, _p, _env());
        zone = pl.zone;
        route = pl.route;
        amountIn = pl.amountIn;

        if (zone == Zone.SELL) {
            if (route == Route.STABILITY_POOL) {
                amountOut = pl.minOut; // sBurn
                _C -= amountIn;
                ISplitToken(sUSD).burn(stabilityPool, amountOut);
                IERC20(asset).safeTransfer(stabilityPool, amountIn);
                IStabilityPool(stabilityPool).offset(amountOut, amountIn);
            } else {
                amountOut = _swap(asset, usdc, amountIn, pl.minOut);
                _C -= amountIn;
                _U += amountOut;
                lastRebalanceAt = block.timestamp;
            }
        } else {
            amountOut = _swap(usdc, asset, amountIn, pl.minOut);
            _U -= amountIn;
            _C += amountOut;
            lastRebalanceAt = block.timestamp;
        }

        (uint256 code, uint256 la) =
            PoolLogic.postCheck(c, pl, _p.levEpsilon, _C, _U, IERC20(sUSD).totalSupply());
        if (code != 0) revert RebalanceCheckFailed(code);

        if (zone == Zone.SELL) emit SellZone(c.L, la, amountIn, amountOut, c.Tr, c.rv.snapshotId, route);
        else emit BuyZone(c.L, la, amountIn, amountOut, c.Lo, c.rv.snapshotId, route);
        _syncMode(c);
    }

    /// @inheritdoc ILeveragePool
    function accrue() external nonReentrant returns (uint256 minted) {
        PoolMath.Ctx memory c = _load(true, false);
        _applyFunding(c);
        _syncMode(c);
        return c.funding;
    }

    /// @inheritdoc ILeveragePool
    function donate(uint256 usdcAmount, uint256 assetAmount)
        external
        nonReentrant
        returns (uint256 usdcAccepted, uint256 assetAccepted)
    {
        if (!isDonor[msg.sender]) revert NotDonor();
        PoolMath.Ctx memory c = _load(true, false);
        _applyFunding(c);
        uint256 crAfter;
        (usdcAccepted, assetAccepted, crAfter) = PoolLogic.quoteDonate(c, _p, usdcAmount, assetAmount);

        if (usdcAccepted > 0) _pull(usdc, usdcAccepted);
        if (assetAccepted > 0) _pull(asset, assetAccepted);
        _U += usdcAccepted;
        _C += assetAccepted;

        emit Donated(msg.sender, usdcAccepted, assetAccepted, c.CR, crAfter);
        _syncMode(c);
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc ILeveragePool
    function setParams(PoolParams calldata np) external nonReentrant {
        if (!IPoolFactory(factory).isAdmin(msg.sender)) revert NotAdmin();
        PoolMath.Ctx memory c = _load(true, false);
        _applyFunding(c);
        if (!PoolMath.paramsValid(np)) revert InvalidParams();
        _p = np;
        emit ParamsUpdated(np);
        _syncMode(c);
    }

    /// @inheritdoc ILeveragePool
    function setMintsPaused(bool paused) external {
        IPoolFactory f = IPoolFactory(factory);
        if (!f.isAdmin(msg.sender) && !f.isGuardian(msg.sender)) revert NotAdminOrGuardian();
        localMintsPaused = paused;
        emit MintsPaused(paused, msg.sender);
    }

    /// @inheritdoc ILeveragePool
    function setDonor(address donor, bool allowed) external {
        if (msg.sender != creator && !IPoolFactory(factory).isAdmin(msg.sender)) revert NotCreatorOrAdmin();
        if (donor == address(0)) revert ZeroAddress();
        isDonor[donor] = allowed;
        emit DonorSet(donor, allowed, msg.sender);
    }

    /// @inheritdoc ILeveragePool
    function setRouter(address router_) external {
        if (!IPoolFactory(factory).isAdmin(msg.sender)) revert NotAdmin();
        if (router_ == address(0) || router_.code.length == 0) revert ZeroAddress();
        router = router_;
        emit RouterSet(router_);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ILeveragePool
    function state() external view returns (PoolState memory st) {
        PoolMath.Ctx memory c = _load(false, true);
        st.C = c.C;
        st.U = c.U;
        st.S = c.S;
        st.X = c.X;
        st.price = c.P;
        st.priceUpdatedAt = c.updatedAt;
        st.priceAge = c.age;
        st.priceFresh = _fresh(c, _p.maxPriceAge) && !c.halted;
        st.feedHalted = c.halted;
        st.V = c.vF;
        st.E = c.eF;
        st.xNav = c.xNav;
        st.leverage = c.L;
        st.collateralRatio = c.CR;
        st.mode = c.mode;
        st.marketOpen = c.open;
        st.gapGuard = c.gap;
        st.mintsPaused = c.paused;
        st.triggerLev = c.Tr;
        st.targetLev = c.T;
        st.lowerTriggerLev = c.Lo;
        st.maxMintLev = c.maxMintLev;
        st.stableMintFeeBps = c.stableFee;
        st.leverMintFeeBps = c.leverFee;
        st.riskSource = c.rv.source;
        st.snapshotId = c.rv.snapshotId;
    }

    /// @inheritdoc ILeveragePool
    function maxMintStable() external view returns (uint256 cInMax) {
        return PoolLogic.maxMintStable(_load(true, true), _p);
    }

    /// @inheritdoc ILeveragePool
    function currentRisk() external view returns (IRiskOracle.RiskParams memory risk, uint256 maxMintLev) {
        PoolMath.Ctx memory c = _load(false, true);
        risk = c.rv.params;
        risk.triggerLev = c.Tr;
        risk.targetLev = c.T;
        risk.lowerTriggerLev = c.Lo;
        maxMintLev = c.maxMintLev;
    }

    /// @inheritdoc ILeveragePool
    function previewRebalance() external view returns (RebalancePreview memory) {
        return PoolLogic.previewRebalance(_load(true, true), _p, _env());
    }

    /// @inheritdoc ILeveragePool
    function previewMintStable(uint256 cIn) external view returns (uint256 sOut, uint256 feeBps) {
        return PoolLogic.quoteMintStable(_load(true, true), _p, cIn);
    }

    /// @inheritdoc ILeveragePool
    function previewMintLever(uint256 cIn) external view returns (uint256 xOut, uint256 feeBps) {
        return PoolLogic.quoteMintLever(_load(true, true), _p, cIn);
    }

    /// @inheritdoc ILeveragePool
    function previewRedeemStable(uint256 s) external view returns (uint256 cOut, uint256 uOut, uint256 feeBps) {
        return PoolLogic.quoteRedeemStable(_load(true, false), _p, s, feed);
    }

    /// @inheritdoc ILeveragePool
    function previewRedeemLever(uint256 x) external view returns (uint256 cOut, uint256 uOut, uint256 feeBps) {
        return PoolLogic.quoteRedeemLever(_load(true, true), _p, x);
    }

    /// @inheritdoc ILeveragePool
    function previewRedeemPair(uint256 sMax, uint256 xMax)
        external
        view
        returns (uint256 sBurned, uint256 xBurned, uint256 cOut, uint256 uOut)
    {
        return PoolLogic.quoteRedeemPair(_load(true, false), _p, sMax, xMax);
    }

    /// @inheritdoc ILeveragePool
    function params() external view returns (PoolParams memory) {
        return _p;
    }

    /// @inheritdoc ILeveragePool
    function reserves() external view returns (uint256 c, uint256 u) {
        return (_C, _U);
    }

    // ------------------------------------------------------------------ quotes (shared by actions and previews)

    // ------------------------------------------------------------------ rebalance helpers

    function _env() internal view returns (PoolLogic.Env memory) {
        return PoolLogic.Env({
            spDeposits: IStabilityPool(stabilityPool).totalDeposits(),
            cooldownLeft: _cooldownLeft(),
            router: router,
            asset: asset,
            usdc: usdc
        });
    }


    function _cooldownLeft() internal view returns (uint256) {
        uint256 readyAt = lastRebalanceAt + _p.rebalanceCooldown;
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    /// @dev Exact-input swap through the router. Approval is exact and reset to 0. Output measured by balance delta.
    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        IERC20 tin = IERC20(tokenIn);
        IERC20 tout = IERC20(tokenOut);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));
        address r = router;
        address[] memory path = new address[](2);
        (path[0], path[1]) = (tokenIn, tokenOut);

        tin.forceApprove(r, amountIn);
        IUniswapV2Router02(r).swapExactTokensForTokens(amountIn, minOut, path, address(this), block.timestamp);
        tin.forceApprove(r, 0);

        uint256 inAfter = tin.balanceOf(address(this));
        uint256 outAfter = tout.balanceOf(address(this));
        if (inBefore < inAfter || inBefore - inAfter != amountIn || outAfter < outBefore) {
            revert RebalanceCheckFailed(5);
        }
        out = outAfter - outBefore;
        if (out < minOut) revert RebalanceCheckFailed(5);
    }

    // ------------------------------------------------------------------ context loading

    /// @dev Builds the working context. Never reverts for any feed / oracle / calendar behaviour.
    /// @param withFunding simulate pending funding into S (actions then mint it with _applyFunding)
    /// @param withRisk read RiskOracle and calendar and compute the effective params and fees
    function _load(bool withFunding, bool withRisk) internal view returns (PoolMath.Ctx memory c) {
        c.aU = aU;
        c.uS = uS;
        c.C = _C;
        c.U = _U;
        c.S = IERC20(sUSD).totalSupply();
        c.X = IERC20(xToken).totalSupply();
        _readPrice(c);
        uint256 stabilityCR = _p.stabilityCR;
        _derive(c, stabilityCR);
        if (withFunding && _pendingFunding(c)) _derive(c, stabilityCR);
        if (withRisk) _readRisk(c);
    }

    /// @dev Fills the §2.2 derived values of `c` (computed in PoolLogic to keep this contract small).
    function _derive(PoolMath.Ctx memory c, uint256 stabilityCR) internal pure {
        PoolLogic.Derived memory d = PoolLogic.derived(c, stabilityCR);
        c.cpF = d.cpF;
        c.cpC = d.cpC;
        c.vF = d.vF;
        c.vC = d.vC;
        c.eF = d.eF;
        c.eC = d.eC;
        c.xNav = d.xNav;
        c.L = d.L;
        c.CR = d.CR;
        c.mode = d.mode;
    }

    function _readPrice(PoolMath.Ctx memory c) internal view {
        address f = feed;
        (bool ok, bytes memory ret) = f.staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        if (ok && ret.length >= 160) {
            (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
            if (answer > 0 && updatedAt != 0 && uint256(answer) <= MAX_PRICE / fS) {
                c.usable = true;
                c.P = uint256(answer) * fS;
                c.updatedAt = updatedAt;
                c.age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
                c.future = updatedAt > block.timestamp + SplitConstants.MAX_FUTURE_SKEW;
            }
        }
        (ok, ret) = f.staticcall(abi.encodeWithSelector(IHaltableFeed.halted.selector));
        if (ok && ret.length >= 32) c.halted = abi.decode(ret, (uint256)) != 0;
    }

    /// @dev Pending funding (SPEC.md accrue). Adds it to c.S and returns true when non-zero.
    function _pendingFunding(PoolMath.Ctx memory c) internal view returns (bool) {
        uint256 last = lastAccrualAt;
        uint256 dt = block.timestamp > last ? Math.min(block.timestamp - last, SplitConstants.MAX_ACCRUAL_DT) : 0;
        c.fundingDt = dt;
        uint256 rate = _p.fundingRateBps;
        // SPEC.md §2.5 accrue skip list: `!usable || age > maxRedeemPriceAge`. Unlike fresh(), it has no future-skew
        // term (age saturates to 0 for a future updatedAt), so a usable future-dated price still accrues.
        if (
            dt == 0 || c.S == 0 || rate == 0 || !c.usable || c.age > _p.maxRedeemPriceAge || c.mode != Mode.NORMAL
                || IStabilityPool(stabilityPool).totalDeposits() == 0
        ) return false;
        uint256 minted = Math.mulDiv(c.S, rate * dt, BPS * SplitConstants.YEAR, Math.Rounding.Floor);
        if (minted == 0 || c.eF <= int256(minted)) return false;
        c.funding = minted;
        c.S += minted;
        return true;
    }

    function _readRisk(PoolMath.Ctx memory c) internal view {
        try IRiskOracle(riskOracle).riskView(assetId) returns (IRiskOracle.RiskView memory rv) {
            c.rv = rv;
        } catch {
            c.rv = PoolMath.fallbackView();
        }
        IMarketCalendar cal = IMarketCalendar(calendar);
        try cal.isOpen(block.timestamp) returns (bool o) {
            c.open = o;
            if (!o) {
                try cal.inGapGuard(block.timestamp, c.rv.params.gapGuardSec) returns (bool g) {
                    c.gap = g;
                } catch {}
            }
        } catch {}
        PoolLogic.Eff memory e = PoolLogic.effective(c, _p);
        c.T = e.T;
        c.Tr = e.Tr;
        c.Lo = e.Lo;
        c.maxMintLev = e.maxMintLev;
        c.baseFee = e.baseFee;
        c.stableFee = e.stableFee;
        c.leverFee = e.leverFee;
        c.localPaused = localMintsPaused;
        c.paused = c.localPaused || c.rv.mintsPaused || c.halted;
        c.riskLoaded = true;
    }

    // ------------------------------------------------------------------ effects helpers

    /// @dev Runs at the start of every mutation: records the accrual time and mints any pending funding.
    function _applyFunding(PoolMath.Ctx memory c) internal {
        lastAccrualAt = block.timestamp;
        uint256 m = c.funding;
        if (m == 0) return;
        ISplitToken(sUSD).mint(stabilityPool, m);
        IStabilityPool(stabilityPool).notifyReward(m);
        emit FundingAccrued(m, _p.fundingRateBps, c.fundingDt);
    }

    /// @dev Recomputes the mode from the post-action books at the same price; emits ModeChanged on change.
    function _syncMode(PoolMath.Ctx memory c) internal {
        c.C = _C;
        c.U = _U;
        c.S = IERC20(sUSD).totalSupply();
        c.X = IERC20(xToken).totalSupply();
        _derive(c, _p.stabilityCR);
        Mode prev = lastMode;
        if (c.mode != prev) {
            lastMode = c.mode;
            emit ModeChanged(prev, c.mode);
        }
    }

    function _payOut(uint256 cOut, uint256 uOut) internal {
        _C -= cOut;
        _U -= uOut;
        if (cOut > 0) IERC20(asset).safeTransfer(msg.sender, cOut);
        if (uOut > 0) IERC20(usdc).safeTransfer(msg.sender, uOut);
    }

    /// @dev Pull verified by balance delta, so fee-on-transfer tokens revert.
    function _pull(address token, uint256 amount) internal {
        IERC20 t = IERC20(token);
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = t.balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(received, amount);
    }

    // ------------------------------------------------------------------ guards

    function _fresh(PoolMath.Ctx memory c, uint256 maxAge) internal pure returns (bool) {
        return c.usable && c.age <= maxAge && !c.future;
    }

    function _checkSlippage(uint256 cOut, uint256 uOut, uint256 minC, uint256 minU) internal pure {
        if (cOut < minC) revert SlippageC(cOut, minC);
        if (uOut < minU) revert SlippageU(uOut, minU);
    }

    /// @dev decimals() via staticcall; must succeed and be <= 18.
    function _decimals(address token) internal view returns (uint256 d) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || ret.length < 32) revert UnsupportedDecimals();
        d = abi.decode(ret, (uint256));
        if (d > 18) revert UnsupportedDecimals();
    }
}
