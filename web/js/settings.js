// Settings: themes, categories, reminders, security, the Claude connector, backup and account.
import { CONFIG } from './config.js';
import { online, sb, signOut } from './backend.js';
import * as store from './store.js';
import * as work from './work.js';
import { state, openDialog, confirmDialog, rerender } from './app.js';
import { esc, ls, toast, ICON, PALETTE, safeColor, downloadText, today } from './util.js';

export const THEMES = [
  ['panel', 'Control Panel', 'Gunmetal, amber indicators'],
  ['blueprint', 'Blueprint', 'Drafting blue, white linework'],
  ['pcb', 'PCB', 'Solder-mask green, gold pads'],
  ['scope', 'Oscilloscope', 'Phosphor trace on black'],
  ['cad', 'CAD', 'Charcoal with layer colours'],
  ['pad', "Engineer's Pad", 'Green grid paper (light)'],
  ['datasheet', 'Datasheet', 'Strict rules, red accent (light)'],
  ['cryo', 'Cleanroom', 'Cool white and steel blue (light)'],
  ['midnight', 'Midnight', 'Dark with violet'],
  ['paper', 'Paper', 'Warm cream, serif headings (light)'],
  ['terminal', 'Terminal', 'Green on black, monospace'],
  ['pastel', 'Pastel', 'Soft, rounded, pink (light)'],
];

const mcpUrl = () => `${CONFIG.supabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp`;

// ---------------------------------------------------------------- theme

export function setTheme(id) {
  if (!THEMES.some(([t]) => t === id)) return;
  document.documentElement.dataset.theme = id;
  ls.set('synaptask:theme', id);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#2b2e33');
}

const currentTheme = () => document.documentElement.dataset.theme || 'panel';

function swatches() {
  const cur = currentTheme();
  return `<div class="swatches" role="radiogroup" aria-label="Theme">${THEMES.map(([id, name, desc]) => `
    <button type="button" class="swatch ${id === cur ? 'on' : ''}" data-act="theme-set" data-theme-id="${id}" role="radio" aria-checked="${id === cur}" title="${esc(desc)}">
      <span class="swatch-in" data-theme="${id}">
        <span class="sw-name">${esc(name)}</span>
        <span class="sw-row"><span class="sw-box"></span>Task<span class="sw-chip">Today</span></span>
      </span>
    </button>`).join('')}</div>`;
}

// ---------------------------------------------------------------- remote settings (reminders)

const remote = { loading: false, loaded: false, settings: null, push: 'unknown', error: '' };

async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (!CONFIG.vapidPublicKey) return 'unconfigured';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

async function loadRemote() {
  if (remote.loading) return;
  remote.loading = true;
  try {
    remote.push = await pushStatus().catch(() => 'unsupported');
    if (online) {
      const { data, error } = await sb.from('user_settings').select('timezone, email_reminders, push_reminders').maybeSingle();
      if (error) throw error;
      remote.settings = data || { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, email_reminders: true, push_reminders: true };
    }
    remote.error = '';
  } catch (e) {
    remote.error = e.message || String(e);
  } finally {
    remote.loading = false;
    remote.loaded = true;
    rerender();
  }
}

async function saveSetting(field, value) {
  const { error } = await sb.from('user_settings').upsert({ user_id: state.user.id, [field]: value }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  remote.settings = { ...remote.settings, [field]: value };
}

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function swReady() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg?.active) return reg;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, no) => setTimeout(() => no(new Error('The app is still installing. Try again in a moment.')), 8000)),
  ]);
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    remote.push = perm === 'denied' ? 'blocked' : 'off';
    rerender();
    return toast('Notifications were not allowed', 'warn');
  }
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(CONFIG.vapidPublicKey) });
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert(
    { user_id: state.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
    { onConflict: 'endpoint' },
  );
  if (error) { await sub.unsubscribe().catch(() => null); throw new Error(error.message); }
  if (remote.settings && !remote.settings.push_reminders) await saveSetting('push_reminders', true);
  remote.push = 'on';
  toast('Push reminders are on for this device');
  rerender();
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
  remote.push = 'off';
  toast('Push reminders are off for this device');
  rerender();
}

