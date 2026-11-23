// Local-first data store.
//  - Personal data is kept in localStorage and (when a backend is configured)
//    synced with Supabase: local changes are pushed, remote changes pulled.
//  - Work data only ever exists decrypted in memory (`work`). What is stored
//    and synced is the ciphertext in `vault_items`.
import { CONFIG } from './config.js';
import { sb, online } from './backend.js';
import * as vault from './vault.js';
import { bus, ls, nowIso, uid, remindAt, safeColor, b64 } from './util.js';

// Columns sent to the server, per table. `updated_at` and `reminded_at` are owned by the server.
const COLUMNS = {
  categories: ['id', 'name', 'color', 'position', 'created_at', 'deleted_at'],
  tasks: ['id', 'category_id', 'idea_id', 'title', 'notes', 'priority', 'due_date', 'due_time', 'remind_at',
    'recurrence', 'subtasks', 'started_at', 'completed_at', 'last_completed_at', 'source', 'position', 'created_at', 'deleted_at'],
  ideas: ['id', 'title', 'notes', 'stage', 'tags', 'links', 'position', 'created_at', 'deleted_at'],
  vault_items: ['id', 'ciphertext', 'iv', 'remind_at', 'created_at', 'deleted_at'],
  shopping_categories: ['id', 'name', 'color', 'position', 'created_at', 'deleted_at'],
  shopping_items: ['id', 'category_id', 'idea_id', 'title', 'quantity', 'notes', 'bought_at', 'source', 'position', 'created_at', 'deleted_at'],
};
const TABLES = Object.keys(COLUMNS);
const DEFAULTS = {
  categories: { name: '', color: '#8792a3', position: 0 },
  shopping_categories: { name: '', color: '#8792a3', position: 0 },
  shopping_items: { category_id: null, idea_id: null, title: '', quantity: '', notes: '', bought_at: null, source: 'app', position: 0 },
  tasks: { category_id: null, idea_id: null, title: '', notes: '', priority: 0, due_date: null, due_time: null,
    remind_at: null, recurrence: null, subtasks: [], started_at: null, completed_at: null, last_completed_at: null, source: 'app', position: 0 },
  ideas: { title: '', notes: '', stage: 'idea', tags: [], links: [], position: 0 },
};

// Same limits as the check constraints in supabase/migrations/0001_init.sql.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = ['idea', 'planning', 'building', 'done'];
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const str = (v, max) => String(v ?? '').slice(0, max);
const int = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
const arr = (v) => (Array.isArray(v) ? v : []);
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const ymdOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v)) ? v : null);
const hmOk = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : null);
const idOk = (v) => (typeof v === 'string' && UUID.test(v) ? v : null);
const httpOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };

