// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IMarketCalendar} from "../interfaces/IMarketCalendar.sol";

/// @title MarketCalendar
/// @notice NYSE regular-session calendar (09:30-16:00 America/New_York) with US DST, holiday and early-close
///         tables, shared by every pool. Preloaded for 2026-2027; admin (Timelock) can amend the tables.
///         Outside the covered range every query fails CLOSED (isOpen = false, nextOpen/nextClose = max), which
///         makes pools apply closed-market rules (closed fee, closed leverage cap) but never blocks mints.
/// @dev All queries are total (never revert). Day index = floor(localEtSeconds / 86400). 1970-01-01 was a
///      Thursday, so weekday(d) = (d + 4) % 7 with 0 = Sunday. No external calls: no reentrancy guard needed.
contract MarketCalendar is AccessControl, IMarketCalendar {
    /// @dev Thrown when the constructor admin is the zero address.
    error ZeroAdmin();

    uint256 private constant DAY = 86400;
    uint256 private constant EDT_OFFSET = 14400; // UTC-4
    uint256 private constant EST_OFFSET = 18000; // UTC-5
    uint256 private constant OPEN_MINUTE = 570; // 09:30
    uint256 private constant CLOSE_MINUTE = 960; // 16:00
    uint256 private constant NOON_PROBE = 61200; // 17:00 UTC: always 12:00/13:00 local, away from DST flips
    uint256 private constant SCAN_DAYS = 14;
    uint256 private constant MAX_DST_YEARS = 64;
    uint256 private constant MAX_TS = type(uint64).max;

    struct DstWindow {
        uint256 startUtc;
        uint256 endUtc;
    }

    mapping(uint256 dayIndex => bool) private _holiday;
    mapping(uint256 dayIndex => uint256 minute) private _earlyClose;
    mapping(uint256 year => DstWindow) private _dst;
    uint256[] private _dstYears;
    uint256 private _coverageFrom;
    uint256 private _coverageTo;

    /// @param admin DEFAULT_ADMIN_ROLE holder (Timelock)
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        // Coverage: 2026-01-01 00:00 ET .. 2028-01-01 00:00 ET (exclusive).
        _setCoverage(1767243600, 1830315600);

        // US DST: second Sunday of March 02:00 EST .. first Sunday of November 02:00 EDT.
        _setDst(2026, 1772953200, 1793512800);
        _setDst(2027, 1805007600, 1825567200);

        // NYSE full-day holidays (day indices, see SPEC.md §8).
        uint16[20] memory h = [
            // 2026: New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth, Independence (obs), Labor,
            //       Thanksgiving, Christmas
            20454, 20472, 20500, 20546, 20598, 20623, 20637, 20703, 20783, 20812,
            // 2027: New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth (obs), Independence (obs), Labor,
            //       Thanksgiving, Christmas (obs)
            20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176
        ];
        for (uint256 i; i < h.length; ++i) {
            _setHoliday(h[i], true);
        }

        // 13:00 ET early closes: day after Thanksgiving 2026, Christmas Eve 2026, day after Thanksgiving 2027.
        // [UNVERIFIED] 2027: assumes no early close on 2027-07-02 or 2027-12-23; amend via setEarlyClose.
        _setEarlyClose(20784, 780);
        _setEarlyClose(20811, 780);
        _setEarlyClose(21148, 780);
    }

    // ---------------------------------------------------------------- queries

    /// @inheritdoc IMarketCalendar
    function isOpen(uint256 ts) public view returns (bool) {
        if (!covered(ts)) return false;
        (uint256 o, uint256 c) = sessionOf(dayIndexOf(ts));
        return o != 0 && o <= ts && ts < c;
    }

    /// @inheritdoc IMarketCalendar
    function nextOpen(uint256 ts) public view returns (uint256) {
        if (!covered(ts)) return type(uint256).max;
        (uint256 o,) = _nextSession(ts);
        return o;
    }

    /// @inheritdoc IMarketCalendar
    function nextClose(uint256 ts) external view returns (uint256) {
        if (!covered(ts)) return type(uint256).max;
        (uint256 o, uint256 c) = sessionOf(dayIndexOf(ts));
        if (o != 0 && o <= ts && ts < c) return c;
        (, c) = _nextSession(ts);
        return c;
    }

    /// @inheritdoc IMarketCalendar
    function inGapGuard(uint256 ts, uint256 windowSec) external view returns (bool) {
        if (isOpen(ts)) return false;
        uint256 n = nextOpen(ts);
        return n != type(uint256).max && n - ts <= windowSec;
    }

    /// @inheritdoc IMarketCalendar
    function utcOffset(uint256 ts) public view returns (uint256) {
        uint256 n = _dstYears.length;
        for (uint256 i; i < n; ++i) {
            DstWindow storage w = _dst[_dstYears[i]];
            if (w.startUtc <= ts && ts < w.endUtc) return EDT_OFFSET;
        }
        return EST_OFFSET;
    }

    /// @inheritdoc IMarketCalendar
    function dayIndexOf(uint256 ts) public view returns (uint256) {
        uint256 off = utcOffset(ts);
        return ts > off ? (ts - off) / DAY : 0;
    }

    /// @inheritdoc IMarketCalendar
    function sessionOf(uint256 dayIndex) public view returns (uint256 openUtc, uint256 closeUtc) {
        // Days far beyond any plausible coverage return (0,0) and keep the arithmetic below overflow-free.
        if (dayIndex > MAX_TS / DAY) return (0, 0);
        uint256 wd = (dayIndex + 4) % 7;
        if (wd == 0 || wd == 6 || _holiday[dayIndex]) return (0, 0);
        uint256 midnightUtc = dayIndex * DAY;
        uint256 off = utcOffset(midnightUtc + NOON_PROBE);
        openUtc = midnightUtc + OPEN_MINUTE * 60 + off;
        if (!covered(openUtc)) return (0, 0);
        uint256 ec = _earlyClose[dayIndex];
        closeUtc = midnightUtc + (ec != 0 ? ec : CLOSE_MINUTE) * 60 + off;
    }

    /// @inheritdoc IMarketCalendar
    function isHoliday(uint256 dayIndex) external view returns (bool) {
        return _holiday[dayIndex];
    }

    /// @inheritdoc IMarketCalendar
    function earlyCloseMinute(uint256 dayIndex) external view returns (uint256) {
        return _earlyClose[dayIndex];
    }

    /// @inheritdoc IMarketCalendar
    function covered(uint256 ts) public view returns (bool) {
        return _coverageFrom <= ts && ts < _coverageTo;
    }

    /// @inheritdoc IMarketCalendar
    function coverage() external view returns (uint256 fromUtc, uint256 toUtc) {
        return (_coverageFrom, _coverageTo);
    }

    /// @notice Years with a DST window configured.
    function dstYears() external view returns (uint256[] memory) {
        return _dstYears;
    }

    /// @notice DST window for a year ((0,0) if unset).
    function dstOf(uint256 year) external view returns (uint256 startUtc, uint256 endUtc) {
        DstWindow storage w = _dst[year];
        return (w.startUtc, w.endUtc);
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IMarketCalendar
    function setHoliday(uint256 dayIndex, bool closed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setHoliday(dayIndex, closed);
    }

    /// @inheritdoc IMarketCalendar
    function setEarlyClose(uint256 dayIndex, uint256 closeMinuteEt) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setEarlyClose(dayIndex, closeMinuteEt);
    }

    /// @inheritdoc IMarketCalendar
    /// @dev endUtc == 0 with startUtc == 0 removes the window for that year.
    function setDst(uint256 year, uint256 startUtc, uint256 endUtc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setDst(year, startUtc, endUtc);
    }

    /// @inheritdoc IMarketCalendar
    function setCoverage(uint256 fromUtc, uint256 toUtc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCoverage(fromUtc, toUtc);
    }

    // --------------------------------------------------------------- internal

    /// @dev First session with open > ts within SCAN_DAYS local days; (max, max) if none.
    function _nextSession(uint256 ts) private view returns (uint256 o, uint256 c) {
        uint256 d = dayIndexOf(ts);
        for (uint256 i; i <= SCAN_DAYS; ++i) {
            (o, c) = sessionOf(d + i);
            if (o != 0 && o > ts) return (o, c);
        }
        return (type(uint256).max, type(uint256).max);
    }

    function _setHoliday(uint256 dayIndex, bool closed) private {
        _holiday[dayIndex] = closed;
        emit HolidaySet(dayIndex, closed);
    }

    function _setEarlyClose(uint256 dayIndex, uint256 minute) private {
        if (minute != 0 && (minute <= OPEN_MINUTE || minute > CLOSE_MINUTE)) revert BadMinute(minute);
        _earlyClose[dayIndex] = minute;
        emit EarlyCloseSet(dayIndex, minute);
    }

    function _setDst(uint256 year, uint256 startUtc, uint256 endUtc) private {
        bool remove = startUtc == 0 && endUtc == 0;
        if (!remove && (startUtc >= endUtc || endUtc - startUtc > 366 days || endUtc > MAX_TS)) revert BadDst();

        bool known = _dst[year].endUtc != 0;
        if (remove) {
            if (known) {
                uint256 n = _dstYears.length;
                for (uint256 i; i < n; ++i) {
                    if (_dstYears[i] == year) {
                        _dstYears[i] = _dstYears[n - 1];
                        _dstYears.pop();
                        break;
                    }
                }
                delete _dst[year];
            }
        } else {
            if (!known) {
                if (_dstYears.length >= MAX_DST_YEARS) revert BadDst();
                _dstYears.push(year);
            }
            _dst[year] = DstWindow({startUtc: startUtc, endUtc: endUtc});
        }
        emit DstSet(year, startUtc, endUtc);
    }

    function _setCoverage(uint256 fromUtc, uint256 toUtc) private {
        if (fromUtc >= toUtc || toUtc > MAX_TS) revert BadCoverage();
        _coverageFrom = fromUtc;
        _coverageTo = toUtc;
        emit CoverageSet(fromUtc, toUtc);
    }
}
