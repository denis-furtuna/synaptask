// The Work section: a passphrase-locked, end-to-end encrypted space.
import * as store from './store.js';
import * as vault from './vault.js';
import { state, openDialog, closeDialog, flushDialog, rerender } from './app.js';
import { esc, toast, ls, ICON, safeColor, ymd, today } from './util.js';
import { viewModel, renderTasks, taskLayout } from './tasks.js';

// ---------------------------------------------------------------- Claude access (time-limited grants)

const DURATIONS = [['60', '1 hour'], ['120', '2 hours'], ['240', '4 hours'], ['480', '8 hours'], ['eod', 'Until midnight']];
const access = { until: null, requestedAt: null, at: 0, loading: false };

/** Re-read whether Claude has access or is asking for it (at most every 15 s unless forced). */
export async function refreshAccess(force = false) {
  if (!store.claudeAccessAvailable() || access.loading) return;
  if (!force && Date.now() - access.at < 15000) return;
  access.loading = true;
  try {
    Object.assign(access, await store.loadClaudeAccess());
  } catch (e) {
    console.warn('claude access', e);
  } finally {
    access.at = Date.now();
    access.loading = false;
    rerender();
  }
}
const claudeActive = () => !!access.until && Date.parse(access.until) > Date.now();
/** Claude asked within the last 30 minutes and has no access yet. */
export const claudeAsking = () => !claudeActive() && !!access.requestedAt && Date.now() - Date.parse(access.requestedAt) < 30 * 60000;

