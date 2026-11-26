// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @dev The PoolFactory surface the registrar needs (`grantCreator` is not part of IPoolFactory on purpose).
interface IPoolFactoryRegistrarTarget {
    function grantCreator(address who) external;
    function isCreator(address who) external view returns (bool);
}

/// @dev SplitLauncherFactory: launcher addresses are deterministic ERC1967 beacon proxies keyed by salt.
interface ISplitLauncherFactoryPredict {
    function predictLauncher(bytes32 salt) external view returns (address);
}

/// @title CreatorRegistrar
/// @notice Holds REGISTRAR_ROLE on PoolFactory and grants CREATOR_ROLE, permissionlessly, to exactly two kinds of
///         callers that open a NEW SplitStock pool per launch:
///         - a SplitLauncher deployed (or about to be deployed) by an allowlisted SplitLauncherFactory. The address is
///           derived on-chain from `predictLauncher(salt)`, so only that factory can ever put code there;
///         - the per-token migrate module of an OpenFour token created by an allowlisted Core under an allowlisted
///           presetId. The module address is read from `Core.tokens(token)`, so it is whatever the Core installed.
///         Before this contract, each grant needed a 24 h Timelock operation after the admin handoff.
///         Admin (deployer, then the Timelock) only edits the two allowlists. It holds no funds and can never revoke.
contract CreatorRegistrar is AccessControl {
    error ZeroAddress();
    error FactoryNotAllowed(address factory);
    error PresetNotAllowed(address core, uint256 presetId);
    error UnknownToken(address token);
    error BadCoreResponse();

    event FlapFactorySet(address indexed factory, bool allowed);
    event OpenFourPresetSet(address indexed core, uint256 indexed presetId, bool allowed);
    event FlapLauncherRegistered(address indexed factory, bytes32 indexed salt, address indexed launcher);
    event OpenFourModuleRegistered(address indexed core, address indexed token, address indexed migrateModule);

    /// @notice PoolFactory this registrar grants on.
    address public immutable poolFactory;

    mapping(address => bool) public flapFactoryAllowed;
    /// @dev core => presetId => allowed
    mapping(address => mapping(uint256 => bool)) public openFourPresetAllowed;

    /// @dev Word positions in the ABI head of `IOpenFourCore.tokens(token)` (compiler getter of RuntimeConfig):
    ///      0 version, 1 creator, 2 presetId, 3 token, 4 name*, 5 symbol*, 6 maxSupply, 7 saleAmount, 8 raiseAmount,
    ///      9 quoteAsset, 10 vault, 11 curveModule, 12 tradeModule, 13 migrateModule, 14 tokenModule, 15 customData,
    ///      16 createBlock, 17 exists, 18 paused, 19 antiSniperEnabled. Decoded by position to avoid stack limits.
    uint256 private constant W_PRESET = 2;
    uint256 private constant W_TOKEN = 3;
    uint256 private constant W_MIGRATE = 13;
    uint256 private constant W_EXISTS = 17;
    uint256 private constant HEAD_WORDS = 20;

    constructor(address admin, address poolFactory_) {
        if (admin == address(0) || poolFactory_ == address(0)) revert ZeroAddress();
        poolFactory = poolFactory_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    function setFlapFactory(address factory, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (factory == address(0)) revert ZeroAddress();
        flapFactoryAllowed[factory] = allowed;
        emit FlapFactorySet(factory, allowed);
    }

    function setOpenFourPreset(address core, uint256 presetId, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (core == address(0)) revert ZeroAddress();
        openFourPresetAllowed[core][presetId] = allowed;
        emit OpenFourPresetSet(core, presetId, allowed);
    }

    // ------------------------------------------------------------------ permissionless registration

    /// @notice Grants CREATOR_ROLE to `factory.predictLauncher(salt)`. Works before or after the launcher exists.
    function registerFlapLauncher(address factory, bytes32 salt) external returns (address launcher) {
        if (!flapFactoryAllowed[factory]) revert FactoryNotAllowed(factory);
        launcher = ISplitLauncherFactoryPredict(factory).predictLauncher(salt);
        if (launcher == address(0)) revert ZeroAddress();
        IPoolFactoryRegistrarTarget(poolFactory).grantCreator(launcher);
        emit FlapLauncherRegistered(factory, salt, launcher);
    }

    /// @notice Grants CREATOR_ROLE to the migrate module the Core installed for `token`.
    function registerOpenFourToken(address core, address token) external returns (address migrateModule) {
        uint256 presetId;
        (presetId, migrateModule) = openFourModuleOf(core, token);
        if (!openFourPresetAllowed[core][presetId]) revert PresetNotAllowed(core, presetId);
        IPoolFactoryRegistrarTarget(poolFactory).grantCreator(migrateModule);
        emit OpenFourModuleRegistered(core, token, migrateModule);
    }

    // ------------------------------------------------------------------ views

    /// @notice Reads (presetId, migrateModule) for `token` from `core.tokens(token)`; reverts if unknown.
    function openFourModuleOf(address core, address token) public view returns (uint256 presetId, address module) {
        if (core.code.length == 0) revert BadCoreResponse();
        (bool ok, bytes memory ret) = core.staticcall(abi.encodeWithSignature("tokens(address)", token));
        if (!ok || ret.length < HEAD_WORDS * 32) revert BadCoreResponse();
        if (_word(ret, W_EXISTS) == 0 || address(uint160(_word(ret, W_TOKEN))) != token) revert UnknownToken(token);
        presetId = _word(ret, W_PRESET);
        module = address(uint160(_word(ret, W_MIGRATE)));
        if (module == address(0)) revert UnknownToken(token);
    }

    function _word(bytes memory b, uint256 i) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(b, 32), mul(i, 32)))
        }
    }
}
