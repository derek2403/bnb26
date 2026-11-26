// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice NYSE regular-session calendar (09:30-16:00 America/New_York), US DST, holiday and early-close tables.
///         Shared by every pool. Outside the covered range every query fails CLOSED (isOpen=false,
///         nextOpen/nextClose = type(uint256).max), which makes pools apply closed-market rules; it never blocks mints.
///         "Day index" = floor(localEtSeconds / 86400), i.e. days since 1970-01-01 of the New York local date.
interface IMarketCalendar {
    event HolidaySet(uint256 indexed dayIndex, bool closed);
    event EarlyCloseSet(uint256 indexed dayIndex, uint256 closeMinuteEt);
    event DstSet(uint256 indexed year, uint256 startUtc, uint256 endUtc);
    event CoverageSet(uint256 fromUtc, uint256 toUtc);

    error BadMinute(uint256 minute);
    error BadDst();
    error BadCoverage();

    /// @notice True iff ts is inside a regular session (open <= ts < close).
    function isOpen(uint256 ts) external view returns (bool);

    /// @notice Smallest session-open timestamp strictly greater than ts. type(uint256).max if not covered.
    function nextOpen(uint256 ts) external view returns (uint256);

    /// @notice If open at ts: the close of the current session. Otherwise the close of the next session.
    ///         type(uint256).max if not covered.
    function nextClose(uint256 ts) external view returns (uint256);

    /// @notice !isOpen(ts) && nextOpen(ts) - ts <= windowSec. False when nextOpen is unknown.
    function inGapGuard(uint256 ts, uint256 windowSec) external view returns (bool);

    /// @notice UTC offset in seconds as a positive number to subtract (14400 during EDT, 18000 during EST).
    function utcOffset(uint256 ts) external view returns (uint256);

    /// @notice New York local day index of ts.
    function dayIndexOf(uint256 ts) external view returns (uint256);

    /// @notice Session bounds in UTC for a local day index. (0,0) if weekend, holiday or not covered.
    function sessionOf(uint256 dayIndex) external view returns (uint256 openUtc, uint256 closeUtc);

    function isHoliday(uint256 dayIndex) external view returns (bool);

    /// @notice Close time in minutes after local midnight for an early-close day; 0 = normal (960 = 16:00).
    function earlyCloseMinute(uint256 dayIndex) external view returns (uint256);

    /// @notice True iff ts is within [coverageFrom, coverageTo).
    function covered(uint256 ts) external view returns (bool);

    function coverage() external view returns (uint256 fromUtc, uint256 toUtc);

    /// @notice Admin only (Timelock). Amends tables after NYSE publishes changes.
    function setHoliday(uint256 dayIndex, bool closed) external;

    /// @notice Admin only. closeMinuteEt in (570, 960]; 0 clears.
    function setEarlyClose(uint256 dayIndex, uint256 closeMinuteEt) external;

    /// @notice Admin only. DST instants in UTC for one calendar year.
    function setDst(uint256 year, uint256 startUtc, uint256 endUtc) external;

    /// @notice Admin only.
    function setCoverage(uint256 fromUtc, uint256 toUtc) external;
}
