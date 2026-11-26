// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IOpenFourCustomDataModule} from "../../interfaces/IOpenFourCustomDataModule.sol";
import {IOpenFourModuleSchema} from "../../interfaces/IOpenFourModuleSchema.sol";
import {IOpenFourToken} from "../../interfaces/IOpenFourToken.sol";
import {IOpenFourVault} from "../../interfaces/IOpenFourVault.sol";
import {OpenFourTypes, ParamDescriptor, ModuleEncodeSchema} from "../../libraries/OpenFourTypes.sol";
import {ILeveragePool} from "../../external/ISplitStock.sol";
import {
    SplitPoolBranch,
    SplitPoolGraduation,
    ISplitPoolMigrateView,
    ISplitPoolDataView
} from "../../external/ISplitPoolLaunch.sol";

/// @title SplitPoolCustomDataModule (`module.data.splitstock_pool`)
/// @notice Post-trade and post-migration facts for the "SplitStock Pool Launch" preset.
///         - FairLaunch per-trader stats (`totalPurchased` is read by FairLaunchTradeModule for the wallet cap).
///         - `conditionsMetAt`: when the graduation conditions (sold out / soft cap) first held. The migrate module
///           starts its grace window from it (forceAt = conditionsMetAt + graceWindow). Reset if they stop holding.
///         - A graduation snapshot on `onMigrate` (branch, pair, pool, price, sUSD minted, CR).
/// @dev Demo-only, unaudited. Derived from the openfour-docs FairLaunch starter (FairLaunchCustomDataModule).
///      Hooks record facts after execution and never decide trade validity; reads of other modules are guarded so a
///      hook cannot revert a trade because of them.
contract SplitPoolCustomDataModule is Initializable, IOpenFourCustomDataModule, IOpenFourModuleSchema, ISplitPoolDataView {
    struct TraderStats {
        uint256 totalPurchased;
        uint256 totalSold;
        uint256 lastTradeTime;
        uint256 lastTradeBlock;
    }

    /// @notice Graduation snapshot stored on onMigrate.
    struct FloorSnapshot {
        uint8 branch; // SplitPoolBranch: 1 pool, 2 fallback, 0 none/unknown
        address pair;
        address pool;
        address sUSD;
        uint256 price; // WAD USD per whole stock unit
        uint256 sUSDMinted;
        uint256 xToTreasury;
        uint256 quoteUsed;
        uint256 tokenUsed;
        uint256 collateralRatio; // pool CR right after graduation (WAD); 0 on fallback
        uint256 leverage; // pool leverage right after graduation (WAD); 0 on fallback
        uint256 timestamp;
    }

    event ConditionsMet(address indexed token, uint256 at);
    event ConditionsReset(address indexed token, uint256 at);
    event FloorSnapshotRecorded(
        address indexed token, uint8 branch, address pair, address pool, uint256 price, uint256 sUSDMinted, uint256 cr
    );

    address public token;
    address public fourCore;
    bool public migrated;
    uint256 public migratedAt;
    uint256 public migrationTotalRaised;
    uint256 public migrationRemainingForSale;
    uint256 public override conditionsMetAt;
    mapping(address => TraderStats) public traderStats;
    FloorSnapshot internal _snapshot;
    bytes private _initParams;
    string private _moduleVersion;

    modifier onlyFourCore() {
        require(msg.sender == fourCore, "SplitData: only fourCore");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function init(address token_, address fourCore_, bytes calldata rawParams, string calldata moduleVersion_)
        external
        override
        initializer
    {
        require(token_ != address(0) && fourCore_ != address(0), "SplitData: zero address");
        require(rawParams.length == 0, "SplitData: params not empty");
        token = token_;
        fourCore = fourCore_;
        _initParams = rawParams;
        _moduleVersion = moduleVersion_;
    }

    function descriptor() external view override returns (bytes8 tagId, string memory tag, string memory version) {
        tag = "module.data.splitstock_pool";
        return (bytes8(keccak256(bytes(tag))), tag, _moduleVersion);
    }

    function afterHook(OpenFourTypes.TradeHookContext calldata ctx) external override onlyFourCore {
        require(ctx.token == token, "SplitData: wrong token");
        if (ctx.executedAmount != 0) {
            TraderStats storage stats = traderStats[ctx.trader];
            if (ctx.isBuy) {
                stats.totalPurchased += ctx.executedAmount;
            } else {
                stats.totalSold += ctx.executedAmount;
            }
            stats.lastTradeTime = ctx.timestamp;
            stats.lastTradeBlock = ctx.blockNumber;
        }
        _updateAnchor(ctx.timestamp);
    }

    /// @dev Grace anchor: set the first time the conditions hold, cleared if a sell drops below the soft cap.
    function _updateAnchor(uint256 ts) internal {
        address t = token;
        address v;
        address m;
        try IOpenFourToken(t).vault() returns (address a) {
            v = a;
        } catch {
            return;
        }
        try IOpenFourToken(t).migrateModule() returns (address a) {
            m = a;
        } catch {
            return;
        }
        if (v.code.length == 0 || m.code.length == 0) return;
        uint256 raised;
        bool soldOut;
        try IOpenFourVault(v).totalRaised() returns (uint256 r) {
            raised = r;
        } catch {
            return;
        }
        try IOpenFourVault(v).isSoldOut() returns (bool s) {
            soldOut = s;
        } catch {}
        bool met;
        try ISplitPoolMigrateView(m).conditionsMet(raised, soldOut, ts) returns (bool ok) {
            met = ok;
        } catch {
            return;
        }
        uint256 at = conditionsMetAt;
        if (met && at == 0) {
            conditionsMetAt = ts;
            emit ConditionsMet(t, ts);
        } else if (!met && at != 0) {
            conditionsMetAt = 0;
            emit ConditionsReset(t, ts);
        }
    }

    function onMigrate(OpenFourTypes.MigrateHookContext calldata ctx) external override onlyFourCore {
        require(ctx.token == token, "SplitData: wrong token");
        migrated = true;
        migratedAt = ctx.timestamp;
        migrationTotalRaised = ctx.totalRaised;
        migrationRemainingForSale = ctx.remainingForSale;

        FloorSnapshot memory s;
        s.timestamp = ctx.timestamp;
        address m;
        try IOpenFourToken(ctx.token).migrateModule() returns (address a) {
            m = a;
        } catch {}
        if (m.code.length > 0) {
            try ISplitPoolMigrateView(m).lastGraduation() returns (SplitPoolGraduation memory g) {
                s.branch = g.branch;
                s.pair = g.pair;
                s.pool = g.pool;
                s.sUSD = g.sUSD;
                s.price = g.price;
                s.sUSDMinted = g.sUSDMinted;
                s.xToTreasury = g.xToTreasury;
                s.quoteUsed = g.quoteUsed;
                s.tokenUsed = g.tokenUsed;
            } catch {}
        }
        if (s.branch == SplitPoolBranch.POOL && s.pool.code.length > 0) {
            try ILeveragePool(s.pool).state() returns (ILeveragePool.PoolState memory st) {
                s.collateralRatio = st.collateralRatio;
                s.leverage = st.leverage;
                if (s.price == 0) s.price = st.price;
            } catch {}
        }
        _snapshot = s;
        emit FloorSnapshotRecorded(ctx.token, s.branch, s.pair, s.pool, s.price, s.sUSDMinted, s.collateralRatio);
    }

    function moduleEncodeSchema() external pure override returns (ModuleEncodeSchema memory) {
        return ModuleEncodeSchema("customData", 1, new ParamDescriptor[](0));
    }

    function getInitParams() external view returns (bytes memory) {
        return _initParams;
    }

    function floorSnapshot() external view returns (FloorSnapshot memory) {
        return _snapshot;
    }

    /// @notice Read by FairLaunchTradeModule for the per-address cap.
    function totalPurchased(address trader) external view returns (uint256) {
        return traderStats[trader].totalPurchased;
    }

    function totalSold(address trader) external view returns (uint256) {
        return traderStats[trader].totalSold;
    }
}
