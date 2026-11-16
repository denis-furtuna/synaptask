// Wall-clock time in the user's time zone (from user_settings.timezone).

export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function parts(ms: number, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of `tz` from UTC at the instant `ms`, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz: string, now = Date.now()): string {
  const p = parts(now, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * When a reminder fires: the due time on the due date in `tz`, or 09:00 when only a
 * date is set. Same rule as remindAt() in web/js/util.js, which uses the device's zone.
 */
export function remindAt(dueDate: string | null, dueTime: string | null, tz: string): string | null {
  if (!dueDate) return null;
  const [y, m, d] = dueDate.split('-').map(Number);
  const [h, mi] = (dueTime || '09:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(ts, tz); // around a DST change the first guess can be an hour off
  if (second !== ts) ts = second;
  return new Date(ts).toISOString();
}