async function testPush() {
  const reg = await swReady();
  await reg.showNotification('Synaptask', { body: 'Notifications work on this device.', icon: 'icons/icon-192.png', tag: 'test' });
}

function remindersCard() {
  if (!online) return '';
  if (!remote.loaded) { loadRemote(); return card('Reminders', '<p class="muted">Loading…</p>'); }
  const s = remote.settings || {};
  const PUSH = {
    unsupported: ['Not available', 'This browser cannot receive push notifications. On iPhone, add Synaptask to the Home Screen first (Share → Add to Home Screen), then open it from there.', ''],
    unconfigured: ['Not set up', 'Push needs a VAPID key in web/js/config.js (see README).', ''],
    blocked: ['Blocked', 'Notifications are blocked for this site in the browser settings.', ''],
    off: ['Off on this device', 'Get a notification when a task is due.', '<button type="button" class="btn primary small" data-act="push-on">Turn on</button>'],
    on: ['On for this device', 'Due tasks show a notification here.', '<button type="button" class="btn small" data-act="push-test">Test</button> <button type="button" class="btn ghost small" data-act="push-off">Turn off</button>'],
    unknown: ['Checking…', '', ''],
  }[remote.push] || ['', '', ''];
  return card('Reminders', `
    <p>Tasks with a due date remind you at their time, or at 09:00 when only a date is set. Work reminders never show the task: only “A work task is due”.</p>
    ${remote.error ? `<div class="notice">${esc(remote.error)}</div>` : ''}
    <div class="setting"><div class="what"><b>Push notifications · ${esc(PUSH[0])}</b><small>${esc(PUSH[1])}</small></div>${PUSH[2]}</div>
    <div class="setting"><div class="what"><b>Push on all my devices</b><small>Master switch for every device where push is on.</small></div>
      <input type="checkbox" data-act="setting-toggle" data-field="push_reminders" ${s.push_reminders ? 'checked' : ''} aria-label="Push reminders"></div>
    <div class="setting"><div class="what"><b>Email reminders</b><small>Also send an email to ${esc(state.user?.email || 'your address')}. Work tasks are never emailed.</small></div>
      <input type="checkbox" data-act="setting-toggle" data-field="email_reminders" ${s.email_reminders ? 'checked' : ''} aria-label="Email reminders"></div>
    <div class="setting"><div class="what"><b>Time zone</b><small>Reminders from Claude use this. It updates when you open the app.</small></div><span class="muted">${esc(s.timezone || '')}</span></div>`);
}

// ---------------------------------------------------------------- cards

const card = (title, inner) => `<section class="panel-card"><h2>${esc(title)}</h2>${inner}</section>`;

function securityCard() {
  const mins = work.autoLockMinutes();
  const opts = [1, 2, 5, 10, 15, 30, 60].map((m) => `<option value="${m}" ${m === mins ? 'selected' : ''}>${m} minute${m === 1 ? '' : 's'}</option>`).join('');
  return card('Work section', `
    <p>Work tasks are encrypted on this device with your work passphrase. Claude can add work tasks; it can read them only while you allow it (see the bar in Work).</p>
    <div class="setting"><div class="what"><b>Lock automatically</b><small>After this long without activity, or when the app was in the background that long.</small></div>
      <select id="autolock" aria-label="Auto-lock">${opts}</select></div>
    ${state.vaultRecord ? `<div class="setting"><div class="what"><b>Work passphrase</b><small>Change it with the current passphrase, or reset it with your recovery key.</small></div>
      <button type="button" class="btn small" data-act="vault-passphrase">Change</button>
      <button type="button" class="btn ghost small" data-act="vault-recover">Use recovery key</button></div>` : ''}
    ${store.workUnlocked() ? `<div class="setting"><div class="what"><b>Unlocked now</b></div><button type="button" class="btn small" data-act="vault-lock">${ICON.lock}Lock now</button></div>` : ''}`);
}

