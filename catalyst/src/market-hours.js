/**
 * US Eastern market hours, computed arithmetically.
 *
 * Deliberately avoids Intl.DateTimeFormat: first-call ICU initialisation costs
 * several milliseconds, and this runs on the new tab's paint path. US DST rules
 * (2nd Sunday of March -> 1st Sunday of November) are stable and cheap to encode.
 */

/** UTC offset in hours for America/New_York at instant `t`. */
export function etOffset(t) {
  const y = new Date(t).getUTCFullYear();
  const marFirst = new Date(Date.UTC(y, 2, 1)).getUTCDay();
  const start = Date.UTC(y, 2, 1 + ((7 - marFirst) % 7) + 7, 7); // 02:00 EST
  const novFirst = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  const end = Date.UTC(y, 10, 1 + ((7 - novFirst) % 7), 6);      // 02:00 EDT
  return t >= start && t < end ? -4 : -5;
}

/** Eastern wall clock at `t`: weekday, minutes-since-midnight, calendar parts. */
export function etNow(t = Date.now()) {
  const d = new Date(t + etOffset(t) * 3600000);
  return {
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** "open" | "pre" | "after" | "closed" */
export function marketPhase(t = Date.now()) {
  const { weekday, minutes } = etNow(t);
  if (weekday === 0 || weekday === 6) return 'closed';
  if (minutes < 240 || minutes >= 1200) return 'closed'; // 04:00 / 20:00
  if (minutes < 570) return 'pre';                        // 09:30
  if (minutes < 960) return 'open';                       // 16:00
  return 'after';
}

export const PHASE_LABEL = { open: 'Open', pre: 'Pre-market', after: 'After hours', closed: 'Closed' };

/** Regular session only — gates the quote refresh alarm. */
export function isRegularHours(t = Date.now()) {
  return marketPhase(t) === 'open';
}

/**
 * The instant the most recent regular-session close became trustworthy: 16:20
 * Eastern on the latest weekday at or before `t`.
 *
 * Twenty minutes, because Nasdaq's reference close is not final at the bell:
 * across 17 days of live samples it was 3 cents off the official closing-auction
 * price in a quarter of reads taken 16:00-16:09, and exact in every read from
 * 16:10 on. A quote fetched before this instant may hold an intraday price or a
 * provisional close; one fetched after it holds the real close.
 */
export function lastSettledCloseAt(t = Date.now()) {
  for (let back = 0; back < 8; back++) {
    const e = etNow(t - back * 86400000);
    if (e.weekday === 0 || e.weekday === 6) continue;
    const wall = Date.UTC(e.year, e.month - 1, e.day, 16, 20);
    let at = wall - etOffset(wall) * 3600000;
    at = wall - etOffset(at) * 3600000;            // settle the offset across a DST change
    if (at <= t) return at;
  }
  return 0;
}

/** `YYYY-MM-DD` in Eastern, offset by `days`. Used to build calendar ranges. */
export function etDateStr(days = 0, t = Date.now()) {
  const e = etNow(t);
  const d = new Date(Date.UTC(e.year, e.month - 1, e.day + days));
  return d.toISOString().slice(0, 10);
}
