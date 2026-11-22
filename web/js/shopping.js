// Shopping list: things to buy, grouped by the user's own shopping categories
// (Groceries, For projects, Fun… editable). An item can be linked to a project idea.
import * as store from './store.js';
import { state, openDialog, closeDialog, confirmDialog, rerender } from './app.js';
import { esc, safeColor, toast, ICON, ls, nowIso } from './util.js';

const LAST_CAT = 'synaptask:shopping-cat';

export const sortedShopCats = () => [...store.list('shopping_categories')]
  .sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name));

/** Number of items still to buy (sidebar badge). */
export const toBuyCount = () => store.list('shopping_items').filter((i) => !i.bought_at).length;

const matches = (i, q) => `${i.title}\n${i.quantity || ''}\n${i.notes || ''}`.toLowerCase().includes(q);

function row(item, showCat) {
  const id = esc(item.id);
  const bought = !!item.bought_at;
  const cat = showCat && item.category_id ? store.get('shopping_categories', item.category_id) : null;
  const idea = item.idea_id ? store.get('ideas', item.idea_id) : null;
  const chips = [];
  if (item.quantity) chips.push(`<span class="chip plain">${esc(item.quantity)}</span>`);
  if (cat) chips.push(`<span class="chip plain"><i class="dot" style="background:${safeColor(cat.color)}"></i>${esc(cat.name)}</span>`);
  if (idea) chips.push(`<span class="chip plain">Project · ${esc(idea.title)}</span>`);
  if (item.source === 'claude') chips.push('<span class="chip claude">from Claude</span>');
  return `<li class="task ${bought ? 'done' : ''}">
    <button type="button" class="check" data-act="shop-toggle" data-id="${id}" aria-label="${bought ? 'Mark as not bought' : 'Mark as bought'}">${ICON.check}</button>
    <div class="task-main" data-act="shop-open" data-id="${id}" role="button" tabindex="0">
      <div class="task-title">${esc(item.title)}</div>
      ${chips.length ? `<div class="task-meta">${chips.join('')}</div>` : ''}
      ${item.notes ? `<div class="task-notes">${esc(item.notes.slice(0, 160))}</div>` : ''}
    </div>
  </li>`;
}

export function viewTitle(route) {
  const cat = route.id ? store.get('shopping_categories', route.id) : null;
  const open = store.list('shopping_items').filter((i) => !i.bought_at && (!cat || i.category_id === cat.id)).length;
  return { title: cat ? cat.name : 'Shopping list', sub: `${open} to buy` };
}

export function renderShopping(route, query = '') {
  const cats = sortedShopCats();
  const current = route.id ? cats.find((c) => c.id === route.id) || null : null;
  const q = query.trim().toLowerCase();
  const items = store.list('shopping_items')
    .filter((i) => (!current || i.category_id === current.id) && (!q || matches(i, q)))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const toBuy = items.filter((i) => !i.bought_at);
  const bought = items.filter((i) => i.bought_at).sort((a, b) => (a.bought_at < b.bought_at ? 1 : -1));

  // Category filter chips
  const filters = `<nav class="shop-filters" aria-label="Shopping categories">
      <a class="chip-link ${!current ? 'on' : ''}" href="#/shopping">All</a>
      ${cats.map((c) => `<a class="chip-link ${current?.id === c.id ? 'on' : ''}" href="#/shopping/${esc(c.id)}"><i class="dot" style="background:${safeColor(c.color)}"></i>${esc(c.name)}</a>`).join('')}
      <button type="button" class="link-btn" data-act="cats-manage" data-table="shopping_categories">Edit categories</button>
    </nav>`;

  // Quick add, with the category it goes into
  const preferred = current?.id || ls.get(LAST_CAT, '');
  const sel = cats.some((c) => c.id === preferred) ? preferred : '';
  const quick = `<form class="quick" data-form="quick-shop" autocomplete="off">
      <input id="quick-input" name="title" maxlength="300" placeholder="Add something to buy…  (press Enter)" aria-label="New item">
      <select name="category_id" aria-label="Category" class="quick-cat">
        <option value="">No category</option>
        ${cats.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <button class="btn primary">Add</button>
    </form>`;

  // To buy: grouped by category when showing everything
  let list;
  if (current) {
    list = toBuy.length ? `<ul class="tasks">${toBuy.map((i) => row(i, false)).join('')}</ul>` : '';
  } else {
    const groups = [...cats.map((c) => ({ c, items: toBuy.filter((i) => i.category_id === c.id) })),
      { c: null, items: toBuy.filter((i) => !i.category_id || !cats.some((c) => c.id === i.category_id)) }]
      .filter((g) => g.items.length);
    list = groups.map((g) => `<section class="group">
        <h3 class="group-h">${g.c ? `<i class="dot" style="background:${safeColor(g.c.color)}"></i>${esc(g.c.name)}` : 'No category'}<small>${g.items.length}</small></h3>
        <ul class="tasks">${g.items.map((i) => row(i, false)).join('')}</ul>
      </section>`).join('');
  }
  const empty = toBuy.length ? '' : `<div class="empty">${q ? 'Nothing matches your search.' : 'Nothing to buy. Add something above.'}</div>`;
  const boughtHtml = bought.length
    ? `<div class="inline shop-bought">
        <button type="button" class="link-btn" data-act="shop-show-bought">${state.showBought ? 'Hide' : 'Show'} bought (${bought.length})</button>
        <button type="button" class="link-btn" data-act="shop-clear-bought">Clear bought</button>
      </div>
      ${state.showBought ? `<ul class="tasks">${bought.map((i) => row(i, !current)).join('')}</ul>` : ''}`
    : '';
  return `${filters}${quick}${list}${empty}${boughtHtml}`;
}

