// deno test supabase/functions/tests/
// Checks the server-side helpers against the browser code they must match.
import * as js from '../../../web/js/recurrence.js';
import * as vault from '../../../web/js/vault.js';
import * as ts from '../_shared/recurrence.ts';
import { remindAt, todayIn, safeTimeZone } from '../_shared/time.ts';
import { sealTo } from '../_shared/seal.ts';

function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  got      ${a}`);
}

Deno.test('recurrence: known cases', () => {
  const T = '2026-11-16'; // a Monday
  eq(ts.nextDue('2026-11-16', { freq: 'daily', interval: 1 }, T), '2026-11-17', 'daily');
  eq(ts.nextDue('2026-11-10', { freq: 'daily', interval: 1 }, T), '2026-11-17', 'overdue daily lands after today');
  eq(ts.nextDue('2026-11-16', { freq: 'weekly', interval: 1, days: [1, 4] }, T), '2026-11-19', 'Mon -> Thu');
  eq(ts.nextDue('2026-11-19', { freq: 'weekly', interval: 1, days: [1, 4] }, T), '2026-11-23', 'Thu -> Mon');
  eq(ts.nextDue('2026-11-16', { freq: 'weekly', interval: 2, days: [1] }, T), '2026-11-30', 'every 2 weeks');
  eq(ts.nextDue('2027-01-31', { freq: 'monthly', interval: 1, day: 31 }, T), '2027-02-28', '31st -> end of Feb');
  eq(ts.nextDue('2027-02-28', { freq: 'monthly', interval: 1, day: 31 }, T), '2027-03-31', 'anchor restores the 31st');
  eq(ts.nextDue('2028-02-29', { freq: 'yearly', interval: 1, day: 29, month: 2 }, T), '2029-02-28', '29 Feb in a non-leap year');
  eq(ts.nextDue('2029-02-28', { freq: 'yearly', interval: 1, day: 29, month: 2 }, T), '2030-02-28', '...and the year after');
  eq(ts.anchorRule({ freq: 'yearly' }, '2026-03-15'), { freq: 'yearly', interval: 1, day: 15, month: 3 });
  eq(ts.describeRule({ freq: 'weekly', interval: 1, days: [0, 1, 4] }), 'Every week on Mon, Thu, Sun');
});

Deno.test('recurrence: JS and TS copies agree on 20,000 random cases', () => {
  let seed = 42;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const freqs = ['daily', 'weekly', 'monthly', 'yearly'] as const;
  for (let i = 0; i < 20000; i++) {
    const due = new Date(Date.UTC(2024 + rnd(6), rnd(12), 1 + rnd(31))).toISOString().slice(0, 10);
    const today = new Date(Date.UTC(2024 + rnd(6), rnd(12), 1 + rnd(28))).toISOString().slice(0, 10);
    const freq = freqs[rnd(4)];
    const days = rnd(3) ? [...new Set(Array.from({ length: 1 + rnd(4) }, () => rnd(7)))] : [];
    const raw = { freq, interval: 1 + rnd(rnd(4) ? 3 : 12), days };
    const rjs = js.anchorRule(raw, due), rts = ts.anchorRule(raw, due);
    eq(rts, rjs, `anchorRule ${JSON.stringify(raw)} ${due}`);
    eq(ts.nextDue(due, rts, today), js.nextDue(due, rjs, today), `nextDue ${JSON.stringify(rjs)} from ${due}, today ${today}`);
    eq(ts.describeRule(rts), js.describeRule(rjs));
  }
});

Deno.test('time: reminders land at local wall-clock time', () => {
  eq(remindAt('2026-11-20', '09:30', 'Europe/Bucharest'), '2026-11-20T07:30:00.000Z', 'EET winter (+2)');
  eq(remindAt('2026-07-20', '09:30', 'Europe/Bucharest'), '2026-07-20T06:30:00.000Z', 'EEST summer (+3)');
  eq(remindAt('2026-11-20', null, 'Europe/Bucharest'), '2026-11-20T07:00:00.000Z', 'date only -> 09:00');
  eq(remindAt('2026-11-20', '09:00', 'America/New_York'), '2026-11-20T14:00:00.000Z', 'New York (-5)');
  eq(remindAt('2026-03-29', '12:00', 'Europe/Bucharest'), '2026-03-29T09:00:00.000Z', 'day of the spring change');
  eq(remindAt('2026-10-25', '12:00', 'Europe/Bucharest'), '2026-10-25T10:00:00.000Z', 'day of the autumn change');
  eq(remindAt('2026-11-20', '09:00', 'Asia/Kolkata'), '2026-11-20T03:30:00.000Z', 'half-hour zone');
  eq(remindAt(null, '09:00', 'UTC'), null);
  eq(safeTimeZone('Not/AZone'), 'UTC');
  eq(todayIn('Pacific/Kiritimati', Date.UTC(2026, 10, 16, 12)), '2026-11-17', '+14 is already tomorrow');
  eq(todayIn('Pacific/Pago_Pago', Date.UTC(2026, 10, 16, 5)), '2026-11-15', '-11 is still yesterday');
});

Deno.test('seal: a task sealed on the server opens with the browser vault', async () => {
  const { record } = await vault.create('correct horse battery staple');
  const task = { title: 'Ship the Q4 report ✓', notes: 'línea 2', priority: 2, due_date: '2026-11-20', due_time: '10:00' };
  const sealed = await sealTo(record.public_key, task);
  eq(await vault.openSealed(sealed), task);
  // tampering is detected
  const bad = { ...sealed, ct: sealed.ct.slice(0, -4) + (sealed.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  let threw = false;
  try { await vault.openSealed(bad); } catch { threw = true; }
  eq(threw, true, 'tampered ciphertext must not open');
  vault.lock();
});

Deno.test('vault: create, lock, unlock, rewrap, recovery', async () => {
  const { record, recoveryKey } = await vault.create('first passphrase here');
  const box = await vault.encryptItem('item-1', { kind: 'task', title: 'secret' });
  vault.lock();
  eq(await vault.unlock(record, 'wrong passphrase!!'), false, 'wrong passphrase');
  eq(await vault.unlock(record, 'first passphrase here'), true, 'right passphrase');
  eq(await vault.decryptItem({ id: 'item-1', ...box }), { kind: 'task', title: 'secret' });
  let swapped = false;
  try { await vault.decryptItem({ id: 'item-2', ...box }); } catch { swapped = true; }
  eq(swapped, true, 'ciphertext bound to its item id');
  const next = await vault.rewrap(record, { recoveryKey: recoveryKey.toUpperCase() }, 'second passphrase here');
  if (!next) throw new Error('recovery rewrap failed');
  vault.lock();
  eq(await vault.unlock(next, 'first passphrase here'), false, 'old passphrase no longer works');
  eq(await vault.unlock(next, 'second passphrase here'), true, 'new passphrase works');
  eq(await vault.decryptItem({ id: 'item-1', ...box }), { kind: 'task', title: 'secret' }, 'same vault key after rewrap');
  vault.lock();
});