function claudeCard() {
  if (!online) {
    return card('Claude connector', '<p>The connector needs the online version (Supabase). In local mode there is nothing for Claude to connect to.</p>');
  }
  return card('Claude connector', `
    <p>Let Claude add and manage your tasks from any chat. Claude can read and change personal tasks and ideas, and can always <b>add</b> work tasks. To read or change work tasks it asks first: you approve in <i>Work</i>, for up to a day at a time, and can stop it there any time.</p>
    <div class="field"><span>Connector URL</span>
      <div class="inline"><div class="code grow" id="mcp-url">${esc(mcpUrl())}</div><button type="button" class="btn small" data-act="copy-mcp">Copy</button></div></div>
    <b>claude.ai, Claude Desktop and the Claude mobile app</b>
    <ol class="steps">
      <li>On claude.ai open <i>Settings → Connectors → Add custom connector</i>.</li>
      <li>Name it “Synaptask” and paste the URL above.</li>
      <li>Click <i>Connect</i>, sign in to Synaptask, type your authenticator code and approve. The mobile app uses the same connector automatically.</li>
    </ol>
    <b>Claude Code</b>
    <div class="code" style="margin:6px 0">claude mcp add --transport http synaptask ${esc(mcpUrl())}</div>
    <p class="hint">Then run <code>/mcp</code> in Claude Code and pick Synaptask to sign in.</p>`);
}

// ---------------------------------------------------------------- connected apps

const apps = { loading: false, loaded: false, list: [], error: '' };

/** Trusted apps (database) merged with the grants Supabase Auth holds. */
async function loadApps() {
  if (apps.loading) return;
  apps.loading = true;
  try {
    const [trusted, grants] = await Promise.all([
      sb.from('trusted_clients').select('client_id, name, redirect_uri, created_at, updated_at').order('created_at'),
      sb.auth.oauth.listGrants(),
    ]);
    if (trusted.error) throw trusted.error;
    const byId = new Map();
    for (const t of trusted.data || []) byId.set(t.client_id, { id: t.client_id, name: t.name, redirect: t.redirect_uri, since: t.created_at, trusted: true, grant: false });
    for (const g of (grants.error ? [] : grants.data) || []) {
      const id = String(g?.client?.id || '');
      if (!id) continue;
      const row = byId.get(id) || { id, name: g.client.name || '', redirect: '', since: g.granted_at, trusted: false };
      byId.set(id, { ...row, grant: true });
    }
    apps.list = [...byId.values()];
    apps.error = grants.error ? `Could not read the sign-in grants: ${grants.error.message}` : '';
  } catch (e) {
    apps.error = e.message || String(e);
  } finally {
    apps.loading = false;
    apps.loaded = true;
    rerender();
  }
}

async function disconnect(id) {
  const { error } = await sb.from('trusted_clients').delete().eq('client_id', id);
  if (error) throw new Error(error.message);
  const r = await sb.auth.oauth.revokeGrant({ clientId: id });
  if (r.error) toast(`Removed from the trusted list (its access is cut off), but the sign-in grant could not be revoked: ${r.error.message}`, 'warn');
}

function appsCard() {
  if (!online) return '';
  if (!apps.loaded) { loadApps(); return card('Connected apps', '<p class="muted">Loading…</p>'); }
  const where = (r) => { try { const u = new URL(r); return u.protocol === 'http:' ? 'Claude Code on a computer' : u.host; } catch { return 'unknown'; } };
  const rows = apps.list.map((a) => `
    <div class="setting"><div class="what"><b>${esc(a.name || 'Unnamed app')}</b>
      <small>${a.trusted ? `Returns to ${esc(where(a.redirect))} · approved ${esc(fmtDay(a.since))}` : 'Not trusted: it has a sign-in grant but cannot reach any data.'}</small></div>
      <button type="button" class="btn small" data-act="app-disconnect" data-client="${esc(a.id)}">Disconnect</button></div>`).join('');
  return card('Connected apps', `
    <p>Apps you approved on the Synaptask consent page. Only these can reach your data, and only after you typed an authenticator code. Disconnecting cuts an app off immediately.</p>
    ${apps.error ? `<div class="notice">${esc(apps.error)}</div>` : ''}
    ${rows || '<p class="muted">No apps connected.</p>'}
    ${apps.list.length > 1 ? '<div class="inline"><button type="button" class="btn ghost small" data-act="app-disconnect-all">Disconnect all</button></div>' : ''}`);
}

const fmtDay = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };

