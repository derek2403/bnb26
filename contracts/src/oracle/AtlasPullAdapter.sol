// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Vendored Atlas consumer (BUSL-1.1, unmodified, see lib/atlas-pull/VENDORED.md).
import {PullOracleConsumerStandard} from "atlas-pull/PullOracleConsumerStandard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3, IHaltableFeed} from "../interfaces/IAggregatorV3.sol";
import {SplitConstants} from "../interfaces/SplitConstants.sol";

/// @title AtlasPullAdapter
/// @notice Verifies Atlas pull-mode signed price payloads on chain 97 and compares them with the AtlasMirror.
///         The Atlas API returns `[feed packages][count][sig 65][0x7096]`; the caller appends it verbatim to the
///         calldata of `verify()` / `verifyAndPrice()`. The vendored `PullOracleConsumerStandard` parses it,
///         enforces EIP-2 low-s and recovers the signer (keccak256 of `[packages][count]`, no EIP-191 prefix).
///
///         Rules on top of the Atlas SDK:
///         - one constant feedId per adapter (constructor), never caller-supplied;
///         - payload timestamp strictly increasing across verified payloads (no replay, no rollback);
///         - payload age <= 60 s and at most 30 s in the future;
///         - pull price within 50 bps of the mirror, and the mirror must not be halted.
///
///         `worseOf` / `userPrice` give the adverse-of-two price: a user who hands the asset to a pool (mints) is
///         priced at the LOWER of pull and mirror; a user who takes the asset out (redeems) at the HIGHER.
///         The mirror stays the only price for keeper calls (rebalance, accrue).
/// @dev The adapter also exposes the last verified pull price as a read-only IAggregatorV3 (18 decimals) so UI
///      and indexer code can read it like any other feed. It holds no funds and has no admin.
///      A contract forwarding a user's payload must call this adapter with the payload appended raw:
///      `adapter.call(abi.encodePacked(abi.encodeCall(AtlasPullAdapter.verify, ()), payload))`.
contract AtlasPullAdapter is PullOracleConsumerStandard, IAggregatorV3, IHaltableFeed {
    // ---------------------------------------------------------------- constants

    /// @notice Atlas production pull signer (same as PullOracleReferenceHooks).
    address public constant ATLAS_SIGNER = 0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600;
    /// @notice Maximum payload age, seconds.
    uint256 public constant MAX_AGE = 60;
    /// @notice Maximum tolerated future skew of the payload timestamp, seconds.
    uint256 public constant MAX_FUTURE_DRIFT = SplitConstants.MAX_FUTURE_SKEW;
    /// @notice Maximum |pull - mirror| / mirror, bps.
    uint256 public constant MAX_DEV_BPS = 50;
    /// @notice Single feed per payload is all we need; caps parsing gas.
    uint256 public constant MAX_PACKAGES = 16;

    // ---------------------------------------------------------------- immutables

    /// @notice Atlas pull feed id (bytes4 of the Atlas registry id). [UNVERIFIED] for NVDAB: 934 or 1005.
    bytes4 public immutable feedId;
    /// @notice AtlasMirror (or any IAggregatorV3 + IHaltableFeed) the pull price is checked against.
    address public immutable mirror;
    /// @notice Recovered signer that is accepted. ATLAS_SIGNER unless a dev override was passed at deploy.
    address public immutable signer;
    uint256 internal immutable _mirrorScale;
    string internal _description;

    // ---------------------------------------------------------------- state

    /// @notice Last verified pull price (WAD USD) and its Atlas aggregation timestamp.
    uint256 public lastPrice;
    uint256 public lastTimestamp;
    uint256 public verifiedCount;

    // ---------------------------------------------------------------- events / errors

    event PullVerified(
        bytes4 indexed feedId,
        address indexed caller,
        uint256 price,
        uint256 timestamp,
        uint256 mirrorPrice,
        uint256 devBps
    );

    error ZeroAddress();
    error ZeroFeedId();
    error UnsupportedDecimals(uint8 decimals);
    error PayloadTooOld(uint256 timestamp, uint256 nowTs);
    error PayloadInFuture(uint256 timestamp, uint256 nowTs);
    error TimestampNotIncreasing(uint256 last, uint256 given);
    error ZeroPrice();
    error MirrorUnusable();
    error MirrorHalted();
    error DeviationTooHigh(uint256 pullPrice, uint256 mirrorPrice, uint256 devBps);
    error NoData();

    /// @param mirror_ AtlasMirror for the same asset (decimals <= 18)
    /// @param feedId_ Atlas pull feed id, constant for the adapter's life
    /// @param signerOverride zero for the Atlas production signer; a dev key only for local testing
    /// @param description_ e.g. "NVDAB / USD (Atlas pull)"
    constructor(address mirror_, bytes4 feedId_, address signerOverride, string memory description_) {
        if (mirror_ == address(0)) revert ZeroAddress();
        if (feedId_ == bytes4(0)) revert ZeroFeedId();
        uint8 d = IAggregatorV3(mirror_).decimals();
        if (d > 18) revert UnsupportedDecimals(d);
        mirror = mirror_;
        feedId = feedId_;
        signer = signerOverride == address(0) ? ATLAS_SIGNER : signerOverride;
        _mirrorScale = 10 ** (18 - d);
        _description = description_;
    }

    // ---------------------------------------------------------------- verification (payload in calldata)

    /// @notice Verify the payload appended to this call, record it and emit PullVerified.
    /// @return price WAD USD per whole asset unit
    /// @return timestamp Atlas aggregation time of the payload
    function verify() external returns (uint256 price, uint256 timestamp) {
        (price, timestamp) = _verifyAndRecord();
    }

    /// @notice verify() and return the adverse-of-two price for the action.
    /// @param userSellsAsset true for actions where the user hands the asset in (mintStable, mintLever):
    ///        priced at min(pull, mirror). false for actions paying the asset out (redeems): max(pull, mirror).
    function verifyAndPrice(bool userSellsAsset) external returns (uint256 price) {
        (uint256 p,) = _verifyAndRecord();
        (uint256 m,) = _mirrorPrice();
        price = worseOf(p, m, userSellsAsset);
    }

    /// @notice Stateless check of the appended payload (no monotonic-timestamp rule, nothing stored). For
    ///         eth_call quoting from the app before the user signs.
    function peek() external view returns (uint256 price, uint256 timestamp, uint256 mirrorPrice_, uint256 devBps) {
        (price, timestamp) = _getVerifiedFeedData(feedId);
        (mirrorPrice_, devBps) = _checkAgainstMirror(price);
    }

    function _verifyAndRecord() internal returns (uint256 price, uint256 timestamp) {
        (price, timestamp) = _getVerifiedFeedData(feedId);
        uint256 last = lastTimestamp;
        if (timestamp <= last) revert TimestampNotIncreasing(last, timestamp);
        (uint256 m, uint256 devBps) = _checkAgainstMirror(price);
        lastPrice = price;
        lastTimestamp = timestamp;
        unchecked {
            ++verifiedCount;
        }
        emit PullVerified(feedId, msg.sender, price, timestamp, m, devBps);
    }

    function _checkAgainstMirror(uint256 price) internal view returns (uint256 m, uint256 devBps) {
        if (price == 0) revert ZeroPrice();
        if (IHaltableFeed(mirror).halted()) revert MirrorHalted();
        (m,) = _mirrorPrice();
        if (m == 0) revert MirrorUnusable();
        devBps = deviationBps(price, m);
        if (devBps > MAX_DEV_BPS) revert DeviationTooHigh(price, m, devBps);
    }

    // ---------------------------------------------------------------- Atlas SDK hooks

    /// @dev Tighter than the reference hooks: 60 s max age, 30 s future drift.
    function _validateTimestamp(bytes4, uint256 ts) internal view override {
        if (ts > block.timestamp) {
            if (ts - block.timestamp > MAX_FUTURE_DRIFT) revert PayloadInFuture(ts, block.timestamp);
        } else if (block.timestamp - ts > MAX_AGE) {
            revert PayloadTooOld(ts, block.timestamp);
        }
    }

    function _getMaxPackageCount() internal pure override returns (uint256) {
        return MAX_PACKAGES;
    }

    function _isAuthorizedSigner(address recovered) internal view override returns (bool) {
        return recovered == signer;
    }

    // ---------------------------------------------------------------- pricing helpers

    /// @notice Adverse-of-two: min for a user handing the asset in, max for a user taking it out.
    ///         A zero input is treated as unavailable and the other price is returned.
    function worseOf(uint256 pullPrice, uint256 mirrorPrice_, bool userSellsAsset) public pure returns (uint256) {
        if (pullPrice == 0) return mirrorPrice_;
        if (mirrorPrice_ == 0) return pullPrice;
        if (userSellsAsset) return pullPrice < mirrorPrice_ ? pullPrice : mirrorPrice_;
        return pullPrice > mirrorPrice_ ? pullPrice : mirrorPrice_;
    }

    /// @notice Adverse-of-two using the last verified pull (if <= MAX_AGE old) and the current mirror.
    /// @return price WAD
    /// @return pullUsed whether a fresh pull price took part
    function userPrice(bool userSellsAsset) external view returns (uint256 price, bool pullUsed) {
        (uint256 m,) = _mirrorPrice();
        uint256 p = lastPrice;
        pullUsed = p != 0 && block.timestamp <= lastTimestamp + MAX_AGE;
        price = pullUsed ? worseOf(p, m, userSellsAsset) : m;
    }

    /// @notice |a - b| / b in bps, rounded up.
    function deviationBps(uint256 a, uint256 b) public pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 diff = a > b ? a - b : b - a;
        return Math.mulDiv(diff, SplitConstants.BPS, b, Math.Rounding.Ceil);
    }

    /// @notice Mirror answer scaled to WAD (0 when unusable) and its updatedAt.
    function mirrorPrice() external view returns (uint256 price, uint256 updatedAt) {
        return _mirrorPrice();
    }

    function _mirrorPrice() internal view returns (uint256 price, uint256 updatedAt) {
        try IAggregatorV3(mirror).latestRoundData() returns (uint80, int256 answer, uint256, uint256 u, uint80) {
            if (answer > 0) return (uint256(answer) * _mirrorScale, u);
        } catch {}
        return (0, 0);
    }

    // ---------------------------------------------------------------- IAggregatorV3 (last verified pull)

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = verifiedCount;
        if (n == 0) revert NoData();
        return (uint80(n), int256(lastPrice), lastTimestamp, lastTimestamp, uint80(n));
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 n = verifiedCount;
        if (n == 0 || roundId != uint80(n)) revert NoData();
        return (roundId, int256(lastPrice), lastTimestamp, lastTimestamp, roundId);
    }

    /// @notice Mirrors the AtlasMirror halt flag.
    function halted() external view returns (bool) {
        return IHaltableFeed(mirror).halted();
    }
}
