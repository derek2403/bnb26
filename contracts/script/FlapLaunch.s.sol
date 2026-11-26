// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeploymentsIO} from "./lib/DeploymentsIO.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {SplitLauncher, SplitConfig} from "src/launch/SplitLauncher.sol";
import {SplitLauncherFactory} from "src/launch/SplitLauncherFactory.sol";
import {BackstopVault} from "src/launch/BackstopVault.sol";
import {FLAP_TOKEN_IMPL, SplitPoolConfig, IUniswapV2FactoryLike} from "src/launch/ISplitLaunch.sol";
import {IUniswapV2Router02} from "src/interfaces/IUniswapV2Router02.sol";
import {IPoolFactory} from "src/interfaces/IPoolFactory.sol";
import {Roles} from "src/interfaces/SplitConstants.sol";
import {CreatorRegistrar} from "src/periphery/CreatorRegistrar.sol";

interface ITaxTokenLike {
    function taxProcessor() external view returns (address);
}

interface ITaxProcessorLike {
    function dispatch() external;
}

/// @notice Step-by-step helpers for the Flap live flow on BSC testnet (plan section "Flap live tx order"). Each step is
///         its own entry point; every step reads deployments/97.json and the ones that change state write it back.
///
///   forge script script/FlapLaunch.s.sol --sig "newLauncher()"           --rpc-url $BSC_TESTNET_RPC --broadcast
///   forge script script/FlapLaunch.s.sol --sig "contribute(uint256)" 1e17 --rpc-url $BSC_TESTNET_RPC --broadcast
///   forge script script/FlapLaunch.s.sol --sig "fill()"                  ...   (contributes exactly remaining())
///   forge script script/FlapLaunch.s.sol --sig "openPool()"              ...
///   forge script script/FlapLaunch.s.sol --sig "dispatch()"              ...   (Flap TaxProcessor.dispatch)
///   forge script script/FlapLaunch.s.sol --sig "cover()"                 ...   (BackstopVault.cover(live pool))
///   forge script script/FlapLaunch.s.sol --sig "claim()" / "refund()"    ...
///   forge script script/FlapLaunch.s.sol --sig "status()"                --rpc-url $BSC_TESTNET_RPC (read-only)
///   (default build dirs out/ + cache/; the old --out out-flap flags are no longer needed)
///
///   Launcher selection: FLAP_LAUNCHER, else the last entry of flap.launchers.
///   newLauncher env: FLAP_NAME, FLAP_SYMBOL, FLAP_META, FLAP_TARGET (wei, default 4.7e18: pool quote 4.5 tBNB, above
///   the 50/50 graduation floor of about 4.29 tBNB at BNB $700 and multiplier 10000), FLAP_SEED (default 0.2e18:
///   openPool swaps the whole seed in one go within 3% of the Atlas price, so the WBNB/tNVDA pair needs >= ~36x the
///   seed in tBNB; DeployCore's default pair is 0.1 tBNB, which fits a seed of at most ~0.0028 tBNB, so deepen it first),
///   FLAP_SALE_DURATION (s, default 3 days), FLAP_SALT (skip mining), FLAP_SALT_SEED (mining seed).
contract FlapLaunch is DeploymentsIO {
    struct LauncherEntry {
        address launcher;
        address token;
        address vault;
        string poolId;
    }

    string internal constant POOL_ID = "nvda-flap";

    // ─────────────────────────────────────────────────────────────────────────
    // Steps
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Mine a 7777 salt, grant the predicted Launcher CREATOR_ROLE (if the broadcaster is PoolFactory admin),
    ///         and create the Launcher through the Portal with exactly SALT_LOCK_FEE.
    function newLauncher() external {
        string memory json = _readDeployments();
        address portal = _jAddr(json, ".flap.portal");
        SplitLauncherFactory lf = SplitLauncherFactory(_jAddr(json, ".flap.launcherFactory"));
        require(_hasCode(address(lf)), "flap.launcherFactory missing: run DeployFlap first");

        SplitConfig memory c;
        c.name = vm.envOr("FLAP_NAME", string("SplitStock Backstop"));
        c.symbol = vm.envOr("FLAP_SYMBOL", string("SPLIT"));
        c.meta = vm.envOr("FLAP_META", string(""));
        c.targetRaise = vm.envOr("FLAP_TARGET", uint256(4.7 ether));
        c.backstopSeed = vm.envOr("FLAP_SEED", uint256(0.2 ether));
        c.saleDuration = vm.envOr("FLAP_SALE_DURATION", uint256(3 days));
        c.vaultFactory = lf.pairedVaultFactory();
        c.salt = vm.envOr("FLAP_SALT", bytes32(0));
        if (c.salt == bytes32(0)) {
            c.salt = _mineSalt(portal, keccak256(bytes(vm.envOr("FLAP_SALT_SEED", string("splitstock")))));
        }
        (address predictedToken, bool ok) = lf.predictToken(c.salt);
        require(ok, "salt does not give a 0x7777 token address");
        address predictedLauncher = lf.predictLauncher(c.salt);
        uint256 minQuote = lf.minPoolQuote();
        console2.log("pool quote (wei)", c.targetRaise - c.backstopSeed, "min pool quote (wei)", minQuote);
        require(c.targetRaise - c.backstopSeed >= minQuote, "pool quote below 1.1x creation floor");

        require(lf.configured(), "SplitStockConfig not set: redeploy with DeployFlap");
        IPoolFactory pf = IPoolFactory(lf.poolConfig().poolFactory);
        address deployer = _startBroadcastTestnet();
        if (!pf.isCreator(predictedLauncher)) {
            address reg = _jAddr(json, ".core.creatorRegistrar");
            if (_hasCode(reg) && CreatorRegistrar(reg).flapFactoryAllowed(address(lf))) {
                CreatorRegistrar(reg).registerFlapLauncher(address(lf), c.salt);
                console2.log("CREATOR_ROLE granted to the predicted launcher via CreatorRegistrar");
            } else if (pf.isAdmin(deployer)) {
                IAccessControl(address(pf)).grantRole(Roles.CREATOR_ROLE, predictedLauncher);
                console2.log("granted CREATOR_ROLE to the predicted launcher");
            } else {
                console2.log("WARNING: grant CREATOR_ROLE before openPool (run ConfigureRegistrar, or Timelock grantRole)");
            }
        }
        uint256 fee = IPortal(portal).SALT_LOCK_FEE();
        address launcher = IPortal(portal).newLauncher{value: fee}(address(lf), abi.encode(c));
        vm.stopBroadcast();
        require(launcher == predictedLauncher, "launcher address prediction failed");

        LauncherEntry[] memory rows = _readLaunchers(_readDeployments());
        LauncherEntry[] memory out = new LauncherEntry[](rows.length + 1);
        for (uint256 i; i < rows.length; ++i) {
            out[i] = rows[i];
        }
        out[rows.length] = LauncherEntry({launcher: launcher, token: predictedToken, vault: address(0), poolId: POOL_ID});
        _writeLaunchers(out);

        _log("launcher", launcher);
        _log("predicted token", predictedToken);
        console2.logBytes32(c.salt);
    }

    /// @notice Contribute `amount` wei (0 = exactly `remaining()`, which launches).
    function contribute(uint256 amount) public {
        SplitLauncher l = _launcher();
        if (amount == 0) amount = l.remaining();
        require(amount > 0, "sale not open");
        _startBroadcastTestnet();
        l.contribute{value: amount}();
        vm.stopBroadcast();
        console2.log("raised", l.raised(), "target", l.targetRaise());
        if (l.launched()) _recordLaunch(l);
    }

    /// @notice Contribute exactly `remaining()`, which launches the token.
    function fill() external {
        contribute(0);
    }

    /// @notice Escrow BOOST_ESCROW sUSD and contribute `amount` wei with the 1.2x boost.
    function contributeBoosted(uint256 amount) external {
        SplitLauncher l = _launcher();
        address bt = l.boostToken();
        require(bt != address(0), "boost disabled");
        _startBroadcastTestnet();
        IERC20(bt).approve(address(l), l.BOOST_ESCROW());
        l.contributeBoosted{value: amount}();
        vm.stopBroadcast();
        if (l.launched()) _recordLaunch(l);
    }

    /// @notice Open the SplitStock NVDA pool (permissionless, once) and record it in pools[] as "nvda-flap".
    function openPool() external {
        SplitLauncher l = _launcher();
        require(l.launched(), "not launched");
        _preflightSeedSwap(l);
        _startBroadcastTestnet();
        address pool = l.openPool();
        vm.stopBroadcast();

        IPoolFactory pf = IPoolFactory(l.poolConfig().poolFactory); // the Launcher's own snapshot
        IPoolFactory.PoolInfo memory info = pf.poolInfo(pool);
        _upsertPool(
            PoolEntry({
                id: POOL_ID,
                symbol: info.symbol,
                assetId: info.assetId,
                kind: "flap",
                pool: pool,
                sUSD: info.sUSD,
                xToken: info.xToken,
                stabilityPool: info.stabilityPool,
                feed: info.feed,
                openedBy: address(l),
                openTx: "" // fill from broadcast/FlapLaunch.s.sol/97/openPool-latest.json
            })
        );
        _recordLaunch(l);
        _log("pool", pool);
        console2.log("xLocked in BackstopVault", l.xLocked());
    }

    /// @notice Flap TaxProcessor.dispatch() for the launch token (moves liquidated tax to the fee slots).
    function dispatch() external {
        SplitLauncher l = _launcher();
        address proc = ITaxTokenLike(l.token()).taxProcessor();
        _startBroadcastTestnet();
        ITaxProcessorLike(proc).dispatch();
        vm.stopBroadcast();
        console2.log("vault buffer (wei)", l.backstopVault().balance);
    }

    /// @notice BackstopVault.cover(live pool). Reverts unless the pool's CR < 1.
    function cover() external {
        SplitLauncher l = _launcher();
        BackstopVault v = BackstopVault(payable(l.backstopVault()));
        _startBroadcastTestnet();
        uint256 out = v.cover(l.pool());
        vm.stopBroadcast();
        console2.log("mUSDC donated", out);
    }

    function claim() external {
        SplitLauncher l = _launcher();
        _startBroadcastTestnet();
        l.claim();
        vm.stopBroadcast();
    }

    function refund() external {
        SplitLauncher l = _launcher();
        _startBroadcastTestnet();
        l.refund();
        vm.stopBroadcast();
    }

    /// @notice Read-only summary of the selected Launcher.
    function status() external view {
        SplitLauncher l = _launcher();
        _log("launcher", address(l));
        console2.log("raised", l.raised(), "target", l.targetRaise());
        console2.log("remaining", l.remaining(), "deadline", l.saleDeadline());
        console2.log("launched", l.launched(), "failed", l.failed());
        _log("token", l.token());
        _log("predicted token", l.predictedToken());
        _log("lp pair", l.lpPair());
        _log("backstop vault", l.backstopVault());
        _log("pool", l.pool());
        console2.log("seedBalance", l.seedBalance(), "xLocked", l.xLocked());
        console2.log("vault buffer USD (wei)", l.backstopBufferUsd());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Same path and minimum as `SplitLauncher._swapSeed`: fail here, before broadcasting, with the reason.
    function _preflightSeedSwap(SplitLauncher l) internal view {
        SplitPoolConfig memory cfg = l.poolConfig();
        uint256 seedIn = l.seedBalance();
        (uint256 minOut,,) = l.seedMinOut(seedIn); // reverts PriceUnavailable on a stale Atlas / stock feed
        IUniswapV2Router02 r = IUniswapV2Router02(cfg.swapRouter);
        address wbnb = r.WETH();
        address direct = IUniswapV2FactoryLike(r.factory()).getPair(wbnb, cfg.asset);
        address[] memory path;
        if (direct != address(0)) {
            path = new address[](2);
            path[1] = cfg.asset;
        } else {
            path = new address[](3);
            path[1] = IPoolFactory(cfg.poolFactory).usdc();
            path[2] = cfg.asset;
        }
        path[0] = wbnb;
        uint256[] memory outs = r.getAmountsOut(seedIn, path);
        uint256 quoted = outs[outs.length - 1];
        console2.log("seed (wei)", seedIn, "router quote", quoted);
        console2.log("min out (Atlas-priced, -3%)", minOut);
        require(
            quoted >= minOut,
            "seed swap would revert SeedSlippage: deepen WBNB/tNVDA (>= ~36x the seed in tBNB) and re-align it to the Atlas price"
        );
    }

    function _launcher() internal view returns (SplitLauncher) {
        address a = vm.envOr("FLAP_LAUNCHER", address(0));
        if (a == address(0)) {
            LauncherEntry[] memory rows = _readLaunchers(_readDeployments());
            require(rows.length > 0, "no flap.launchers entry: run newLauncher or set FLAP_LAUNCHER");
            a = rows[rows.length - 1].launcher;
        }
        require(_hasCode(a), "launcher has no code");
        return SplitLauncher(a);
    }

    /// @dev After launch: fill in token and vault for the launcher's entry.
    function _recordLaunch(SplitLauncher l) internal {
        LauncherEntry[] memory rows = _readLaunchers(_readDeployments());
        bool found;
        for (uint256 i; i < rows.length; ++i) {
            if (rows[i].launcher == address(l)) {
                rows[i].token = l.token();
                rows[i].vault = l.backstopVault();
                found = true;
            }
        }
        if (!found) {
            LauncherEntry[] memory out = new LauncherEntry[](rows.length + 1);
            for (uint256 i; i < rows.length; ++i) {
                out[i] = rows[i];
            }
            out[rows.length] =
                LauncherEntry({launcher: address(l), token: l.token(), vault: l.backstopVault(), poolId: POOL_ID});
            rows = out;
        }
        _writeLaunchers(rows);
        _log("token", l.token());
        _log("backstop vault", l.backstopVault());
    }

    function _readLaunchers(string memory json) internal view returns (LauncherEntry[] memory rows) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".flap.launchers[", vm.toString(n), "]"))) ++n;
        rows = new LauncherEntry[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".flap.launchers[", vm.toString(i), "]");
            rows[i] = LauncherEntry({
                launcher: _jAddr(json, string.concat(k, ".launcher")),
                token: _jAddr(json, string.concat(k, ".token")),
                vault: _jAddr(json, string.concat(k, ".vault")),
                poolId: _jStr(json, string.concat(k, ".poolId"))
            });
        }
    }

    function _writeLaunchers(LauncherEntry[] memory rows) internal {
        string memory s = "[";
        for (uint256 i; i < rows.length; ++i) {
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                "{",
                _kv("launcher", _a(rows[i].launcher)),
                ",",
                _kv("token", _a(rows[i].token)),
                ",",
                _kv("vault", _a(rows[i].vault)),
                ",",
                _kv("poolId", _q(rows[i].poolId)),
                "}"
            );
        }
        _writeSection(".flap.launchers", string.concat(s, "]"));
    }

    /// @dev A salt whose predicted token CREATE2(FLAP_TOKEN_IMPL, salt, portal) ends in 0x7777 (as ForkBase._mineSalt).
    ///      Hashing in scratch space keeps memory flat across ~65k candidates.
    function _mineSalt(address portal, bytes32 seed) internal pure returns (bytes32 salt) {
        for (uint256 i;; ++i) {
            assembly ("memory-safe") {
                mstore(0x00, seed)
                mstore(0x20, i)
                salt := keccak256(0x00, 0x40)
            }
            if (uint16(uint160(Clones.predictDeterministicAddress(FLAP_TOKEN_IMPL, salt, portal))) == 0x7777) {
                return salt;
            }
        }
    }
}
