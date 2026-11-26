// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One private SANDBOX pool per viewer: its own ScenarioFeed clone (viewer = operator), pool, tokens
///         and StabilityPool, routed through the shared MockRouter. Holds CREATOR_ROLE on PoolFactory,
///         AUTHORIZER_ROLE on MockRouter and MINTER_ROLE on the mock asset.
interface ISandboxFactory {
    struct Sandbox {
        address pool;
        address feed;
        uint256 createdAt;
    }

    event SandboxCreated(address indexed owner, address indexed pool, address indexed feed, uint256 seedC, uint256 stableC);

    error AlreadyHasSandbox(address pool);

    /// @notice Creates the caller's sandbox: clone feed (anchored to the asset's AtlasMirror), createPool(kind=SANDBOX),
    ///         register pool on MockRouter, mint seedAssetAmount() asset and seed(to = msg.sender), then
    ///         try mintStable(stableAssetAmount()) and send the sUSD to msg.sender (skipped if it reverts, e.g. breaker).
    function create() external returns (address pool, address feed);

    function sandboxOf(address owner) external view returns (Sandbox memory);

    function sandboxCount() external view returns (uint256);

    function poolFactory() external view returns (address);

    function mockRouter() external view returns (address);

    function feedImpl() external view returns (address);

    function asset() external view returns (address);

    function assetId() external view returns (bytes32);

    function symbol() external view returns (string memory);

    function referenceFeed() external view returns (address);

    function seedAssetAmount() external view returns (uint256);

    function stableAssetAmount() external view returns (uint256);
}
