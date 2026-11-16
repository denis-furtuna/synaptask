// The Work section: a passphrase-locked, end-to-end encrypted space.
import * as store from './store.js';
import * as vault from './vault.js';
import { state, openDialog, rerender } from './app.js';
import { esc, toast, ls, ICON, safeColor } from './util.js';
import { viewModel, renderTasks } from './tasks.js';

let idleTimer = null;
let hiddenAt = 0;
export const autoLockMinutes = () => Number(ls.get('mynotes:autolock', 5)) || 5;

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
export function lockNow() {
  clearTimeout(idleTimer);
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
         not the hosting provider, not Claude, not someone who gets into your account.</p>
      <form data-form="vault-create" class="gate-form" autocomplete="off">
        <label class="field"><span>Work passphrase</span><input type="password" name="p1" autocomplete="new-password" minlength="12"></label>
        <label class="field"><span>Repeat passphrase</span><input type="password" name="p2" autocomplete="new-password"></label>
        <button class="btn primary">Create Work section</button>
      </form>
      <p class="hint">Use something different from your account password. If you forget it, only the recovery key shown on the next step can get your work tasks back.</p>
    </div>`;
  }

  if (!store.workUnlocked()) {
    return `<div class="gate">
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
  return chips + renderTasks(vm, 'No work tasks yet. Add one above, or ask Claude to send one here.');
}

export const forms = {
  'vault-create': async (fd) => {
    const p1 = String(fd.get('p1')), p2 = String(fd.get('p2'));
    const problem = vault.passphraseProblem(p1);
    if (problem) return toast(problem, 'warn');
    if (p1 !== p2) return toast('The two passphrases do not match', 'warn');
    toast('Creating encryption keys…');
    const { record, recoveryKey } = await vault.create(p1);
    try {
      await store.saveVaultRecord(record);
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
