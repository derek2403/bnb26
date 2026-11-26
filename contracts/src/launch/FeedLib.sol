// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "src/interfaces/IAggregatorV3.sol";

/// @title FeedLib
/// @notice Never-reverting AggregatorV3 reads, scaled to WAD (1e18 = $1). Used by SplitLauncher, BackstopVault and
///         BackstopTreasury. A failed call, a non-positive answer, decimals > 18, a timestamp more than 30 s in the
///         future, or an age above `maxAge` all return `ok = false` (the price is still returned when it was usable,
///         so views can show the last value).
library FeedLib {
    uint256 internal constant MAX_FUTURE_SKEW = 30;

    function read(address feed, uint256 maxAge)
        internal
        view
        returns (uint256 priceWad, uint256 updatedAt, bool ok)
    {
        if (feed == address(0) || feed.code.length == 0) return (0, 0, false);
        uint8 dec;
        try IAggregatorV3(feed).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return (0, 0, false);
        }
        if (dec > 18) return (0, 0, false);
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 upd, uint80) {
            if (answer <= 0) return (0, upd, false);
            priceWad = uint256(answer) * (10 ** (18 - dec));
            updatedAt = upd;
            if (upd > block.timestamp + MAX_FUTURE_SKEW) return (priceWad, upd, false);
            uint256 age = block.timestamp > upd ? block.timestamp - upd : 0;
            ok = age <= maxAge;
        } catch {
            return (0, 0, false);
        }
    }

    /// @dev ERC20 decimals via staticcall; 18 when the call fails or returns garbage.
    function decimalsOf(address token) internal view returns (uint8) {
        (bool success, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!success || ret.length < 32) return 18;
        uint256 d = abi.decode(ret, (uint256));
        return d > 18 ? 18 : uint8(d);
    }
}
