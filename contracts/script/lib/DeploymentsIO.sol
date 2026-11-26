// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @title DeploymentsIO
/// @notice Shared helpers for every forge script that reads or writes `deployments/<chainId>.json`
///         (format: deployments/SCHEMA.md). Other components' scripts (Flap, OpenFour) may inherit it.
/// @dev Paths are relative to the Foundry root (`contracts/`); `fs_permissions` grants `../deployments`.
///      JSON is assembled as text and written with `vm.writeJson` (which parses and pretty-prints it), so the
///      output keeps the SCHEMA.md key order and can carry `null`.
abstract contract DeploymentsIO is Script {
    /// @notice One row of `pools[]` in SCHEMA.md.
    struct PoolEntry {
        string id; // stable slug, e.g. "nvda-flap"
        string symbol; // "NVDA"
        bytes32 assetId; // keccak256(symbol)
        string kind; // flap | four | scenario | dev
        address pool;
        address sUSD;
        address xToken;
        address stabilityPool;
        address feed;
        address openedBy;
        string openTx; // "" when the script cannot know the tx hash (fill from broadcast/run-latest.json)
    }

    // ------------------------------------------------------------------ paths

    function _deploymentsPath() internal view returns (string memory) {
        return _deploymentsPath(block.chainid);
    }

    function _deploymentsPath(uint256 chainId) internal view returns (string memory) {
        string memory dir = vm.envOr("DEPLOYMENTS_DIR", string("../deployments"));
        return string.concat(dir, "/", vm.toString(chainId), ".json");
    }

    function _readDeployments() internal view returns (string memory json) {
        string memory path = _deploymentsPath();
        require(vm.isFile(path), string.concat("missing ", path, ": run deploy-core first"));
        json = vm.readFile(path);
    }

    // ------------------------------------------------------------------ broadcaster

    /// @dev Testnet deployer: DEPLOYER_PRIVATE_KEY, else KEEPER_PRIVATE_KEY (the original testnet wallet),
    ///      else the forge default sender (--account / --ledger / local simulation).
    function _startBroadcastTestnet() internal returns (address who) {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.envOr("KEEPER_PRIVATE_KEY", uint256(0));
        return _startBroadcastWith(pk);
    }

    /// @dev Mainnet deployer: MAINNET_DEPLOYER_PRIVATE_KEY, else MAINNET_PRIVATE_KEY. Never a testnet key.
    function _startBroadcastMainnet() internal returns (address who) {
        uint256 pk = vm.envOr("MAINNET_DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.envOr("MAINNET_PRIVATE_KEY", uint256(0));
        return _startBroadcastWith(pk);
    }

    function _startBroadcastWith(uint256 pk) internal returns (address who) {
        if (pk != 0) {
            who = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            who = msg.sender;
            vm.startBroadcast();
        }
    }

    // ------------------------------------------------------------------ env

    /// @dev `<NAME>_ADDRESS` if set, else the address of `<keyName>` if set, else `fallback_`.
    ///      Private keys are only turned into addresses locally (vm.addr); they are never logged.
    function _roleAddr(string memory addrName, string memory keyName, address fallback_)
        internal
        view
        returns (address a)
    {
        a = vm.envOr(addrName, address(0));
        if (a != address(0)) return a;
        if (bytes(keyName).length != 0) {
            uint256 pk = vm.envOr(keyName, uint256(0));
            if (pk != 0) return vm.addr(pk);
        }
        return fallback_;
    }

    // ------------------------------------------------------------------ JSON reading

    function _jAddr(string memory json, string memory key) internal view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);
        try vm.parseJsonAddress(json, key) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    function _jStr(string memory json, string memory key) internal view returns (string memory) {
        if (!vm.keyExistsJson(json, key)) return "";
        try vm.parseJsonString(json, key) returns (string memory s) {
            return s;
        } catch {
            return "";
        }
    }

    function _jB32(string memory json, string memory key) internal view returns (bytes32) {
        if (!vm.keyExistsJson(json, key)) return bytes32(0);
        try vm.parseJsonBytes32(json, key) returns (bytes32 b) {
            return b;
        } catch {
            return bytes32(0);
        }
    }

    /// @dev Returns (0, false) for a missing key or `null`.
    function _jUint(string memory json, string memory key) internal view returns (uint256, bool) {
        if (!vm.keyExistsJson(json, key)) return (0, false);
        try vm.parseJsonUint(json, key) returns (uint256 v) {
            return (v, true);
        } catch {
            return (0, false);
        }
    }

    function _readPools(string memory json) internal view returns (PoolEntry[] memory pools) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".pools[", vm.toString(n), "]"))) ++n;
        pools = new PoolEntry[](n);
        for (uint256 i; i < n; ++i) {
            string memory k = string.concat(".pools[", vm.toString(i), "]");
            pools[i] = PoolEntry({
                id: _jStr(json, string.concat(k, ".id")),
                symbol: _jStr(json, string.concat(k, ".symbol")),
                assetId: _jB32(json, string.concat(k, ".assetId")),
                kind: _jStr(json, string.concat(k, ".kind")),
                pool: _jAddr(json, string.concat(k, ".pool")),
                sUSD: _jAddr(json, string.concat(k, ".sUSD")),
                xToken: _jAddr(json, string.concat(k, ".xToken")),
                stabilityPool: _jAddr(json, string.concat(k, ".stabilityPool")),
                feed: _jAddr(json, string.concat(k, ".feed")),
                openedBy: _jAddr(json, string.concat(k, ".openedBy")),
                openTx: _jStr(json, string.concat(k, ".openTx"))
            });
        }
    }

    function _findPool(PoolEntry[] memory pools, string memory id) internal pure returns (bool found, uint256 idx) {
        for (uint256 i; i < pools.length; ++i) {
            if (keccak256(bytes(pools[i].id)) == keccak256(bytes(id))) return (true, i);
        }
        return (false, 0);
    }

    // ------------------------------------------------------------------ JSON writing

    /// @notice Insert or replace (by id) one row of `pools[]` in the existing file, and bump `updatedAt`.
    function _upsertPool(PoolEntry memory p) internal {
        string memory path = _deploymentsPath();
        string memory json = vm.readFile(path);
        PoolEntry[] memory pools = _readPools(json);
        (bool found, uint256 idx) = _findPool(pools, p.id);
        PoolEntry[] memory out = new PoolEntry[](found ? pools.length : pools.length + 1);
        for (uint256 i; i < pools.length; ++i) {
            out[i] = pools[i];
        }
        out[found ? idx : pools.length] = p;
        vm.writeJson(_poolsJson(out), path, ".pools");
        _touch(path);
    }

    /// @notice Replace one top-level (or nested, e.g. ".flap") key of an existing file with raw JSON.
    function _writeSection(string memory key, string memory rawJson) internal {
        string memory path = _deploymentsPath();
        vm.writeJson(rawJson, path, key);
        _touch(path);
    }

    function _touch(string memory path) internal {
        vm.writeJson(_q(_isoNow()), path, ".updatedAt");
    }

    function _poolsJson(PoolEntry[] memory pools) internal pure returns (string memory s) {
        s = "[";
        for (uint256 i; i < pools.length; ++i) {
            s = string.concat(s, i == 0 ? "" : ",", _poolJson(pools[i]));
        }
        s = string.concat(s, "]");
    }

    function _poolJson(PoolEntry memory p) internal pure returns (string memory) {
        string memory a = string.concat(
            "{",
            _kv("id", _q(p.id)),
            ",",
            _kv("symbol", _q(p.symbol)),
            ",",
            _kv("assetId", _q(vm.toString(p.assetId))),
            ",",
            _kv("kind", _q(p.kind)),
            ",",
            _kv("pool", _a(p.pool))
        );
        return string.concat(
            a,
            ",",
            _kv("sUSD", _a(p.sUSD)),
            ",",
            _kv("xToken", _a(p.xToken)),
            ",",
            _kv("stabilityPool", _a(p.stabilityPool)),
            ",",
            _kv("feed", _a(p.feed)),
            ",",
            _kv("openedBy", _a(p.openedBy)),
            ",",
            _kv("openTx", _q(p.openTx)),
            "}"
        );
    }

    /// @dev "key":value (value is already JSON).
    function _kv(string memory key, string memory value) internal pure returns (string memory) {
        return string.concat('"', key, '":', value);
    }

    /// @dev JSON string literal. Inputs are script-controlled identifiers (no escaping needed).
    function _q(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    /// @dev Checksummed address as a JSON string.
    function _a(address a) internal pure returns (string memory) {
        return _q(vm.toString(a));
    }

    // ------------------------------------------------------------------ time

    /// @dev ISO-8601 UTC of the current wall clock (vm.unixTime) or, if that is 0, block.timestamp.
    function _isoNow() internal view returns (string memory) {
        uint256 t = vm.unixTime() / 1000;
        if (t == 0) t = block.timestamp;
        return _iso(t);
    }

    /// @dev civil-from-days (H. Hinnant), valid for t >= 1970.
    function _iso(uint256 t) internal pure returns (string memory) {
        return string.concat(_isoDate(t / 86400), "T", _isoTime(t % 86400), "Z");
    }

    function _isoTime(uint256 secs) internal pure returns (string memory) {
        return string.concat(_pad2(secs / 3600), ":", _pad2((secs % 3600) / 60), ":", _pad2(secs % 60));
    }

    function _isoDate(uint256 days_) internal pure returns (string memory) {
        uint256 z = days_ + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 d = doy - (153 * mp + 2) / 5 + 1;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) ++y;
        return string.concat(vm.toString(y), "-", _pad2(m), "-", _pad2(d));
    }

    function _pad2(uint256 v) internal pure returns (string memory) {
        return v < 10 ? string.concat("0", vm.toString(v)) : vm.toString(v);
    }

    // ------------------------------------------------------------------ misc

    function _hasCode(address a) internal view returns (bool) {
        return a != address(0) && a.code.length > 0;
    }

    function _log(string memory label, address a) internal pure {
        console2.log(label, a);
    }
}