function cleanRule(r) {
  if (!r || typeof r !== 'object' || !FREQS.includes(r.freq)) return null;
  const out = { freq: r.freq, interval: int(r.interval, 1, 365, 1) };
  const days = [...new Set(arr(r.days).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  if (r.freq === 'weekly' && days.length) out.days = days;
  if ((r.freq === 'monthly' || r.freq === 'yearly') && r.day) out.day = int(r.day, 1, 31, 1);
  if (r.freq === 'yearly' && r.month) out.month = int(r.month, 1, 12, 1);
  return out;
}

/** Coerce a record into the shape and limits the database accepts. */
function sanitize(table, r) {
  const base = { ...r, created_at: iso(r.created_at) || nowIso(), deleted_at: iso(r.deleted_at) };
  if (table === 'categories' || table === 'shopping_categories') {
    return { ...base, name: str(r.name, 100), color: safeColor(r.color), position: int(r.position, -1e6, 1e6, 0) };
  }
  if (table === 'shopping_items') {
    return {
      ...base, category_id: idOk(r.category_id), idea_id: idOk(r.idea_id),
      title: str(r.title, 300), quantity: str(r.quantity, 50), notes: str(r.notes, 5000),
      bought_at: iso(r.bought_at), source: r.source === 'claude' ? 'claude' : 'app',
      position: int(r.position, -1e6, 1e6, 0),
    };
  }
  if (table === 'ideas') {
    return {
      ...base, title: str(r.title, 300), notes: str(r.notes, 50000), stage: STAGES.includes(r.stage) ? r.stage : 'idea',
      tags: [...new Set(arr(r.tags).map((t) => str(t, 50).trim()).filter(Boolean))].slice(0, 20),
      links: arr(r.links).map((l) => str(l, 2000)).filter(httpOk).slice(0, 30),
      position: int(r.position, -1e6, 1e6, 0),
    };
  }
  if (table === 'tasks') {
    return {
      ...base, category_id: idOk(r.category_id), idea_id: idOk(r.idea_id),
      title: str(r.title, 500), notes: str(r.notes, 20000), priority: int(r.priority, 0, 3, 0),
      due_date: ymdOk(r.due_date), due_time: r.due_date ? hmOk(r.due_time) : null,
      recurrence: cleanRule(r.recurrence),
      subtasks: arr(r.subtasks).filter((s) => s && typeof s === 'object').slice(0, 100)
        .map((s) => ({ id: str(s.id, 64) || uid(), title: str(s.title, 300), done: !!s.done })),
      started_at: iso(r.started_at), completed_at: iso(r.completed_at), last_completed_at: iso(r.last_completed_at),
      source: r.source === 'claude' ? 'claude' : 'app', position: int(r.position, -1e6, 1e6, 0),
    };
  }
  return base;
}

const db = { categories: [], tasks: [], ideas: [], vault_items: [], shopping_categories: [], shopping_items: [] };
const work = { categories: [], tasks: [] };
let ns = 'local';
let syncTimer = null;
let syncing = false;
let syncAgain = false;
export let syncState = online ? 'idle' : 'local'; // local | idle | syncing | offline | error

const key = (name) => `synaptask:${ns}:${name}`;
const persist = (table) => {
  if (!ls.set(key(table), db[table])) bus.emit('storage-full');
};
const changed = () => bus.emit('change');
const setSyncState = (s) => { if (syncState !== s) { syncState = s; bus.emit('sync'); } };

export function init(userId) {
  ns = userId || 'local';
  for (const t of TABLES) db[t] = ls.get(key(t), []);
  work.categories = [];
  work.tasks = [];
  if (!online && !ls.get(key('seeded')) && db.categories.length === 0) seed();
  if (!online) seedShopping(); // online: after the first sync, so another device's list is seen first
}

/** Starter shopping categories, created once. The ids are derived from the account, so two devices
 *  that both seed write the same rows instead of duplicates; a deleted starter stays deleted. */
export const SHOPPING_STARTERS = [['Groceries', '#5bbf7a'], ['For projects', '#ff9d1e'], ['Fun', '#c98be0']];
async function seedShopping() {
  if (ls.get(key('shop-seeded')) || db.shopping_categories.length) return;
  ls.set(key('shop-seeded'), true);
  const now = nowIso();
  for (const [i, [name, color]] of SHOPPING_STARTERS.entries()) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ns}:shopping:${name}`))).slice(0, 16);
    h[6] = (h[6] & 0x0f) | 0x40; h[8] = (h[8] & 0x3f) | 0x80;
    const hex = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (db.shopping_categories.some((c) => c.id === id)) continue;
    upsertLocal('shopping_categories', { ...DEFAULTS.shopping_categories, id, name, color, position: i, created_at: now, deleted_at: null });
  }
  changed();
  scheduleSync();
}

function seed() {
  ls.set(key('seeded'), true);
  const now = nowIso();
  [['Personal', '#4fa3e5'], ['Home', '#c98be0'], ['Learning', '#5bbf7a']].forEach(([name, color], i) => {
    db.categories.push({ ...DEFAULTS.categories, id: uid(), name, color, position: i, created_at: now, updated_at: now, deleted_at: null, _dirty: true });
  });
  persist('categories');
}

/** Wipe everything cached on this device for the current user (used on sign-out). */
export function clearLocal() {
  const prefix = key('');
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
  for (const t of TABLES) db[t] = [];
  lockWork();
}

// ---------------------------------------------------------------- reading

const alive = (r) => !r.deleted_at;
export function list(table, space = 'personal') {
  if (space === 'work') return work[table] || [];
  return db[table].filter(alive);
}
export function get(table, id) {
  return db[table]?.find((r) => r.id === id && alive(r)) || work[table]?.find((r) => r.id === id) || null;
}
export const spaceOf = (obj) => (obj && obj._space === 'work' ? 'work' : 'personal');

// ---------------------------------------------------------------- writing

function upsertLocal(table, row) {
  const rows = db[table];
  const i = rows.findIndex((r) => r.id === row.id);
  const next = { ...row, updated_at: nowIso(), _dirty: true, _rev: ((i >= 0 && rows[i]._rev) || 0) + 1 };
  if (i >= 0) rows[i] = next; else rows.push(next);
  persist(table);
}

const publicFields = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));

/** Create or update a record. `space` is only needed for new records. */
export async function save(table, obj, space) {
  const sp = space || spaceOf(obj);
  const isNew = !obj.id;
  const rec = sanitize(table, { ...DEFAULTS[table], ...publicFields(obj) });
  if (isNew) { rec.id = uid(); rec.created_at = nowIso(); }
  rec.deleted_at = null;
  if (table === 'tasks') rec.remind_at = rec.completed_at ? null : remindAt(rec.due_date, rec.due_time);

  if (sp === 'work') {
    if (!vault.isUnlocked()) throw new Error('Work section is locked');
    const kind = table === 'categories' ? 'category' : 'task';
    const box = await vault.encryptItem(rec.id, { kind, ...rec });
    upsertLocal('vault_items', {
      id: rec.id, ciphertext: box.ciphertext, iv: box.iv,
      remind_at: kind === 'task' ? rec.remind_at : null, // only the time is visible to the server, never the content
      created_at: rec.created_at, deleted_at: null,
    });
    const mem = { ...rec, updated_at: nowIso(), _space: 'work' };
    const i = work[table].findIndex((r) => r.id === rec.id);
    if (i >= 0) work[table][i] = mem; else work[table].push(mem);
  } else {
    upsertLocal(table, rec);
  }
  changed();
  scheduleSync();
  return rec.id;
}

export async function remove(table, id) {
  const inWork = work[table]?.some((r) => r.id === id);
  if (inWork) {
    work[table] = work[table].filter((r) => r.id !== id);
    const row = db.vault_items.find((r) => r.id === id);
    if (row) upsertLocal('vault_items', { ...publicFields(row), ciphertext: '', iv: '', remind_at: null, deleted_at: nowIso() });
    if (table === 'categories') {
      for (const t of work.tasks.filter((x) => x.category_id === id)) await save('tasks', { ...t, category_id: null });
    }
  } else {
    const row = db[table].find((r) => r.id === id);
    if (!row) return;
    upsertLocal(table, { ...publicFields(row), deleted_at: nowIso() });
    if (table === 'categories') {
      for (const t of db.tasks.filter((x) => alive(x) && x.category_id === id)) upsertLocal('tasks', { ...publicFields(t), category_id: null });
    }
    if (table === 'ideas') {
      for (const t of db.tasks.filter((x) => alive(x) && x.idea_id === id)) upsertLocal('tasks', { ...publicFields(t), idea_id: null });
      for (const s of db.shopping_items.filter((x) => alive(x) && x.idea_id === id)) upsertLocal('shopping_items', { ...publicFields(s), idea_id: null });
    }
    if (table === 'shopping_categories') {
      for (const s of db.shopping_items.filter((x) => alive(x) && x.category_id === id)) upsertLocal('shopping_items', { ...publicFields(s), category_id: null });
    }
  }
  changed();
  scheduleSync();
}

// ---------------------------------------------------------------- work vault

export const workUnlocked = () => vault.isUnlocked();

export async function loadVaultRecord() {
  if (online) {
    try {
      const { data, error } = await sb.from('vaults').select('record').maybeSingle();
      if (!error) {
        if (data?.record) ls.set(key('vault'), data.record);
        return data?.record || null;
      }
    } catch { /* offline: fall back to the cached copy below */ }
  }
  return ls.get(key('vault'));
}

/**
 * Store the vault record. With `create`, refuse to replace an existing vault:
 * two devices setting up Work at the same time must not overwrite each other's keys.
 */
export async function saveVaultRecord(record, { create = false } = {}) {
  if (online) {
    const row = { user_id: ns, record, public_key: record.public_key };
    const { error } = create
      ? await sb.from('vaults').insert(row)
      : await sb.from('vaults').upsert(row, { onConflict: 'user_id' });
    if (error) {
      if (error.code === '23505') throw new Error('A Work section already exists on your account. Reload and unlock it.');
      throw new Error(error.message);
    }
  } else if (create && ls.get(key('vault'))) {
    throw new Error('A Work section already exists in this browser.');
  }
  ls.set(key('vault'), record);
}

/** Decrypt everything in the vault into memory. Call after a successful unlock. */
export async function openWork() {
  await rebuildWork();
  await importInbox();
  changed();
}

async function rebuildWork() {
  if (!vault.isUnlocked()) return;
  const cats = [], tasks = [];
  let unreadable = 0;
  for (const row of db.vault_items.filter(alive)) {
    try {
      const { kind, ...obj } = await vault.decryptItem(row);
      (kind === 'category' ? cats : tasks).push({ ...obj, id: row.id, _space: 'work' });
    } catch { unreadable++; }
  }
  work.categories = cats;
  work.tasks = tasks;
  if (unreadable) bus.emit('vault-unreadable', unreadable);
}

/** Tasks Claude dropped into the sealed inbox become normal work tasks once the vault is open. */
async function importInbox() {
  if (!online || !vault.isUnlocked()) return;
  const { data, error } = await sb.from('vault_inbox').select('id, sealed, created_at').order('created_at');
  if (error || !data?.length) return;
  let n = 0;
  for (const row of data) {
    try {
      const t = await vault.openSealed(row.sealed);
      const catName = String(t.category || '').trim().toLowerCase();
      const cat = catName ? work.categories.find((c) => c.name.trim().toLowerCase() === catName) : null;
      // save() sanitises every field (dates, priority, recurrence, step list) to the usual limits.
      await save('tasks', {
        title: t.title, notes: t.notes, priority: t.priority, due_date: t.due_date, due_time: t.due_time,
        recurrence: t.recurrence || null,
        subtasks: arr(t.steps).map((s) => ({ id: uid(), title: s, done: false })),
        category_id: cat ? cat.id : null,
        source: 'claude',
      }, 'work');
      await sb.from('vault_inbox').delete().eq('id', row.id);
      n++;
    } catch { /* leave it in the inbox; it may belong to an older vault */ }
  }
  if (n) bus.emit('inbox-imported', n);
}

export function lockWork() {
  vault.lock();
  work.categories = [];
  work.tasks = [];
  changed();
}

// ---------------------------------------------------------------- Claude access to Work
// See supabase/migrations/0002_work_access.sql. The app seals the vault key to the server's
// grant key; the database caps a grant at 24 hours and lets only the app create or delete it.

export const claudeAccessAvailable = () => online && !!CONFIG.grantPublicKey;

export async function loadClaudeAccess() {
  const [g, r] = await Promise.all([
    sb.from('work_grants').select('expires_at').maybeSingle(),
    sb.from('work_access_requests').select('requested_at').maybeSingle(),
  ]);
  if (g.error) throw new Error(g.error.message);
  return { until: g.data?.expires_at || null, requestedAt: r.data?.requested_at || null };
}

/** Let Claude read and change the Work section until `expiresAt` (ISO time, at most 24 h ahead). */
export async function grantClaude(expiresAt) {
  if (!vault.isUnlocked()) throw new Error('Unlock the Work section first');
  const raw = await vault.exportVaultKey();
  let sealed;
  try {
    sealed = await vault.sealTo(CONFIG.grantPublicKey, { v: 1, k: b64.enc(raw) }, 'work-grant');
  } finally {
    raw.fill(0);
  }
  const { error } = await sb.from('work_grants').upsert({ user_id: ns, sealed_key: sealed, expires_at: expiresAt }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  await sb.from('work_access_requests').delete().eq('user_id', ns);
}

export async function revokeClaude() {
  const { error } = await sb.from('work_grants').delete().eq('user_id', ns);
  if (error) throw new Error(error.message);
}

export async function denyClaude() {
  const { error } = await sb.from('work_access_requests').delete().eq('user_id', ns);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- sync

export function scheduleSync(delay = 800) {
  if (!online) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

export async function sync() {
  if (!online) return;
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setSyncState('offline'); return; }
  syncing = true;
  setSyncState('syncing');
  let pulledVault = false;
  let anyChange = false;
  let failed = null;
  try {
    for (const table of TABLES) {
      // One table failing (for example a new table the server does not have yet) must not stop the others.
      try {
        const n = await syncTable(table);
        if (n) { anyChange = true; if (table === 'vault_items') pulledVault = true; }
      } catch (e) {
        if (!navigator.onLine) throw e;
        console.error(`sync failed for ${table}`, e);
        failed = failed || e;
      }
    }
    if (vault.isUnlocked()) {
      if (pulledVault) await rebuildWork();
      await importInbox();
    }
    if (anyChange) changed();
    if (failed) throw failed;
    setSyncState('idle');
    seedShopping().catch(() => null); // only after a clean sync: another device's list is already here
  } catch (e) {
    console.error('sync failed', e);
    setSyncState(navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(200); }
  }
}

/** Push this table's local changes, then pull the remote ones. Returns how many rows changed locally. */
async function syncTable(table) {
  let changes = 0;
  // push local changes
  const dirty = db[table].filter((r) => r._dirty);
  for (let at = 0; at < dirty.length; at += 200) {
    const batch = dirty.slice(at, at + 200);
    const sent = batch.map((r) => ({ id: r.id, rev: r._rev }));
    const rows = batch.map((r) => Object.fromEntries(COLUMNS[table].map((c) => [c, r[c] ?? null])));
    const rejected = await pushRows(table, rows);
    for (const s of sent) {
      const r = db[table].find((x) => x.id === s.id);
      if (r && r._rev === s.rev) delete r._dirty; // untouched while the request was in flight
    }
    if (rejected) bus.emit('sync-rejected', rejected);
    persist(table);
  }
  // pull remote changes (small overlap so nothing committed concurrently is missed)
  // Pages are keyed on (updated_at, id) so rows sharing a timestamp are never skipped.
  let cursor = ls.get(key(`cursor:${table}`), '1970-01-01T00:00:00Z');
  let lastId = null;
  for (;;) {
    let q = sb.from(table).select('*').order('updated_at').order('id').limit(500);
    q = lastId
      ? q.or(`updated_at.gt."${cursor}",and(updated_at.eq."${cursor}",id.gt.${lastId})`)
      : q.gt('updated_at', cursor);
    const { data, error } = await q;
    if (error) throw error;
    for (const remote of data) {
      const i = db[table].findIndex((r) => r.id === remote.id);
      if (i >= 0 && db[table][i]._dirty) continue; // local edit wins; it is pushed on the next pass
      delete remote.user_id;
      delete remote.reminded_at;
      if (i >= 0) {
        if (db[table][i].updated_at === remote.updated_at) continue;
        db[table][i] = remote;
      } else db[table].push(remote);
      changes++;
    }
    if (data.length) { cursor = data[data.length - 1].updated_at; lastId = data[data.length - 1].id; }
    if (data.length < 500) break;
  }
  ls.set(key(`cursor:${table}`), new Date(new Date(cursor).getTime() - 5000).toISOString());
  persist(table);
  return changes;
}

// Postgres "data exception" (22xxx) and "integrity constraint" (23xxx) errors are about one row's contents.
const isDataError = (e) => /^2[23]/.test(e?.code || '');

/**
 * Upsert rows. If the server rejects the batch because of the data itself, retry one by one
 * so a single bad row cannot block syncing forever. Returns how many rows were rejected.
 */
async function pushRows(table, rows) {
  const { error } = await sb.from(table).upsert(rows, { onConflict: 'id' });
  if (!error) return 0;
  if (!isDataError(error)) throw error;
  let rejected = 0;
  for (const row of rows) {
    const { error: e1 } = await sb.from(table).upsert([row], { onConflict: 'id' });
    if (!e1) continue;
    if (!isDataError(e1)) throw e1;
    console.warn(`server rejected ${table} ${row.id}:`, e1.message);
    rejected++;
  }
  return rejected;
}

export const pendingCount = () => TABLES.reduce((n, t) => n + db[t].filter((r) => r._dirty).length, 0);

/** Restore personal data from a backup made with exportData(). Existing records with the same id are overwritten. */
export function importData(json) {
  if (!json || json.app !== 'synaptask') throw new Error('This is not a Synaptask backup file.');
  let n = 0;
  for (const table of ['categories', 'ideas', 'tasks', 'shopping_categories', 'shopping_items']) {
    for (const raw of Array.isArray(json[table]) ? json[table] : []) {
      if (!raw || !idOk(raw.id)) continue;
      const rec = { ...DEFAULTS[table] };
      for (const c of COLUMNS[table]) if (raw[c] !== undefined) rec[c] = raw[c];
      const clean = sanitize(table, rec);
      clean.deleted_at = null;
      if (table === 'tasks') clean.remind_at = clean.completed_at ? null : remindAt(clean.due_date, clean.due_time);
      upsertLocal(table, clean);
      n++;
    }
  }
  changed();
  scheduleSync();
  return n;
}

/** Plain JSON backup of the personal data (work items stay encrypted). */
export function exportData() {
  const clean = (rows) => rows.filter(alive).map(publicFields);
  return {
    app: 'synaptask', version: 1, exported_at: nowIso(),
    categories: clean(db.categories), tasks: clean(db.tasks), ideas: clean(db.ideas),
    shopping_categories: clean(db.shopping_categories), shopping_items: clean(db.shopping_items),
    encrypted_work_items: clean(db.vault_items),
  };
}
