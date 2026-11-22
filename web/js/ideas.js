// Project ideas: a board with four stages. Each idea can carry notes, tags, links and its own tasks.
import * as store from './store.js';
import { openDialog, closeDialog, confirmDialog } from './app.js';
import { esc, toast, ICON, $ } from './util.js';
import { openTaskEditor, toggleTask } from './tasks.js';
import { itemsOfIdea, addForIdea, toggleBought, openShoppingEditor } from './shopping.js';

export const STAGES = [['idea', 'Idea'], ['planning', 'Planning'], ['building', 'Building'], ['done', 'Done']];

const tasksOf = (ideaId) => store.list('tasks').filter((t) => t.idea_id === ideaId);
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

function card(idea) {
  const tasks = tasksOf(idea.id);
  const done = tasks.filter((t) => t.completed_at).length;
  const toBuy = itemsOfIdea(idea.id).filter((i) => !i.bought_at).length;
  return `<article class="idea-card" draggable="true" data-act="idea-open" data-id="${esc(idea.id)}" tabindex="0" role="button">
    <h4>${esc(idea.title)}</h4>
    ${idea.notes ? `<p>${esc(idea.notes.slice(0, 140))}${idea.notes.length > 140 ? '…' : ''}</p>` : ''}
    <div class="task-meta">
      ${(idea.tags || []).map((t) => `<span class="chip plain">#${esc(t)}</span>`).join('')}
      ${tasks.length ? `<span class="chip">${done}/${tasks.length} tasks</span>` : ''}
      ${toBuy ? `<span class="chip plain">${ICON.cart}${toBuy} to buy</span>` : ''}
    </div>
  </article>`;
}

const ideaMatches = (i, q) => `${i.title}\n${i.notes || ''}\n${(i.tags || []).join(' ')}`.toLowerCase().includes(q);

export function renderIdeas(query = '') {
  const q = query.trim().toLowerCase();
  const ideas = store.list('ideas').filter((i) => !q || ideaMatches(i, q));
  const cols = STAGES.map(([key, label]) => {
    const items = ideas.filter((i) => i.stage === key).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return `<section class="col" data-stage="${key}">
      <h3 class="group-h">${label}<small>${items.length}</small></h3>
      <div class="col-body">${items.map(card).join('') || '<div class="col-empty">Drop ideas here</div>'}</div>
    </section>`;
  }).join('');
  return `<form class="quick" data-form="quick-idea" autocomplete="off">
      <input id="quick-input" name="title" maxlength="300" placeholder="Capture a project idea…  (press Enter)" aria-label="New idea">
      <button class="btn primary">Add</button>
    </form>
    <div class="board">${cols}</div>`;
}

export async function quickAddIdea(title) {
  title = title.trim();
  if (title) await store.save('ideas', { title, stage: 'idea' });
}

export async function moveIdea(id, stage) {
  const idea = store.get('ideas', id);
  if (idea && idea.stage !== stage && STAGES.some(([k]) => k === stage)) await store.save('ideas', { ...idea, stage });
}

export const actions = { 'idea-open': (el) => openIdeaEditor(el.dataset.id) };

export function openIdeaEditor(id) {
  const idea = store.get('ideas', id);
  if (!idea) return;
  const tasks = tasksOf(id).sort((a, b) => Number(!!a.completed_at) - Number(!!b.completed_at));
  const links = (idea.links || []).map(safeUrl).filter(Boolean);
  const shop = itemsOfIdea(id);

  const read = (fd) => ({
    ...idea,
    title: String(fd.get('title')).trim() || idea.title,
    stage: fd.get('stage'),
    notes: String(fd.get('notes')),
    tags: [...new Set(String(fd.get('tags')).split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 20),
    links: String(fd.get('links')).split('\n').map((l) => l.trim()).filter((l) => safeUrl(l)).slice(0, 30),
  });
  const reopen = () => openIdeaEditor(id);

  const form = openDialog(`
    <header class="dlg-head"><h2>Project idea</h2>
      <button type="button" class="icon-btn" data-dact="close" aria-label="Close">${ICON.x}</button></header>
    <div class="dlg-body">
      <div class="row">
        <label class="field grow2"><span>Title</span><input name="title" maxlength="300" value="${esc(idea.title)}"></label>
        <label class="field"><span>Stage</span><select name="stage">${STAGES.map(([k, l]) => `<option value="${k}" ${idea.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Notes</span><textarea name="notes" rows="7" maxlength="50000" placeholder="What is it, why build it, how might it work…">${esc(idea.notes || '')}</textarea></label>
      <label class="field"><span>Tags (comma separated)</span><input name="tags" maxlength="300" value="${esc((idea.tags || []).join(', '))}"></label>
      <label class="field"><span>Links (one per line)</span><textarea name="links" rows="2" maxlength="4000" placeholder="https://…">${esc((idea.links || []).join('\n'))}</textarea></label>
      ${links.length ? `<div class="link-list">${links.map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`).join('')}</div>` : ''}
      <div class="field"><span>Tasks for this idea</span>
        <ul class="tasks compact">${tasks.map((t) => `<li class="task ${t.completed_at ? 'done' : ''}">
            <button type="button" class="check" data-dact="task-toggle" data-id="${esc(t.id)}" aria-label="Toggle done">${ICON.check}</button>
            <div class="task-main" data-dact="task-open" data-id="${esc(t.id)}" role="button" tabindex="0"><div class="task-title">${esc(t.title)}</div></div>
          </li>`).join('')}</ul>
        <span class="inline"><input type="text" id="idea-task-new" maxlength="500" placeholder="Add a task for this idea…"><button type="button" class="btn ghost" data-dact="task-add">Add</button></span></div>
      <div class="field"><span>To buy for this project</span>
        <ul class="tasks compact">${shop.map((s) => `<li class="task ${s.bought_at ? 'done' : ''}">
            <button type="button" class="check" data-dact="shop-toggle" data-id="${esc(s.id)}" aria-label="${s.bought_at ? 'Mark as not bought' : 'Mark as bought'}">${ICON.check}</button>
            <div class="task-main" data-dact="shop-open" data-id="${esc(s.id)}" role="button" tabindex="0"><div class="task-title">${esc(s.title)}${s.quantity ? ` <span class="chip plain">${esc(s.quantity)}</span>` : ''}</div></div>
          </li>`).join('')}</ul>
        <span class="inline"><input type="text" id="idea-shop-new" maxlength="300" placeholder="Add something to buy for this project…"><button type="button" class="btn ghost" data-dact="shop-add">Add</button></span>
        ${shop.length ? '<button type="button" class="link-btn" data-dact="go-shop" data-no-autosave>Open in the shopping list</button>' : ''}</div>
    </div>
    <footer class="dlg-foot">
      <button type="button" class="btn danger ghost" data-dact="delete" data-no-autosave>Delete</button>
      <span class="grow"></span>
      <span class="autosave-status" data-autosave aria-live="polite"></span>
      <button class="btn primary">Done</button>
    </footer>`, {
    onSubmit: async (fd) => { await store.save('ideas', read(fd)); },
    // Notes and everything else are saved while you type.
    autosave: {
      collect: (f) => read(new FormData(f)),
      persist: (rec) => store.save('ideas', rec),
    },
    onAction: async (name, el, f) => {
      const keep = () => store.save('ideas', read(new FormData(f))); // do not lose edits when the dialog redraws
      if (name === 'task-add') {
        const title = $('#idea-task-new', f).value.trim();
        if (!title) return;
        await keep();
        await store.save('tasks', { title, idea_id: id });
        reopen();
        $('#idea-task-new')?.focus();
      }
      if (name === 'task-toggle') { await keep(); await toggleTask(el.dataset.id); reopen(); }
      if (name === 'task-open') { await keep(); openTaskEditor(el.dataset.id, reopen); }
      if (name === 'shop-add') {
        const title = $('#idea-shop-new', f).value.trim();
        if (!title) return;
        await keep();
        await addForIdea(id, title);
        reopen();
        $('#idea-shop-new')?.focus();
      }
      if (name === 'shop-toggle') { await keep(); await toggleBought(el.dataset.id); reopen(); }
      if (name === 'shop-open') { await keep(); openShoppingEditor(el.dataset.id, reopen); }
      if (name === 'go-shop') { closeDialog(); location.hash = `#/shopping/project/${id}`; }
      if (name === 'delete' && await confirmDialog(`Delete the idea “${idea.title}”? Its tasks are kept.`)) {
        await f.discardAutosave(); // never re-save a deleted idea
        await store.remove('ideas', id);
        closeDialog();
        toast('Idea deleted');
      }
    },
  });
  for (const [input, button] of [['#idea-task-new', 'task-add'], ['#idea-shop-new', 'shop-add']]) {
    $(input, form).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); form.querySelector(`[data-dact="${button}"]`).click(); }
    });
  }
}
