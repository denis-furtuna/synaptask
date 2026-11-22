// Boot, the app shell, routing and all delegated event handling.
import { online, sb } from './backend.js';
import * as store from './store.js';
import { state, parseRoute, flushDialog } from './app.js';
import { $, esc, bus, toast, ICON, safeColor, today, fmtLongDate } from './util.js';
import * as tasks from './tasks.js';
import * as ideas from './ideas.js';
import * as shopping from './shopping.js';
import * as work from './work.js';
import * as settings from './settings.js';
import * as auth from './auth.js';

const root = $('#app');
let booted = false;
let installPrompt = null;

// ---------------------------------------------------------------- shell

function sortedCats(space = 'personal') {
  return [...store.list('categories', space)].sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name));
}

function counts() {
  const t0 = today();
  const open = store.list('tasks').filter((t) => !t.completed_at);
  const byCat = new Map();
  for (const t of open) if (t.category_id) byCat.set(t.category_id, (byCat.get(t.category_id) || 0) + 1);
  return {
    today: open.filter((t) => t.due_date && t.due_date <= t0).length,
    upcoming: open.filter((t) => t.due_date && t.due_date > t0).length,
    inbox: open.filter((t) => !t.category_id).length,
    all: open.length,
    ideas: store.list('ideas').filter((i) => i.stage !== 'done').length,
    byCat,
  };
}

const SYNC_LABEL = {
  local: 'Local mode · this browser only',
  idle: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline · changes are kept',
  error: 'Sync problem · will retry',
};
function syncHtml() {
  const s = store.syncState;
  const waiting = s !== 'local' ? store.pendingCount() : 0;
  const label = SYNC_LABEL[s] + (waiting && s !== 'syncing' ? ` · ${waiting} waiting` : '');
  return `<div id="sync-status" class="sync ${s}">${online && s !== 'syncing'
    ? `<button type="button" class="link-btn" data-act="sync-now" style="padding:0;font-size:12px;color:inherit;text-decoration:none">${esc(label)}</button>`
    : esc(label)}</div>`;
}

function navLink(href, icon, label, count, on) {
  return `<a class="nav ${on ? 'on' : ''}" href="${href}" ${on ? 'aria-current="page"' : ''}>${icon}<span class="label">${esc(label)}</span>${count ? `<small>${count}</small>` : ''}</a>`;
}

function sidebar(route) {
  const c = counts();
  const v = route.view;
  const cats = sortedCats().map((cat) => `<a class="nav ${v === 'cat' && route.id === cat.id ? 'on' : ''}" href="#/cat/${esc(cat.id)}">
      <i class="dot" style="background:${safeColor(cat.color)}"></i><span class="label">${esc(cat.name)}</span>${c.byCat.get(cat.id) ? `<small>${c.byCat.get(cat.id)}</small>` : ''}</a>`).join('');
  const workCount = store.workUnlocked() ? store.list('tasks', 'work').filter((t) => !t.completed_at).length : 0;
  return `<aside class="side" id="side" aria-label="Navigation">
    <div class="brand">${ICON.logo}<span>synap<i>task</i></span></div>
    ${navLink('#/today', ICON.today, 'Today', c.today, v === 'today')}
    ${navLink('#/upcoming', ICON.upcoming, 'Upcoming', c.upcoming, v === 'upcoming')}
    ${navLink('#/inbox', ICON.inbox, 'Inbox', c.inbox, v === 'inbox')}
    ${navLink('#/all', ICON.all, 'All tasks', c.all, v === 'all')}
    ${navLink('#/ideas', ICON.idea, 'Project ideas', c.ideas, v === 'ideas')}
    ${navLink('#/shopping', ICON.cart, 'Shopping list', shopping.toBuyCount(), v === 'shopping')}
    <div class="nav-h"><span>Categories</span><button type="button" data-act="cats-manage" data-space="personal">Edit</button></div>
    ${cats || '<div class="nav muted" style="font-size:13px">No categories yet</div>'}
    <div class="nav-h"><span>Locked</span></div>
    <a class="nav ${v === 'work' ? 'on' : ''}" href="#/work">${store.workUnlocked() ? ICON.unlock : ICON.lock}<span class="label">Work</span>${work.claudeAsking() ? '<span class="chip claude">Claude asks</span>' : workCount ? `<small>${workCount}</small>` : ''}</a>
    <div class="nav-h"></div>
    ${navLink('#/settings', ICON.gear, 'Settings', 0, v === 'settings')}
    ${installPrompt ? `<button type="button" class="nav" data-act="install" style="background:none;border:0;width:100%;cursor:pointer;font:inherit">${ICON.download}<span class="label">Install app</span></button>` : ''}
    <div class="side-foot">
      ${syncHtml()}
      ${state.user?.email ? `<div class="who" title="${esc(state.user.email)}">${esc(state.user.email)}</div>` : ''}
    </div>
  </aside>`;
}

