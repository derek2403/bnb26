// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One per LeveragePool (clone). Users deposit the pool's sUSD. During rebalance the pool burns
///         deposited sUSD against asset at P*(1 - spDiscount) (offset), and mints funding to it (reward).
///         Liquity-v1 product-sum accounting: P (deposit scale), S (asset gain sum), G (sUSD reward sum),
///         with epoch/scale handling. Invariant: sum of claims <= assets held.
interface IStabilityPool {
    event Deposited(address indexed user, uint256 amount, uint256 newDeposit);
    event Withdrawn(address indexed user, uint256 amount, uint256 newDeposit);
    event GainsClaimed(address indexed user, uint256 assetGain, uint256 stableReward);
    event Offset(uint256 stableBurned, uint256 assetAdded, uint256 newP, uint256 epoch, uint256 scale);
    event RewardNotified(uint256 amount);

    error OnlyPool();
    error ZeroAmount();
    error InsufficientDeposit(uint256 have, uint256 want);
    error OffsetTooLarge(uint256 totalDeposits, uint256 debt);
    error NoDeposits();

    /// @notice One-shot initializer (clone). Called by PoolFactory.
    function initialize(address pool_, address stable_, address asset_) external;

    /// @notice Pulls `amount` sUSD from msg.sender. Pays out pending gains first.
    function deposit(uint256 amount) external;

    /// @notice Withdraws up to the compounded deposit (type(uint256).max = all). Pays out pending gains.
    ///         Never blocked.
    function withdraw(uint256 amount) external;

    /// @notice Sends pending asset gain and sUSD reward to msg.sender.
    function claimGains() external returns (uint256 assetGain, uint256 stableReward);

    /// @notice Pool only. Called AFTER the pool burned `stableBurned` sUSD from this contract and transferred
    ///         `assetAdded` asset to it. stableBurned <= totalDeposits().
    function offset(uint256 stableBurned, uint256 assetAdded) external;

    /// @notice Pool only. Called AFTER the pool minted `amount` sUSD to this contract (funding).
    ///         Requires totalDeposits() > 0.
    function notifyReward(uint256 amount) external;

    function pool() external view returns (address);

    function stable() external view returns (address);

    function asset() external view returns (address);

    /// @notice Sum of compounded deposits (excludes unclaimed rewards).
    function totalDeposits() external view returns (uint256);

    function depositOf(address user) external view returns (uint256);

    function gainsOf(address user) external view returns (uint256 assetGain, uint256 stableReward);
}
