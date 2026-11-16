// Shared UI state, routing and the dialog helper.
import { $, bus } from './util.js';

export const state = {
  route: { view: 'today' },
  search: '',
  showDone: false,
  expanded: new Set(),  // task ids whose subtasks are shown inline
  navOpen: false,
  user: null,
  vaultRecord: null,
  vaultLoaded: false,
};

export function parseRoute(hash = location.hash) {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'cat' && p[1]) return { view: 'cat', id: p[1] };
  if (p[0] === 'work') return { view: 'work', id: p[1] === 'cat' ? p[2] || null : null };
  if (['today', 'upcoming', 'inbox', 'all', 'ideas', 'settings'].includes(p[0])) return { view: p[0] };
  return { view: 'today' };
}

export function go(hash) {
  if (location.hash === hash) bus.emit('render'); else location.hash = hash;
}

export const rerender = () => bus.emit('render');

/**
 * Show a modal dialog.
 *  onSubmit(formData, form) -> return false to keep the dialog open
 *  onAction(name, element, form) for buttons carrying data-dact
 */
export function openDialog(html, { onSubmit, onAction, onInput } = {}) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form class="dlg-form" novalidate>${html}</form>`;
  const form = dlg.firstElementChild;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const keep = onSubmit ? await onSubmit(new FormData(form), form) : true;
    if (keep !== false) closeDialog();
  };
  dlg.onclick = (e) => {
    if (e.target === dlg) return closeDialog(); // click on the backdrop
    const el = e.target.closest('[data-dact]');
    if (!el) return;
    if (el.dataset.dact === 'close') return closeDialog();
    if (onAction) onAction(el.dataset.dact, el, form);
  };
  form.oninput = onInput ? (e) => onInput(e.target, form) : null;
  if (!dlg.open) dlg.showModal();
  const first = form.querySelector('[autofocus]');
  if (first) first.focus();
  return form;
}

export function closeDialog() {
  const dlg = $('#dlg');
  if (dlg.open) dlg.close();
  dlg.innerHTML = '';
}

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