function dataCard() {
  const n = store.list('tasks').length, i = store.list('ideas').length, c = store.list('categories').length;
  return card('Backup', `
    <p>${n} task${n === 1 ? '' : 's'}, ${i} idea${i === 1 ? '' : 's'}, ${c} categor${c === 1 ? 'y' : 'ies'}. The export is plain JSON; work items stay encrypted inside it.</p>
    <div class="inline">
      <button type="button" class="btn" data-act="export">${ICON.download}Export</button>
      <button type="button" class="btn ghost" data-act="import">Import a backup…</button>
    </div>`);
}

function accountCard() {
  if (!online) return '';
  return card('Account', `
    <div class="setting"><div class="what"><b>${esc(state.user?.email || '')}</b><small>Signed in with password and authenticator app.</small></div>
      <button type="button" class="btn small" data-act="sign-out">Sign out</button></div>`);
}

const aboutCard = () => card('Keyboard', `<p><kbd>/</kbd> search · <kbd>n</kbd> new task · <kbd>Esc</kbd> close a dialog</p>`);

export function renderSettings() {
  const notice = online ? '' : `<div class="notice"><b>Local mode.</b> No server is configured, so everything stays in this browser only:
    no sync, no reminders, no Claude connector. Fill in <code>web/js/config.js</code> to go online (see README).</div>`;
  return `${notice}
    ${card('Theme', swatches())}
    ${remindersCard()}
    ${securityCard()}
    ${claudeCard()}
    ${appsCard()}
    ${dataCard()}
    ${accountCard()}
    ${aboutCard()}`;
}

// ---------------------------------------------------------------- actions

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('That file is too large for a Synaptask backup.');
      const json = JSON.parse(await file.text());
      if (!await confirmDialog('Import this backup? Records with the same id are replaced; nothing is deleted.', 'Import')) return;
      const n = store.importData(json);
      toast(`Imported ${n} record${n === 1 ? '' : 's'}`);
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message, 'error');
    }
  };
  input.click();
}

export const actions = {
  'theme-set': (el) => { setTheme(el.dataset.themeId); rerender(); },
  'push-on': () => enablePush(),
  'push-off': () => disablePush(),
  'push-test': () => testPush(),
  'setting-toggle': async (el) => {
    try {
      await saveSetting(el.dataset.field, el.checked);
      toast('Saved');
    } catch (e) {
      el.checked = !el.checked;
      throw e;
    }
  },
  'vault-passphrase': () => work.openPassphraseChange(false),
  'app-disconnect': async (el) => {
    const a = apps.list.find((x) => x.id === el.dataset.client);
    if (!a || !await confirmDialog(`Disconnect “${a.name || 'this app'}”? It loses access immediately. To use it again, connect it again from Claude.`, 'Disconnect')) return;
    try { await disconnect(a.id); toast('Disconnected'); } finally { apps.loaded = false; rerender(); }
  },
  'app-disconnect-all': async () => {
    if (!await confirmDialog('Disconnect every app? Claude loses access everywhere until you connect it again.', 'Disconnect all')) return;
    try { for (const a of apps.list) await disconnect(a.id); toast('All apps disconnected'); } finally { apps.loaded = false; rerender(); }
  },
  'copy-mcp': async () => {
    try { await navigator.clipboard.writeText(mcpUrl()); toast('Copied'); } catch { toast('Select the URL and copy it', 'warn'); }
  },
  export: () => {
    downloadText(`synaptask-backup-${today()}.json`, JSON.stringify(store.exportData(), null, 2));
  },
  import: () => importBackup(),
  'sign-out': async () => {
    const waiting = store.pendingCount();
    const msg = waiting
      ? `${waiting} change(s) have not reached the server yet and will be lost. Sign out anyway?`
      : 'Sign out? Synaptask data cached on this device is removed.';
    if (!await confirmDialog(msg, 'Sign out')) return;
    store.clearLocal();
    await signOut();
    location.replace(location.pathname);
  },
};

// The auto-lock <select> fires `change`, not `click`.
document.addEventListener('change', (e) => {
  if (e.target.id === 'autolock') {
    ls.set('synaptask:autolock', Number(e.target.value));
    work.armAutoLock();
    toast('Saved');
  }
});

// ---------------------------------------------------------------- categories

const UP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

