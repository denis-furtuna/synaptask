// Local-first data store.
//  - Personal data is kept in localStorage and (when a backend is configured)
//    synced with Supabase: local changes are pushed, remote changes pulled.
//  - Work data only ever exists decrypted in memory (`work`). What is stored
//    and synced is the ciphertext in `vault_items`.
import { sb, online } from './backend.js';
import * as vault from './vault.js';
import { bus, ls, nowIso, uid, remindAt } from './util.js';

// Columns sent to the server, per table. `updated_at` and `reminded_at` are owned by the server.
const COLUMNS = {
  categories: ['id', 'name', 'color', 'position', 'created_at', 'deleted_at'],
  tasks: ['id', 'category_id', 'idea_id', 'title', 'notes', 'priority', 'due_date', 'due_time', 'remind_at',
    'recurrence', 'subtasks', 'completed_at', 'last_completed_at', 'source', 'position', 'created_at', 'deleted_at'],
  ideas: ['id', 'title', 'notes', 'stage', 'tags', 'links', 'position', 'created_at', 'deleted_at'],
  vault_items: ['id', 'ciphertext', 'iv', 'remind_at', 'created_at', 'deleted_at'],
};
const TABLES = Object.keys(COLUMNS);
const DEFAULTS = {
  categories: { name: '', color: '#8792a3', position: 0 },
  tasks: { category_id: null, idea_id: null, title: '', notes: '', priority: 0, due_date: null, due_time: null,
    remind_at: null, recurrence: null, subtasks: [], completed_at: null, last_completed_at: null, source: 'app', position: 0 },
  ideas: { title: '', notes: '', stage: 'idea', tags: [], links: [], position: 0 },
};

const db = { categories: [], tasks: [], ideas: [], vault_items: [] };
const work = { categories: [], tasks: [] };
let ns = 'local';
let syncTimer = null;
let syncing = false;
let syncAgain = false;
export let syncState = online ? 'idle' : 'local'; // local | idle | syncing | offline | error

const key = (name) => `mynotes:${ns}:${name}`;
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
  for (const t of TABLES) { ls.del(key(t)); ls.del(key(`cursor:${t}`)); db[t] = []; }
  ls.del(key('vault'));
  ls.del(key('seeded'));
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
  const rec = { ...DEFAULTS[table], ...publicFields(obj) };
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

export async function saveVaultRecord(record) {
  ls.set(key('vault'), record);
  if (online) {
    const { error } = await sb.from('vaults').upsert({ record, public_key: record.public_key }, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
  }
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
      await save('tasks', {
        title: String(t.title || '').slice(0, 500), notes: String(t.notes || '').slice(0, 20000),
        priority: [0, 1, 2, 3].includes(t.priority) ? t.priority : 0,
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null,
        due_time: /^\d{2}:\d{2}$/.test(t.due_time || '') ? t.due_time : null,
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
  try {
    for (const table of TABLES) {
      // push local changes
      const dirty = db[table].filter((r) => r._dirty);
      if (dirty.length) {
        const sent = dirty.map((r) => ({ id: r.id, rev: r._rev }));
        const rows = dirty.map((r) => Object.fromEntries(COLUMNS[table].map((c) => [c, r[c] ?? null])));
        const { error } = await sb.from(table).upsert(rows, { onConflict: 'id' });
        if (error) throw error;
        for (const s of sent) {
          const r = db[table].find((x) => x.id === s.id);
          if (r && r._rev === s.rev) delete r._dirty; // untouched while the request was in flight
        }
        persist(table);
      }
      // pull remote changes (small overlap so nothing committed concurrently is missed)
      let cursor = ls.get(key(`cursor:${table}`), '1970-01-01T00:00:00Z');
      for (;;) {
        const { data, error } = await sb.from(table).select('*').gt('updated_at', cursor).order('updated_at').limit(500);
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
          anyChange = true;
          if (table === 'vault_items') pulledVault = true;
        }
        if (data.length) cursor = data[data.length - 1].updated_at;
        if (data.length < 500) break;
      }
      ls.set(key(`cursor:${table}`), new Date(new Date(cursor).getTime() - 5000).toISOString());
      persist(table);
    }
    if (vault.isUnlocked()) {
      if (pulledVault) await rebuildWork();
      await importInbox();
    }
    setSyncState('idle');
    if (anyChange) changed();
  } catch (e) {
    console.error('sync failed', e);
    setSyncState(navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(200); }
  }
}

export const pendingCount = () => TABLES.reduce((n, t) => n + db[t].filter((r) => r._dirty).length, 0);

/** Restore personal data from a backup made with exportData(). Existing records with the same id are overwritten. */
export function importData(json) {
  if (!json || json.app !== 'mynotes') throw new Error('This is not a MyNotes backup file.');
  let n = 0;
  for (const table of ['categories', 'ideas', 'tasks']) {
    for (const raw of Array.isArray(json[table]) ? json[table] : []) {
      if (!raw || typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id)) continue;
      const rec = { ...DEFAULTS[table] };
      for (const c of COLUMNS[table]) if (raw[c] !== undefined) rec[c] = raw[c];
      rec.deleted_at = null;
      rec.created_at ||= nowIso();
      upsertLocal(table, rec);
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
    app: 'mynotes', version: 1, exported_at: nowIso(),
    categories: clean(db.categories), tasks: clean(db.tasks), ideas: clean(db.ideas),
    encrypted_work_items: clean(db.vault_items),
  };
}
