// Recurrence rules. A copy of web/js/recurrence.js for the Claude connector.
// KEEP THE TWO IN SYNC: tools/selftest.html runs the same cases against both.
//
//   { freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
//     interval: 1,            every N days / weeks / months / years
//     days: [1, 4],           weekly only: weekdays, 0 = Sunday ... 6 = Saturday
//     day: 31, month: 2 }     anchors so "31st" or "29 Feb" does not drift
// All date maths is done on calendar dates in UTC so time zones cannot shift a day.

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface Rule {
  freq: Freq;
  interval?: number;
  days?: number[];
  day?: number;
  month?: number;
}

const DAY = 86400000;
const toUtc = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m is 0-based

function step(dateStr: string, rule: Rule): string | null {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const ms = toUtc(dateStr);
  const d = new Date(ms);
  switch (rule.freq) {
    case 'daily':
      return fromUtc(ms + interval * DAY);
    case 'weekly': {
      const days = (rule.days || []).filter((n) => n >= 0 && n <= 6);
      if (!days.length) return fromUtc(ms + interval * 7 * DAY);
      // Weeks start on Monday; only every Nth week counts.
      const weekStart = ms - ((d.getUTCDay() + 6) % 7) * DAY;
      for (let i = 1; i <= 7 * interval + 7; i++) {
        const cand = ms + i * DAY;
        const week = Math.floor((cand - weekStart) / (7 * DAY));
        if (week % interval === 0 && days.includes(new Date(cand).getUTCDay())) return fromUtc(cand);
      }
      return fromUtc(ms + interval * 7 * DAY);
    }
    case 'monthly': {
      const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + interval;
      const y = Math.floor(total / 12), m = total % 12;
      const day = Math.min(rule.day || d.getUTCDate(), daysIn(y, m));
      return fromUtc(Date.UTC(y, m, day));
    }
    case 'yearly': {
      const y = d.getUTCFullYear() + interval;
      const m = rule.month ? rule.month - 1 : d.getUTCMonth();
      const day = Math.min(rule.day || d.getUTCDate(), daysIn(y, m));
      return fromUtc(Date.UTC(y, m, day));
    }
    default:
      return null;
  }
}

/**
 * The next due date after completing a recurring task.
 * Starts from the current due date (so finishing early keeps the rhythm) and
 * always lands after today, so finishing an overdue task never leaves it due
 * again straight away.
 */
export function nextDue(dueDate: string | null, rule: Rule | null, todayStr: string): string | null {
  if (!rule || !rule.freq) return null;
  let next = step(dueDate || todayStr, rule);
  for (let i = 0; next && next <= todayStr && i < 5000; i++) next = step(next, rule);
  return next;
}

/** Fill in the anchors when a rule is first attached to a due date. */
export function anchorRule(rule: Partial<Rule> | null, dueDate: string | null): Rule | null {
  if (!rule || !rule.freq) return null;
  const out: Rule = { freq: rule.freq, interval: Math.max(1, Math.floor(rule.interval || 1)) };
  const [, m, d] = (dueDate || '').split('-').map(Number);
  if (rule.freq === 'weekly' && rule.days?.length) out.days = [...new Set(rule.days)].sort();
  if (rule.freq === 'monthly' && d) out.day = d;
  if (rule.freq === 'yearly' && d) { out.day = d; out.month = m; }
  return out;
}

const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNIT: Record<Freq, string> = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
export function describeRule(rule: Rule | null): string {
  if (!rule || !rule.freq) return '';
  const n = Math.max(1, rule.interval || 1);
  let s = n === 1 ? `Every ${UNIT[rule.freq]}` : `Every ${n} ${UNIT[rule.freq]}s`;
  if (rule.freq === 'weekly' && rule.days?.length) {
    const order = [1, 2, 3, 4, 5, 6, 0].filter((x) => rule.days!.includes(x));
    s += ` on ${order.map((x) => NAMES[x]).join(', ')}`;
  }
  return s;
}