/** Rename, recolour, reorder, add and delete the categories of one space ('personal' or 'work'). */
export function openCategoryManager(space = 'personal') {
  if (space === 'work' && !store.workUnlocked()) return toast('Unlock the Work section first', 'warn');
  let rows = [...store.list('categories', space)]
    .sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name, color: safeColor(c.color), orig: c }));
  let palette = -1;

  const rowHtml = (r, i) => `<li>
    <div class="cat-row">
      <button type="button" class="cat-color" data-dact="cat-palette" data-i="${i}" style="background:${safeColor(r.color)}" aria-label="Change colour" aria-expanded="${palette === i}"></button>
      <input type="text" class="cat-name" data-i="${i}" maxlength="100" value="${esc(r.name)}" aria-label="Category name">
      <button type="button" class="icon-btn" data-dact="cat-up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${UP}</button>
      <button type="button" class="icon-btn" data-dact="cat-down" data-i="${i}" aria-label="Move down" ${i === rows.length - 1 ? 'disabled' : ''}>${DOWN}</button>
      <button type="button" class="icon-btn" data-dact="cat-del" data-i="${i}" aria-label="Delete category">${ICON.x}</button>
    </div>
    ${palette === i ? `<div class="palette">${PALETTE.map((p) => `<button type="button" data-dact="cat-color" data-i="${i}" data-color="${p}" class="${p === r.color ? 'on' : ''}" style="background:${p}" aria-label="Colour ${p}"></button>`).join('')}</div>` : ''}
  </li>`;

  const form = openDialog(`
    <header class="dlg-head"><h2>${space === 'work' ? 'Work categories' : 'Categories'}</h2>
      <button type="button" class="icon-btn" data-dact="close" aria-label="Close">${ICON.x}</button></header>
    <div class="dlg-body">
      <ul class="cat-list" data-cats></ul>
      <span class="inline"><input type="text" id="cat-new" maxlength="100" placeholder="New category…" aria-label="New category"><button type="button" class="btn ghost" data-dact="cat-add">Add</button></span>
    </div>
    <footer class="dlg-foot"><span class="grow"></span>
      <button type="button" class="btn ghost" data-dact="close">Cancel</button><button class="btn primary">Save</button></footer>`, {
    onSubmit: async () => {
      readNames();
      addPending();
      for (const [i, r] of rows.entries()) {
        const name = r.name.trim();
        if (!r.id) {
          if (name) await store.save('categories', { name, color: r.color, position: i }, space);
        } else if (name !== r.orig.name || r.color !== r.orig.color || i !== r.orig.position) {
          await store.save('categories', { ...r.orig, name: name || r.orig.name, color: r.color, position: i }, space);
        }
      }
    },
    onAction: async (name, el) => {
      const i = Number(el.dataset.i);
      readNames();
      if (name === 'cat-add') { addPending(); draw(); form.querySelector('#cat-new').focus(); return; }
      if (name === 'cat-palette') palette = palette === i ? -1 : i;
      if (name === 'cat-color') { rows[i].color = el.dataset.color; palette = -1; }
      if (name === 'cat-up' && i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; palette = -1; }
      if (name === 'cat-down' && i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; palette = -1; }
      if (name === 'cat-del') {
        const r = rows[i];
        if (r.id) {
          const where = space === 'work' ? 'Work → All' : 'the Inbox';
          if (!await confirmDialog(`Delete “${r.orig.name}”? Its tasks move to ${where}.`)) return;
          await store.remove('categories', r.id);
        }
        rows.splice(i, 1);
        palette = -1;
      }
      draw();
    },
  });

  function readNames() {
    form.querySelectorAll('.cat-name').forEach((inp) => { const r = rows[Number(inp.dataset.i)]; if (r) r.name = inp.value; });
  }
  function addPending() {
    const inp = form.querySelector('#cat-new');
    const v = inp.value.trim();
    if (!v) return;
    const used = new Set(rows.map((r) => r.color));
    const color = PALETTE.find((p) => !used.has(p)) || PALETTE[rows.length % PALETTE.length];
    rows.push({ id: null, name: v, color, orig: null });
    inp.value = '';
  }
  function draw() { form.querySelector('[data-cats]').innerHTML = rows.map(rowHtml).join('') || '<li class="muted">No categories yet.</li>'; }
  form.querySelector('#cat-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); readNames(); addPending(); draw(); }
  });
  draw();
}
