// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {SplitConstants} from "../interfaces/SplitConstants.sol";

/// @title AtlasCmcAnchor (BSC mainnet, read-only)
/// @notice The keeper posts the CoinMarketCap NVDAB price it just fetched; in the SAME transaction this contract
///         reads the live Atlas NVDAB SingleFeed (0xf25af12920d408baf6211e9e90eda89df3d8ccda, 18 decimals) and
///         emits both prices and the gap between them. Anyone can check every row on BscScan: the Atlas value is
///         read on-chain, the CMC value is bound to the raw response body by `respHash`.
/// @dev No funds, no external writes. DEFAULT_ADMIN_ROLE manages KEEPER_ROLE only.
contract AtlasCmcAnchor is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    struct AnchorRow {
        uint256 atlasPrice; // WAD
        uint256 cmcPrice; // WAD
        uint256 devBps; // |atlas - cmc| / cmc, bps, rounded up
        int256 gapBps; // (atlas - cmc) / cmc, bps, signed
        uint256 atlasUpdatedAt;
        uint80 atlasRoundId;
        uint256 cmcTs;
        bytes32 respHash;
        uint256 blockTimestamp;
    }

    /// @notice Atlas SingleFeed read in every anchor() call.
    address public immutable atlasFeed;
    uint256 internal immutable _scale;

    uint256 public anchorCount;
    uint256 public lastCmcTs;
    AnchorRow internal _last;

    event Anchor(
        uint256 indexed index,
        uint256 atlasPrice,
        uint256 cmcPrice,
        uint256 devBps,
        uint256 atlasUpdatedAt,
        bytes32 respHash,
        uint256 cmcTs,
        int256 gapBps,
        uint80 atlasRoundId
    );

    error ZeroAddress();
    error UnsupportedDecimals(uint8 decimals);
    error ZeroCmcPrice();
    error ZeroRespHash();
    error CmcTsNotIncreasing(uint256 last, uint256 given);
    error FutureTimestamp(uint256 ts, uint256 nowTs);
    error AtlasUnusable();

    /// @param admin DEFAULT_ADMIN_ROLE (mainnet deployer)
    /// @param keeper KEEPER_ROLE (K_RISK56); may be zero and granted later
    /// @param atlasFeed_ Atlas NVDAB SingleFeed
    constructor(address admin, address keeper, address atlasFeed_) {
        if (admin == address(0) || atlasFeed_ == address(0)) revert ZeroAddress();
        uint8 d = IAggregatorV3(atlasFeed_).decimals();
        if (d > 18) revert UnsupportedDecimals(d);
        atlasFeed = atlasFeed_;
        _scale = 10 ** (18 - d);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (keeper != address(0)) _grantRole(KEEPER_ROLE, keeper);
    }

    /// @notice Record one CMC observation next to the Atlas value read in this transaction.
    /// @param cmcPriceE18 CMC NVDAB price, WAD USD
    /// @param cmcTs CMC status.timestamp (seconds); strictly increasing, at most 30 s in the future
    /// @param respHash keccak256 of the raw CMC response body (published in the hash-chained log)
    /// @return index the anchor index (0-based)
    function anchor(uint256 cmcPriceE18, uint256 cmcTs, bytes32 respHash)
        external
        onlyRole(KEEPER_ROLE)
        returns (uint256 index)
    {
        if (cmcPriceE18 == 0) revert ZeroCmcPrice();
        if (respHash == bytes32(0)) revert ZeroRespHash();
        if (cmcTs <= lastCmcTs) revert CmcTsNotIncreasing(lastCmcTs, cmcTs);
        if (cmcTs > block.timestamp + SplitConstants.MAX_FUTURE_SKEW) revert FutureTimestamp(cmcTs, block.timestamp);

        AnchorRow memory r = _readAtlas();
        r.cmcPrice = cmcPriceE18;
        r.cmcTs = cmcTs;
        r.respHash = respHash;
        r.blockTimestamp = block.timestamp;
        uint256 diff = r.atlasPrice > cmcPriceE18 ? r.atlasPrice - cmcPriceE18 : cmcPriceE18 - r.atlasPrice;
        r.devBps = Math.mulDiv(diff, SplitConstants.BPS, cmcPriceE18, Math.Rounding.Ceil);
        uint256 gapAbs = Math.mulDiv(diff, SplitConstants.BPS, cmcPriceE18);
        r.gapBps = r.atlasPrice >= cmcPriceE18 ? int256(gapAbs) : -int256(gapAbs);

        index = anchorCount;
        anchorCount = index + 1;
        lastCmcTs = cmcTs;
        _last = r;
        _emitAnchor(index, r);
    }

    function _readAtlas() internal view returns (AnchorRow memory r) {
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IAggregatorV3(atlasFeed).latestRoundData();
        if (answer <= 0) revert AtlasUnusable();
        r.atlasPrice = uint256(answer) * _scale;
        r.atlasUpdatedAt = updatedAt;
        r.atlasRoundId = roundId;
    }

    function _emitAnchor(uint256 index, AnchorRow memory r) internal {
        emit Anchor(
            index, r.atlasPrice, r.cmcPrice, r.devBps, r.atlasUpdatedAt, r.respHash, r.cmcTs, r.gapBps, r.atlasRoundId
        );
    }

    /// @notice The most recent anchor row (all zero before the first anchor).
    function lastAnchor() external view returns (AnchorRow memory) {
        return _last;
    }

    /// @notice Current Atlas value scaled to WAD, for quoting before anchor().
    function atlasPrice() external view returns (uint256 price, uint256 updatedAt) {
        (, int256 answer,, uint256 u,) = IAggregatorV3(atlasFeed).latestRoundData();
        if (answer <= 0) return (0, u);
        return (uint256(answer) * _scale, u);
    }
}
