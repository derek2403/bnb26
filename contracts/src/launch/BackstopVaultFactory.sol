// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibClone} from "solady/utils/LibClone.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {IPortal, IPortalTypes} from "src/flap/IPortal.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {Distribution, DistributionTarget} from "src/flap/Distribution.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "src/flap/IVaultSchemas.sol";

import {BackstopVault} from "src/launch/BackstopVault.sol";
import {ISplitLauncherView} from "src/launch/ISplitLaunch.sol";

/// @title BackstopVaultFactory
/// @notice Vault factory paired with `SplitLauncherFactory` (deployed first, at the launcher factory's predicted
///         address, as in the Crowd example). It only serves Launchers created by that factory.
///
///         What `newVault` checks before it deploys (everything rejected, nothing defaulted):
///           1. the caller is the Portal (`onlyHub`) and `_validateLaunch` passes (one VAULT slot naming this factory,
///              non-zero bps, supported quote); `_requireNoReserveDistribution` (no reserve routed to the vault);
///           2. `Portal.getLauncher(creator).launcherFactory == launcherFactory`;
///           3. `vaultData` is exactly `abi.encode(address launcher, address scenarioPool)`, names the calling
///              Launcher, and its scenarioPool equals the ScenarioPool in that Launcher's config snapshot;
///           4. native quote, and the VAULT slot takes exactly 5000 bps;
///           5. the Launcher is mid-launch with `raised == targetRaise`;
///           6. the reserve distribution is EXPLICIT to the Launcher itself.
///         The vault is a deterministic beacon proxy keyed by the token. Upgrades: Guardian only.
contract BackstopVaultFactory is DirectLaunchVaultFactoryBase {
    address public immutable hub;
    address public immutable guardian;
    address public immutable beacon;
    /// @notice The only Launcher factory whose Launchers this vault factory accepts.
    address public immutable launcherFactory;

    uint16 public constant VAULT_SLOT_BPS = 5000;

    error NotFromLauncherFactory(address launcher);
    error VaultDataLauncherMismatch(address expected, address got);
    error VaultDataScenarioMismatch(address expected, address got);
    error VaultSlotBpsMismatch(uint16 got, uint16 expected);
    error NativeQuoteOnly(address quoteToken);
    error LauncherNotLaunching(address launcher);
    error LauncherNotFunded(uint256 raised, uint256 target);
    error WrongDistribution();

    event FlapVaultImplementationUpgraded(address implementation);
    event BackstopVaultCreated(address indexed vault, address indexed token, address indexed launcher);

    constructor(address hub_, address guardian_, address launcherFactory_) {
        if (hub_ == address(0) || guardian_ == address(0) || launcherFactory_ == address(0)) revert ZeroAddress();
        hub = hub_;
        guardian = guardian_;
        launcherFactory = launcherFactory_;
        beacon = address(new UpgradeableBeacon(address(this), address(new BackstopVault())));
    }

    function _getHub() internal view override returns (address) {
        return hub;
    }

    function _getGuardian() internal view override returns (address) {
        return guardian;
    }

    /// @notice The vault address a launch of `token` gets.
    function predictVault(address token) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967BeaconProxy(
            beacon, bytes32(uint256(uint160(token))), address(this)
        );
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function newVault(address token, address creator, uint8 launchKind, bytes calldata launchParams)
        external
        override
        onlyHub
        returns (address vault)
    {
        (IPortalTypes.CreateTaxTokenParams memory p, Distribution memory d, bytes memory vaultData) =
            _validateLaunch(token, creator, launchKind, launchParams);
        _requireNoReserveDistribution(d);

        // 2. A Launcher of our paired factory, as recorded by the Portal itself.
        if (IPortal(_getHub()).getLauncher(creator).launcherFactory != launcherFactory) {
            revert NotFromLauncherFactory(creator);
        }

        // 3. Exact vaultData naming the calling Launcher and the configured ScenarioPool.
        if (vaultData.length != 64) revert InvalidVaultData();
        (address named, address scenario) = abi.decode(vaultData, (address, address));
        if (named != creator) revert VaultDataLauncherMismatch(creator, named);
        // The Launcher's own snapshot (taken at its creation from the factory pair's immutable SplitStockConfig).
        address expectedScenario = ISplitLauncherView(creator).poolConfig().scenarioPool;
        if (scenario != expectedScenario) revert VaultDataScenarioMismatch(expectedScenario, scenario);

        // 4. Native quote and the slot size the vault's economics assume.
        if (p.quoteToken != address(0)) revert NativeQuoteOnly(p.quoteToken);
        uint16 slotBps = _vaultSlotBps(p.feeConfigs);
        if (slotBps != VAULT_SLOT_BPS) revert VaultSlotBpsMismatch(slotBps, VAULT_SLOT_BPS);

        // 5. Mid-launch with the full raise in.
        ISplitLauncherView l = ISplitLauncherView(creator);
        if (!l.launching()) revert LauncherNotLaunching(creator);
        if (l.raised() != l.targetRaise()) revert LauncherNotFunded(l.raised(), l.targetRaise());

        // 6. The 500,000 reserve goes back to the Launcher for contributors.
        if (d.target != DistributionTarget.EXPLICIT || d.strategy != creator) revert WrongDistribution();

        vault = LibClone.deployDeterministicERC1967BeaconProxy(beacon, bytes32(uint256(uint160(token))));
        BackstopVault(payable(vault)).initialize(token, creator, scenario);
        emit BackstopVaultCreated(vault, token, creator);
    }

    /// @dev `_validateLaunch` already guarantees exactly one VAULT slot naming this factory.
    function _vaultSlotBps(IPortalTypes.FeeConfig[] memory fees) internal view returns (uint16) {
        for (uint256 i; i < fees.length; ++i) {
            if (fees[i].feeType != IPortalTypes.FeeSlotType.VAULT) continue;
            IPortalTypes.FeeConfigVault memory v = abi.decode(fees[i].configData, (IPortalTypes.FeeConfigVault));
            if (v.vaultFactory == address(this)) return fees[i].bps;
        }
        return 0;
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            "SplitStock BackstopVault: holds half of the token tax in tBNB plus the protocol-owned first-loss xNVDA, and spends tBNB only to cover a SplitStock pool whose collateral ratio is below 1. Set by the SplitLauncher, not by hand.";
        schema.fields = new FieldDescriptor[](2);
        schema.fields[0] = FieldDescriptor("launcher", "address", "The SplitLauncher that is launching", 0);
        schema.fields[1] = FieldDescriptor("scenarioPool", "address", "Demo ScenarioPool (capped tranche) or zero", 0);
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function isQuoteTokenSupported(address quoteToken) public pure override returns (bool) {
        return quoteToken == address(0);
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function factorySpecVersion() public pure override returns (string memory) {
        return "pl-v1";
    }

    /// @inheritdoc DirectLaunchVaultFactoryBase
    function tokenCreationPolicies() public pure override returns (FactoryPolicy[] memory policies) {
        policies = new FactoryPolicy[](2);
        policies[0] = FactoryPolicy({
            target: "quoteToken", operator: "eq", value: abi.encode(address(0)), description: "Native BNB quote only."
        });
        policies[1] = FactoryPolicy({
            target: "vaultSlotBps",
            operator: "eq",
            value: abi.encode(uint256(VAULT_SLOT_BPS)),
            description: "The VAULT slot must take exactly 50% of the tax."
        });
    }

    function upgradeVaultImplementation(address newImplementation) external override onlyGuardian {
        UpgradeableBeacon(beacon).upgradeTo(newImplementation);
        emit FlapVaultImplementationUpgraded(newImplementation);
    }

    function beaconImplementation() external view returns (address) {
        return UpgradeableBeacon(beacon).implementation();
    }
}
