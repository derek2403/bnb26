// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStabilityPool} from "../interfaces/IStabilityPool.sol";

/// @title StabilityPool
/// @notice One per LeveragePool (clone). Users deposit the pool's sUSD. During a sell-zone rebalance the pool
///         burns deposited sUSD against stock sold at P*(1 - spDiscount) (`offset`), and it streams funding
///         sUSD to depositors (`notifyReward`).
/// @dev Liquity v1 product-sum accounting (P, S, G with epoch/scale), with error feedback on every division so
///      that the sum of claims never exceeds what the contract holds. All results round down.
///      Withdrawals are never blocked: there is no pause and no lock.
contract StabilityPool is IStabilityPool, Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Scale step for the running product P (Liquity v1).
    uint256 public constant SCALE_FACTOR = 1e9;
    uint256 internal constant DECIMAL_PRECISION = 1e18;

    struct Snapshot {
        uint256 P;
        uint256 S;
        uint256 G;
        uint256 scale;
        uint256 epoch;
    }

    /// @notice Fee-on-transfer or otherwise misbehaving token.
    error TransferAmountMismatch(uint256 received, uint256 expected);
    error ZeroAddress();
    /// @notice The running product would reach zero (precision exhausted).
    error ProductUnderflow();

    /// @inheritdoc IStabilityPool
    address public pool;
    /// @inheritdoc IStabilityPool
    address public stable;
    /// @inheritdoc IStabilityPool
    address public asset;

    /// @notice Running product: the compounded value of 1 unit deposited at the start of the current epoch.
    uint256 public P;
    uint256 public currentScale;
    uint256 public currentEpoch;

    /// @notice epoch => scale => cumulative asset gain per unit staked (times P).
    mapping(uint256 => mapping(uint256 => uint256)) public epochToScaleToS;
    /// @notice epoch => scale => cumulative sUSD reward per unit staked (times P).
    mapping(uint256 => mapping(uint256 => uint256)) public epochToScaleToG;

    /// @inheritdoc IStabilityPool
    uint256 public totalDeposits;

    /// @notice Deposit value at the user's last snapshot.
    mapping(address => uint256) public initialValue;
    mapping(address => Snapshot) internal _snapshots;

    uint256 public lastAssetError;
    uint256 public lastLossError;
    uint256 public lastRewardError;

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IStabilityPool
    function initialize(address pool_, address stable_, address asset_) external initializer {
        if (pool_ == address(0) || stable_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        pool = pool_;
        stable = stable_;
        asset = asset_;
        P = DECIMAL_PRECISION;
    }

    // ------------------------------------------------------------------ user actions

    /// @inheritdoc IStabilityPool
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        (uint256 assetGain, uint256 reward) = _gains(msg.sender);
        uint256 compounded = _compounded(msg.sender);

        // Pull first, verified by balance delta (rejects fee-on-transfer).
        IERC20 s = IERC20(stable);
        uint256 before = s.balanceOf(address(this));
        s.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = s.balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(received, amount);

        uint256 newDeposit = compounded + amount;
        totalDeposits += amount;
        _setDeposit(msg.sender, newDeposit);

        _sendGains(msg.sender, assetGain, reward);
        emit Deposited(msg.sender, amount, newDeposit);
    }

    /// @inheritdoc IStabilityPool
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        (uint256 assetGain, uint256 reward) = _gains(msg.sender);
        uint256 compounded = _compounded(msg.sender);
        uint256 w = Math.min(amount, compounded);
        uint256 newDeposit = compounded - w;

        // Defence in depth: never pay out more than totalDeposits or the sUSD actually held, so rounding dust can
        // never block an exit. The (dust) difference is forfeited, not kept as a residual claim.
        uint256 td = totalDeposits;
        if (w > td) w = td;
        uint256 bal = IERC20(stable).balanceOf(address(this));
        if (w > bal) w = bal;
        totalDeposits = td - w;
        _setDeposit(msg.sender, newDeposit);

        if (w > 0) IERC20(stable).safeTransfer(msg.sender, w);
        _sendGains(msg.sender, assetGain, reward);
        emit Withdrawn(msg.sender, w, newDeposit);
    }

    /// @inheritdoc IStabilityPool
    function claimGains() external nonReentrant returns (uint256 assetGain, uint256 stableReward) {
        (assetGain, stableReward) = _gains(msg.sender);
        _setDeposit(msg.sender, _compounded(msg.sender));
        (assetGain, stableReward) = _sendGains(msg.sender, assetGain, stableReward);
    }

    // ------------------------------------------------------------------ pool hooks

    /// @inheritdoc IStabilityPool
    function offset(uint256 stableBurned, uint256 assetAdded) external onlyPool {
        uint256 total = totalDeposits;
        if (total == 0) revert NoDeposits();
        if (stableBurned == 0) revert ZeroAmount();
        if (stableBurned > total) revert OffsetTooLarge(total, stableBurned);

        // Asset gain per unit staked, with error feedback.
        uint256 collNum = assetAdded * DECIMAL_PRECISION + lastAssetError;
        uint256 assetPerUnit = collNum / total;
        lastAssetError = collNum - assetPerUnit * total;

        // Loss per unit staked, rounded up, with error feedback (Liquity's lastLUSDLossError_Offset):
        // lastLossError (/1e18 = wei) is the accumulated overcharge, i.e. slack already held in totalDeposits
        // above the sum of compounded deposits, and is credited back against later losses.
        uint256 lossPerUnit;
        if (stableBurned == total) {
            lossPerUnit = DECIMAL_PRECISION;
            lastLossError = 0;
        } else {
            uint256 debtNum = stableBurned * DECIMAL_PRECISION;
            uint256 err = lastLossError;
            if (debtNum <= err) {
                // The previous overcharge already covers this debt: no further reduction of P.
                lastLossError = err - debtNum;
            } else {
                // The slack backing `err` shrinks with this offset by the factor (1 - lossPerUnit/1e18), because
                // the loss per unit is spread over totalDeposits (which includes the slack) rather than over the
                // compounded deposits alone. Crediting the full `err` (as Liquity does) can therefore spend more
                // slack than remains and leave Σ compounded > totalDeposits by a few wei once totalDeposits has
                // shrunk far below the deposits that produced the error. Credit only what survives this offset,
                // using the no-credit loss as an upper bound on lossPerUnit; the rest is forfeited to the pool
                // (it stays as unclaimed sUSD dust), so every rounding remains in the protocol's favour.
                uint256 maxLossPerUnit = debtNum / total + 1; // <= 1e18 because stableBurned < total
                uint256 credit = Math.mulDiv(err, DECIMAL_PRECISION - maxLossPerUnit, DECIMAL_PRECISION);
                uint256 lossNum = debtNum - credit;
                lossPerUnit = lossNum / total + 1;
                lastLossError = lossPerUnit * total - lossNum;
            }
        }

        uint256 epoch = currentEpoch;
        uint256 scale = currentScale;
        uint256 p = P;
        epochToScaleToS[epoch][scale] += assetPerUnit * p;

        uint256 f = DECIMAL_PRECISION - lossPerUnit;
        if (f == 0) {
            // Pool emptied: every deposit is fully consumed; start a new epoch (SPEC.md §4, R6). The loss error is
            // an overcharge credit owed to the deposits just wiped, so it must not carry into the new epoch:
            // otherwise the first offset of the new epoch under-charges P and Σ compounded > totalDeposits.
            currentEpoch = epoch + 1;
            currentScale = 0;
            P = DECIMAL_PRECISION;
            totalDeposits = 0;
            lastLossError = 0;
        } else {
            uint256 np = p * f / DECIMAL_PRECISION;
            if (np < SCALE_FACTOR) {
                np = p * f * SCALE_FACTOR / DECIMAL_PRECISION;
                currentScale = scale + 1;
            }
            if (np == 0) revert ProductUnderflow();
            P = np;
            totalDeposits = total - stableBurned;
        }
        emit Offset(stableBurned, assetAdded, P, currentEpoch, currentScale);
    }

    /// @inheritdoc IStabilityPool
    function notifyReward(uint256 amount) external onlyPool {
        uint256 total = totalDeposits;
        if (total == 0) revert NoDeposits();
        uint256 num = amount * DECIMAL_PRECISION + lastRewardError;
        uint256 perUnit = num / total;
        lastRewardError = num - perUnit * total;
        epochToScaleToG[currentEpoch][currentScale] += perUnit * P;
        emit RewardNotified(amount);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IStabilityPool
    function depositOf(address user) external view returns (uint256) {
        return _compounded(user);
    }

    /// @inheritdoc IStabilityPool
    function gainsOf(address user) external view returns (uint256 assetGain, uint256 stableReward) {
        return _gains(user);
    }

    /// @notice The user's last snapshot (P, S, G, scale, epoch).
    function snapshotOf(address user) external view returns (Snapshot memory) {
        return _snapshots[user];
    }

    // ------------------------------------------------------------------ internals

    function _compounded(address user) internal view returns (uint256) {
        uint256 d = initialValue[user];
        if (d == 0) return 0;
        Snapshot storage snap = _snapshots[user];
        if (snap.epoch < currentEpoch) return 0;
        uint256 scaleDiff = currentScale - snap.scale;
        uint256 comp;
        if (scaleDiff == 0) {
            comp = Math.mulDiv(d, P, snap.P);
        } else if (scaleDiff == 1) {
            comp = Math.mulDiv(d, P, snap.P) / SCALE_FACTOR;
        } else {
            return 0;
        }
        // Precision guard (Liquity v1): a deposit reduced by more than 1e9 is treated as fully consumed.
        if (comp < d / SCALE_FACTOR) return 0;
        // Rounds down; no single deposit can be worth more than all deposits.
        return Math.min(comp, totalDeposits);
    }

    function _gains(address user) internal view returns (uint256 assetGain, uint256 reward) {
        uint256 d = initialValue[user];
        if (d == 0) return (0, 0);
        Snapshot storage snap = _snapshots[user];
        uint256 e = snap.epoch;
        uint256 sc = snap.scale;
        uint256 sumS = (epochToScaleToS[e][sc] - snap.S) + epochToScaleToS[e][sc + 1] / SCALE_FACTOR;
        uint256 sumG = (epochToScaleToG[e][sc] - snap.G) + epochToScaleToG[e][sc + 1] / SCALE_FACTOR;
        assetGain = Math.mulDiv(d, sumS, snap.P) / DECIMAL_PRECISION;
        reward = Math.mulDiv(d, sumG, snap.P) / DECIMAL_PRECISION;
    }

    function _setDeposit(address user, uint256 newDeposit) internal {
        initialValue[user] = newDeposit;
        if (newDeposit == 0) {
            delete _snapshots[user];
            return;
        }
        uint256 e = currentEpoch;
        uint256 sc = currentScale;
        _snapshots[user] = Snapshot({
            P: P,
            S: epochToScaleToS[e][sc],
            G: epochToScaleToG[e][sc],
            scale: sc,
            epoch: e
        });
    }

    /// @dev Pays what is actually held (dust caps: asset gains never exceed the asset balance, and sUSD rewards
    ///      never dip into deposits, i.e. balance - totalDeposits) and returns the amounts sent.
    function _sendGains(address user, uint256 assetGain, uint256 reward) internal returns (uint256, uint256) {
        if (assetGain > 0) {
            uint256 aBal = IERC20(asset).balanceOf(address(this));
            if (assetGain > aBal) assetGain = aBal;
        }
        if (reward > 0) {
            uint256 sBal = IERC20(stable).balanceOf(address(this));
            uint256 td = totalDeposits;
            uint256 room = sBal > td ? sBal - td : 0;
            if (reward > room) reward = room;
        }
        if (assetGain == 0 && reward == 0) return (0, 0);
        if (assetGain > 0) IERC20(asset).safeTransfer(user, assetGain);
        if (reward > 0) IERC20(stable).safeTransfer(user, reward);
        emit GainsClaimed(user, assetGain, reward);
        return (assetGain, reward);
    }
}
