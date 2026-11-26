// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin-contracts-upgradeable/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {IPortalTypes, IPortal} from "src/flap/IPortal.sol";
import {LauncherBase} from "src/flap/LauncherBase.sol";
import {Distribution, DistributionTarget} from "src/flap/Distribution.sol";
import {IStrategy} from "src/flap/IStrategy.sol";
import {LaunchExtensionHelper} from "src/flap/LaunchExtensionHelper.sol";
import {LauncherDescription} from "src/flap/LauncherHelper.sol";

import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";
import {ILeveragePool} from "src/interfaces/ILeveragePool.sol";
import {IUniswapV2Router02} from "src/interfaces/IUniswapV2Router02.sol";

import {
    SplitPoolConfig,
    ISplitLauncherFactory,
    ISplitStockConfig,
    IBackstopVaultView,
    IUniswapV2FactoryLike,
    FLAP_TOKEN_IMPL
} from "src/launch/ISplitLaunch.sol";
import {FeedLib} from "src/launch/FeedLib.sol";

// Display copy for `description()`. Developer constants: nothing in them needs JSON escaping (no quote, backslash or
// control character). Chinese constants are `unicode` literals.
string constant SPLIT_TITLE_EN = "Backstop-first crowdfund";
string constant SPLIT_TITLE_ZH = unicode"备用金优先众筹";
string constant SPLIT_SUMMARY_EN =
    "Contributors send tBNB until the target is met. The token then launches on Flap: 500,000 of the 1,000,000 supply seed the pool and 500,000 are split pro rata among contributors. Holders who escrow 100 sUSD get 1.2x weight on a capped amount, and the escrow is returned at claim or refund. The backstop seed is kept apart: after launch anyone can call openPool once, which opens a new SplitStock NVDA pool, swaps the seed to tNVDA at an Atlas-priced minimum and seeds the pool, so the first-loss xNVDA is owned by the BackstopVault and locked there. The pool settings (PoolFactory, stock token, price feeds, routers, ScenarioPool, boost token) are fixed for this launcher factory: they come from an immutable SplitStock config with no admin and no setter, so nobody can change them. Tax is 3% on buys and 3% on sells for 30 days: 50% goes to the BackstopVault, which can only spend it to cover the pool while its collateral ratio is below 1, 20% goes to liquidity and 30% is burned. There is no creator or marketing fee. If the target is missed by the deadline, every contributor can refund in full. The ScenarioPool shown in the app is a demo pool with a team-set price.";
string constant SPLIT_SUMMARY_ZH =
    unicode"贡献者存入 tBNB 直至达到目标。随后代币在 Flap 发射：总量 1,000,000 中 500,000 注入流动性池，500,000 按出资比例分给贡献者。托管 100 sUSD 的持有者在限额内获得 1.2 倍权重，托管的 sUSD 在领取或退款时退回。备用金种子单独保留：发射后任何人都可调用一次 openPool，它会新建一个 SplitStock NVDA 池，按 Atlas 价格设定的最低成交量把种子换成 tNVDA 并为池子注资，因此首亏 xNVDA 归 BackstopVault 所有并锁定在其中。池子设置（PoolFactory、股票代币、价格源、路由、ScenarioPool、加成代币）对本 Launcher 工厂固定不变：来自不可变的 SplitStock 配置，没有管理员也没有修改函数，任何人都无法更改。买入和卖出各收 3% 的税，为期 30 天：50% 进入 BackstopVault，仅在池子抵押率低于 1 时用于补足，20% 进入流动性，30% 销毁。没有创建者或营销费用。截止时间前未达到目标，所有贡献者都可全额退款。应用中显示的 ScenarioPool 是演示池，价格由团队设定。";

