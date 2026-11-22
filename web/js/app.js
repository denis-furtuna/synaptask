// Shared UI state, routing and the dialog helper.
import { $, bus, toast } from './util.js';

export const state = {
  route: { view: 'today' },
  search: '',
  showDone: false,
  expanded: new Set(),  // task ids whose subtasks are shown inline
  showBought: false,    // shopping list: show the bought items
  navOpen: false,
  user: null,
  vaultRecord: null,
  vaultLoaded: false,
};

export function parseRoute(hash = location.hash) {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'cat' && p[1]) return { view: 'cat', id: p[1] };
  if (p[0] === 'work') return { view: 'work', id: p[1] === 'cat' ? p[2] || null : null };
  if (p[0] === 'shopping') return p[1] === 'project' ? { view: 'shopping', id: null, idea: p[2] || null } : { view: 'shopping', id: p[1] || null };
  if (['today', 'upcoming', 'inbox', 'all', 'ideas', 'settings'].includes(p[0])) return { view: p[0] };
  return { view: 'today' };
}

export function go(hash) {
  if (location.hash === hash) bus.emit('render'); else location.hash = hash;
}

export const rerender = () => bus.emit('render');

// Autosave of the open dialog: `flushCurrent()` saves pending edits right away (it reads the form
// synchronously, so it is safe to call just before the dialog is cleared).
let flushCurrent = null;
const AUTOSAVE_MS = 700;

/** Save the open dialog's pending edits now. Resolves when every save so far has finished. */
export function flushDialog() {
  return flushCurrent ? flushCurrent() : Promise.resolve();
}

/**
 * Show a modal dialog.
 *  onSubmit(formData, form) -> return false to keep the dialog open
 *  onAction(name, element, form) for buttons carrying data-dact
 *  autosave: { collect(form) -> record or null, persist(record) -> Promise }
 *    Edits are saved AUTOSAVE_MS after the last change, and whenever the dialog closes
 *    (X, Esc, backdrop, another dialog opening, the page being hidden). collect() runs
 *    synchronously; persist() calls run one after another, never in parallel.
 */
export function openDialog(html, { onSubmit, onAction, onInput, autosave } = {}) {
  const dlg = $('#dlg');
  if (flushCurrent) flushCurrent(); // the dialog being replaced keeps its edits
  flushCurrent = null;
  dlg.innerHTML = `<form class="dlg-form" novalidate>${html}</form>`;
  const form = dlg.firstElementChild;

  let schedule = () => {};
  let settle = () => Promise.resolve();
  if (autosave) {
    const status = form.querySelector('[data-autosave]');
    const show = (text) => { if (status) status.textContent = text; };
    let timer = null, dirty = false, chain = Promise.resolve();
    const run = () => {
      clearTimeout(timer);
      timer = null;
      if (!dirty) return chain;
      dirty = false;
      let rec;
      try { rec = autosave.collect(form); } catch (e) { show('Not saved'); toast(e.message || String(e), 'error'); return chain; }
      if (!rec) { show(''); return chain; }
      show('Saving…');
      chain = chain.then(() => autosave.persist(rec)).then(
        () => { if (!dirty) show('Saved'); },
        (e) => { dirty = true; show('Not saved'); toast(e.message || String(e), 'error'); },
      );
      return chain;
    };
    schedule = () => { dirty = true; show('Editing…'); clearTimeout(timer); timer = setTimeout(run, AUTOSAVE_MS); };
    settle = () => { clearTimeout(timer); timer = null; dirty = false; return chain; };
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    flushCurrent = run;
    form.discardAutosave = () => { settle(); flushCurrent = null; return chain; };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    await settle(); // the submit handler does the final save itself
    const keep = onSubmit ? await onSubmit(new FormData(form), form) : true;
    if (keep !== false) closeDialog();
  };
  dlg.oncancel = () => { if (flushCurrent) flushCurrent(); flushCurrent = null; }; // Esc
  // Only a press that starts and ends on the backdrop closes the dialog, so
  // selecting text in a field and releasing outside does not lose the edit.
  let downOnBackdrop = false;
  dlg.onpointerdown = (e) => { downOnBackdrop = e.target === dlg; };
  dlg.onclick = (e) => {
    if (e.target === dlg) { if (downOnBackdrop) closeDialog(); return; } // click on the backdrop
    const el = e.target.closest('[data-dact]');
    if (!el) return;
    if (el.dataset.dact === 'close') return closeDialog();
    if (onAction) {
      // Actions such as adding a step change the record without an input event.
      Promise.resolve(onAction(el.dataset.dact, el, form)).then(() => { if (form.isConnected && !('noAutosave' in el.dataset)) schedule(); });
    }
  };
  form.oninput = onInput ? (e) => onInput(e.target, form) : null;
  if (!dlg.open) dlg.showModal();
  const first = form.querySelector('[autofocus]');
  if (first) first.focus();
  return form;
}

export function closeDialog() {
  const dlg = $('#dlg');
  if (flushCurrent) flushCurrent(); // reads the form before it is cleared
  flushCurrent = null;
  if (dlg.open) dlg.close();
  dlg.innerHTML = '';
}

// Leaving the page or switching apps saves what is being typed.
document.addEventListener('visibilitychange', () => { if (document.hidden && flushCurrent) flushCurrent(); });
addEventListener('pagehide', () => { if (flushCurrent) flushCurrent(); });

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    dlg.innerHTML = `<form class="dlg-form" method="dialog">
      <p class="confirm-msg"></p>
      <div class="dlg-foot"><span class="grow"></span>
        <button type="button" class="btn ghost" value="no">Cancel</button>
        <button type="button" class="btn danger" value="yes"></button></div></form>`;
    dlg.querySelector('.confirm-msg').textContent = message;
    dlg.querySelector('.danger').textContent = okLabel;
    dlg.onclick = (e) => {
      const b = e.target.closest('button');
      if (b || e.target === dlg) { dlg.close(); resolve(b?.value === 'yes'); }
    };
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}
