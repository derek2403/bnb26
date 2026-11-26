// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

import {ILeveragePool} from "src/interfaces/ILeveragePool.sol";
import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";
import {FeedLib} from "src/launch/FeedLib.sol";

/// @notice The two OpenFour FeeRouter claims the treasury uses (public ABI, `IOpenFourFeeRouter`).
interface IOpenFourFeeClaims {
    function claimDevFee(address quoteAsset, address to) external;
    function claimPartnerFee(address quoteAsset, address to) external;
    function devFeePending(address quoteAsset, address author) external view returns (uint256);
    function partnerFeePending(address quoteAsset, address partner) external view returns (uint256);
}

/// @title BackstopTreasury
/// @notice The Four.meme / OpenFour side of the SplitStock backstop. It is the SplitPool preset's author and every
///         launched meme's `partner`, so preset developer fees and the partner share of protocol fees accrue to it in
///         the quote asset (tTSLA). The OpenFour migrate module seeds the new TSLA pool with `to = this`, so it also
///         holds that pool's protocol-owned first-loss xTSLA, which can never leave.
///
///           sweep()      permissionless: FeeRouter.claimDevFee / claimPartnerFee for every quote asset -> here
///           cover(pool)  permissionless: only a SplitStock pool whose x this treasury holds (or one the admin
///                        registered), only while CR < 1 with a fresh price; donates held mUSDC first, then the
///                        pool's own stock asset, capped by the pool at S - V and here by 50% of each holding per day.
///
///         The admin (deployer, then the Timelock) can configure fee routing, quote assets and feeds, and forward
///         calls to the OpenFour Registry (to author the preset). It has no withdrawal, sweep or transfer function, and
///         the registry target can never be a token this treasury holds.
contract BackstopTreasury is ReentrancyGuard {
    using SafeTransferLib for address;

    uint256 internal constant BPS = 10_000;
    uint256 public constant EPOCH = 1 days;
    /// @notice Share of each held asset cover may spend per epoch.
    uint256 public constant EPOCH_CAP_BPS = 5000;
    /// @notice Price age used for `bufferUsd()` freshness (display only; cover uses the pool's own fresh price).
    uint256 public constant FEED_MAX_AGE = 1 days;

    IPoolFactory public immutable poolFactory;
    address public immutable usdc;

    address public admin;
    address public pendingAdmin;
    /// @notice OpenFour FeeRouter of our fork (0 until set).
    address public feeRouter;
    /// @notice OpenFour Registry of our fork; settable once.
    address public registry;

    address[] internal _quoteAssets;
    mapping(address asset => bool) public isQuoteAsset;
    /// @notice asset => USD AggregatorV3 used by `bufferUsd()` (display only).
    mapping(address asset => address feed) public feedOf;
    /// @notice Pools the admin allowed to be covered even when this treasury holds none of their x.
    mapping(address pool => bool) public registeredPool;
    /// @notice epoch => token => amount spent on cover.
    mapping(uint256 epoch => mapping(address token => uint256 amount)) public spent;
    /// @notice USD (WAD) donated to pools so far.
    uint256 public totalDefendedUsd;

    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error RegistryAlreadySet();
    error RegistryIsHeldToken(address target);
    error RegistryCallFailed(bytes reason);
    error NoFeeRouter();
    error NotCoverable(address pool);
    error NotDonor(address pool);
    error StalePoolPrice();
    error NotUnderwater(uint256 cr);
    error NothingToCover();

    event Swept(address indexed asset, uint256 amount);
    event Defended(address indexed pool, uint256 amountIn, uint256 donated, uint256 crBefore, uint256 crAfter);
    event DonatedDetail(address indexed pool, uint256 usdcAccepted, uint256 assetAccepted, uint256 price);
    event FeeRouterSet(address feeRouter);
    event RegistrySet(address registry);
    event QuoteAssetAdded(address indexed asset, address feed);
    event AssetFeedSet(address indexed asset, address feed);
    event PoolRegistered(address indexed pool, bool allowed);
    event RegistryCalled(bytes4 indexed selector, bytes result);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    struct CoverCtx {
        uint256 crBefore;
        uint256 deficitUsd;
        uint256 price;
        address asset;
        uint256 epoch;
        uint256 usdcAmt;
        uint256 assetAmt;
        uint256 usdcAcc;
        uint256 assetAcc;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @param admin_       Deployer first; hand over to the Timelock with `transferAdmin` + `acceptAdmin`.
    /// @param poolFactory_ SplitStock PoolFactory (pool validity and mUSDC).
    /// @param feeRouter_   OpenFour FeeRouter of the fork (may be 0 and set later).
    /// @param quoteAsset_  First quote asset to sweep (tTSLA; may be 0).
    /// @param quoteFeed_   Its USD feed for `bufferUsd()` (the TSLA AtlasMirror; may be 0).
    constructor(address admin_, address poolFactory_, address feeRouter_, address quoteAsset_, address quoteFeed_) {
        if (admin_ == address(0) || poolFactory_ == address(0)) revert ZeroAddress();
        admin = admin_;
        poolFactory = IPoolFactory(poolFactory_);
        usdc = IPoolFactory(poolFactory_).usdc();
        feeRouter = feeRouter_;
        if (feeRouter_ != address(0)) emit FeeRouterSet(feeRouter_);
        if (quoteAsset_ != address(0)) _addQuoteAsset(quoteAsset_, quoteFeed_);
        emit AdminTransferred(address(0), admin_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fees in
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permissionless. Claims pending developer and partner fees for every quote asset into this treasury.
    ///         Each claim is wrapped in try/catch, so one failing asset never blocks the others.
    function sweep() external nonReentrant {
        address fr = feeRouter;
        if (fr == address(0)) revert NoFeeRouter();
        uint256 n = _quoteAssets.length;
        for (uint256 i; i < n; ++i) {
            address q = _quoteAssets[i];
            uint256 before = _balanceOf(q, address(this));
            try IOpenFourFeeClaims(fr).claimDevFee(q, address(this)) {} catch {}
            try IOpenFourFeeClaims(fr).claimPartnerFee(q, address(this)) {} catch {}
            uint256 got = _balanceOf(q, address(this)) - before;
            if (got > 0) emit Swept(q, got);
        }
    }

    /// @notice Fees claimable by this treasury for `quoteAsset` right now (dev + partner). Never reverts.
    function pendingFees(address quoteAsset) external view returns (uint256 dev, uint256 partner) {
        address fr = feeRouter;
        if (fr == address(0)) return (0, 0);
        try IOpenFourFeeClaims(fr).devFeePending(quoteAsset, address(this)) returns (uint256 d) {
            dev = d;
        } catch {}
        try IOpenFourFeeClaims(fr).partnerFeePending(quoteAsset, address(this)) returns (uint256 p) {
            partner = p;
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cover
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permissionless. Donates to `pool` only while its CR < 1: held mUSDC first, then the pool's own asset,
    ///         each capped by 50% of the holding per epoch; the pool itself caps the total at S - V.
    /// @return donated USD (WAD) the pool accepted.
    function cover(address pool) external nonReentrant returns (uint256 donated) {
        CoverCtx memory c;
        (c.crBefore, c.deficitUsd, c.price, c.asset) = _checkCoverable(pool);
        c.epoch = block.timestamp / EPOCH;
        (c.usdcAmt, c.assetAmt) = _amounts(c.asset, c.deficitUsd, c.price, c.epoch);

        (c.usdcAcc, c.assetAcc) = _donate(pool, c.asset, c.usdcAmt, c.assetAmt);
        spent[c.epoch][usdc] += c.usdcAcc;
        spent[c.epoch][c.asset] += c.assetAcc;

        donated = _usdValue(c.asset, c.usdcAcc, c.assetAcc, c.price);
        totalDefendedUsd += donated;
        emit DonatedDetail(pool, c.usdcAcc, c.assetAcc, c.price);
        emit Defended(pool, c.assetAcc, donated, c.crBefore, _cr(pool));
    }

    /// @dev mUSDC first (up to the deficit), then the asset for the rest; each within its epoch cap.
    function _amounts(address asset, uint256 deficitUsd, uint256 price, uint256 e)
        internal
        view
        returns (uint256 usdcAmt, uint256 assetAmt)
    {
        uint8 uDec = FeedLib.decimalsOf(usdc);
        usdcAmt = _capped(usdc, e);
        uint256 usdcNeed = Math.mulDiv(deficitUsd, 10 ** uDec, 1e18, Math.Rounding.Ceil);
        if (usdcAmt > usdcNeed) usdcAmt = usdcNeed;
        uint256 usdcUsd = Math.mulDiv(usdcAmt, 1e18, 10 ** uDec);
        if (usdcUsd < deficitUsd) {
            assetAmt = _capped(asset, e);
            uint256 aNeed = Math.mulDiv(
                Math.mulDiv(deficitUsd - usdcUsd, 1e18, price, Math.Rounding.Ceil),
                10 ** FeedLib.decimalsOf(asset),
                1e18,
                Math.Rounding.Ceil
            );
            if (assetAmt > aNeed) assetAmt = aNeed;
        }
        if (usdcAmt == 0 && assetAmt == 0) revert NothingToCover();
    }

    function _usdValue(address asset, uint256 uAcc, uint256 aAcc, uint256 price) internal view returns (uint256) {
        return Math.mulDiv(uAcc, 1e18, 10 ** FeedLib.decimalsOf(usdc))
            + Math.mulDiv(Math.mulDiv(aAcc, 1e18, 10 ** FeedLib.decimalsOf(asset)), price, 1e18);
    }

    function _cr(address pool) internal view returns (uint256) {
        return ILeveragePool(pool).state().collateralRatio;
    }

    /// @notice Whether `cover(pool)` should run now (best effort). Never reverts.
    function canCover(address pool) external view returns (bool) {
        if (!_eligible(pool)) return false;
        try ILeveragePool(pool).isDonor(address(this)) returns (bool d) {
            if (!d) return false;
        } catch {
            return false;
        }
        try ILeveragePool(pool).state() returns (ILeveragePool.PoolState memory st) {
            if (!st.priceFresh || st.S <= st.V) return false;
        } catch {
            return false;
        }
        uint256 e = block.timestamp / EPOCH;
        address asset;
        try ILeveragePool(pool).asset() returns (address a) {
            asset = a;
        } catch {}
        return _capped(usdc, e) > 0 || (asset != address(0) && _capped(asset, e) > 0);
    }

    function _checkCoverable(address pool)
        internal
        view
        returns (uint256 crBefore, uint256 deficitUsd, uint256 price, address asset)
    {
        if (!_eligible(pool)) revert NotCoverable(pool);
        if (!ILeveragePool(pool).isDonor(address(this))) revert NotDonor(pool);
        ILeveragePool.PoolState memory st = ILeveragePool(pool).state();
        if (!st.priceFresh || st.price == 0) revert StalePoolPrice();
        if (st.S <= st.V) revert NotUnderwater(st.collateralRatio);
        crBefore = st.collateralRatio;
        deficitUsd = st.S - st.V;
        price = st.price;
        asset = ILeveragePool(pool).asset();
    }

    /// @dev A SplitStock pool whose first-loss x this treasury holds, or one the admin registered.
    function _eligible(address pool) internal view returns (bool) {
        if (pool == address(0)) return false;
        try poolFactory.isPool(pool) returns (bool ok) {
            if (!ok) return false;
        } catch {
            return false;
        }
        if (registeredPool[pool]) return true;
        try ILeveragePool(pool).xToken() returns (address x) {
            return _balanceOf(x, address(this)) > 0;
        } catch {
            return false;
        }
    }

    /// @dev What may still be spent of `token` this epoch: 50% of (balance + spent this epoch), less spent.
    function _capped(address token, uint256 e) internal view returns (uint256) {
        uint256 bal = _balanceOf(token, address(this));
        uint256 s = spent[e][token];
        uint256 cap = ((bal + s) * EPOCH_CAP_BPS) / BPS;
        uint256 left = cap > s ? cap - s : 0;
        return left < bal ? left : bal;
    }

    function _donate(address pool, address asset, uint256 usdcAmt, uint256 assetAmt)
        internal
        returns (uint256 uAcc, uint256 aAcc)
    {
        if (usdcAmt > 0) usdc.safeApprove(pool, usdcAmt);
        if (assetAmt > 0) asset.safeApprove(pool, assetAmt);
        (uAcc, aAcc) = ILeveragePool(pool).donate(usdcAmt, assetAmt);
        if (usdcAmt > 0) usdc.safeApprove(pool, 0);
        if (assetAmt > 0) asset.safeApprove(pool, 0);
        if (uAcc == 0 && aAcc == 0) revert NothingToCover();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice USD value (WAD) of the fee holdings: every quote asset at its feed's last answer, plus mUSDC at $1.
    ///         Excludes the locked x tokens. Never reverts.
    function bufferUsd() external view returns (uint256 usd) {
        uint256 n = _quoteAssets.length;
        for (uint256 i; i < n; ++i) {
            address q = _quoteAssets[i];
            if (q == usdc) continue;
            (uint256 p,,) = FeedLib.read(feedOf[q], type(uint256).max);
            if (p == 0) continue;
            uint256 wad = Math.mulDiv(_balanceOf(q, address(this)), 1e18, 10 ** FeedLib.decimalsOf(q));
            usd += Math.mulDiv(wad, p, 1e18);
        }
        usd += Math.mulDiv(_balanceOf(usdc, address(this)), 1e18, 10 ** FeedLib.decimalsOf(usdc));
    }

    function quoteAssets() external view returns (address[] memory) {
        return _quoteAssets;
    }

    /// @notice First-loss x of `pool` held (locked) here.
    function xHeld(address pool) external view returns (uint256) {
        try ILeveragePool(pool).xToken() returns (address x) {
            return _balanceOf(x, address(this));
        } catch {
            return 0;
        }
    }

    function _balanceOf(address token, address who) internal view returns (uint256 bal) {
        if (token == address(0) || token.code.length == 0) return 0;
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        if (ok && ret.length >= 32) bal = abi.decode(ret, (uint256));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin (configuration only; no fund movement)
    // ─────────────────────────────────────────────────────────────────────────

    function setFeeRouter(address feeRouter_) external onlyAdmin {
        if (feeRouter_ == address(0)) revert ZeroAddress();
        if (_isHeldToken(feeRouter_)) revert RegistryIsHeldToken(feeRouter_);
        feeRouter = feeRouter_;
        emit FeeRouterSet(feeRouter_);
    }

    function addQuoteAsset(address asset, address feed) external onlyAdmin {
        if (asset == address(0)) revert ZeroAddress();
        if (registry != address(0) && asset == registry) revert RegistryIsHeldToken(asset);
        _addQuoteAsset(asset, feed);
    }

    function setAssetFeed(address asset, address feed) external onlyAdmin {
        feedOf[asset] = feed;
        emit AssetFeedSet(asset, feed);
    }

    function registerPool(address pool, bool allowed) external onlyAdmin {
        registeredPool[pool] = allowed;
        emit PoolRegistered(pool, allowed);
    }

    /// @notice Set the OpenFour Registry once. It can never be a token this treasury holds.
    function setRegistry(address registry_) external onlyAdmin {
        if (registry != address(0)) revert RegistryAlreadySet();
        if (registry_ == address(0)) revert ZeroAddress();
        if (_isHeldToken(registry_)) revert RegistryIsHeldToken(registry_);
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice Forward a call to the OpenFour Registry from this address, so the preset's author is this treasury
    ///         (OpenFour's register.js sets author = msg.sender). Admin only; target fixed to `registry`.
    function callRegistry(bytes calldata data) external onlyAdmin returns (bytes memory result) {
        address r = registry;
        if (r == address(0)) revert ZeroAddress();
        if (_isHeldToken(r)) revert RegistryIsHeldToken(r);
        bool ok;
        (ok, result) = r.call(data);
        if (!ok) revert RegistryCallFailed(result);
        emit RegistryCalled(bytes4(data), result);
    }

    function transferAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function _addQuoteAsset(address asset, address feed) internal {
        if (!isQuoteAsset[asset]) {
            isQuoteAsset[asset] = true;
            _quoteAssets.push(asset);
        }
        feedOf[asset] = feed;
        emit QuoteAssetAdded(asset, feed);
    }

    /// @dev Quote assets and mUSDC (the tokens this treasury may hold besides x). An x token is a pool clone whose
    ///      `isPool` is false, so we also refuse any address that answers `pool()` with a factory pool.
    function _isHeldToken(address target) internal view returns (bool) {
        if (target == usdc || isQuoteAsset[target]) return true;
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("pool()"));
        if (ok && ret.length >= 32) {
            address p = abi.decode(ret, (address));
            try poolFactory.isPool(p) returns (bool isP) {
                if (isP) return true;
            } catch {}
        }
        return false;
    }
}