const EMPTY = {
  today: 'Nothing due today. Clean mind.',
  upcoming: 'Nothing scheduled after today.',
  inbox: 'Inbox zero. Tasks without a category land here.',
  cat: 'No tasks in this category yet.',
  all: 'No tasks yet. Add your first one above.',
};

function page(route) {
  const searching = !!state.search.trim();
  let title, sub = '', body, actions = '', wide = false, showSearch = true;
  switch (route.view) {
    case 'ideas':
      title = 'Project ideas';
      sub = searching ? `Ideas matching “${state.search.trim()}”` : 'Idea → Planning → Building → Done. Drag cards between stages.';
      body = ideas.renderIdeas(state.search);
      wide = true;
      break;
    case 'shopping': {
      ({ title, sub } = shopping.viewTitle(route));
      if (searching) sub = `Items matching “${state.search.trim()}”`;
      body = shopping.renderShopping(route, state.search);
      break;
    }
    case 'settings':
      title = 'Settings';
      body = settings.renderSettings();
      showSearch = false;
      break;
    case 'work': {
      const open = state.vaultRecord && store.workUnlocked();
      if (open) {
        const vm = tasks.viewModel(route);
        title = vm.title; sub = vm.sub;
        actions = `<button type="button" class="btn small" data-act="vault-lock">${ICON.lock}Lock</button>`;
      } else {
        title = 'Work'; sub = 'End-to-end encrypted';
        showSearch = false;
      }
      body = work.renderWork(route);
      break;
    }
    default: {
      const vm = tasks.viewModel(route);
      title = vm.title; sub = vm.sub;
      if (route.view === 'today' && !searching) sub = `${fmtLongDate()} · ${vm.open.length} open`;
      if (route.view === 'cat' && !searching) {
        actions = `<button type="button" class="btn small ghost" data-act="cats-manage" data-space="personal">Edit categories</button>`;
      }
      body = tasks.renderTasks(vm, searching ? 'No tasks match your search.' : EMPTY[route.view] || EMPTY.all);
    }
  }
  const search = showSearch ? `<label class="search">${ICON.search}<span class="sr-only">Search</span>
      <input id="search" type="search" placeholder="Search" value="${esc(state.search)}" autocomplete="off" enterkeyhint="search"></label>` : '';
  return `<main class="main ${wide ? 'wide' : ''}" id="main">
    <header class="top">
      <button type="button" class="icon-btn menu" data-act="nav-toggle" aria-label="Menu" aria-controls="side" aria-expanded="${state.navOpen}">${ICON.menu}</button>
      <div class="titles"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
      ${actions}${search}
    </header>
    <div class="content">${body}</div>
  </main>`;
}

// ---------------------------------------------------------------- render

/** Remember focus, caret and typed text so a re-render does not interrupt typing. */
function snapshot() {
  const a = document.activeElement;
  const values = {};
  root.querySelectorAll('input[id], textarea[id]').forEach((el) => {
    if (el.id !== 'search' && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file') values[el.id] = el.value;
  });
  let sel = null;
  try { sel = a && a.id && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null; } catch { /* e.g. type=email */ }
  return { id: a && root.contains(a) ? a.id : null, sel, values, y: window.scrollY, board: $('.board')?.scrollLeft || 0 };
}

function restore(snap) {
  for (const [id, v] of Object.entries(snap.values)) {
    const el = document.getElementById(id);
    if (el && root.contains(el) && !el.value) el.value = v;
  }
  if (snap.id) {
    const el = document.getElementById(snap.id);
    if (el && root.contains(el)) {
      el.focus({ preventScroll: true });
      if (snap.sel) { try { el.setSelectionRange(snap.sel[0], snap.sel[1]); } catch { /* not a text field */ } }
    }
  }
  const board = $('.board');
  if (board) board.scrollLeft = snap.board;
  window.scrollTo(0, snap.y);
}

function render() {
  if (!booted) return;
  const snap = snapshot();
  document.body.classList.toggle('nav-open', state.navOpen);
  root.innerHTML = `<div class="shell">${sidebar(state.route)}<div class="scrim" data-act="nav-close"></div>${page(state.route)}</div>`;
  restore(snap);
}

let queued = false;
function scheduleRender() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
}