export async function quickAdd(fd, form) {
  const title = String(fd.get('title') || '').trim();
  if (!title) return;
  const category_id = String(fd.get('category_id') || '') || null;
  ls.set(LAST_CAT, category_id || '');
  form.elements.title.value = '';
  await store.save('shopping_items', { title, category_id });
}

async function toggleBought(id) {
  const item = store.get('shopping_items', id);
  if (item) await store.save('shopping_items', { ...item, bought_at: item.bought_at ? null : nowIso() });
}

export const actions = {
  'shop-toggle': (el) => toggleBought(el.dataset.id),
  'shop-open': (el) => openShoppingEditor(el.dataset.id),
  'shop-show-bought': () => { state.showBought = !state.showBought; rerender(); },
  'shop-clear-bought': async () => {
    const bought = store.list('shopping_items').filter((i) => i.bought_at);
    if (!bought.length || !await confirmDialog(`Remove ${bought.length} bought item${bought.length === 1 ? '' : 's'} from the list?`, 'Clear')) return;
    for (const i of bought) await store.remove('shopping_items', i.id);
    toast('Bought items cleared');
  },
};

/** Edit an item. Saved while typing, like tasks and ideas. */
export function openShoppingEditor(id) {
  const item = store.get('shopping_items', id);
  if (!item) return;
  const cats = sortedShopCats();
  const ideas = store.list('ideas').filter((i) => i.stage !== 'done' || i.id === item.idea_id);
  const opt = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current ?? '') ? 'selected' : ''}>${esc(label)}</option>`;

  const read = (f) => {
    const fd = new FormData(f);
    const title = String(fd.get('title')).trim();
    if (!title) return null;
    return {
      ...item,
      title,
      quantity: String(fd.get('quantity')).trim(),
      category_id: fd.get('category_id') || null,
      idea_id: fd.get('idea_id') || null,
      notes: String(fd.get('notes')),
      bought_at: store.get('shopping_items', id)?.bought_at ?? item.bought_at,
    };
  };

  const form = openDialog(`
    <header class="dlg-head"><h2>Shopping item</h2>
      <button type="button" class="icon-btn" data-dact="close" aria-label="Close">${ICON.x}</button></header>
    <div class="dlg-body">
      <div class="row">
        <label class="field grow2"><span>What</span><input name="title" maxlength="300" value="${esc(item.title)}"></label>
        <label class="field"><span>How much</span><input name="quantity" maxlength="50" value="${esc(item.quantity || '')}" placeholder="e.g. 2 kg"></label>
      </div>
      <div class="row">
        <label class="field"><span>Category</span><select name="category_id">${opt('', 'No category', item.category_id)}${cats.map((c) => opt(c.id, c.name, item.category_id)).join('')}</select></label>
        <label class="field"><span>For project</span><select name="idea_id">${opt('', 'None', item.idea_id)}${ideas.map((i) => opt(i.id, i.title, item.idea_id)).join('')}</select></label>
      </div>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3" maxlength="5000" placeholder="Shop, brand, link…">${esc(item.notes || '')}</textarea></label>
    </div>
    <footer class="dlg-foot">
      <button type="button" class="btn danger ghost" data-dact="delete" data-no-autosave>Delete</button>
      <span class="grow"></span>
      <span class="autosave-status" data-autosave aria-live="polite"></span>
      <button class="btn primary">Done</button>
    </footer>`, {
    onSubmit: async (_fd, f) => {
      const rec = read(f);
      if (!rec) { toast('Say what to buy', 'warn'); return false; }
      await store.save('shopping_items', rec);
    },
    autosave: { collect: read, persist: (rec) => store.save('shopping_items', rec) },
    onAction: async (name, _el, f) => {
      if (name === 'delete' && await confirmDialog(`Remove “${item.title}” from the shopping list?`)) {
        await f.discardAutosave();
        await store.remove('shopping_items', id);
        closeDialog();
      }
    },
  });
  return form;
}
