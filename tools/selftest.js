// Browser self-test for the parts of Synaptask that run without a server.
import { nextDue, anchorRule, describeRule } from '../web/js/recurrence.js';
import * as vault from '../web/js/vault.js';
import * as store from '../web/js/store.js';
import { online } from '../web/js/backend.js';
import { remindAt, esc, claudeRedirect } from '../web/js/util.js';

const log = document.getElementById('log');
let pass = 0, fail = 0, list = null;

function section(name) {
  log.insertAdjacentHTML('beforeend', `<h2>${esc(name)}</h2><ol></ol>`);
  list = log.lastElementChild;
}
function check(cond, name, detail = '') {
  if (cond) pass++; else fail++;
  list.insertAdjacentHTML('beforeend', `<li class="${cond ? 'ok' : 'bad'}">${cond ? '✓' : '✗'} ${esc(name)}${!cond && detail ? ` — ${esc(detail)}` : ''}</li>`);
}
const eq = (a, b, name) => check(JSON.stringify(a) === JSON.stringify(b), name, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
async function throws(fn) { try { await fn(); return false; } catch { return true; } }

async function recurrenceTests() {
  section('Recurrence');
  const T = '2026-11-16'; // Monday
  eq(nextDue('2026-11-16', { freq: 'daily', interval: 1 }, T), '2026-11-17', 'daily');
  eq(nextDue('2026-11-01', { freq: 'daily', interval: 1 }, T), '2026-11-17', 'overdue daily lands after today');
  eq(nextDue('2026-11-16', { freq: 'daily', interval: 3 }, T), '2026-11-19', 'every 3 days');
  eq(nextDue('2026-11-16', { freq: 'weekly', interval: 1, days: [1, 4] }, T), '2026-11-19', 'weekly Mon/Thu: Mon -> Thu');
  eq(nextDue('2026-11-19', { freq: 'weekly', interval: 1, days: [1, 4] }, T), '2026-11-23', 'weekly Mon/Thu: Thu -> Mon');
  eq(nextDue('2026-11-16', { freq: 'weekly', interval: 2, days: [1] }, T), '2026-11-30', 'every 2 weeks');
  eq(nextDue('2026-11-16', { freq: 'weekly', interval: 1 }, T), '2026-11-23', 'weekly without days');
  eq(nextDue('2027-01-31', { freq: 'monthly', interval: 1, day: 31 }, T), '2027-02-28', 'monthly on the 31st -> 28 Feb');
  eq(nextDue('2027-02-28', { freq: 'monthly', interval: 1, day: 31 }, T), '2027-03-31', 'anchor brings back the 31st');
  eq(nextDue('2026-12-15', { freq: 'monthly', interval: 3, day: 15 }, T), '2027-03-15', 'quarterly across a year end');
  eq(nextDue('2028-02-29', { freq: 'yearly', interval: 1, day: 29, month: 2 }, T), '2029-02-28', 'yearly 29 Feb -> 28 Feb');
  eq(nextDue('2026-11-16', { freq: 'yearly', interval: 1, day: 16, month: 11 }, T), '2027-11-16', 'birthday');
  eq(anchorRule({ freq: 'monthly', interval: 0 }, '2026-01-31'), { freq: 'monthly', interval: 1, day: 31 }, 'anchorRule monthly');
  eq(anchorRule({ freq: 'weekly', days: [4, 1, 4] }, '2026-11-16'), { freq: 'weekly', interval: 1, days: [1, 4] }, 'anchorRule dedupes days');
  eq(describeRule({ freq: 'weekly', interval: 2, days: [0, 3] }), 'Every 2 weeks on Wed, Sun', 'describeRule');
  eq(nextDue('2026-11-16', null, T), null, 'no rule -> null');
}

async function vaultTests() {
  section('Work vault crypto');
  const t0 = performance.now();
  const { record, recoveryKey } = await vault.create('correct horse battery staple');
  check(vault.isUnlocked(), `create() unlocks (${Math.round(performance.now() - t0)} ms)`);
  check(/^[0-9a-f]{4}(-[0-9a-f]{4}){9}$/.test(recoveryKey), 'recovery key is 160 bits in groups of 4');
  check(!JSON.stringify(record).includes('correct horse'), 'record does not contain the passphrase');
  eq(record.iterations, 600000, 'PBKDF2 600k iterations');

  const box = await vault.encryptItem('id-1', { kind: 'task', title: 'Quarterly review' });
  check(!JSON.stringify(box).includes('Quarterly review'), 'ciphertext hides the title');
  eq(await vault.decryptItem({ id: 'id-1', ...box }), { kind: 'task', title: 'Quarterly review' }, 'decrypt round trip');
  check(await throws(() => vault.decryptItem({ id: 'id-2', ...box })), 'ciphertext moved to another id fails (AAD)');

  vault.lock();
  check(!vault.isUnlocked(), 'lock()');
  check(await throws(() => vault.encryptItem('x', {})), 'locked vault refuses to encrypt');
  eq(await vault.unlock(record, 'wrong one, sorry'), false, 'wrong passphrase rejected');
  eq(await vault.unlock(record, 'correct horse battery staple'), true, 'right passphrase unlocks');

  const sealed = await vault.sealTo(record.public_key, { title: 'From Claude' });
  eq(await vault.openSealed(sealed), { title: 'From Claude' }, 'sealTo / openSealed round trip');
  const raw = await vault.exportVaultKey();
  eq(raw.length, 32, 'exportVaultKey gives the 256-bit key (for a Claude grant)');
  raw.fill(0);
  const grantSeal = await vault.sealTo(record.public_key, { k: 'x' }, 'work-grant');
  check(await throws(() => vault.openSealed(grantSeal)), 'a work-grant seal cannot pass as an inbox task (AAD)');
  check(await throws(() => vault.openSealed({ ...sealed, iv: sealed.iv.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) })), 'tampered seal fails');

  const changed = await vault.rewrap(record, { passphrase: 'correct horse battery staple' }, 'a new passphrase here');
  check(!!changed && changed.salt !== record.salt, 'rewrap with the passphrase');
  const recovered = await vault.rewrap(changed, { recoveryKey: ` ${recoveryKey.toUpperCase()} ` }, 'after recovery 123');
  check(!!recovered, 'rewrap with the recovery key (any case, spaces)');
  eq(await vault.rewrap(recovered, { recoveryKey: '0000-0000' }, 'whatever passphrase'), null, 'wrong recovery key rejected');
  vault.lock();
  eq(await vault.unlock(recovered, 'a new passphrase here'), false, 'old passphrase stops working');
  eq(await vault.unlock(recovered, 'after recovery 123'), true, 'new passphrase works');
  eq(await vault.decryptItem({ id: 'id-1', ...box }), { kind: 'task', title: 'Quarterly review' }, 'old items still open after rewrap');
  vault.lock();

  check(vault.passphraseProblem('short') !== '', 'short passphrase refused');
  check(vault.passphraseProblem('aaaaaaaaaaaaaaa') !== '', 'repeated character refused');
  check(vault.passphraseProblem('purple tractor sings') === '', 'four random words accepted');
}