function fmtUntil(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return ymd(d) === today() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

function expiryFor(choice) {
  if (choice === 'eod') {
    const d = new Date();
    d.setHours(23, 59, 0, 0);
    if (d.getTime() - Date.now() >= 5 * 60000) return d.toISOString();
    choice = '60';
  }
  return new Date(Date.now() + Number(choice || 120) * 60000).toISOString();
}

function claudeBar() {
  if (!store.claudeAccessAvailable()) return '';
  if (claudeActive()) {
    return `<div class="claude-bar on" role="status"><span class="grow">Claude can read and change your work tasks until <b>${esc(fmtUntil(access.until))}</b>.</span>
      <button type="button" class="btn small" data-act="claude-revoke">Stop now</button></div>`;
  }
  const asking = claudeAsking();
  const pick = ls.get('synaptask:claude-for', '120');
  return `<div class="claude-bar ${asking ? 'ask' : ''}">
    <span class="grow">${asking ? '<b>Claude is asking to use your Work section.</b>' : 'Claude can add work tasks but not read them.'}</span>
    <select id="claude-for" aria-label="For how long">${DURATIONS.map(([v, l]) => `<option value="${v}" ${v === pick ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${asking ? '<button type="button" class="btn small ghost" data-act="claude-deny">Deny</button>' : ''}
    <button type="button" class="btn small ${asking ? 'primary' : ''}" data-act="claude-allow">${asking ? 'Allow' : 'Let Claude in'}</button>
  </div>`;
}

function lockedNotice() {
  if (!store.claudeAccessAvailable()) return '';
  if (claudeActive()) {
    return `<div class="claude-bar on"><span class="grow">Claude has access to Work until <b>${esc(fmtUntil(access.until))}</b>.</span>
      <button type="button" class="btn small" data-act="claude-revoke">Stop now</button></div>`;
  }
  return claudeAsking() ? '<div class="claude-bar ask"><span class="grow"><b>Claude is asking to use your Work section.</b> Unlock to allow or deny.</span></div>' : '';
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'claude-for') ls.set('synaptask:claude-for', e.target.value);
});

let idleTimer = null;
let hiddenAt = 0;
export const autoLockMinutes = () => Number(ls.get('synaptask:autolock', 5)) || 5;

/** Lock automatically after a period without any interaction, or when the tab was hidden that long. */
export function armAutoLock() {
  clearTimeout(idleTimer);
  if (!store.workUnlocked()) return;
  idleTimer = setTimeout(() => { lockNow(); toast('Work section locked after inactivity'); }, autoLockMinutes() * 60000);
}
export function onVisibility() {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (store.workUnlocked() && hiddenAt && Date.now() - hiddenAt > autoLockMinutes() * 60000) {
    lockNow();
    toast('Work section locked while you were away');
  }
  hiddenAt = 0;
}
export async function lockNow() {
  clearTimeout(idleTimer);
  // An open work task is saved (encrypted) before the key goes, then its plaintext leaves the screen.
  if (document.querySelector('#dlg [data-work-editor]')) {
    await flushDialog().catch(() => null);
    closeDialog();
  }
  store.lockWork();
}

async function unlocked() {
  await store.openWork();
  armAutoLock();
  rerender();
}

export function renderWork(route) {
  if (!state.vaultLoaded) return '<div class="empty">Loading…</div>';

  if (!state.vaultRecord) {
    return `<div class="gate">
      <div class="gate-icon">${ICON.lock}</div>
      <h2>Set up your Work section</h2>
      <p>Work tasks are encrypted on this device with a passphrase only you know. Nobody else can read them:
         not the hosting provider, not someone who gets into your account, and not Claude unless you let it in for a while.</p>
      <form data-form="vault-create" class="gate-form" autocomplete="off">
        <label class="field"><span>Work passphrase</span><input type="password" name="p1" autocomplete="new-password" minlength="12"></label>
        <label class="field"><span>Repeat passphrase</span><input type="password" name="p2" autocomplete="new-password"></label>
        <button class="btn primary">Create Work section</button>
      </form>
      <p class="hint">Use something different from your account password. If you forget it, only the recovery key shown on the next step can get your work tasks back.</p>
    </div>`;
  }

  refreshAccess();

  if (!store.workUnlocked()) {
    return `${lockedNotice()}<div class="gate">
      <div class="gate-icon">${ICON.lock}</div>
      <h2>Work section is locked</h2>
      <form data-form="vault-unlock" class="gate-form" autocomplete="off">
        <label class="field"><span>Work passphrase</span><input type="password" name="p" id="vault-pass" autocomplete="off"></label>
        <button class="btn primary">Unlock</button>
      </form>
      <button type="button" class="link-btn" data-act="vault-recover">Forgot the passphrase? Use your recovery key</button>
    </div>`;
  }

  const vm = viewModel(route);
  const cats = vm.cats;
  const chips = `<nav class="pillbar">
      <a class="pill ${route.id ? '' : 'on'}" href="#/work">All</a>
      ${cats.map((c) => `<a class="pill ${route.id === c.id ? 'on' : ''}" href="#/work/cat/${esc(c.id)}"><i class="dot" style="background:${safeColor(c.color)}"></i>${esc(c.name)}</a>`).join('')}
      <button type="button" class="pill dashed" data-act="cats-manage" data-space="work">Edit categories</button>
    </nav>`;
  return claudeBar() + chips + renderTasks(vm, 'No work tasks yet. Add one above, or ask Claude to send one here.', state.search.trim() ? 'list' : taskLayout());
}

export const forms = {
  'vault-create': async (fd) => {
    const p1 = String(fd.get('p1')), p2 = String(fd.get('p2'));
    const problem = vault.passphraseProblem(p1);
    if (problem) return toast(problem, 'warn');
    if (p1 !== p2) return toast('The two passphrases do not match', 'warn');
    const existing = await store.loadVaultRecord(); // set up on another device meanwhile?
    if (existing) {
      state.vaultRecord = existing;
      rerender();
      return toast('Your Work section was already set up on another device. Unlock it with that passphrase.', 'warn');
    }
    toast('Creating encryption keys…');
    const { record, recoveryKey } = await vault.create(p1);
    try {
      await store.saveVaultRecord(record, { create: true });
    } catch (e) {
      vault.lock();
      return toast(`Could not save the vault: ${e.message}`, 'error');
    }
    state.vaultRecord = record;
    await unlocked();
    showRecoveryKey(recoveryKey);
  },
  'vault-unlock': async (fd, form) => {
    const btn = form.querySelector('button');
    btn.disabled = true;
    const ok = await vault.unlock(state.vaultRecord, String(fd.get('p')));
    btn.disabled = false;
    if (!ok) {
      form.reset();
      return toast('Wrong passphrase', 'error');
    }
    await unlocked();
  },
};

export const actions = {
  'claude-allow': async () => {
    const choice = document.getElementById('claude-for')?.value || '120';
    await store.grantClaude(expiryFor(choice));
    access.requestedAt = null;
    await refreshAccess(true);
    toast(`Claude can use Work until ${fmtUntil(access.until || expiryFor(choice))}`);
  },
  'claude-revoke': async () => {
    await store.revokeClaude();
    access.until = null;
    await refreshAccess(true);
    toast('Claude no longer has access to Work');
  },
  'claude-deny': async () => {
    await store.denyClaude();
    access.requestedAt = null;
    await refreshAccess(true);
    toast('Request denied');
  },
  'vault-lock': () => { lockNow(); toast('Work section locked'); },
  'vault-recover': () => openPassphraseChange(true),
};

function showRecoveryKey(key) {
  openDialog(`
    <header class="dlg-head"><h2>Save your recovery key</h2></header>
    <div class="dlg-body">
      <p>This is the <strong>only</strong> way back into your Work section if you forget the passphrase. It is shown once. Write it down or keep it in a password manager, not in this app.</p>
      <div class="recovery">${esc(key)}</div>
      <label class="check-line"><input type="checkbox" name="saved"><span>I have saved this key somewhere safe</span></label>
    </div>
    <footer class="dlg-foot"><span class="grow"></span><button class="btn primary">Done</button></footer>`, {
    onSubmit: (fd) => {
      if (!fd.get('saved')) { toast('Tick the box once you have saved the key', 'warn'); return false; }
      return true;
    },
  });
}

/** Change the work passphrase, using either the current passphrase or the recovery key. */
export function openPassphraseChange(useRecovery = false) {
  openDialog(`
    <header class="dlg-head"><h2>${useRecovery ? 'Reset work passphrase' : 'Change work passphrase'}</h2>
      <button type="button" class="icon-btn" data-dact="close" aria-label="Close">${ICON.x}</button></header>
    <div class="dlg-body">
      <label class="field"><span>${useRecovery ? 'Recovery key' : 'Current passphrase'}</span>
        <input ${useRecovery ? 'type="text" placeholder="xxxx-xxxx-…"' : 'type="password"'} name="old" autocomplete="off" autofocus></label>
      <label class="field"><span>New passphrase</span><input type="password" name="p1" autocomplete="new-password"></label>
      <label class="field"><span>Repeat new passphrase</span><input type="password" name="p2" autocomplete="new-password"></label>
    </div>
    <footer class="dlg-foot"><span class="grow"></span>
      <button type="button" class="btn ghost" data-dact="close">Cancel</button><button class="btn primary">Save</button></footer>`, {
    onSubmit: async (fd) => {
      const p1 = String(fd.get('p1'));
      const problem = vault.passphraseProblem(p1);
      if (problem) { toast(problem, 'warn'); return false; }
      if (p1 !== String(fd.get('p2'))) { toast('The two passphrases do not match', 'warn'); return false; }
      const old = String(fd.get('old'));
      const wasUnlocked = store.workUnlocked();
      const next = await vault.rewrap(state.vaultRecord, useRecovery ? { recoveryKey: old } : { passphrase: old }, p1);
      if (!next) { toast(useRecovery ? 'That recovery key is not right' : 'Wrong current passphrase', 'error'); return false; }
      try {
        await store.saveVaultRecord(next);
      } catch (e) {
        if (!wasUnlocked) vault.lock();
        toast(`Could not save: ${e.message}`, 'error');
        return false;
      }
      state.vaultRecord = next;
      toast('Work passphrase updated');
      await unlocked();
      return true;
    },
  });
}
