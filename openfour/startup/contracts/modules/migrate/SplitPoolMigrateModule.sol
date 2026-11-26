// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOpenFourMigrateModule} from "../../interfaces/IOpenFourMigrateModule.sol";
import {IOpenFourModuleSchema} from "../../interfaces/IOpenFourModuleSchema.sol";
import {IOpenFourToken} from "../../interfaces/IOpenFourToken.sol";
import {IOpenFourVault} from "../../interfaces/IOpenFourVault.sol";
import {OpenFourTypes, ParamDescriptor, ModuleEncodeSchema} from "../../libraries/OpenFourTypes.sol";
import {IPoolFactory, ILeveragePool, IRiskOracle, IAggregatorV3, IHaltableFeed} from "../../external/ISplitStock.sol";
import {
    SplitPoolBranch,
    SplitPoolGraduation,
    SplitPoolPreview,
    ISplitPoolMigrateView,
    ISplitPoolDataView,
    IPancakeV2RouterLike,
    IPancakeV2FactoryLike2,
    IPancakeV2PairLike2
} from "../../external/ISplitPoolLaunch.sol";

/// @title SplitPoolMigrateModule (`module.migrate.splitstock_pool`)
/// @notice "SplitStock Pool Launch" graduation. A fair launch raised in a mock stock token (tTSLA) graduates by
///         opening a NEW SplitStock pool through `PoolFactory.createPool`:
///           1. `seed(seedBps of the raise, BackstopTreasury)`: protocol-owned first-loss x<SYM>, locked in the treasury
///           2. `mintStable(rest, minOut)`: sUSD-<SYM>, capped by `maxMintStable()` (excess stock -> treasury)
///           3. meme/sUSD liquidity on PancakeSwap V2 (`pair.mint`, LP to 0xdead)
///         If anything in 1-3 fails (or the pool is unhealthy once the grace window has elapsed) the raise goes to
///         the meme/stock pair that was pre-created and registered with the token at init: `FloorFallback(reason)`.
///         Dollar-quoted graduation liquidity, not a price floor: the pool's sell zone may still sell stock later.
/// @dev Demo-only, unaudited. Derived from the openfour-docs FairLaunch starter (FairLaunchMigrateModule).
///      migratedDataVersion 1 = abi.encode(pair, sUSD, pool); 2 = abi.encode(pair, stock). 0 = no DEX on this chain.
///      `evaluate()` is view and never reverts: every external read is guarded (code check + try/catch or staticcall).
///      This clone must hold CREATOR_ROLE on the PoolFactory (granted per token after createToken); until it does,
///      evaluate() defers and the grace window eventually forces the fallback branch, so holders are never stranded.
contract SplitPoolMigrateModule is Initializable, IOpenFourMigrateModule, IOpenFourModuleSchema, ISplitPoolMigrateView {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    string internal constant TAG = "module.migrate.splitstock_pool";
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant BSC_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant BSC_TESTNET_V2_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_FUTURE_SKEW = 30;

    uint16 public constant MIN_SEED_BPS = 3_000;
    uint16 public constant MAX_SEED_BPS = 7_000;
    uint16 public constant MIN_SUSD_OUT_BPS = 8_000;
    uint256 public constant MIN_GRACE = 60;
    uint256 public constant MAX_GRACE = 7 days;
    uint256 public constant MIN_MIGRATE_GAS = 4_000_000;
    uint256 public constant MAX_MIGRATE_GAS = 20_000_000;
    /// @dev Gas the catch branch needs to run the fallback (skim + 2 transfers + pair.mint + bookkeeping).
    uint256 public constant FALLBACK_GAS_RESERVE = 400_000;

    // ------------------------------------------------------------------ types

    /// @notice ABI input layout supplied at token creation (one tuple, schema order).
    struct InputParams {
        uint256 softCap; // quote units; 0 disables
        uint256 duration; // seconds; endTime = init time + duration
        uint256 tokenLiquidityAmount; // meme units into the pair; 0 = maxSupply - sold
        uint256 maxQuoteToUse; // quote cap; 0 = all totalRaised
        address stockAsset; // == TokenInitParams.quoteAsset (tTSLA)
        address poolFactory; // SplitStock PoolFactory
        address feed; // AggregatorV3 for the stock (AtlasMirror TSLA)
        address poolRouter; // router handed to createPool (pool rebalancing DEX)
        address backstopTreasury; // receives the seed x<SYM>, any leftover stock; set as pool donor
        string stockSymbol; // "TSLA"; assetId = keccak256(bytes(symbol))
        uint16 seedBps; // share of the raise into seed() [3000, 7000]
        uint16 minSusdOutBps; // mintStable minOut vs gross value [8000, 10000]
        uint256 graceWindow; // seconds after conditions are met before an unhealthy pool forces the fallback
        uint256 minMigrateGas; // gasleft() required before the pool path [4e6, 2e7]
    }

    /// @notice Stored configuration (`duration` converted to `endTime`).
    struct Config {
        uint256 softCap;
        uint256 endTime;
        uint256 tokenLiquidityAmount;
        uint256 maxQuoteToUse;
        address stockAsset;
        address poolFactory;
        address feed;
        address poolRouter;
        address backstopTreasury;
        string stockSymbol;
        uint16 seedBps;
        uint16 minSusdOutBps;
        uint256 graceWindow;
        uint256 minMigrateGas;
    }

    // ------------------------------------------------------------------ errors / events

    error ZeroAddress();
    error NoCode(address target);
    error BadParam(uint8 field);
    error UnsupportedDecimals(address token);
    error OnlyFourCore();
    error OnlySelf();
    error WrongToken(address token);
    error WrongVault(address vault);
    error WrongQuote(address quote);
    error AlreadyMigrated();
    error ConditionsNotMet();
    error NotHealthy(string reason);
    error ZeroQuote();
    error ZeroTokenLiquidity();
    error QuoteMismatch(uint256 got, uint256 expected);
    error InsufficientGas(uint256 left, uint256 required);
    error PoolMismatch(address pool);
    error NoFreshPrice();
    error MintCapacityZero();
    error SusdMismatch(uint256 got, uint256 reported, uint256 minOut);
    error PairNotEmpty(address pair);
    error ZeroLiquidity(address pair);

    event FallbackPairRegistered(address indexed token, address indexed pair, bool guarded);
    event PoolGraduated(
        address indexed token,
        address indexed pool,
        address indexed pair,
        address sUSD,
        address xToken,
        uint256 seedAmount,
        uint256 mintAmount,
        uint256 sUSDMinted,
        uint256 xToTreasury,
        uint256 leftoverToTreasury,
        uint256 liquidity,
        uint256 price
    );
    event FloorFallback(
        address indexed token, address indexed pair, uint256 quoteUsed, uint256 tokenUsed, uint256 liquidity, bytes reason
    );

    // ------------------------------------------------------------------ storage

    address public boundToken;
    address public fourCore;
    address public feeRouter;
    bytes32 public assetId;
    uint256 public stockUnit; // 10 ** stock decimals
    uint256 public feedScale; // 10 ** (18 - feed decimals)
    address public pcsFactory; // 0 when this chain has no PCS v2 (local Hardhat)
    address public fallbackPair; // meme/stock pair pre-created at init
    bool public fallbackPairGuarded; // registered with token.setMigratedPools at init
    bool public migrated;
    Config internal _cfg;
    SplitPoolGraduation internal _last;
    bool internal _launching;
    bytes private _initParams;
    string private _moduleVersion;

    modifier onlyFourCore() {
        if (msg.sender != fourCore) revert OnlyFourCore();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ------------------------------------------------------------------ init

    function init(address token, address fourCore_, address feeRouter_, bytes calldata rawParams, string calldata moduleVersion_)
        external
        override
        initializer
    {
        if (token == address(0) || fourCore_ == address(0)) revert ZeroAddress();
        InputParams memory p = abi.decode(rawParams, (InputParams));
        _validateInput(p);

        stockUnit = 10 ** _decimals(p.stockAsset);
        feedScale = 10 ** (18 - _decimals(p.feed));
        assetId = keccak256(bytes(p.stockSymbol));

        boundToken = token;
        fourCore = fourCore_;
        feeRouter = feeRouter_;
        _cfg = Config({
            softCap: p.softCap,
            endTime: block.timestamp + p.duration,
            tokenLiquidityAmount: p.tokenLiquidityAmount,
            maxQuoteToUse: p.maxQuoteToUse,
            stockAsset: p.stockAsset,
            poolFactory: p.poolFactory,
            feed: p.feed,
            poolRouter: p.poolRouter,
            backstopTreasury: p.backstopTreasury,
            stockSymbol: p.stockSymbol,
            seedBps: p.seedBps,
            minSusdOutBps: p.minSusdOutBps,
            graceWindow: p.graceWindow,
            minMigrateGas: p.minMigrateGas
        });
        _initParams = rawParams;
        _moduleVersion = moduleVersion_;

        _preparePairs(token, p.stockAsset);
    }

    function _validateInput(InputParams memory p) internal view {
        if (
            p.stockAsset == address(0) || p.poolFactory == address(0) || p.feed == address(0)
                || p.poolRouter == address(0) || p.backstopTreasury == address(0)
        ) revert ZeroAddress();
        if (p.stockAsset.code.length == 0) revert NoCode(p.stockAsset);
        if (p.poolFactory.code.length == 0) revert NoCode(p.poolFactory);
        if (p.feed.code.length == 0) revert NoCode(p.feed);
        if (p.poolRouter.code.length == 0) revert NoCode(p.poolRouter);
        uint256 len = bytes(p.stockSymbol).length;
        if (len == 0 || len > 10) revert BadParam(1);
        if (p.seedBps < MIN_SEED_BPS || p.seedBps > MAX_SEED_BPS) revert BadParam(2);
        if (p.minSusdOutBps < MIN_SUSD_OUT_BPS || p.minSusdOutBps > BPS) revert BadParam(3);
        if (p.graceWindow < MIN_GRACE || p.graceWindow > MAX_GRACE) revert BadParam(4);
        if (p.minMigrateGas < MIN_MIGRATE_GAS || p.minMigrateGas > MAX_MIGRATE_GAS) revert BadParam(5);
    }

    /// @dev Pre-create the meme/stock fallback pair and register it so nobody can seed or grief it before
    ///      MigratePending (OpenFourToken blocks transfers to/from migratedPools until then).
    function _preparePairs(address token, address stock) internal {
        address router = _pcsRouter();
        if (router == address(0)) return;
        address f = IPancakeV2RouterLike(router).factory();
        if (f == address(0)) revert ZeroAddress();
        pcsFactory = f;
        address pair = IPancakeV2FactoryLike2(f).getPair(token, stock);
        if (pair == address(0)) pair = IPancakeV2FactoryLike2(f).createPair(token, stock);
        if (pair == address(0)) revert ZeroAddress();
        if (IPancakeV2PairLike2(pair).totalSupply() != 0) revert PairNotEmpty(pair);
        fallbackPair = pair;
        address[] memory pools = new address[](1);
        pools[0] = pair;
        bool guarded;
        try IOpenFourToken(token).setMigratedPools(pools, true) {
            guarded = true;
        } catch {}
        fallbackPairGuarded = guarded;
        emit FallbackPairRegistered(token, pair, guarded);
    }

    // ------------------------------------------------------------------ descriptor / schema

    function descriptor() external view override returns (bytes8 tagId, string memory tag, string memory version) {
        tag = TAG;
        return (bytes8(keccak256(bytes(tag))), tag, _moduleVersion);
    }

    function getInitParams() external view override returns (bytes memory) {
        return _initParams;
    }

    function lastGraduation() external view override returns (SplitPoolGraduation memory) {
        return _last;
    }

    // ------------------------------------------------------------------ evaluate (view, never reverts)

    function evaluate(OpenFourTypes.MigrateContext calldata ctx)
        external
        view
        override
        returns (OpenFourTypes.MigrateResult memory)
    {
        if (fourCore == address(0)) {
            return OpenFourTypes.MigrateResult({canMigrate: false, data: "", reason: "Not initialized"});
        }
        if (ctx.token != boundToken) {
            return OpenFourTypes.MigrateResult({canMigrate: false, data: "", reason: "Wrong token"});
        }
        SplitPoolPreview memory pv = _preview(ctx.totalRaised, ctx.soldOut, ctx.timestamp);
        return OpenFourTypes.MigrateResult({
            canMigrate: pv.canMigrate,
            data: pv.canMigrate ? abi.encode(pv.quoteToUse) : bytes(""),
            reason: pv.reason
        });
    }

    /// @notice Same logic as evaluate(), from live vault state. For the UI, keeper and agent. Never reverts.
    function previewGraduation(address token) external view override returns (SplitPoolPreview memory pv) {
        if (fourCore == address(0) || token != boundToken || token == address(0)) {
            pv.reason = fourCore == address(0) ? "Not initialized" : "Wrong token";
            return pv;
        }
        (uint256 raised, bool soldOut) = _vaultSnapshot(token);
        return _preview(raised, soldOut, block.timestamp);
    }

    /// @notice FairLaunch conditions: sold out, soft cap reached, or expired.
    function conditionsMet(uint256 totalRaised, bool soldOut, uint256 timestamp) public view override returns (bool) {
        Config storage c = _cfg;
        return soldOut || (c.softCap > 0 && totalRaised >= c.softCap) || timestamp >= c.endTime;
    }

    function _preview(uint256 totalRaised, bool soldOut, uint256 ts) internal view returns (SplitPoolPreview memory pv) {
        Config storage c = _cfg;
        pv.initialized = true;
        pv.migrated = migrated;
        pv.endTime = c.endTime;
        pv.totalRaised = totalRaised;
        pv.quoteToUse = _capQuote(totalRaised);
        pv.seedAmount = Math.mulDiv(pv.quoteToUse, c.seedBps, BPS);
        pv.mintAmount = pv.quoteToUse - pv.seedAmount;
        pv.conditionsMet = conditionsMet(totalRaised, soldOut, ts);

        // grace anchor: first time the conditions held (customData), or endTime once expired
        uint256 anchor = _customDataAnchor();
        if (ts >= c.endTime && (anchor == 0 || c.endTime < anchor)) anchor = c.endTime;
        if (pv.conditionsMet && anchor != 0) {
            pv.conditionsMetAt = anchor;
            pv.forceAt = anchor + c.graceWindow;
            pv.forced = ts >= pv.forceAt;
        }

        string memory why = _health(c.poolFactory, c.feed, c.minSusdOutBps, pv, ts);
        pv.healthy = bytes(why).length == 0;

        if (pv.migrated) {
            pv.reason = "Already migrated";
        } else if (!pv.conditionsMet) {
            pv.reason = "Launch conditions not met";
        } else if (pv.quoteToUse == 0) {
            pv.reason = "Zero quote raised";
        } else if (pv.healthy) {
            pv.canMigrate = true;
        } else if (pv.forced) {
            pv.canMigrate = true;
            pv.reason = string.concat("Grace elapsed, fallback: ", why);
        } else {
            pv.reason = string.concat("Deferred: ", why);
        }
    }

    /// @dev Empty string = the pool path is expected to pass. Mirrors LeveragePool's seed/mint guards.
    function _health(address f, address feed, uint256 minSusdOutBps, SplitPoolPreview memory pv, uint256 ts)
        internal
        view
        returns (string memory)
    {
        if (f.code.length == 0) return "PoolFactory has no code";

        bool role;
        try IPoolFactory(f).isCreator(address(this)) returns (bool ok) {
            role = ok;
        } catch {}
        if (!role) {
            try IPoolFactory(f).isAdmin(address(this)) returns (bool ok) {
                role = ok;
            } catch {}
        }
        pv.hasCreatorRole = role;

        (bool usable, uint256 price, uint256 updatedAt, bool halted) = _readFeed(feed);
        pv.price = price;
        pv.priceAge = usable && ts > updatedAt ? ts - updatedAt : 0;
        if (usable && price > 0) pv.mintValueUsd = Math.mulDiv(pv.mintAmount, price, stockUnit);
        pv.minSusdOut = Math.mulDiv(pv.mintValueUsd, minSusdOutBps, BPS);

        uint256 maxPriceAge;
        uint256 maxRefAge;
        try IPoolFactory(f).defaultParams() returns (ILeveragePool.PoolParams memory d) {
            maxPriceAge = d.maxPriceAge;
            maxRefAge = d.maxRefAge;
        } catch {
            return "PoolFactory params unreadable";
        }
        pv.feedFresh = usable && !halted && pv.priceAge <= maxPriceAge && updatedAt <= ts + MAX_FUTURE_SKEW;

        IRiskOracle.RiskView memory rv;
        bool rvOk;
        address ro;
        try IPoolFactory(f).riskOracle() returns (address r) {
            ro = r;
        } catch {}
        if (ro.code.length > 0) {
            try IRiskOracle(ro).riskView(assetId) returns (IRiskOracle.RiskView memory v) {
                rv = v;
                rvOk = true;
            } catch {}
        }
        pv.mintsPaused = rvOk && rv.mintsPaused;
        string memory br = _breaker(rv, rvOk, price, maxRefAge, ts);
        pv.breakerOk = bytes(br).length == 0;

        if (!role) return "module lacks PoolFactory CREATOR_ROLE";
        if (!usable || price == 0) return "no usable stock price";
        if (halted) return "feed halted";
        if (!pv.feedFresh) return "stock price stale";
        if (!rvOk) return "RiskOracle unreadable";
        if (pv.mintsPaused) return "mints paused";
        if (!pv.breakerOk) return br;
        return "";
    }

    function _breaker(IRiskOracle.RiskView memory rv, bool rvOk, uint256 price, uint256 maxRefAge, uint256 ts)
        internal
        pure
        returns (string memory)
    {
        if (!rvOk) return "RiskOracle unreadable";
        uint256 ref = rv.refPrice;
        if (ref == 0) return "CMC reference price missing";
        uint256 refAge = ts > rv.refTs ? ts - rv.refTs : 0;
        if (refAge > maxRefAge) return "CMC reference price stale";
        uint256 diff = price > ref ? price - ref : ref - price;
        uint256 dev = Math.mulDiv(diff, BPS, ref, Math.Rounding.Up);
        if (dev > rv.params.maxDevBps) return "breaker: Atlas vs CMC deviation too high";
        return "";
    }

    /// @dev LeveragePool._readPrice semantics, via staticcall so a bad feed can never revert evaluate().
    function _readFeed(address feed) internal view returns (bool usable, uint256 price, uint256 updatedAt, bool halted) {
        if (feed.code.length == 0) return (false, 0, 0, false);
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        if (ok && ret.length >= 160) {
            (, int256 answer,, uint256 upd,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
            if (answer > 0 && upd != 0 && uint256(answer) <= type(uint96).max / feedScale) {
                usable = true;
                price = uint256(answer) * feedScale;
                updatedAt = upd;
            }
        }
        (ok, ret) = feed.staticcall(abi.encodeWithSelector(IHaltableFeed.halted.selector));
        if (ok && ret.length >= 32) halted = abi.decode(ret, (uint256)) != 0;
    }

    function _customDataAnchor() internal view returns (uint256) {
        address token = boundToken;
        address cd;
        try IOpenFourToken(token).customData() returns (address a) {
            cd = a;
        } catch {
            return 0;
        }
        if (cd.code.length == 0) return 0;
        (bool ok, bytes memory ret) = cd.staticcall(abi.encodeWithSelector(ISplitPoolDataView.conditionsMetAt.selector));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    function _vaultSnapshot(address token) internal view returns (uint256 raised, bool soldOut) {
        address v;
        try IOpenFourToken(token).vault() returns (address a) {
            v = a;
        } catch {
            return (0, false);
        }
        if (v.code.length == 0) return (0, false);
        try IOpenFourVault(v).totalRaised() returns (uint256 r) {
            raised = r;
        } catch {}
        try IOpenFourVault(v).isSoldOut() returns (bool s) {
            soldOut = s;
        } catch {}
    }

    // ------------------------------------------------------------------ executeMigration

    /// @dev Core-only, bound token only. Re-checks every condition, ignores hookData beyond a capped hint.
    function executeMigration(OpenFourTypes.MigrateHookContext calldata ctx, bytes calldata hookData)
        external
        override
        onlyFourCore
        returns (uint8 migratedDataVersion, bytes memory encodedMigratedData)
    {
        address token = boundToken;
        if (ctx.token != token) revert WrongToken(ctx.token);
        if (migrated) revert AlreadyMigrated();
        address vault = IOpenFourToken(token).vault();
        if (ctx.vault != vault) revert WrongVault(ctx.vault);
        address stock = _cfg.stockAsset;
        if (ctx.quoteAsset != stock) revert WrongQuote(ctx.quoteAsset);

        bool soldOut = ctx.remainingForSale <= 1e18;
        try IOpenFourVault(vault).isSoldOut() returns (bool s) {
            soldOut = s;
        } catch {}
        if (!conditionsMet(ctx.totalRaised, soldOut, ctx.timestamp)) revert ConditionsNotMet();

        if (pcsFactory == address(0)) {
            // Same as FairLaunch on a chain without PCS v2 (local Hardhat): nothing to graduate into.
            return (SplitPoolBranch.NONE, "");
        }

        uint256 q = _quoteToUse(ctx.totalRaised, hookData, vault, stock);
        if (q == 0) revert ZeroQuote();
        uint256 tokenAmt = _tokenLiquidityAmount(token, vault);

        SplitPoolPreview memory pv = _preview(ctx.totalRaised, soldOut, ctx.timestamp);
        if (!pv.healthy && !pv.forced) revert NotHealthy(pv.reason);

        uint256 before = IERC20(stock).balanceOf(address(this));
        IOpenFourVault(vault).transferQuoteForMigration(address(this), q);
        uint256 got = IERC20(stock).balanceOf(address(this)) - before;
        if (got != q) revert QuoteMismatch(got, q);
        migrated = true;

        SplitPoolGraduation memory r;
        bytes memory why = bytes(pv.reason);
        if (pv.healthy) {
            uint256 g = gasleft();
            uint256 minGas = _cfg.minMigrateGas;
            if (g < minGas) revert InsufficientGas(g, minGas);
            _launching = true;
            try this.runPoolLaunch(q, tokenAmt, vault) returns (SplitPoolGraduation memory ok) {
                r = ok;
            } catch (bytes memory reason) {
                uint256 left = gasleft();
                // An out-of-gas inside the pool path must never turn into a fallback: revert the whole migration.
                if (left < FALLBACK_GAS_RESERVE || (reason.length == 0 && left <= g / 63)) {
                    revert InsufficientGas(left, FALLBACK_GAS_RESERVE);
                }
                why = reason;
            }
            _launching = false;
        }

        if (r.branch == SplitPoolBranch.POOL) {
            IOpenFourToken(token).setMigratedPool(r.pair, true);
            IOpenFourToken(token).setMigratedPool(fallbackPair, false);
            emit PoolGraduated(
                token,
                r.pool,
                r.pair,
                r.sUSD,
                r.xToken,
                r.seedAmount,
                r.mintAmount,
                r.sUSDMinted,
                r.xToTreasury,
                r.leftoverToTreasury,
                r.liquidity,
                r.price
            );
            encodedMigratedData = abi.encode(r.pair, r.sUSD, r.pool);
        } else {
            r = _fallback(token, vault, stock, q, tokenAmt, why);
            r.price = pv.price;
            encodedMigratedData = abi.encode(r.pair, stock);
        }
        r.timestamp = block.timestamp;
        _last = r;
        migratedDataVersion = r.branch;
    }

    /// @notice Pool path, run as a self-call so every step reverts together into the fallback.
    /// @dev Only this contract, only inside executeMigration.
    function runPoolLaunch(uint256 q, uint256 tokenAmt, address vault) external returns (SplitPoolGraduation memory r) {
        if (msg.sender != address(this) || !_launching) revert OnlySelf();
        Config memory c = _cfg;
        IERC20 stock = IERC20(c.stockAsset);

        address pool = IPoolFactory(c.poolFactory).createPool(
            c.stockAsset, c.feed, assetId, c.stockSymbol, c.poolRouter, ILeveragePool.PoolKind.LIVE
        );
        if (pool == address(0) || pool.code.length == 0) revert PoolMismatch(pool);
        ILeveragePool lp = ILeveragePool(pool);
        if (lp.asset() != c.stockAsset) revert PoolMismatch(pool);
        r.branch = SplitPoolBranch.POOL;
        r.pool = pool;
        r.sUSD = lp.sUSD();
        r.xToken = lp.xToken();
        r.stabilityPool = lp.stabilityPool();
        r.quoteUsed = q;
        r.tokenUsed = tokenAmt;

        // 1. first-loss x<SYM> to the BackstopTreasury (protocol-owned)
        stock.forceApprove(pool, q);
        r.seedAmount = Math.mulDiv(q, c.seedBps, BPS);
        r.xToTreasury = lp.seed(r.seedAmount, c.backstopTreasury);
        try lp.setDonor(c.backstopTreasury, true) {} catch {}

        // 2. sUSD from the rest, capped by the pool's leverage limit
        uint256 mintAmt = q - r.seedAmount;
        uint256 cap = lp.maxMintStable();
        if (mintAmt > cap) mintAmt = cap;
        if (mintAmt == 0) revert MintCapacityZero();
        ILeveragePool.PoolState memory st = lp.state();
        if (!st.priceFresh || st.price == 0) revert NoFreshPrice();
        r.price = st.price;
        uint256 minOut = Math.mulDiv(Math.mulDiv(mintAmt, st.price, stockUnit), c.minSusdOutBps, BPS);
        IERC20 susd = IERC20(r.sUSD);
        uint256 sBefore = susd.balanceOf(address(this));
        uint256 sOut = lp.mintStable(mintAmt, minOut, block.timestamp);
        uint256 sGot = susd.balanceOf(address(this)) - sBefore;
        if (sGot != sOut || sGot < minOut || sGot == 0) revert SusdMismatch(sGot, sOut, minOut);
        stock.forceApprove(pool, 0);
        r.mintAmount = mintAmt;
        r.sUSDMinted = sGot;

        uint256 leftover = q - r.seedAmount - mintAmt;
        if (leftover > 0) stock.safeTransfer(c.backstopTreasury, leftover);
        r.leftoverToTreasury = leftover;

        // 3. meme/sUSD on PCS v2, LP to 0xdead
        address pair = _emptyPair(boundToken, r.sUSD);
        IOpenFourVault(vault).transferTokenForMigration(pair, tokenAmt);
        susd.safeTransfer(pair, sGot);
        r.liquidity = IPancakeV2PairLike2(pair).mint(DEAD);
        if (r.liquidity == 0) revert ZeroLiquidity(pair);
        r.pair = pair;
    }

    /// @dev Meme/stock liquidity into the pair pre-created and registered at init. Reverts if it cannot add it.
    function _fallback(address token, address vault, address stock, uint256 q, uint256 tokenAmt, bytes memory reason)
        internal
        returns (SplitPoolGraduation memory r)
    {
        address pair = fallbackPair;
        if (IPancakeV2PairLike2(pair).totalSupply() != 0) revert PairNotEmpty(pair);
        try IPancakeV2PairLike2(pair).skim(DEAD) {} catch {}
        IOpenFourVault(vault).transferTokenForMigration(pair, tokenAmt);
        IERC20(stock).safeTransfer(pair, q);
        uint256 liq = IPancakeV2PairLike2(pair).mint(DEAD);
        if (liq == 0) revert ZeroLiquidity(pair);
        if (!fallbackPairGuarded) IOpenFourToken(token).setMigratedPool(pair, true);
        r.branch = SplitPoolBranch.FALLBACK;
        r.pair = pair;
        r.quoteUsed = q;
        r.tokenUsed = tokenAmt;
        r.liquidity = liq;
        emit FloorFallback(token, pair, q, tokenAmt, liq, reason);
    }

    /// @dev getPair or createPair; must have no LP yet; stray donations are skimmed to 0xdead.
    function _emptyPair(address token, address other) internal returns (address pair) {
        address f = pcsFactory;
        pair = IPancakeV2FactoryLike2(f).getPair(token, other);
        if (pair == address(0)) pair = IPancakeV2FactoryLike2(f).createPair(token, other);
        if (pair == address(0)) revert ZeroAddress();
        if (IPancakeV2PairLike2(pair).totalSupply() != 0) revert PairNotEmpty(pair);
        try IPancakeV2PairLike2(pair).skim(DEAD) {} catch {}
    }

    function _quoteToUse(uint256 totalRaised, bytes calldata hookData, address vault, address stock)
        internal
        view
        returns (uint256 q)
    {
        q = totalRaised;
        if (hookData.length == 32) {
            uint256 hint = abi.decode(hookData, (uint256));
            if (hint < q) q = hint;
        }
        q = _capQuote(q);
        uint256 bal = IERC20(stock).balanceOf(vault);
        if (q > bal) q = bal;
    }

    function _capQuote(uint256 amount) internal view returns (uint256) {
        uint256 cap = _cfg.maxQuoteToUse;
        return cap > 0 && amount > cap ? cap : amount;
    }

    function _tokenLiquidityAmount(address token, address vault) internal view returns (uint256 amt) {
        amt = _cfg.tokenLiquidityAmount;
        if (amt == 0) {
            uint256 maxSupply = IOpenFourToken(token).maxSupply();
            uint256 sold = IOpenFourVault(vault).soldAmount();
            if (maxSupply <= sold) revert ZeroTokenLiquidity();
            amt = maxSupply - sold;
        }
        uint256 bal = IERC20(token).balanceOf(vault);
        if (amt > bal) amt = bal;
        if (amt == 0) revert ZeroTokenLiquidity();
    }

    function _pcsRouter() internal view returns (address) {
        if (block.chainid == 56) return BSC_V2_ROUTER;
        if (block.chainid == 97) return BSC_TESTNET_V2_ROUTER;
        return address(0);
    }

    function _decimals(address t) internal view returns (uint256 d) {
        (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || ret.length < 32) revert UnsupportedDecimals(t);
        d = abi.decode(ret, (uint256));
        if (d > 18) revert UnsupportedDecimals(t);
    }

    // ------------------------------------------------------------------ schema

    /// @dev Packed schema: fields split by 0x1f, rows by 0x1e, field order = ParamDescriptor order
    ///      (name, abiType, decimals, optional, title, defaultValue, hint, minValue, maxValue). Rows = InputParams order.
    bytes internal constant SCHEMA =
        "softCap\x1fuint256\x1f18\x1f1\x1fSoft cap (quote)\x1f0\x1fRaise that triggers graduation; 0 disables.\x1f0\x1f\x1e"
        "duration\x1fuint256\x1f0\x1f0\x1fDuration (seconds)\x1f1800\x1fLaunch length; never 0 if the token must also be sold.\x1f60\x1f\x1e"
        "tokenLiquidityAmount\x1fuint256\x1f0\x1f1\x1fToken liquidity amount\x1f0\x1fMeme units into the pair; 0 = maxSupply - sold.\x1f0\x1f\x1e"
        "maxQuoteToUse\x1fuint256\x1f18\x1f1\x1fMax quote to use\x1f0\x1f0 = all totalRaised.\x1f0\x1f\x1e"
        "stockAsset\x1faddress\x1f0\x1f0\x1fStock token (quote)\x1f\x1fMock stock raised (tTSLA); must equal quoteAsset.\x1f\x1f\x1e"
        "poolFactory\x1faddress\x1f0\x1f0\x1fSplitStock PoolFactory\x1f\x1fOpens the new pool at graduation.\x1f\x1f\x1e"
        "feed\x1faddress\x1f0\x1f0\x1fStock price feed\x1f\x1fAggregatorV3 for the stock (Atlas mirror).\x1f\x1f\x1e"
        "poolRouter\x1faddress\x1f0\x1f0\x1fPool rebalance router\x1f\x1fRouter the new pool rebalances through.\x1f\x1f\x1e"
        "backstopTreasury\x1faddress\x1f0\x1f0\x1fBackstopTreasury\x1f\x1fGets the first-loss x tokens; pool donor.\x1f\x1f\x1e"
        "stockSymbol\x1fstring\x1f0\x1f0\x1fStock symbol\x1fTSLA\x1fassetId = keccak256(symbol).\x1f1\x1f10\x1e"
        "seedBps\x1fuint16\x1f0\x1f1\x1fSeed share (bps)\x1f5000\x1fShare of the raise seeded as first-loss x.\x1f3000\x1f7000\x1e"
        "minSusdOutBps\x1fuint16\x1f0\x1f1\x1fMin sUSD out (bps)\x1f9000\x1fmintStable minOut vs value; room for the closed-market fee.\x1f8000\x1f10000\x1e"
        "graceWindow\x1fuint256\x1f0\x1f1\x1fGrace window (seconds)\x1f1800\x1fAfter this, an unhealthy pool forces the meme/stock fallback.\x1f60\x1f604800\x1e"
        "minMigrateGas\x1fuint256\x1f0\x1f1\x1fMin migrate gas\x1f8000000\x1fgasleft() required before the pool path.\x1f4000000\x1f20000000";
    uint256 internal constant SCHEMA_ROWS = 14;

    function moduleEncodeSchema() external pure override returns (ModuleEncodeSchema memory) {
        bytes memory s = SCHEMA;
        ParamDescriptor[] memory p = new ParamDescriptor[](SCHEMA_ROWS);
        string[9] memory f;
        uint256 fi;
        uint256 pi;
        uint256 start;
        uint256 n = s.length;
        for (uint256 i = 0; i <= n; ++i) {
            bytes1 ch = i == n ? bytes1(0x1e) : s[i];
            if (ch != 0x1f && ch != 0x1e) continue;
            bytes memory part = new bytes(i - start);
            for (uint256 j = 0; j < part.length; ++j) {
                part[j] = s[start + j];
            }
            f[fi++] = string(part);
            start = i + 1;
            if (ch == 0x1e) {
                p[pi++] = ParamDescriptor(f[0], f[1], uint8(_atoi(bytes(f[2]))), bytes(f[3])[0] == "1", f[4], f[5], f[6], f[7], f[8]);
                fi = 0;
            }
        }
        return ModuleEncodeSchema("migrate", 1, p);
    }

    function _atoi(bytes memory b) private pure returns (uint256 v) {
        for (uint256 i = 0; i < b.length; ++i) {
            v = v * 10 + (uint8(b[i]) - 48);
        }
    }
}