async function consentTests() {
  section('Consent page: which apps can be approved');
  for (const u of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://claude.ai:443/api/mcp/auth_callback?code=x&state=y',
    'http://localhost:53682/callback',
    'http://127.0.0.1:8123/callback',
    'http://[::1]:9000/cb',
  ]) check(claudeRedirect(u), `allowed: ${u}`);
  for (const u of [
    'https://evil.example/api/mcp/auth_callback',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'https://evil.claude.ai/api/mcp/auth_callback',
    'https://claude.ai/somewhere-else',
    'https://claude.ai/api/mcp/auth_callback/../../steal',
    'https://claude.ai:8443/api/mcp/auth_callback',
    'http://claude.ai/api/mcp/auth_callback',
    'https://user:pw@claude.ai/api/mcp/auth_callback',
    'http://192.168.1.10:8080/callback',
    'http://localhost.evil.example/callback',
    'javascript:alert(1)',
    'claude.ai/api/mcp/auth_callback',
    '',
  ]) check(!claudeRedirect(u), `refused: ${u || '(empty)'}`);
}

async function storeTests() {
  section('Local store');
  check(!online, 'running in local mode (this page does not load the Supabase library)');
  const ns = `selftest-${Date.now()}`;
  store.init(ns);
  eq(store.list('tasks').length, 0, 'fresh namespace is empty');

  const catId = await store.save('categories', { name: 'Garden', color: '#5bbf7a' }, 'personal');
  const ideaId = await store.save('ideas', { title: 'Greenhouse', stage: 'idea', links: ['https://example.com', 'javascript:alert(1)'] });
  const taskId = await store.save('tasks', { title: 'Plant tulips', category_id: catId, idea_id: ideaId, due_date: '2026-11-20', due_time: '17:00', priority: 9 });
  const t = store.get('tasks', taskId);
  eq(t.priority, 0, 'out-of-range priority sanitised');
  eq(t.remind_at, remindAt('2026-11-20', '17:00'), 'remind_at computed from the due date and time');
  eq(store.get('ideas', ideaId).links, ['https://example.com'], 'non-http links dropped');
  const raw = JSON.parse(localStorage.getItem(`synaptask:${ns}:tasks`));
  check(raw[0]._dirty === true, 'change is marked for sync');

  await store.save('tasks', { ...t, completed_at: new Date().toISOString() });
  eq(store.get('tasks', taskId).remind_at, null, 'completing clears the reminder');

  await store.remove('categories', catId);
  eq(store.get('categories', catId), null, 'category deleted');
  eq(store.get('tasks', taskId).category_id, null, 'its tasks move to the Inbox');
  await store.remove('ideas', ideaId);
  eq(store.get('tasks', taskId).idea_id, null, 'deleting an idea unlinks its tasks');
  check(JSON.parse(localStorage.getItem(`synaptask:${ns}:ideas`))[0].deleted_at, 'deletes are soft (synced as deleted_at)');

  // work space
  check(await throws(() => store.save('tasks', { title: 'locked' }, 'work')), 'work save refused while locked');
  const { record } = await vault.create('selftest passphrase');
  await store.saveVaultRecord(record, { create: true });
  check(await throws(() => store.saveVaultRecord(record, { create: true })), 'a second vault cannot overwrite the first');
  const wId = await store.save('tasks', { title: 'Board meeting prep', due_date: '2026-11-21' }, 'work');
  const rows = JSON.parse(localStorage.getItem(`synaptask:${ns}:vault_items`));
  check(rows.length === 1 && !JSON.stringify(rows).includes('Board meeting prep'), 'work task stored only as ciphertext');
  check(!!rows[0].remind_at, 'only the reminder time is visible');
  store.lockWork();
  eq(store.list('tasks', 'work').length, 0, 'locking clears work tasks from memory');
  await vault.unlock(record, 'selftest passphrase');
  await store.openWork();
  eq(store.list('tasks', 'work').map((x) => x.title), ['Board meeting prep'], 'unlock decrypts them again');
  check(store.get('tasks', wId)?._space === 'work', 'work task is tagged as work');
  store.lockWork();

  // backup
  const backup = store.exportData();
  eq(backup.app, 'synaptask', 'export has the app marker');
  check(backup.encrypted_work_items.length === 1 && !JSON.stringify(backup).includes('Board meeting prep'), 'export keeps work items encrypted');
  check(await throws(() => store.importData({ app: 'other' })), 'foreign file refused');
  const n = store.importData({ app: 'synaptask', tasks: [
    { id: '0b4c3b7e-9a1e-4e0f-8a39-5d8b1c1f2a10', title: 'Imported', priority: 'high', due_date: 'tomorrow', subtasks: 'nope', source: 'evil' },
    { id: 'not-a-uuid', title: 'skipped' },
  ] });
  eq(n, 1, 'import skips rows with a bad id');
  const imp = store.get('tasks', '0b4c3b7e-9a1e-4e0f-8a39-5d8b1c1f2a10');
  eq([imp.priority, imp.due_date, imp.subtasks, imp.source], [0, null, [], 'app'], 'imported values sanitised');

  store.clearLocal();
  check(!Object.keys(localStorage).some((k) => k.startsWith(`synaptask:${ns}:`)), 'clearLocal removes everything for the user');
}

(async () => {
  for (const suite of [recurrenceTests, vaultTests, consentTests, storeTests]) {
    try { await suite(); } catch (e) { check(false, `${suite.name} crashed`, e?.stack || String(e)); }
  }
  const s = document.getElementById('summary');
  s.textContent = fail ? `${fail} failed, ${pass} passed` : `All ${pass} checks passed`;
  s.className = fail ? 'bad' : 'ok';
  document.title = fail ? `FAIL ${fail}` : `PASS ${pass}`;
})();
