// Client-side approximation of NYSE regular hours (09:30-16:00 America/New_York, Mon-Fri, US DST), used for
// demo pools and as a fallback label. The on-chain MarketCalendar (with holidays and early closes) is the
// source of truth for real pools.

function nthSunday(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1));
  const day = first.getUTCDay();
  return 1 + ((7 - day) % 7) + (n - 1) * 7;
}

/** UTC offset in hours to subtract (4 during EDT, 5 during EST). */
export function nyOffsetHours(tsSec: number): number {
  const d = new Date(tsSec * 1000);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7) / 1000; // 2nd Sun Mar, 02:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6) / 1000; // 1st Sun Nov, 02:00 EDT = 06:00 UTC
  return tsSec >= start && tsSec < end ? 4 : 5;
}

function sessionFor(dayStartLocalUtcMs: number, offsetH: number) {
  const open = dayStartLocalUtcMs / 1000 + (9 * 3600 + 30 * 60) + offsetH * 3600;
  const close = dayStartLocalUtcMs / 1000 + 16 * 3600 + offsetH * 3600;
  return { open, close };
}

export function nyseStatus(tsSec: number) {
  for (let i = -1; i < 10; i++) {
    const probe = tsSec + i * 86400;
    const off = nyOffsetHours(probe);
    const local = new Date((probe - off * 3600) * 1000);
    const dow = local.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    const { open, close } = sessionFor(dayStart, off);
    if (tsSec >= open && tsSec < close) return { open: true, nextOpen: open + 86400, nextClose: close };
    if (open > tsSec) return { open: false, nextOpen: open, nextClose: close };
  }
  return { open: false, nextOpen: tsSec + 86400, nextClose: tsSec + 86400 + 6.5 * 3600 };
}
