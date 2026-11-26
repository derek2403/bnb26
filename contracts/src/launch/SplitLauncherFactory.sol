// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibClone} from "solady/utils/LibClone.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {LauncherFactoryBase} from "src/flap/LauncherFactoryBase.sol";
import {LauncherDataSchema, FieldDescriptor} from "src/flap/IVaultSchemas.sol";
import {IPortal, IPortalTypes} from "src/flap/IPortal.sol";

import {SplitLauncher, SplitConfig} from "src/launch/SplitLauncher.sol";
import {
    SplitPoolConfig,
    ISplitLauncherFactory,
    ISplitStockConfig,
    IPortalQuoteLens,
    FLAP_TOKEN_IMPL
} from "src/launch/ISplitLaunch.sol";

/// @title SplitLauncherFactory
/// @notice Launcher factory for `SplitLauncher`, the Launcher half of the SplitStock Launcher + Vault pair. Mirrors
///         `CrowdLauncherFactory`: Hub and Guardian immutables, one beacon, deterministic ERC1967 beacon proxies keyed
///         by the launch salt, Guardian-only upgrades, no other privileged function.
///
///         Strict checks in `_newLauncher` (all rejected, none defaulted):
///           - `data` re-encodes byte-for-byte (`keccak(abi.encode(decoded)) == keccak(data)`), else `InvalidData`;
///           - `vaultFactory == pairedVaultFactory`;
///           - name 1..32 bytes, symbol 1..10 bytes, meta <= 512 bytes, salt non-zero;
///           - targetRaise, backstopSeed and saleDuration within bounds;
///           - the Flap pool quote (`targetRaise - backstopSeed`) is at least 1.1x the live creation floor, read from
///             `Portal.launchQuoteConfig` and `Portal.launcherFactoryMultiplier(this)`. The Portal re-checks the floor
///             at launch, so this is an early guard only: it is skipped whenever the undocumented `launchQuoteConfig`
///             read fails or returns something implausible, so a Portal change can never brick this factory.
///         The 0x7777 vanity rule is NOT re-checked here: the Portal enforces it in `lockSalt` (called by the
///         Launcher's `initialize`), and duplicating it would hard-code the Portal's token implementation into this
///         frozen bytecode. `predictToken` stays as a view for salt mining.
///
///         The pool every Launcher opens comes from `config` (a `SplitStockConfig`), copied into the Launcher when it
///         is created. That config is immutable (no admin, no setter) and the pointer to it is immutable, so the
///         pool target is FIXED PER FACTORY PAIR: nobody can redirect a Launcher's seed or a vault's buffer. A new
///         SplitStock core deployment means a new config + factory pair (and a new Flap enable request).
contract SplitLauncherFactory is LauncherFactoryBase, ISplitLauncherFactory {
    address public immutable override hub;
    address public immutable override guardian;
    address public immutable beacon;
    /// @notice The vault factory every Launcher of this factory must use. Fixed at construction.
    address public immutable override pairedVaultFactory;

    /// @notice The `SplitStockConfig` every Launcher copies its pool target from. Both the pointer and the config
    ///         behind it are immutable (fixed per factory pair). Each Launcher also snapshots it at creation.
    address public immutable override config;

    uint256 public constant MIN_TARGET = 0.5 ether;
    uint256 public constant MAX_TARGET = 1_000 ether;
    uint256 public constant MIN_BACKSTOP_SEED = 0.01 ether;
    uint256 public constant MIN_SALE_DURATION = 10 minutes;
    uint256 public constant MAX_SALE_DURATION = 30 days;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 10;
    uint256 public constant MAX_META_BYTES = 512;
    /// @notice Flap's documented creation floor, in USD (WAD): $750 x multiplier x totalSupply / poolToken.
    uint256 public constant CREATION_FLOOR_USD = 750e18;
    /// @notice Our margin over the creation floor: the pool quote must be >= 1.1x the floor.
    uint256 public constant FLOOR_MARGIN_BPS = 11_000;
    /// @notice Bounds outside which a `launchQuoteConfig` price is treated as unreadable (WAD USD per quote unit).
    uint256 public constant MIN_PLAUSIBLE_QUOTE_USD = 1e18;
    uint256 public constant MAX_PLAUSIBLE_QUOTE_USD = 1_000_000e18;

    error ZeroAddress();
    error NoCode(address target);
    error ConfigUnset();
    error WrongVaultFactory(address got, address expected);
    error TargetOutOfRange(uint256 got);
    error BackstopSeedOutOfRange(uint256 got);
    error SaleDurationOutOfRange(uint256 got);
    error FieldLength();
    error EmptyField();
    error InvalidData();
    error BelowFloor(uint256 poolQuote, uint256 minPoolQuote);

    event SplitLauncherCreated(address indexed launcher, address indexed creator, bytes32 launchSalt);
    event FlapLauncherImplementationUpgraded(address implementation);

    /// @dev The pool target lives in `config_`, an immutable `SplitStockConfig` deployed (and validated) before this
    ///      factory.
    constructor(address hub_, address guardian_, address pairedVaultFactory_, address config_) {
        if (hub_ == address(0) || guardian_ == address(0) || pairedVaultFactory_ == address(0) || config_ == address(0))
        {
            revert ZeroAddress();
        }
        if (config_.code.length == 0) revert NoCode(config_);
        if (!ISplitStockConfig(config_).isConfigured()) revert ConfigUnset();
        hub = hub_;
        guardian = guardian_;
        pairedVaultFactory = pairedVaultFactory_;
        config = config_;
        beacon = address(new UpgradeableBeacon(address(this), address(new SplitLauncher())));
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    function _getGuardian() internal view override returns (address) {
        return guardian;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Config views
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ISplitLauncherFactory
    /// @dev The factory pair's fixed config, i.e. what every Launcher copies. A Launcher's own pool target is
    ///      `launcher.poolConfig()`.
    function poolConfig() external view override returns (SplitPoolConfig memory) {
        return ISplitStockConfig(config).poolConfig();
    }

    /// @inheritdoc ISplitLauncherFactory
    function poolSymbol() external view override returns (string memory) {
        return ISplitStockConfig(config).poolSymbol();
    }

    /// @notice Always true (kept for scripts and UIs): the immutable config is set at deployment.
    function configured() external view returns (bool) {
        return ISplitStockConfig(config).isConfigured();
    }

    /// @notice The Launcher address `Portal.newLauncher` will create for `salt` (grant it CREATOR_ROLE beforehand).
    function predictLauncher(bytes32 salt) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(beacon, salt, address(this));
    }

    /// @notice The token address a launch with `salt` will produce, and whether it satisfies the 0x7777 rule
    ///         (a mining helper: the Portal itself enforces the rule in `lockSalt`).
    /// @dev The Portal clones the token with the standard EIP-1167 proxy (OpenZeppelin Clones), so this must use the
    ///      OZ prediction. Solady's `LibClone.predictDeterministicAddress` assumes a different 44-byte proxy and gives
    ///      another address (the live Portal then reverts `VanityAddressRequirementNotMet`).
    function predictToken(bytes32 salt) public view returns (address token, bool ok) {
        token = Clones.predictDeterministicAddress(FLAP_TOKEN_IMPL, salt, hub);
        ok = uint16(uint160(token)) == 0x7777;
    }

    /// @notice Live creation floor for this factory in wei of tBNB, and whether the Portal read gave a plausible
    ///         answer. floor = $750 x multiplier/10000 x totalSupply/poolToken / quotePriceUsd.
    /// @dev `launchQuoteConfig` is undocumented; we expect `(bool enabled, uint256 quotePriceUsd WAD)`. Anything else
    ///      (call fails, short return, enabled word not exactly 1, price outside $1..$1,000,000) is "unknown", and the
    ///      factory then leaves the floor to the Portal (which re-checks it at launch).
    function creationFloor() public view returns (uint256 floorWei, bool known) {
        (bool success, bytes memory ret) = hub.staticcall(
            abi.encodeCall(IPortalQuoteLens.launchQuoteConfig, (uint8(IPortalTypes.LaunchKind.DIRECT_V2_POOL_TAX), address(0)))
        );
        if (!success || ret.length < 64) return (0, false);
        (uint256 enabledWord, uint256 quotePriceUsd) = abi.decode(ret, (uint256, uint256));
        if (enabledWord != 1 || quotePriceUsd < MIN_PLAUSIBLE_QUOTE_USD || quotePriceUsd > MAX_PLAUSIBLE_QUOTE_USD) {
            return (0, false);
        }

        uint256 multBps = 10_000;
        try IPortal(hub).launcherFactoryMultiplier(address(this)) returns (bool enabled, uint16 m) {
            if (enabled) multBps = m;
        } catch {}

        uint256 supply = 1_000_000 ether;
        uint256 poolToken = 500_000 ether;
        floorWei = (CREATION_FLOOR_USD * multBps * supply * 1e18) / (10_000 * poolToken * quotePriceUsd);
        known = true;
    }

    /// @notice Smallest pool quote this factory accepts right now (1.1x the creation floor), 0 when unknown.
    function minPoolQuote() public view returns (uint256) {
        (uint256 floorWei, bool known) = creationFloor();
        if (!known) return 0;
        return (floorWei * FLOOR_MARGIN_BPS + 9_999) / 10_000;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LauncherFactoryBase
    // ─────────────────────────────────────────────────────────────────────────

    function _newLauncher(address creator, bytes calldata data) internal override returns (address launcher) {
        // `abi.decode` ignores trailing bytes: compare against a canonical re-encoding instead.
        SplitConfig memory c = abi.decode(data, (SplitConfig));
        if (keccak256(abi.encode(c)) != keccak256(data)) revert InvalidData();
        _validate(c);

        launcher = LibClone.deployDeterministicERC1967BeaconProxy(beacon, c.salt);
        _initialize(launcher, creator, c);
        emit SplitLauncherCreated(launcher, creator, c.salt);
    }

    function _validate(SplitConfig memory c) internal view {
        if (c.vaultFactory != pairedVaultFactory) revert WrongVaultFactory(c.vaultFactory, pairedVaultFactory);
        uint256 nl = bytes(c.name).length;
        uint256 sl = bytes(c.symbol).length;
        if (nl == 0 || sl == 0 || c.salt == bytes32(0)) revert EmptyField();
        if (nl > MAX_NAME_BYTES || sl > MAX_SYMBOL_BYTES || bytes(c.meta).length > MAX_META_BYTES) revert FieldLength();
        if (c.targetRaise < MIN_TARGET || c.targetRaise > MAX_TARGET) revert TargetOutOfRange(c.targetRaise);
        if (c.backstopSeed < MIN_BACKSTOP_SEED || c.backstopSeed * 2 > c.targetRaise) {
            revert BackstopSeedOutOfRange(c.backstopSeed);
        }
        if (c.saleDuration < MIN_SALE_DURATION || c.saleDuration > MAX_SALE_DURATION) {
            revert SaleDurationOutOfRange(c.saleDuration);
        }
        uint256 minQuote = minPoolQuote();
        uint256 quote = c.targetRaise - c.backstopSeed;
        if (quote < minQuote) revert BelowFloor(quote, minQuote);
    }

    /// @dev Hands the Launcher the (immutable) config; the Launcher stores it and never reads the config again.
    function _initialize(address launcher, address creator, SplitConfig memory c) internal {
        (SplitPoolConfig memory cfg, string memory sym,) = ISplitStockConfig(config).current();
        SplitLauncher(launcher).initialize{value: msg.value}(hub, creator, c, cfg, sym);
    }

    function upgradeVaultImplementation(address newImplementation) external override onlyGuardian {
        UpgradeableBeacon(beacon).upgradeTo(newImplementation);
        emit FlapLauncherImplementationUpgraded(newImplementation);
    }

    function beaconImplementation() external view returns (address) {
        return UpgradeableBeacon(beacon).implementation();
    }

    function launcherDataSchema() external pure override returns (LauncherDataSchema memory schema) {
        schema.description =
            "SplitStock backstop-first crowdfund: contributors raise tBNB together. At the target the token launches on Flap (500,000 of 1,000,000 in the pool, 500,000 to contributors pro rata). The backstop seed then opens a new SplitStock NVDA pool through openPool, and its first-loss xNVDA is locked in the BackstopVault, which receives 50% of the 3%/3% tax to cover the pool when its collateral ratio is below 1. Missed target: full refunds.";
        FieldDescriptor[] memory f = new FieldDescriptor[](8);
        f[0] = FieldDescriptor("name", "string", "Token name (1-32 bytes)", 0);
        f[1] = FieldDescriptor("symbol", "string", "Token symbol (1-10 bytes)", 0);
        f[2] = FieldDescriptor("meta", "string", "Metadata URI (max 512 bytes)", 0);
        f[3] = FieldDescriptor("salt", "bytes32", "Vanity-mined launch salt (token address ends in 7777)", 0);
        f[4] = FieldDescriptor(
            "targetRaise",
            "uint256",
            "Total tBNB raised (0.5 to 1000). targetRaise - backstopSeed must be >= 1.1x Flap's creation floor ($750 x 2 / BNB price: about 2.36 tBNB at $700); about 4.3 tBNB reaches Flap's graduation floor",
            18
        );
        f[5] = FieldDescriptor(
            "backstopSeed", "uint256", "tBNB held back to seed the SplitStock pool (min 0.01, max half the target)", 18
        );
        f[6] = FieldDescriptor("saleDuration", "uint256", "Contribution window in seconds (10 min to 30 days)", 0);
        f[7] = FieldDescriptor("vaultFactory", "address", "Must be the paired BackstopVaultFactory", 0);
        schema.fields = f;
    }
}