/// @notice Payload for `Portal.newLauncher(SplitLauncherFactory, abi.encode(SplitConfig))`. Field order is the ABI.
/// @param name         Token name, 1..32 bytes.
/// @param symbol       Token symbol, 1..10 bytes.
/// @param meta         Metadata URI (IPFS CID), at most 512 bytes.
/// @param salt         Launch salt, mined so the token address CREATE2(TOKEN_IMPL, salt, Portal) ends in 0x7777.
/// @param targetRaise  Total tBNB raised. `targetRaise - backstopSeed` becomes the Flap pool quote.
/// @param backstopSeed tBNB held back for `openPool()`: swapped to tNVDA and used as the new pool's first-loss seed.
/// @param saleDuration Contribution window in seconds.
/// @param vaultFactory Must be the paired BackstopVaultFactory.
struct SplitConfig {
    string name;
    string symbol;
    string meta;
    bytes32 salt;
    uint256 targetRaise;
    uint256 backstopSeed;
    uint256 saleDuration;
    address vaultFactory;
}

/// @title SplitLauncher
/// @notice "Backstop-first crowdfund". A crowd raise in tBNB launches a 7777 tax token on Flap Pool Launch, and the
///         rest of the raise opens a new SplitStock pool whose protocol-owned first-loss xNVDA sits in the token's
///         BackstopVault. Half of the token's tax then funds that pool's backstop.
///
///           contribute() ... contribute()  --raised == target-->  launchTaxTokenV2 (pool quote = target - seed)
///                                                                  |  VAULT 50% -> BackstopVault (tax, in BNB)
///                                                                  |  LP 20%, DEFLATION 30%
///                                                                  |  EXPLICIT distribution: 500,000 to this contract
///           openPool()  (anyone, once)  -->  PoolFactory.createPool(tNVDA, NVDA mirror)  -->  swap seed tBNB->tNVDA
///                                          -->  pool.seed(cIn, BackstopVault)  -->  pool.setDonor(BackstopVault)
///           claim() / refund()  pull payments, one-shot, mutually exclusive.
///
///         `openPool` is a separate transaction so a pool-side failure (stale price, missing role) can never revert the
///         Flap launch. If the pool is never opened, `releaseSeed()` hands the seed to the BackstopVault after
///         `SEED_RELEASE_DELAY`, so nothing is stranded.
///
///         Guardian (from the factory): may only force the Failed state before launch (which opens refunds) and
///         upgrade the beacon through the factory. It has no sweep and cannot touch contributions, escrow or the seed.
///
/// @dev Deployed by `SplitLauncherFactory` as an ERC1967 beacon proxy keyed by the launch salt.
contract SplitLauncher is LauncherBase, Initializable, ReentrancyGuard, IStrategy {
    using SafeTransferLib for address;

    // ─────────────────────────────────────────────────────────────────────────
    // Fixed token shape
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant TOTAL_SUPPLY = 1_000_000 ether;
    uint256 public constant POOL_TOKEN = 500_000 ether;
    uint256 public constant DISTRIBUTED_TOKEN = TOTAL_SUPPLY - POOL_TOKEN; // 500,000e18 (50/50, like Flap's CrowdLauncher)
    uint16 public constant BUY_TAX_BPS = 300;
    uint16 public constant SELL_TAX_BPS = 300;
    uint32 public constant TAX_DURATION = 30 days;
    uint32 public constant ANTI_FARMER_DURATION = 1 days;
    uint16 public constant VAULT_SLOT_BPS = 5000;
    uint16 public constant LP_SLOT_BPS = 2000;
    uint16 public constant DEFLATION_SLOT_BPS = 3000;

    /// @notice FlapDirectTaxToken implementation the Portal clones: token = CREATE2(impl, salt, Portal).
    address public constant TOKEN_IMPL = FLAP_TOKEN_IMPL;

    // ─────────────────────────────────────────────────────────────────────────
    // Holder boost and pool opening
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Exact sUSD escrow pulled by `contributeBoosted()`.
    uint256 public constant BOOST_ESCROW = 100 ether;
    /// @notice Extra weight for a boosted contributor, on contributions up to `BOOST_CAP_BNB`.
    uint256 public constant BOOST_BPS = 2000; // +20% -> 1.2x
    uint256 public constant BOOST_CAP_BNB = 0.5 ether;
    /// @notice Slippage allowed on the seed swap, against the Atlas BNB/USD and the pool feed.
    uint256 public constant SEED_SLIPPAGE_BPS = 300;
    /// @notice Max age of the Atlas BNB/USD answer used for the seed swap minimum (Atlas on 97 updates about every
    ///         60 s; a staler answer would widen the effective slippage bound).
    uint256 public constant BNB_USD_MAX_AGE = 15 minutes;
    /// @notice Max age of the stock feed used for the seed swap minimum (the pool's own seed check is stricter).
    uint256 public constant ASSET_USD_MAX_AGE = 10 minutes;
    /// @notice After this long without `openPool`, anyone may hand the seed to the BackstopVault instead.
    uint256 public constant SEED_RELEASE_DELAY = 14 days;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    address public hub;
    address public factory;
    address public creator;
    bytes32 public launchSalt;
    uint256 public targetRaise;
    uint256 public backstopSeed;
    uint256 public saleDeadline;
    address public vaultFactory;
    /// @dev Snapshot of the SplitStock pool target, copied from the factory's immutable `SplitStockConfig` at
    ///      `initialize()`. Never written again.
    SplitPoolConfig internal _pool;
    /// @notice Symbol of the SplitStock pool `openPool` creates (snapshot, like `poolConfig()`).
    string public poolSymbol;

    string public name;
    string public symbol;
    string public meta;

    uint256 public raised;
    mapping(address account => uint256 amount) public contributions;
    mapping(address account => bool) public boosted;
    uint256 public totalWeight;
    uint256 public claimedWeight;
    mapping(address account => bool) public claimed;
    mapping(address account => bool) public refunded;
    uint256 public escrowHeld;
    /// @notice Escrow whose return failed at claim / refund (the token refused the transfer). Pull it with
    ///         `withdrawEscrow()`; the BNB refund or token claim never waits on it.
    mapping(address account => uint256 amount) public escrowOwed;

    bool public launching;
    bool public launched;
    bool public forcedFailed;
    bool internal distributionInitialized;
    uint256 public launchedAt;

    address public token;
    /// @notice The Flap V2 LP pair of the launch token.
    address public lpPair;
    /// @notice The token's BackstopVault (`Portal.getLaunchVault(token)`).
    address public backstopVault;

    /// @notice tBNB still held for `openPool` (equals `backstopSeed` after launch until the pool opens).
    uint256 public seedBalance;
    bool public poolOpened;
    bool public seedReleased;
    /// @notice The SplitStock pool this launch opened.
    address public pool;
    uint256 public xLocked;

    // ─────────────────────────────────────────────────────────────────────────
    // Events and errors
    // ─────────────────────────────────────────────────────────────────────────

    event Contributed(address indexed user, uint256 amount, bool boosted, uint256 raised);
    event Launched(address indexed token, uint256 poolQuote, uint256 backstopSeed);
    event LaunchRecorded(address indexed token, address indexed lpPair, address indexed backstopVault);
    event PoolOpened(address indexed pool, uint256 seedIn, uint256 xLocked);
    event SeedSwapped(uint256 bnbIn, uint256 assetOut, uint256 minOut, uint256 bnbUsd, uint256 assetUsd);
    event SeedReleased(address indexed backstopVault, uint256 amount);
    event Claimed(address indexed user, uint256 tokenAmount, uint256 escrowReturned);
    event Refunded(address indexed user, uint256 bnbAmount, uint256 escrowReturned);
    event ForcedFailed(address indexed guardian);
    event DustSwept(address indexed to, uint256 amount);
    event ExcessReturned(address indexed user, uint256 amount);
    event EscrowDeferred(address indexed user, uint256 amount);
    event EscrowWithdrawn(address indexed user, uint256 amount);

    error InvalidConfig();
    error SaleClosed();
    error ZeroContribution();
    error LaunchInProgress();
    error UnauthorizedDistribution();
    error NotLaunched();
    error AlreadyLaunched();
    error AlreadyClaimed();
    error AlreadyBoosted();
    error BoostDisabled();
    error EscrowNotReceived(uint256 got);
    error NothingToClaim();
    error NotRefundable();
    error NothingToRefund();
    error PoolAlreadyOpened();
    error NoSeed();
    error NoVault();
    error PriceUnavailable(address feed);
    error SeedSlippage(uint256 got, uint256 minOut);
    error TooEarly(uint256 at);
    error DustNotReady();
    error CoreImplementationChanged();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory. `msg.value` must be exactly `Portal.SALT_LOCK_FEE()`; the Launcher locks the
    ///         salt itself because the Portal records the locker as `msg.sender`.
    ///         `cfg` / `poolSymbol_` are the factory's immutable SplitStockConfig; they are stored here and are the
    ///         only pool target this Launcher ever uses.
    function initialize(
        address hub_,
        address creator_,
        SplitConfig calldata c,
        SplitPoolConfig calldata cfg,
        string calldata poolSymbol_
    ) external payable initializer {
        if (hub_ == address(0) || creator_ == address(0)) revert InvalidConfig();
        if (cfg.poolFactory == address(0) || cfg.asset == address(0) || bytes(poolSymbol_).length == 0) {
            revert InvalidConfig();
        }
        if (c.salt == bytes32(0) || c.targetRaise == 0 || c.saleDuration == 0) revert InvalidConfig();
        if (c.backstopSeed == 0 || c.backstopSeed >= c.targetRaise) revert InvalidConfig();
        if (c.vaultFactory == address(0)) revert InvalidConfig();

        hub = hub_;
        factory = msg.sender;
        creator = creator_;
        launchSalt = c.salt;
        targetRaise = c.targetRaise;
        backstopSeed = c.backstopSeed;
        saleDeadline = block.timestamp + c.saleDuration;
        vaultFactory = c.vaultFactory;
        name = c.name;
        symbol = c.symbol;
        meta = c.meta;

        _pool = cfg;
        poolSymbol = poolSymbol_;

        uint256 fee = IPortal(hub_).SALT_LOCK_FEE();
        // Exactly the fee: anything extra would stay here, since neither a refund nor the launch can spend it.
        if (msg.value != fee) revert InvalidConfig();
        IPortal(hub_).lockSalt{value: fee}(c.salt, uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX));
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    /// @dev The Guardian named by the factory (the Flap Guardian on BSC testnet).
    function _getGuardian() internal view override returns (address) {
        return ISplitLauncherFactory(factory).guardian();
    }

    /// @inheritdoc LauncherBase
    function _description() internal view override returns (LauncherDescription memory d) {
        d.name = name;
        d.symbol = symbol;
        d.quoteToken = address(0);
        d.targetRaise = targetRaise;
        d.poolTokenRatio = (POOL_TOKEN * 1e18) / TOTAL_SUPPLY;
        d.titleZh = SPLIT_TITLE_ZH;
        d.titleEn = SPLIT_TITLE_EN;
        d.summaryZh = SPLIT_SUMMARY_ZH;
        d.summaryEn = SPLIT_SUMMARY_EN;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice This Launcher's own pool target (snapshot taken at creation; the vault factory and vault read it).
    function poolConfig() external view returns (SplitPoolConfig memory) {
        return _pool;
    }

    /// @notice The demo ScenarioPool the BackstopVault may also cover (0 = none). Part of the snapshot.
    function scenarioPool() public view returns (address) {
        return _pool.scenarioPool;
    }

    /// @notice sUSD accepted by `contributeBoosted()` (0 = boost disabled). Part of the snapshot.
    function boostToken() public view returns (address) {
        return _pool.boostToken;
    }

    /// @notice The token address the launch will produce: CREATE2 of the EIP-1167 clone of TOKEN_IMPL with `salt` by
    ///         the Portal (OpenZeppelin Clones prediction, as the Portal deploys it). Ends in 0x7777.
    function predictedToken() public view returns (address) {
        return Clones.predictDeterministicAddress(TOKEN_IMPL, launchSalt, hub);
    }

    /// @notice The exact amount that completes the raise (0 once the sale is not open).
    function remaining() public view returns (uint256) {
        if (launched || launching || forcedFailed || block.timestamp >= saleDeadline) return 0;
        return targetRaise - raised;
    }

    /// @notice tBNB that goes into the Flap LP at launch.
    function poolQuote() public view returns (uint256) {
        return targetRaise - backstopSeed;
    }

    /// @notice True when the raise can no longer launch and refunds are open.
    function failed() public view returns (bool) {
        return !launched && (forcedFailed || block.timestamp >= saleDeadline);
    }

    /// @notice Claim weight: contribution, plus BOOST_BPS on up to BOOST_CAP_BNB for a boosted contributor.
    function weightOf(address account) public view returns (uint256) {
        return _weight(contributions[account], boosted[account]);
    }

    /// @notice Launch tokens `account` can claim now (0 before launch or after its claim).
    function claimable(address account) public view returns (uint256) {
        if (!launched || claimed[account] || totalWeight == 0) return 0;
        return (weightOf(account) * DISTRIBUTED_TOKEN) / totalWeight;
    }

    /// @notice USD value (WAD) of the BackstopVault's tBNB buffer, from Atlas BNB/USD. Never reverts.
    function backstopBufferUsd() external view returns (uint256) {
        address v = backstopVault;
        if (v == address(0)) return 0;
        try IBackstopVaultView(v).bufferUsd() returns (uint256 usd) {
            return usd;
        } catch {
            return 0;
        }
    }

    /// @notice Alias of `BOOST_ESCROW` for UIs.
    function boostAmount() external pure returns (uint256) {
        return BOOST_ESCROW;
    }

    function _weight(uint256 c, bool b) internal pure returns (uint256) {
        if (!b) return c;
        uint256 boostedPart = c < BOOST_CAP_BNB ? c : BOOST_CAP_BNB;
        return c + (boostedPart * BOOST_BPS) / 10_000;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Contribution
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Add tBNB. Only what fits under `targetRaise` is taken: any excess is sent straight back in the same
    ///         call (`ExcessReturned`), so a tiny front-run can never make the final contribution revert. The call that
    ///         reaches `targetRaise` launches the token in the same transaction; if that launch reverts, the whole
    ///         contribution reverts.
    function contribute() external payable nonReentrant {
        _contribute(msg.sender, msg.value, false);
    }

    /// @notice Contribute and escrow exactly `BOOST_ESCROW` of `boostToken` (sUSD) for 1.2x weight on up to
    ///         `BOOST_CAP_BNB`. One boost per address; approve this Launcher first. The escrow is returned at claim or
    ///         refund. No oracle is read here.
    function contributeBoosted() external payable nonReentrant {
        address bt = _pool.boostToken;
        if (bt == address(0)) revert BoostDisabled();
        if (boosted[msg.sender]) revert AlreadyBoosted();
        uint256 before = bt.balanceOf(address(this));
        bt.safeTransferFrom(msg.sender, address(this), BOOST_ESCROW);
        uint256 got = bt.balanceOf(address(this)) - before;
        if (got != BOOST_ESCROW) revert EscrowNotReceived(got);
        escrowHeld += BOOST_ESCROW;
        _contribute(msg.sender, msg.value, true);
    }

    function _contribute(address user, uint256 amount, bool boost) internal {
        if (launching) revert LaunchInProgress();
        if (launched) revert AlreadyLaunched();
        if (forcedFailed || block.timestamp >= saleDeadline) revert SaleClosed();
        if (amount == 0) revert ZeroContribution();
        uint256 left = targetRaise - raised; // > 0: reaching the target launches (or reverts) in the same call
        uint256 take = amount < left ? amount : left;

        uint256 oldW = weightOf(user);
        raised += take;
        contributions[user] += take;
        if (boost) boosted[user] = true;
        totalWeight = totalWeight - oldW + weightOf(user);
        emit Contributed(user, take, boosted[user], raised);

        if (raised == targetRaise) _launch();
        if (amount > take) {
            user.safeTransferETH(amount - take);
            emit ExcessReturned(user, amount - take);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Launch
    // ─────────────────────────────────────────────────────────────────────────

    function _launch() private {
        IPortalTypes.CreateTaxTokenParams memory p = _buildParams();
        Distribution memory dist = Distribution({
            target: DistributionTarget.EXPLICIT,
            strategy: address(this),
            amount: uint128(DISTRIBUTED_TOKEN),
            configData: ""
        });
        IPortalTypes.CreatorBuyParams memory creatorBuy;

        uint256 quote = poolQuote();
        launching = true;
        (address token_, address lp_) = IPortal(hub).launchTaxTokenV2{value: quote}(p, dist, creatorBuy);
        launching = false;

        launched = true;
        launchedAt = block.timestamp;
        token = token_;
        lpPair = lp_;
        seedBalance = backstopSeed;
        (address vault,) = IPortal(hub).getLaunchVault(token_);
        if (vault == address(0)) revert NoVault();
        backstopVault = vault;
        emit Launched(token_, quote, backstopSeed);
        emit LaunchRecorded(token_, lp_, vault);
    }

    /// @inheritdoc IStrategy
    /// @dev Copied from CrowdLauncher: only the Portal, only during this Launcher's own launch, only once, exact amount.
    function initializeDistribution(address token_, uint256 amount, bytes calldata, bytes32) external override onlyHub {
        if (!launching || distributionInitialized) revert UnauthorizedDistribution();
        if (token_ == address(0) || amount != DISTRIBUTED_TOKEN) revert InvalidConfig();
        distributionInitialized = true;
        token = token_;
        token_.safeTransferFrom(msg.sender, address(this), amount);
        emit FlapDistributionInitialized(token_, amount);
    }

    function _buildParams() private view returns (IPortalTypes.CreateTaxTokenParams memory p) {
        p.name = name;
        p.symbol = symbol;
        p.meta = meta;
        p.totalSupply = TOTAL_SUPPLY;
        p.salt = launchSalt;
        p.quoteToken = address(0);
        p.dexId = 0;
        p.poolQuote = poolQuote();
        p.poolToken = POOL_TOKEN;
        p.buyTaxRate = BUY_TAX_BPS;
        p.sellTaxRate = SELL_TAX_BPS;
        p.taxDuration = TAX_DURATION;
        p.antiFarmerDuration = ANTI_FARMER_DURATION;
        p.feeConfigs = _feeConfigs();
        p.antiSniperMode = 0;
        p.exemptWindow = 0;
        p.exemptAddrs = new address[](0);
        p.creatorBuyQuote = 0;
        (p.extensionID, p.extensionData) = LaunchExtensionHelper.encodeCreator(creator);
        p.commissionReceiver = address(0);
    }

    /// @dev VAULT 5000 (BackstopVault) / LP 2000 / DEFLATION 3000. vaultData = abi.encode(launcher, scenarioPool).
    function _feeConfigs() private view returns (IPortalTypes.FeeConfig[] memory fees) {
        fees = new IPortalTypes.FeeConfig[](3);
        fees[0] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeSlotType.VAULT,
            bps: VAULT_SLOT_BPS,
            configData: abi.encode(
                IPortalTypes.FeeConfigVault({vaultFactory: vaultFactory, vaultData: abi.encode(address(this), _pool.scenarioPool)})
            )
        });
        fees[1] = IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.LP_BPS, bps: LP_SLOT_BPS, configData: ""});
        fees[2] =
            IPortalTypes.FeeConfig({feeType: IPortalTypes.FeeSlotType.DEFLATION, bps: DEFLATION_SLOT_BPS, configData: ""});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Open the SplitStock pool
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permissionless, once, after launch. Creates a new SplitStock pool through PoolFactory (this Launcher must
    ///         hold CREATOR_ROLE there), swaps the seed tBNB to the pool asset with an Atlas-priced minimum, seeds the
    ///         pool with the first-loss x minted to the BackstopVault, and allowlists the vault as the pool's donor.
    function openPool() external nonReentrant returns (address pool_) {
        if (!launched) revert NotLaunched();
        if (poolOpened) revert PoolAlreadyOpened();
        uint256 seedIn = seedBalance;
        if (seedIn == 0) revert NoSeed();
        address vault = backstopVault;
        if (vault == address(0)) revert NoVault();

        SplitPoolConfig memory cfg = _pool;

        // The PoolFactory admin can swap the clone implementations (`setImplementations`). Only open the pool with
        // the code pinned in this factory pair's immutable SplitStockConfig, so no core role can redirect the seed.
        // If they changed, openPool reverts and the seed goes to the BackstopVault through `releaseSeed`.
        _requirePinnedImplementations(cfg.poolFactory);

        poolOpened = true;
        seedBalance = 0;

        pool_ = IPoolFactory(cfg.poolFactory).createPool(
            cfg.asset, cfg.feed, cfg.assetId, poolSymbol, cfg.poolRouter, ILeveragePool.PoolKind.LIVE
        );
        pool = pool_;

        uint256 cIn = _swapSeed(cfg, seedIn);

        cfg.asset.safeApprove(pool_, cIn);
        uint256 xOut = ILeveragePool(pool_).seed(cIn, vault);
        cfg.asset.safeApprove(pool_, 0);
        ILeveragePool(pool_).setDonor(vault, true);

        xLocked = xOut;
        emit PoolOpened(pool_, seedIn, xOut);
    }

    function _requirePinnedImplementations(address poolFactory) internal view {
        (address p, address t, address sp) = ISplitStockConfig(ISplitLauncherFactory(factory).config()).implementations();
        IPoolFactory f = IPoolFactory(poolFactory);
        if (f.poolImpl() != p || f.tokenImpl() != t || f.stabilityPoolImpl() != sp) revert CoreImplementationChanged();
    }

    /// @notice Minimum pool-asset output for `bnbIn` tBNB: Atlas BNB/USD over the pool's stock feed, less
    ///         SEED_SLIPPAGE_BPS. Reverts when either price is unavailable or stale.
    function seedMinOut(uint256 bnbIn) public view returns (uint256 minOut, uint256 bnbUsd, uint256 assetUsd) {
        return _seedMinOut(_pool, bnbIn);
    }

    function _seedMinOut(SplitPoolConfig memory cfg, uint256 bnbIn)
        internal
        view
        returns (uint256 minOut, uint256 bnbUsd, uint256 assetUsd)
    {
        bool ok;
        (bnbUsd,, ok) = FeedLib.read(cfg.atlasBnbUsd, BNB_USD_MAX_AGE);
        if (!ok) revert PriceUnavailable(cfg.atlasBnbUsd);
        (assetUsd,, ok) = FeedLib.read(cfg.feed, ASSET_USD_MAX_AGE);
        if (!ok) revert PriceUnavailable(cfg.feed);
        // whole-asset amount (WAD) = bnbIn * bnbUsd / assetUsd, then scale to the asset's decimals.
        uint256 wadOut = Math.mulDiv(bnbIn, bnbUsd, assetUsd);
        uint256 units = Math.mulDiv(wadOut, 10 ** FeedLib.decimalsOf(cfg.asset), 1e18);
        minOut = Math.mulDiv(units, 10_000 - SEED_SLIPPAGE_BPS, 10_000);
    }

    function _swapSeed(SplitPoolConfig memory cfg, uint256 bnbIn) internal returns (uint256 out) {
        (uint256 minOut, uint256 bnbUsd, uint256 assetUsd) = _seedMinOut(cfg, bnbIn);
        IUniswapV2Router02 r = IUniswapV2Router02(cfg.swapRouter);
        address wbnb = r.WETH();
        address[] memory path;
        if (IUniswapV2FactoryLike(r.factory()).getPair(wbnb, cfg.asset) != address(0)) {
            path = new address[](2);
            path[0] = wbnb;
            path[1] = cfg.asset;
        } else {
            path = new address[](3);
            path[0] = wbnb;
            path[1] = IPoolFactory(cfg.poolFactory).usdc();
            path[2] = cfg.asset;
        }
        uint256 before = cfg.asset.balanceOf(address(this));
        r.swapExactETHForTokens{value: bnbIn}(minOut, path, address(this), block.timestamp);
        out = cfg.asset.balanceOf(address(this)) - before;
        if (out < minOut || out == 0) revert SeedSlippage(out, minOut);
        emit SeedSwapped(bnbIn, out, minOut, bnbUsd, assetUsd);
    }

    /// @notice Fallback so the seed is never stranded: if no pool was opened `SEED_RELEASE_DELAY` after launch, anyone
    ///         may forward the seed tBNB to the BackstopVault, where it joins the cover buffer.
    function releaseSeed() external nonReentrant {
        if (!launched) revert NotLaunched();
        if (poolOpened) revert PoolAlreadyOpened();
        uint256 at = launchedAt + SEED_RELEASE_DELAY;
        if (block.timestamp < at) revert TooEarly(at);
        uint256 amount = seedBalance;
        if (amount == 0) revert NoSeed();
        seedBalance = 0;
        seedReleased = true;
        backstopVault.safeTransferETH(amount);
        emit SeedReleased(backstopVault, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claim and refund (pull payments, one-shot, mutually exclusive)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Claim the caller's share of the 500,000 distributed tokens plus any escrowed sUSD.
    function claim() external nonReentrant {
        if (!launched) revert NotLaunched();
        if (claimed[msg.sender]) revert AlreadyClaimed();
        uint256 w = weightOf(msg.sender);
        if (w == 0) revert NothingToClaim();
        uint256 amount = (w * DISTRIBUTED_TOKEN) / totalWeight;

        claimed[msg.sender] = true;
        claimedWeight += w;
        uint256 escrow = boosted[msg.sender] ? BOOST_ESCROW : 0;
        if (escrow > 0) escrowHeld -= escrow;

        if (amount > 0) token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount, _returnEscrow(msg.sender, escrow));
    }

    /// @notice After the deadline (or a Guardian-forced failure) without a launch: 1x the tBNB contributed plus escrow.
    function refund() external nonReentrant {
        if (!failed()) revert NotRefundable();
        if (refunded[msg.sender]) revert NothingToRefund();
        uint256 amount = contributions[msg.sender];
        if (amount == 0) revert NothingToRefund();

        refunded[msg.sender] = true;
        uint256 escrow = boosted[msg.sender] ? BOOST_ESCROW : 0;
        if (escrow > 0) escrowHeld -= escrow;

        uint256 sent = _returnEscrow(msg.sender, escrow);
        msg.sender.safeTransferETH(amount);
        emit Refunded(msg.sender, amount, sent);
    }

    /// @notice Pull escrow whose return failed at claim or refund.
    function withdrawEscrow() external nonReentrant {
        uint256 amount = escrowOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        escrowOwed[msg.sender] = 0;
        escrowHeld -= amount;
        _pool.boostToken.safeTransfer(msg.sender, amount);
        emit EscrowWithdrawn(msg.sender, amount);
    }

    /// @dev Returns the escrow without letting a failing boost token block the caller's claim or refund: on failure
    ///      it is recorded in `escrowOwed` instead. Returns what was actually sent.
    function _returnEscrow(address user, uint256 amount) internal returns (uint256 sent) {
        if (amount == 0) return 0;
        address bt = _pool.boostToken;
        (bool ok, bytes memory ret) = bt.call(abi.encodeWithSignature("transfer(address,uint256)", user, amount));
        if (ok) ok = ret.length == 0 ? bt.code.length != 0 : (ret.length >= 32 && abi.decode(ret, (uint256)) == 1);
        if (ok) return amount;
        escrowOwed[user] += amount;
        escrowHeld += amount; // still held here until withdrawEscrow
        emit EscrowDeferred(user, amount);
        return 0;
    }

    /// @notice Once every weight has claimed, rounding dust of the distributed tokens goes to the BackstopVault.
    function sweepDust() external nonReentrant {
        if (!launched) revert NotLaunched();
        if (claimedWeight != totalWeight) revert DustNotReady();
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) revert DustNotReady();
        token.safeTransfer(backstopVault, bal);
        emit DustSwept(backstopVault, bal);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Guardian
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Guardian only, before launch: mark the raise Failed so contributors can refund now.
    function forceFail() external onlyGuardian {
        if (launched || launching) revert AlreadyLaunched();
        forcedFailed = true;
        emit ForcedFailed(msg.sender);
    }
}
