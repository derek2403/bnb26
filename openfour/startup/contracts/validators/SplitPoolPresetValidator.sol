// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOpenFourPresetValidator} from "../interfaces/IOpenFourPresetValidator.sol";
import {OpenFourTypes} from "../libraries/OpenFourTypes.sol";
import {IAggregatorV3} from "../external/ISplitStock.sol";

/// @title SplitPoolPresetValidator
/// @notice Create-time cross-module checks for the "SplitStock Pool Launch" preset. Keeps every FairLaunch check
///         (base token, curve, trade, migrate) and adds the SplitStock bindings: quote asset == the stock,
///         migrate params pinned to the deployment's PoolFactory / feed allowlist / router / BackstopTreasury /
///         symbol, parameter ranges, a minimum duration, a maximum raise, and a soft feed sanity read.
/// @dev Demo-only, unaudited. Derived from the openfour-docs FairLaunch starter (FairLaunchPresetValidator).
contract SplitPoolPresetValidator is IOpenFourPresetValidator {
    uint256 private constant TOKEN_UNIT = 1e18;
    uint16 private constant MAX_BPS = 10_000;
    uint16 private constant MAX_SELL_PENALTY_BPS = 5_000;
    /// @dev Trade fee cap for this preset (fees go to the BackstopTreasury).
    uint16 public constant MAX_TRADE_FEE_BPS = 100;

    // must match SplitPoolMigrateModule
    uint16 public constant MIN_SEED_BPS = 3_000;
    uint16 public constant MAX_SEED_BPS = 7_000;
    uint16 public constant MIN_SUSD_OUT_BPS = 8_000;
    uint256 public constant MIN_GRACE = 60;
    uint256 public constant MAX_GRACE = 7 days;
    uint256 public constant MIN_MIGRATE_GAS = 4_000_000;
    uint256 public constant MAX_MIGRATE_GAS = 20_000_000;

    /// @notice Deployment-time bounds (preset JSON `validator.args`, filled from deployments/<chainId>.json).
    struct Bounds {
        uint256 expectedPresetId; // non-zero: creation must use this preset id
        address requiredQuoteAsset; // the stock (tTSLA); required
        uint256 minSaleAmount; // 0 disables
        uint256 maxSaleAmount; // 0 disables
        uint256 maxRaiseAmount; // 0 disables (keep graduations small: each one sets a pool's first-loss size)
        uint256 minDuration; // seconds; > 0 (no DURATION=0, it migrates on the first buy)
        address poolFactory;
        address liveFeed; // AtlasMirror TSLA
        address scenarioFeed; // optional ScenarioFeed TSLA (0 disables)
        address poolRouter;
        address backstopTreasury;
        string stockSymbol;
    }

    /// @dev Must match `FairLaunchCurveModule.Params`.
    struct CurveParams {
        uint256 fixedPrice;
        uint16 sellPenaltyBps;
        bool enableSell;
        uint256 minPurchase;
        uint256 maxPurchase;
    }

    /// @dev Must match `FairLaunchTradeModule.TradeConfig`.
    struct TradeConfig {
        uint256 maxBuyAmount;
        uint256 maxPerAddress;
        uint256 maxSellAmount;
        uint16 buyFeeBps;
        uint16 sellFeeBps;
        address feeRecipient;
    }

    /// @dev Must match `SplitPoolMigrateModule.InputParams`.
    struct MigrateInputParams {
        uint256 softCap;
        uint256 duration;
        uint256 tokenLiquidityAmount;
        uint256 maxQuoteToUse;
        address stockAsset;
        address poolFactory;
        address feed;
        address poolRouter;
        address backstopTreasury;
        string stockSymbol;
        uint16 seedBps;
        uint16 minSusdOutBps;
        uint256 graceWindow;
        uint256 minMigrateGas;
    }

    Bounds internal _bounds;
    bytes32 public immutable symbolHash;

    constructor(Bounds memory b) {
        require(b.maxSaleAmount == 0 || b.maxSaleAmount >= b.minSaleAmount, "SplitValidator: bad sale bounds");
        require(b.requiredQuoteAsset != address(0), "SplitValidator: zero quote");
        require(
            b.poolFactory != address(0) && b.liveFeed != address(0) && b.poolRouter != address(0)
                && b.backstopTreasury != address(0),
            "SplitValidator: zero binding"
        );
        require(b.minDuration > 0, "SplitValidator: zero minDuration");
        uint256 len = bytes(b.stockSymbol).length;
        require(len > 0 && len <= 10, "SplitValidator: bad symbol");
        _bounds = b;
        symbolHash = keccak256(bytes(b.stockSymbol));
    }

    function bounds() external view returns (Bounds memory) {
        return _bounds;
    }

    function validate(uint256 presetId, OpenFourTypes.TokenInitParams calldata params) external view override {
        Bounds memory b = _bounds;
        if (b.expectedPresetId != 0) {
            require(presetId == b.expectedPresetId, "SplitValidator: wrong preset");
        }

        _validateBaseTokenParams(params, b);

        CurveParams memory curve = abi.decode(params.curveParams, (CurveParams));
        TradeConfig memory trade = abi.decode(params.tradeParams, (TradeConfig));
        MigrateInputParams memory migrate = abi.decode(params.migrateParams, (MigrateInputParams));

        _validateCurve(params, curve);
        _validateTrade(params, curve, trade, b);
        _validateMigrate(params, migrate);
        _validateSplitStock(params, migrate, b);

        require(params.tokenParams.length == 0, "SplitValidator: tokenParams not empty");
        require(params.vaultParams.length == 0, "SplitValidator: vaultParams not empty");
        require(params.customDataParams.length == 0, "SplitValidator: customDataParams not empty");
    }

    function _validateBaseTokenParams(OpenFourTypes.TokenInitParams calldata params, Bounds memory b) internal pure {
        require(bytes(params.name).length > 0, "SplitValidator: empty name");
        require(bytes(params.symbol).length > 0, "SplitValidator: empty symbol");
        require(params.maxSupply > 0, "SplitValidator: zero maxSupply");
        require(params.saleAmount > 0, "SplitValidator: zero saleAmount");
        require(params.saleAmount < params.maxSupply, "SplitValidator: no supply left for liquidity");
        require(params.raiseAmount > 0, "SplitValidator: zero raiseAmount");
        require(params.quoteAsset == b.requiredQuoteAsset, "SplitValidator: quote must be the stock");
        if (b.minSaleAmount > 0) require(params.saleAmount >= b.minSaleAmount, "SplitValidator: sale below min");
        if (b.maxSaleAmount > 0) require(params.saleAmount <= b.maxSaleAmount, "SplitValidator: sale above max");
        if (b.maxRaiseAmount > 0) require(params.raiseAmount <= b.maxRaiseAmount, "SplitValidator: raise above max");
    }

    function _validateCurve(OpenFourTypes.TokenInitParams calldata params, CurveParams memory curve) internal pure {
        require(curve.fixedPrice > 0, "SplitValidator: zero fixedPrice");
        require(curve.sellPenaltyBps <= MAX_SELL_PENALTY_BPS, "SplitValidator: penalty too high");
        require(curve.minPurchase > 0, "SplitValidator: zero minPurchase");
        require(curve.maxPurchase >= curve.minPurchase, "SplitValidator: bad purchase range");
        require(curve.maxPurchase <= params.saleAmount, "SplitValidator: maxPurchase too large");
        uint256 expectedRaiseAmount = Math.mulDiv(params.saleAmount, curve.fixedPrice, TOKEN_UNIT);
        require(params.raiseAmount == expectedRaiseAmount, "SplitValidator: raiseAmount mismatch");
    }

    function _validateTrade(
        OpenFourTypes.TokenInitParams calldata params,
        CurveParams memory curve,
        TradeConfig memory trade,
        Bounds memory b
    ) internal pure {
        require(trade.maxBuyAmount > 0, "SplitValidator: zero maxBuyAmount");
        require(trade.maxBuyAmount >= curve.minPurchase, "SplitValidator: maxBuy below min");
        require(trade.maxBuyAmount <= curve.maxPurchase, "SplitValidator: maxBuy above curve cap");
        require(
            trade.buyFeeBps <= MAX_TRADE_FEE_BPS && trade.sellFeeBps <= MAX_TRADE_FEE_BPS, "SplitValidator: fee too high"
        );
        if (trade.buyFeeBps != 0 || trade.sellFeeBps != 0) {
            require(trade.feeRecipient == b.backstopTreasury, "SplitValidator: fees must fund the backstop");
        }
        if (trade.maxPerAddress > 0) {
            require(trade.maxPerAddress >= curve.minPurchase, "SplitValidator: wallet cap below min");
            require(trade.maxPerAddress <= params.saleAmount, "SplitValidator: wallet cap too large");
        }
        if (!curve.enableSell) {
            require(trade.maxSellAmount == 0 && trade.sellFeeBps == 0, "SplitValidator: sell config disabled");
        }
    }

    function _validateMigrate(OpenFourTypes.TokenInitParams calldata params, MigrateInputParams memory m)
        internal
        pure
    {
        require(m.softCap == 0 || m.softCap <= params.raiseAmount, "SplitValidator: softCap too high");
        require(m.maxQuoteToUse == 0 || m.maxQuoteToUse <= params.raiseAmount, "SplitValidator: maxQuote too high");
        if (m.tokenLiquidityAmount > 0) {
            require(
                m.tokenLiquidityAmount <= params.maxSupply - params.saleAmount, "SplitValidator: liquidity too high"
            );
        }
    }

    function _validateSplitStock(OpenFourTypes.TokenInitParams calldata params, MigrateInputParams memory m, Bounds memory b)
        internal
        view
    {
        require(m.stockAsset == params.quoteAsset, "SplitValidator: stockAsset != quoteAsset");
        require(m.poolFactory == b.poolFactory, "SplitValidator: poolFactory not allowed");
        require(
            m.feed == b.liveFeed || (b.scenarioFeed != address(0) && m.feed == b.scenarioFeed),
            "SplitValidator: feed not allowed"
        );
        require(m.poolRouter == b.poolRouter, "SplitValidator: poolRouter not allowed");
        require(m.backstopTreasury == b.backstopTreasury, "SplitValidator: backstopTreasury mismatch");
        require(keccak256(bytes(m.stockSymbol)) == symbolHash, "SplitValidator: stockSymbol mismatch");
        require(m.seedBps >= MIN_SEED_BPS && m.seedBps <= MAX_SEED_BPS, "SplitValidator: seedBps out of range");
        require(m.minSusdOutBps >= MIN_SUSD_OUT_BPS && m.minSusdOutBps <= MAX_BPS, "SplitValidator: minSusdOutBps out of range");
        require(m.graceWindow >= MIN_GRACE && m.graceWindow <= MAX_GRACE, "SplitValidator: graceWindow out of range");
        require(
            m.minMigrateGas >= MIN_MIGRATE_GAS && m.minMigrateGas <= MAX_MIGRATE_GAS,
            "SplitValidator: minMigrateGas out of range"
        );
        require(m.duration >= b.minDuration, "SplitValidator: duration too short");

        // Soft sanity read of the feed: skipped if the call fails (graduation re-checks health anyway).
        (bool ok, bytes memory ret) = m.feed.staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        if (ok && ret.length >= 160) {
            (, int256 answer,,,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
            require(answer > 0, "SplitValidator: feed has no price");
        }
    }
}
