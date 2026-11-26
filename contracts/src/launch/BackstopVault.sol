// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {LibString} from "solady/utils/LibString.sol";

import {DirectLaunchVaultBase} from "src/flap/DirectLaunchVaultBase.sol";
import {VaultUISchema, VaultMethodSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";

import {ILeveragePool} from "src/interfaces/ILeveragePool.sol";
import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";
import {IUniswapV2Router02} from "src/interfaces/IUniswapV2Router02.sol";

import {SplitPoolConfig, ISplitLauncherView} from "src/launch/ISplitLaunch.sol";
import {FeedLib} from "src/launch/FeedLib.sol";

/// @title BackstopVault
/// @notice The VAULT-slot recipient of a SplitLauncher token. It receives 50% of the token's 3%/3% tax in native
///         tBNB and holds the protocol-owned first-loss xNVDA minted by `SplitLauncher.openPool()`. It spends its tBNB
///         only through `cover(pool)`, and only while that pool is under water (CR < 1):
///
///           tax dispatch --> receive() --> totalRevenue (balance-delta accounting: seen = balance + totalOut)
///           cover(pool):  CR < 1  -->  spend <= deficit and <= epoch cap  -->  tBNB -> mUSDC (Atlas-priced minOut)
///                         -->  pool.donate(mUSDC)  -->  Defended(...) + BufferValued(...)
///
///         Pools it may cover: the live pool its Launcher opened (main tranche, 50% of the buffer per day) and the
///         ScenarioPool named in vaultData (separate demo tranche: 20% of the buffer per day and at most 10% of all
///         revenue ever, paid only from tBNB swapped in that same call). The ScenarioPool is a demo pool whose price
///         the SplitStock team sets, so this tranche is bounded as a disclosed demo budget.
///
///         Thin DEX pairs: `cover` sizes its swap to the pair. If the router quote for the planned amount misses the
///         Atlas-priced minimum, it halves the amount (up to `MAX_DEPTH_HALVINGS` times) and covers in smaller pieces
///         instead of reverting.
///
///         No owner, no withdrawal, no sweep. The xNVDA it holds can never leave. It never calls the launch token.
///         Upgrades: the Guardian only, through the factory's beacon.
///
/// @dev Native BNB only. Deployed per launch as a beacon proxy by `BackstopVaultFactory`.
contract BackstopVault is DirectLaunchVaultBase, Initializable, ReentrancyGuard {
    using SafeTransferLib for address;

    uint256 internal constant BPS = 10_000;
    /// @notice Cover epoch length.
    uint256 public constant EPOCH = 1 days;
    /// @notice Share of the buffer the live pool may draw per epoch.
    uint256 public constant LIVE_EPOCH_CAP_BPS = 5000;
    /// @notice Share of the buffer the ScenarioPool may draw per epoch (separate tranche).
    uint256 public constant SCENARIO_EPOCH_CAP_BPS = 2000;
    /// @notice Swap minimum: Atlas BNB/USD value less this slippage.
    uint256 public constant SWAP_SLIPPAGE_BPS = 200;
    /// @notice Extra tBNB swapped above the exact deficit to absorb swap fees (the pool caps what it accepts).
    uint256 public constant SWAP_HEADROOM_BPS = 300;
    /// @notice Max age of the Atlas BNB/USD answer for cover (Atlas on 97 updates about every 60 s).
    uint256 public constant BNB_USD_MAX_AGE = 15 minutes;
    /// @notice Lifetime cap of the ScenarioPool tranche, as a share of all revenue recognized.
    uint256 public constant SCENARIO_LIFETIME_CAP_BPS = 1000;
    /// @notice How many times `cover` may halve its swap to fit a thin pair (1/64 of the plan at most).
    uint256 public constant MAX_DEPTH_HALVINGS = 6;

    address public taxToken;
    address public launcher;
    address public scenarioPool;
    address public usdc;
    address public swapRouter;
    address public atlasBnbUsd;

    /// @notice tBNB revenue recognized so far (tax, seed fallback, anything received).
    uint256 public totalRevenue;
    /// @notice tBNB spent on cover so far.
    uint256 public totalOut;
    /// @notice USD (WAD) donated to pools so far.
    uint256 public totalDefendedUsd;
    /// @notice epoch => tBNB spent on the live pool / on the ScenarioPool.
    mapping(uint256 epoch => uint256 amount) public spentLive;
    mapping(uint256 epoch => uint256 amount) public spentScenario;
    /// @notice tBNB spent on the ScenarioPool over the vault's life.
    uint256 public spentScenarioTotal;

    error ZeroAddress();
    error NotCoverable(address pool);
    error NotUnderwater(uint256 cr);
    error NotDonor(address pool);
    error StaleBnbUsd();
    error StalePoolPrice();
    error EpochCapReached();
    error NothingToCover();
    error SwapShort(uint256 got, uint256 minOut);

    event RevenueRecognized(uint256 amount, uint256 totalRevenue);
    event Defended(address indexed pool, uint256 bnbIn, uint256 usdcOut, uint256 crBefore, uint256 crAfter);
    event BufferValued(uint256 bnbUsd, uint256 atlasUpdatedAt);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Called once by the factory in `newVault`, in the same transaction that deploys the proxy.
    function initialize(address taxToken_, address launcher_, address scenarioPool_) external initializer {
        if (taxToken_ == address(0) || launcher_ == address(0)) revert ZeroAddress();
        taxToken = taxToken_;
        launcher = launcher_;
        scenarioPool = scenarioPool_;
        // The Launcher's snapshot, so the vault and the pool it opens always agree on the core addresses.
        SplitPoolConfig memory cfg = ISplitLauncherView(launcher_).poolConfig();
        usdc = IPoolFactory(cfg.poolFactory).usdc();
        swapRouter = cfg.swapRouter;
        atlasBnbUsd = cfg.atlasBnbUsd;
        if (usdc == address(0) || swapRouter == address(0) || atlasBnbUsd == address(0)) revert ZeroAddress();
    }

    receive() external payable {
        _sync();
    }

    /// @notice Recognize revenue that arrived without a wake (for example a direct transfer).
    function sync() external {
        _sync();
    }

    function version() external pure returns (string memory) {
        return "v1.0.0";
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Accounting
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Revenue = balance + spent. Spending lowers the balance and raises `totalOut` by the same amount, so a cover
    ///      never looks like new revenue.
    function _sync() internal {
        uint256 seen = address(this).balance + totalOut;
        if (seen <= totalRevenue) return;
        emit RevenueRecognized(seen - totalRevenue, seen);
        totalRevenue = seen;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views (never revert)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The live SplitStock pool the Launcher opened (0 until `openPool`).
    function livePool() public view returns (address p) {
        try ISplitLauncherView(launcher).pool() returns (address x) {
            p = x;
        } catch {}
    }

    /// @notice Alias of `livePool()` for the Flap vault UI (which may only read the vault itself).
    function pool() external view returns (address) {
        return livePool();
    }

    /// @notice The live pool's collateral ratio (WAD, 1e18 = 100%); 0 before `openPool` or if unreadable.
    function poolCollateralRatio() external view returns (uint256 cr) {
        address p = livePool();
        if (p == address(0)) return 0;
        try ILeveragePool(p).state() returns (ILeveragePool.PoolState memory st) {
            cr = st.collateralRatio;
        } catch {}
    }

    /// @notice tBNB buffer available for cover.
    function bufferBnb() public view returns (uint256) {
        return address(this).balance;
    }

    /// @notice USD value (WAD) of the tBNB buffer at Atlas BNB/USD (last answer, even if stale; 0 if unreadable).
    function bufferUsd() public view returns (uint256) {
        (uint256 bnbUsd,,) = FeedLib.read(atlasBnbUsd, type(uint256).max);
        return Math.mulDiv(address(this).balance, bnbUsd, 1e18);
    }

    /// @notice Full buffer valuation: tBNB, its USD value, the Atlas BNB/USD answer, its time and freshness, plus any
    ///         mUSDC left over from a previous cover.
    function bufferValuation()
        external
        view
        returns (uint256 bnb, uint256 usd, uint256 bnbUsd, uint256 atlasUpdatedAt, bool fresh, uint256 usdcHeld)
    {
        bnb = address(this).balance;
        (bnbUsd, atlasUpdatedAt, fresh) = FeedLib.read(atlasBnbUsd, BNB_USD_MAX_AGE);
        usd = Math.mulDiv(bnb, bnbUsd, 1e18);
        usdcHeld = _usdcBalance();
    }

    /// @notice First-loss x tokens of the live pool held (locked) here.
    function xHeld() external view returns (uint256) {
        address p = livePool();
        if (p == address(0)) return 0;
        try ILeveragePool(p).xToken() returns (address x) {
            return _balanceOf(x, address(this));
        } catch {
            return 0;
        }
    }

    /// @notice tBNB the pool's tranche may still spend this epoch.
    function capLeft(address target) public view returns (uint256) {
        uint256 e = block.timestamp / EPOCH;
        uint256 base = address(this).balance + spentLive[e] + spentScenario[e];
        if (target != address(0) && target == livePool()) {
            uint256 cap = (base * LIVE_EPOCH_CAP_BPS) / BPS;
            return cap > spentLive[e] ? cap - spentLive[e] : 0;
        }
        if (target != address(0) && target == scenarioPool) {
            uint256 cap = (base * SCENARIO_EPOCH_CAP_BPS) / BPS;
            uint256 left = cap > spentScenario[e] ? cap - spentScenario[e] : 0;
            uint256 life = (totalRevenue * SCENARIO_LIFETIME_CAP_BPS) / BPS;
            uint256 lifeLeft = life > spentScenarioTotal ? life - spentScenarioTotal : 0;
            return left < lifeLeft ? left : lifeLeft;
        }
        return 0;
    }

    /// @notice True when `cover(pool)` should succeed now (best effort; the swap and donate can still fail).
    function canCover(address target) external view returns (bool) {
        if (target == address(0) || (target != livePool() && target != scenarioPool)) return false;
        try ILeveragePool(target).isDonor(address(this)) returns (bool d) {
            if (!d) return false;
        } catch {
            return false;
        }
        ILeveragePool.PoolState memory st;
        try ILeveragePool(target).state() returns (ILeveragePool.PoolState memory s) {
            st = s;
        } catch {
            return false;
        }
        if (!_priceOk(target, st) || st.S <= st.V) return false;
        (,, bool fresh) = FeedLib.read(atlasBnbUsd, BNB_USD_MAX_AGE);
        if (!fresh) return false;
        return capLeft(target) > 0 || (target == livePool() && _usdcBalance() > 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cover
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permissionless. Valid only for the live pool or the ScenarioPool, only while its CR < 1 with a fresh
    ///         price (or a fresh price the feed has halted on, so the cover lands during the pool's redeem hold).
    ///         Spends at most the deficit S - V (plus swap headroom) and the tranche's caps: tBNB -> mUSDC on
    ///         PancakeSwap with minOut = amount x Atlas BNB/USD x (1 - 2%), then `pool.donate(mUSDC, 0)`. The swap is
    ///         halved until the router quote meets that minimum (thin pairs). The live pool also gets any mUSDC left
    ///         from earlier covers; the ScenarioPool only gets what this call bought. mUSDC the pool does not accept
    ///         stays here for the next live-pool cover.
    /// @return usdcOut mUSDC the pool accepted.
    function cover(address target) external nonReentrant returns (uint256 usdcOut) {
        _sync();
        (bool isLive, uint256 crBefore, uint256 deficitUsd) = _checkCoverable(target);
        uint256 bnbUsd = _freshBnbUsd();
        uint8 uDec = FeedLib.decimalsOf(usdc);
        uint256 usable = isLive ? _usdcBalance() : 0;
        uint256 bnbIn = _bnbToSpend(target, usable, deficitUsd, bnbUsd, uDec);

        if (bnbIn > 0) {
            uint256 minOut;
            (bnbIn, minOut) = _fitToDepth(bnbIn, bnbUsd, uDec, usable == 0);
            if (bnbIn > 0) {
                uint256 e = block.timestamp / EPOCH;
                if (isLive) {
                    spentLive[e] += bnbIn;
                } else {
                    spentScenario[e] += bnbIn;
                    spentScenarioTotal += bnbIn;
                }
                totalOut += bnbIn;
                usable += _swapBnbToUsdc(bnbIn, minOut);
            }
        }

        usdcOut = _donate(target, usable);
        totalDefendedUsd += Math.mulDiv(usdcOut, 1e18, 10 ** uDec);
        emit Defended(target, bnbIn, usdcOut, crBefore, _cr(target));
    }

    /// @dev Reverts unless `pool` is ours to cover, we are its donor, its price is fresh (or fresh but halted) and S > V.
    function _checkCoverable(address target) internal view returns (bool isLive, uint256 crBefore, uint256 deficitUsd) {
        isLive = target != address(0) && target == livePool();
        bool isScenario = target != address(0) && target == scenarioPool;
        if (!isLive && !isScenario) revert NotCoverable(target);
        if (!ILeveragePool(target).isDonor(address(this))) revert NotDonor(target);
        ILeveragePool.PoolState memory st = ILeveragePool(target).state();
        if (!_priceOk(target, st)) revert StalePoolPrice();
        if (st.S <= st.V) revert NotUnderwater(st.collateralRatio);
        crBefore = st.collateralRatio;
        deficitUsd = st.S - st.V;
    }

    /// @dev Fresh price, or a price that is only "not fresh" because the feed is halted (a jump the mirror is
    ///      confirming) and still within the pool's maxPriceAge. Covering during a halt is what lets the pool's
    ///      redeemStable hold end with holders made whole instead of paying the first redeemers the V/S haircut.
    function _priceOk(address target, ILeveragePool.PoolState memory st) internal view returns (bool) {
        if (st.priceFresh) return true;
        if (!st.feedHalted || st.price == 0) return false;
        try ILeveragePool(target).params() returns (ILeveragePool.PoolParams memory p) {
            return st.priceAge <= p.maxPriceAge;
        } catch {
            return false;
        }
    }

    /// @dev Fresh Atlas BNB/USD (WAD), and the `BufferValued` evidence event.
    function _freshBnbUsd() internal returns (uint256 bnbUsd) {
        (uint256 p, uint256 atlasAt, bool fresh) = FeedLib.read(atlasBnbUsd, BNB_USD_MAX_AGE);
        if (!fresh) revert StaleBnbUsd();
        emit BufferValued(p, atlasAt);
        bnbUsd = p;
    }

    function _cr(address target) internal view returns (uint256) {
        return ILeveragePool(target).state().collateralRatio;
    }

    /// @dev tBNB to swap: the deficit not already covered by usable mUSDC, plus headroom, capped by the tranche's caps
    ///      and the balance. Reverts when there is nothing at all to donate.
    function _bnbToSpend(address target, uint256 usdcHeld, uint256 deficitUsd, uint256 bnbUsd, uint8 uDec)
        internal
        view
        returns (uint256 bnbIn)
    {
        uint256 heldUsd = Math.mulDiv(usdcHeld, 1e18, 10 ** uDec);
        uint256 cap = capLeft(target);
        if (heldUsd < deficitUsd) {
            uint256 needBnb = Math.mulDiv(deficitUsd - heldUsd, 1e18, bnbUsd, Math.Rounding.Ceil);
            needBnb = Math.mulDiv(needBnb, BPS + SWAP_HEADROOM_BPS, BPS, Math.Rounding.Ceil);
            bnbIn = needBnb < cap ? needBnb : cap;
            uint256 bal = address(this).balance;
            if (bnbIn > bal) bnbIn = bal;
        }
        if (bnbIn == 0 && usdcHeld == 0) {
            if (cap == 0 && address(this).balance > 0) revert EpochCapReached();
            revert NothingToCover();
        }
    }

    /// @dev Largest of bnbIn, bnbIn/2, ... (at most MAX_DEPTH_HALVINGS halvings) whose router quote meets the
    ///      Atlas-priced minimum. Returns (0, 0) when none does and `mustSwap` is false (there is mUSDC to donate
    ///      anyway); reverts `SwapShort` when none does and there is nothing else to donate.
    function _fitToDepth(uint256 bnbIn, uint256 bnbUsd, uint8 uDec, bool mustSwap)
        internal
        view
        returns (uint256 amt, uint256 minOut)
    {
        address[] memory path = _usdcPath();
        uint256 quoted;
        amt = bnbIn;
        for (uint256 i; i <= MAX_DEPTH_HALVINGS && amt > 0; ++i) {
            minOut = _usdcMinOut(amt, bnbUsd, uDec);
            quoted = 0;
            try IUniswapV2Router02(swapRouter).getAmountsOut(amt, path) returns (uint256[] memory outs) {
                quoted = outs[outs.length - 1];
            } catch {}
            if (quoted >= minOut && quoted > 0 && minOut > 0) return (amt, minOut);
            amt /= 2;
        }
        if (mustSwap) revert SwapShort(quoted, minOut);
        return (0, 0);
    }

    function _usdcMinOut(uint256 bnbIn, uint256 bnbUsd, uint8 uDec) internal pure returns (uint256) {
        uint256 usdValue = Math.mulDiv(bnbIn, bnbUsd, 1e18);
        return Math.mulDiv(Math.mulDiv(usdValue, 10 ** uDec, 1e18), BPS - SWAP_SLIPPAGE_BPS, BPS);
    }

    function _usdcPath() internal view returns (address[] memory path) {
        path = new address[](2);
        path[0] = IUniswapV2Router02(swapRouter).WETH();
        path[1] = usdc;
    }

    /// @dev Approve exactly `amount` mUSDC, donate it, reset the approval. The pool caps what it accepts at S - V.
    function _donate(address target, uint256 amount) internal returns (uint256 usdcOut) {
        if (amount == 0) revert NothingToCover();
        usdc.safeApprove(target, amount);
        (usdcOut,) = ILeveragePool(target).donate(amount, 0);
        usdc.safeApprove(target, 0);
        if (usdcOut == 0) revert NothingToCover();
    }

    /// @notice Permissionless: emit `BufferValued` from a live Atlas BNB/USD read (testnet Atlas read evidence).
    function valueBuffer() external returns (uint256 usd) {
        (uint256 bnbUsd, uint256 atlasAt,) = FeedLib.read(atlasBnbUsd, type(uint256).max);
        emit BufferValued(bnbUsd, atlasAt);
        usd = Math.mulDiv(address(this).balance, bnbUsd, 1e18);
    }

    function _swapBnbToUsdc(uint256 bnbIn, uint256 minOut) internal returns (uint256 got) {
        uint256 before = _usdcBalance();
        IUniswapV2Router02(swapRouter).swapExactETHForTokens{value: bnbIn}(
            minOut, _usdcPath(), address(this), block.timestamp
        );
        got = _usdcBalance() - before;
        if (got < minOut || got == 0) revert SwapShort(got, minOut);
    }

    function _usdcBalance() internal view returns (uint256) {
        return _balanceOf(usdc, address(this));
    }

    function _balanceOf(address token, address who) internal view returns (uint256 bal) {
        if (token == address(0) || token.code.length == 0) return 0;
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        if (ok && ret.length >= 32) bal = abi.decode(ret, (uint256));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IDirectLaunchVault
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc DirectLaunchVaultBase
    /// @dev Never reverts: storage reads, `livePool()` (try/catch) and `bufferUsd()` (never reverts) only.
    function description() public view override returns (string memory) {
        string memory head = string.concat(
            "BackstopVault for SplitStock launcher ",
            LibString.toHexString(launcher),
            " and token ",
            LibString.toHexString(taxToken),
            ". Receives 50% of the token's 3% buy and 3% sell tax in tBNB (the rest: 20% to liquidity, 30% burned; no creator or marketing fee). It holds the protocol-owned first-loss xNVDA of the SplitStock pool ",
            LibString.toHexString(livePool()),
            " locked forever, and spends tBNB only through cover(pool): only while that pool's collateral ratio is below 1, at most the deficit and 50% of the buffer per day, swapped to mUSDC at an Atlas BNB/USD minimum and donated to the pool. "
        );
        return string.concat(
            head,
            "The ScenarioPool ",
            LibString.toHexString(scenarioPool),
            " is a demo pool whose price the SplitStock team sets (a cover there benefits that pool's xNVDA holders), so it may draw at most 20% of the buffer per day and 10% of all revenue ever. No owner, no withdrawal. Revenue recognized: ",
            LibString.toString(totalRevenue),
            " wei; buffer: ",
            LibString.toString(address(this).balance),
            " wei (about ",
            LibString.toString(bufferUsd() / 1e18),
            " USD)."
        );
    }

    /// @inheritdoc DirectLaunchVaultBase
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "BackstopVault";
        schema.description =
            "Insurance buffer for a SplitStock pool: half of the token tax in tBNB, spent only to cover the pool when its collateral ratio is below 1. Holds the pool's protocol-owned first-loss xNVDA.";
        schema.methods = new VaultMethodSchema[](9);

        schema.methods[0].name = "bufferUsd";
        schema.methods[0].description = "USD value of the tBNB buffer at Atlas BNB/USD.";
        schema.methods[0].outputs = new FieldDescriptor[](1);
        schema.methods[0].outputs[0] = FieldDescriptor("usd", "uint256", "Buffer in USD", 18);

        schema.methods[1].name = "bufferBnb";
        schema.methods[1].description = "tBNB available for cover.";
        schema.methods[1].outputs = new FieldDescriptor[](1);
        schema.methods[1].outputs[0] = FieldDescriptor("amount", "uint256", "Buffer in tBNB", 18);

        schema.methods[2].name = "totalRevenue";
        schema.methods[2].description = "tBNB received by the vault so far.";
        schema.methods[2].outputs = new FieldDescriptor[](1);
        schema.methods[2].outputs[0] = FieldDescriptor("amount", "uint256", "Total tBNB received", 18);

        schema.methods[3].name = "totalDefendedUsd";
        schema.methods[3].description = "USD donated to pools by cover so far.";
        schema.methods[3].outputs = new FieldDescriptor[](1);
        schema.methods[3].outputs[0] = FieldDescriptor("usd", "uint256", "Defended USD", 18);

        schema.methods[4].name = "livePool";
        schema.methods[4].description = "The SplitStock pool this vault backs.";
        schema.methods[4].outputs = new FieldDescriptor[](1);
        schema.methods[4].outputs[0] = FieldDescriptor("pool", "address", "LeveragePool", 0);

        schema.methods[5].name = "canCover";
        schema.methods[5].description = "Whether cover(pool) would run now (the pool is below CR 1).";
        schema.methods[5].inputs = new FieldDescriptor[](1);
        schema.methods[5].inputs[0] = FieldDescriptor("pool", "address", "Pool to cover", 0);
        schema.methods[5].outputs = new FieldDescriptor[](1);
        schema.methods[5].outputs[0] = FieldDescriptor("ok", "bool", "Coverable now", 0);

        schema.methods[6].name = "cover";
        schema.methods[6].description = "Cover the pool's deficit from the buffer (only while CR < 1).";
        schema.methods[6].inputs = new FieldDescriptor[](1);
        schema.methods[6].inputs[0] = FieldDescriptor("pool", "address", "Pool to cover", 0);
        schema.methods[6].isWriteMethod = true;

        schema.methods[7].name = "sync";
        schema.methods[7].description = "Recognize tBNB that arrived without a receive() call (for example a direct transfer).";
        schema.methods[7].isWriteMethod = true;

        schema.methods[8].name = "valueBuffer";
        schema.methods[8].description = "Emit BufferValued with the current Atlas BNB/USD answer (on-chain evidence of the buffer value).";
        schema.methods[8].outputs = new FieldDescriptor[](1);
        schema.methods[8].outputs[0] = FieldDescriptor("usd", "uint256", "Buffer in USD", 18);
        schema.methods[8].isWriteMethod = true;
    }
}