// ---------------------------------------------------------------- actions

const ACTIONS = {
  ...tasks.actions,
  ...ideas.actions,
  ...shopping.actions,
  ...work.actions,
  ...settings.actions,
  'task-new': () => {
    const { ctx } = tasks.viewModel(state.route);
    tasks.openTaskEditor({ _space: ctx.space, category_id: ctx.category_id, due_date: ctx.due_date });
  },
  'cats-manage': (el) => {
    if (state.navOpen) { state.navOpen = false; render(); }
    settings.openCategoryManager(el.dataset.space || 'personal', el.dataset.table || 'categories');
  },
  'nav-toggle': () => { state.navOpen = !state.navOpen; render(); },
  'nav-close': () => { state.navOpen = false; render(); },
  'sync-now': () => store.sync(),
  install: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    render();
  },
};

const FORMS = {
  'quick-task': async (fd, form) => {
    const input = form.elements.title;
    const title = String(fd.get('title') || '');
    if (!title.trim()) return;
    input.value = '';
    await tasks.quickAdd(title, tasks.viewModel(state.route).ctx);
  },
  'quick-idea': async (fd, form) => {
    const title = String(fd.get('title') || '');
    if (!title.trim()) return;
    form.elements.title.value = '';
    await ideas.quickAddIdea(title);
  },
  'quick-shop': (fd, form) => shopping.quickAdd(fd, form),
  ...work.forms,
};

async function run(fn, ...args) {
  try {
    await fn(...args);
  } catch (e) {
    console.error(e);
    toast(e?.message || 'Something went wrong', 'error');
  }
}

function wireEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return; // dialogs use data-dact and handle their own clicks
    const fn = ACTIONS[el.dataset.act];
    if (fn) run(fn, el, e);
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form || !root.contains(form)) return;
    e.preventDefault();
    const fn = FORMS[form.dataset.form];
    if (fn) run(fn, new FormData(form), form);
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { state.search = e.target.value; scheduleRender(); }
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    // role="button" elements behave like buttons for the keyboard
    if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('[role="button"][data-act]') && root.contains(t)) {
      e.preventDefault();
      t.click();
      return;
    }
    if (e.key === 'Escape' && state.navOpen) { state.navOpen = false; render(); return; }
    const typing = t.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]');
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { const s = $('#search'); if (s) { e.preventDefault(); s.focus(); } }
    if (e.key === 'n') { const q = $('#quick-input'); if (q) { e.preventDefault(); q.focus(); } }
  });

  // Any interaction keeps the Work section open; idleness locks it.
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(evt, () => work.armAutoLock(), { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    work.onVisibility();
    if (!document.hidden) { store.sync(); work.refreshAccess(); checkForUpdate(); }
  });

  window.addEventListener('hashchange', () => {
    const prev = state.route.view;
    state.route = parseRoute();
    state.navOpen = false;
    if (prev !== state.route.view) state.search = '';
    if (state.route.view === 'work' && !state.vaultRecord) refreshVaultRecord();
    if (state.route.view === 'work') work.refreshAccess(true);
    render();
    window.scrollTo(0, 0);
  });

  // Drag idea cards between stages (desktop; on touch screens use the Stage field in the editor).
  let dragId = null;
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.idea-card');
    if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    card.classList.add('dragging');
  });
  document.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging, .col.drop').forEach((el) => el.classList.remove('dragging', 'drop'));
  });
  document.addEventListener('dragover', (e) => {
    const col = e.target.closest?.('.col[data-stage]');
    if (!col || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
    col.classList.add('drop');
  });
  document.addEventListener('drop', (e) => {
    const col = e.target.closest?.('.col[data-stage]');
    if (!col || !dragId) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    col.classList.remove('drop');
    run(ideas.moveIdea, id, col.dataset.stage);
  });

  bus.on('render', scheduleRender);
  bus.on('change', scheduleRender);
  bus.on('sync', () => {
    const el = $('#sync-status');
    if (el) el.outerHTML = syncHtml(); else scheduleRender();
  });
  bus.on('storage-full', () => toast('This device is out of storage space for Synaptask.', 'error'));
  bus.on('vault-unreadable', (n) => toast(`${n} work item(s) could not be decrypted.`, 'warn'));
  bus.on('inbox-imported', (n) => toast(`${n} work task${n === 1 ? '' : 's'} from Claude added`));
  bus.on('sync-rejected', (n) => toast(`${n} change${n === 1 ? ' was' : 's were'} rejected by the server and kept only on this device.`, 'warn'));

  window.addEventListener('focus', () => store.sync());
  window.addEventListener('online', () => store.sync());
  window.addEventListener('offline', () => store.sync());
  setInterval(() => { if (!document.hidden) store.sync(); }, 60000);
  // Midnight: "Today" and overdue labels change.
  let day = today();
  setInterval(() => { if (today() !== day) { day = today(); scheduleRender(); } }, 30000);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  scheduleRender();
});
window.addEventListener('appinstalled', () => { installPrompt = null; scheduleRender(); });

// ---------------------------------------------------------------- boot

let vaultFetchedAt = 0;
async function refreshVaultRecord() {
  if (Date.now() - vaultFetchedAt < 5000) return;
  vaultFetchedAt = Date.now();
  state.vaultRecord = await store.loadVaultRecord();
  state.vaultLoaded = true;
  scheduleRender();
}

async function saveTimezone(userId) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const k = `synaptask:${userId}:tz`;
  try { if (localStorage.getItem(k) === tz) return; } catch { /* ignore */ }
  const { error } = await sb.from('user_settings').upsert({ user_id: userId, timezone: tz }, { onConflict: 'user_id' });
  if (!error) { try { localStorage.setItem(k, tz); } catch { /* ignore */ } }
}

/** The OAuth consent page sends signed-out users here and asks to be returned to afterwards. */
function returnToConsent() {
  let back = null;
  try { back = sessionStorage.getItem('synaptask:returnTo'); sessionStorage.removeItem('synaptask:returnTo'); } catch { /* ignore */ }
  if (!back) return false;
  try {
    const u = new URL(back, location.href);
    if (u.origin === location.origin && u.pathname.endsWith('/consent.html')) { location.replace(u.href); return true; }
  } catch { /* ignore malformed */ }
  return false;
}

// ---------------------------------------------------------------- app updates

let swReg = null;
let lastUpdateCheck = 0;
let reloadPending = false;

/** Ask the browser to look for a new sw.js (at most once a minute). */
function checkForUpdate() {
  if (reloadPending && !document.hidden) return reloadIfSafe();
  if (!swReg || Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  swReg.update().catch(() => null);
}

/** Reload into the new version, unless that would interrupt something; then wait for a calmer moment. */
async function reloadIfSafe() {
  const a = document.activeElement;
  const typing = a && a.matches?.('input, textarea') && a.value && a.type !== 'checkbox' && a.type !== 'search';
  const busy = document.querySelector('dialog[open]') || typing || !booted;
  if (busy) {
    if (!reloadPending) toast('Synaptask was updated. It reloads the next time you come back to it.');
    reloadPending = true;
    return;
  }
  await flushDialog().catch(() => null);
  location.reload();
}

function watchForUpdates() {
  const sw = navigator.serviceWorker;
  const updating = !!sw.controller; // no controller yet = first install, not an update
  sw.register('sw.js').then((reg) => { swReg = reg; lastUpdateCheck = Date.now(); }).catch((e) => console.warn('service worker', e));
  if (updating) sw.addEventListener('controllerchange', () => { reloadIfSafe(); });
  setInterval(checkForUpdate, 30 * 60000); // tabs and installed apps that stay open for days
}

async function boot() {
  if ('serviceWorker' in navigator) watchForUpdates();

  if (online) {
    state.user = await auth.ensureSignedIn(root);
    if (returnToConsent()) return;
    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { store.clearLocal(); location.replace(location.pathname); }
    });
  }

  store.init(state.user?.id);
  state.route = parseRoute();
  settings.setTheme(document.documentElement.dataset.theme); // sync the browser's theme-color
  booted = true;
  wireEvents();
  render();

  await refreshVaultRecord();
  if (online) {
    store.sync();
    saveTimezone(state.user.id).catch(() => null);
    work.refreshAccess(true);
  }
}

boot().catch((e) => {
  console.error(e);
  root.innerHTML = `<div class="auth"><div class="auth-card"><h2>Synaptask could not start</h2><p>${esc(e?.message || e)}</p>
    <button class="btn primary" type="button" id="reload">Reload</button></div></div>`;
  $('#reload').onclick = () => location.reload();
});
