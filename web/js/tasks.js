// Task lists and the task editor. Used for both the personal views and the Work section.
import * as store from './store.js';
import { state, openDialog, closeDialog, confirmDialog, rerender } from './app.js';
import { esc, today, addDays, fmtDate, fmtLongDate, nowIso, safeColor, toast, ICON, uid, ymd, ls, $ } from './util.js';
import { nextDue, anchorRule, describeRule } from './recurrence.js';

const PRI = ['None', 'Low', 'Medium', 'High'];

// Stages, like the project board. Done is completed_at; Ongoing is started_at without completed_at.
export const STATUSES = [['todo', 'To do'], ['ongoing', 'Ongoing'], ['done', 'Done']];
export const statusOf = (t) => (t.completed_at ? 'done' : t.started_at ? 'ongoing' : 'todo');

/** Move a task to a stage. Done on a repeating task means "this occurrence": it moves to the next date. */
export async function setStatus(id, status) {
  const t = store.get('tasks', id);
  if (!t || statusOf(t) === status) return;
  if (status === 'done') return toggleTask(id);
  await store.save('tasks', { ...t, completed_at: null, started_at: status === 'ongoing' ? t.started_at || nowIso() : null });
}

// List or board, remembered per device.
const LAYOUT_KEY = 'synaptask:task-layout';
export const taskLayout = () => (ls.get(LAYOUT_KEY, 'list') === 'board' ? 'board' : 'list');

function sortTasks(a, b) {
  const da = a.due_date || '9999', dbb = b.due_date || '9999';
  if (da !== dbb) return da < dbb ? -1 : 1;
  const ta = a.due_time || '99', tb = b.due_time || '99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
  return (a.created_at || '') < (b.created_at || '') ? -1 : 1;
}

const matches = (t, q) =>
  `${t.title}\n${t.notes || ''}\n${(t.subtasks || []).map((s) => s.title).join('\n')}`.toLowerCase().includes(q);

/** Work out which tasks a route shows, how they are grouped, and what a quick-added task should inherit. */
export function viewModel(route) {
  const space = route.view === 'work' ? 'work' : 'personal';
  const all = store.list('tasks', space);
  const cats = [...store.list('categories', space)].sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name));
  const t0 = today();
  const q = state.search.trim().toLowerCase();
  const ctx = { space, category_id: null, due_date: null };
  let title = 'Tasks', sub = '', filter = () => true, doneFilter = null, groupBy = null, showCat = true;
  const byCategory = () => { groupBy = 'category'; showCat = false; };

  switch (route.view) {
    case 'today':
      title = 'Today'; sub = fmtLongDate();
      filter = (t) => !!t.due_date && t.due_date <= t0;
      doneFilter = (t) => ymd(new Date(t.completed_at)) === t0;
      groupBy = (t) => (t.due_date < t0 ? 'Overdue' : 'Today');
      ctx.due_date = t0;
      break;
    case 'upcoming':
      title = 'Upcoming'; sub = 'Everything with a date after today';
      filter = (t) => !!t.due_date && t.due_date > t0;
      doneFilter = () => false;
      groupBy = (t) => fmtDate(t.due_date);
      ctx.due_date = addDays(t0, 1);
      break;
    case 'inbox':
      title = 'Inbox'; sub = 'Tasks that have no category yet';
      filter = (t) => !t.category_id;
      break;
    case 'cat': {
      const cat = store.get('categories', route.id);
      title = cat ? cat.name : 'Category';
      filter = (t) => t.category_id === route.id;
      ctx.category_id = cat ? cat.id : null;
      showCat = false;
      break;
    }
    case 'work': {
      const cat = route.id ? store.get('categories', route.id) : null;
      title = cat ? cat.name : 'Work';
      sub = 'Encrypted on this device before it is stored';
      if (cat) { filter = (t) => t.category_id === cat.id; ctx.category_id = cat.id; showCat = false; } else byCategory();
      break;
    }
    default:
      title = 'All tasks';
      byCategory();
  }
  if (q) {
    title = 'Search'; sub = `Results for “${state.search.trim()}”`;
    filter = (t) => matches(t, q); doneFilter = null; groupBy = null; showCat = true;
  }

  const open = all.filter((t) => !t.completed_at && filter(t)).sort(sortTasks);
  const done = all.filter((t) => t.completed_at && (doneFilter || filter)(t))
    .sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1));

  let groups;
  if (groupBy === 'category') {
    groups = [{ label: 'No category', tasks: open.filter((t) => !t.category_id || !cats.some((c) => c.id === t.category_id)) },
      ...cats.map((c) => ({ label: c.name, color: c.color, tasks: open.filter((t) => t.category_id === c.id) }))]
      .filter((g) => g.tasks.length);
    if (groups.length === 1 && groups[0].label === 'No category') groups[0].label = '';
  } else if (groupBy) {
    const map = new Map();
    for (const t of open) { const k = groupBy(t); if (!map.has(k)) map.set(k, []); map.get(k).push(t); }
    groups = [...map].map(([label, tasks]) => ({ label, tasks }));
  } else {
    groups = open.length ? [{ label: '', tasks: open }] : [];
  }
  return { title, sub, groups, open, done, ctx, showCat, cats, space };
}

/** The small labels under a task title. `board` leaves out what the column already says. */
function taskChips(t, showCat, board = false) {
  const t0 = today();
  const id = esc(t.id);
  const isDone = !!t.completed_at;
  const cat = t.category_id ? store.get('categories', t.category_id) : null;
  const idea = t.idea_id ? store.get('ideas', t.idea_id) : null;
  const subs = t.subtasks || [];
  const chips = [];
  if (!board && !isDone && t.started_at) chips.push('<span class="chip ongoing">Ongoing</span>');
  if (t.due_date) {
    const cls = isDone ? '' : t.due_date < t0 ? 'overdue' : t.due_date === t0 ? 'due-today' : '';
    chips.push(`<span class="chip due ${cls}">${esc(fmtDate(t.due_date))}${t.due_time ? ` · ${esc(t.due_time)}` : ''}</span>`);
  }
  if (t.recurrence) chips.push(`<span class="chip plain">${ICON.repeat}${esc(describeRule(t.recurrence))}</span>`);
  if (t.priority) chips.push(`<span class="chip pri p${Number(t.priority)}">${PRI[t.priority] || ''}</span>`);
  if (subs.length) {
    chips.push(board
      ? `<span class="chip plain">${subs.filter((s) => s.done).length}/${subs.length} steps</span>`
      : `<button type="button" class="chip plain as-btn" data-act="task-expand" data-id="${id}" aria-expanded="${state.expanded.has(t.id)}">${subs.filter((s) => s.done).length}/${subs.length} steps</button>`);
  }
  if (cat && showCat) chips.push(`<span class="chip plain"><i class="dot" style="background:${safeColor(cat.color)}"></i>${esc(cat.name)}</span>`);
  if (idea) chips.push(`<span class="chip plain">Idea · ${esc(idea.title)}</span>`);
  if (t.source === 'claude') chips.push('<span class="chip claude">from Claude</span>');
  return chips;
}

function taskRow(t, showCat) {
  const id = esc(t.id);
  const isDone = !!t.completed_at;
  const subs = t.subtasks || [];
  const chips = taskChips(t, showCat);

  const subList = subs.length && state.expanded.has(t.id)
    ? `<li class="subs-wrap"><ul class="subs">${subs.map((s) => `<li><label class="${s.done ? 'sub-done' : ''}">
        <input type="checkbox" data-act="sub-toggle" data-id="${id}" data-sub="${esc(s.id)}" ${s.done ? 'checked' : ''}>
        <span>${esc(s.title)}</span></label></li>`).join('')}</ul></li>`
    : '';

  return `<li class="task ${isDone ? 'done' : ''} pri-${Number(t.priority) || 0}">
    <button type="button" class="check" data-act="task-toggle" data-id="${id}" aria-label="${isDone ? 'Mark as not done' : 'Mark as done'}">${ICON.check}</button>
    <div class="task-main" data-act="task-open" data-id="${id}" role="button" tabindex="0">
      <div class="task-title">${esc(t.title)}</div>
      ${chips.length ? `<div class="task-meta">${chips.join('')}</div>` : ''}
      ${t.notes ? `<div class="task-notes">${esc(t.notes.slice(0, 160))}</div>` : ''}
    </div>
  </li>${subList}`;
}

const quickForm = () => `<form class="quick" data-form="quick-task" autocomplete="off">
      <input id="quick-input" name="title" maxlength="500" placeholder="Add a task…  (press Enter)" aria-label="New task">
      <button class="btn primary">Add</button>
      <button type="button" class="btn ghost" data-act="task-new" title="Add with details">Details</button>
    </form>`;

/** List / Board switch for the page header. */
export function layoutSwitch() {
  const cur = taskLayout();
  return `<div class="seg" role="group" aria-label="Layout">
    <button type="button" class="${cur === 'list' ? 'on' : ''}" data-act="task-layout" data-layout="list" aria-pressed="${cur === 'list'}">List</button>
    <button type="button" class="${cur === 'board' ? 'on' : ''}" data-act="task-layout" data-layout="board" aria-pressed="${cur === 'board'}">Board</button>
  </div>`;
}

const BOARD_DONE_MAX = 30;

/** The same tasks as the list, in three columns: To do, Ongoing, Done. Drag cards between them. */
function renderBoard(vm) {
  const cols = {
    todo: vm.open.filter((t) => !t.started_at),
    ongoing: vm.open.filter((t) => t.started_at),
    done: vm.done,
  };
  const card = (t) => `<article class="idea-card task-card ${t.completed_at ? 'done' : ''} pri-${Number(t.priority) || 0}" draggable="true" data-kind="task" data-id="${esc(t.id)}">
      <div class="task-card-top">
        <button type="button" class="check" data-act="task-toggle" data-id="${esc(t.id)}" aria-label="${t.completed_at ? 'Mark as not done' : 'Mark as done'}">${ICON.check}</button>
        <div class="task-main" data-act="task-open" data-id="${esc(t.id)}" role="button" tabindex="0"><div class="task-title">${esc(t.title)}</div></div>
      </div>
      ${(() => {
        const c = taskChips(t, vm.showCat, true);
        // One tap to start (touch screens cannot drag cards)
        if (statusOf(t) === 'todo') c.unshift(`<button type="button" class="chip plain as-btn" data-act="task-start" data-id="${esc(t.id)}">▶ Start</button>`);
        return c.length ? `<div class="task-meta">${c.join('')}</div>` : '';
      })()}
    </article>`;
  const html = STATUSES.map(([key, label]) => {
    const list = cols[key];
    const shown = key === 'done' ? list.slice(0, BOARD_DONE_MAX) : list;
    const more = list.length - shown.length;
    return `<section class="col" data-status="${key}">
      <h3 class="group-h">${label}<small>${list.length}</small></h3>
      <div class="col-body">${shown.map(card).join('') || `<div class="col-empty">${key === 'ongoing' ? 'Drag a task here when you start it' : 'Drop tasks here'}</div>`}
        ${more > 0 ? `<div class="col-empty">and ${more} older</div>` : ''}</div>
    </section>`;
  }).join('');
  return `${quickForm()}<div class="board board-3">${html}</div>`;
}

/** HTML for the body of a task view (quick-add box, groups, completed list), or the board. */
export function renderTasks(vm, emptyText, layout = 'list') {
  if (layout === 'board') return renderBoard(vm);
  const groups = vm.groups.map((g) => `<section class="group">
      ${g.label ? `<h3 class="group-h">${g.color ? `<i class="dot" style="background:${safeColor(g.color)}"></i>` : ''}${esc(g.label)}<small>${g.tasks.length}</small></h3>` : ''}
      <ul class="tasks">${g.tasks.map((t) => taskRow(t, vm.showCat)).join('')}</ul>
    </section>`).join('');
  const empty = vm.open.length ? '' : `<div class="empty">${esc(emptyText || 'Nothing here. Add a task above.')}</div>`;
  const done = vm.done.length
    ? `<button type="button" class="link-btn" data-act="toggle-done">${state.showDone ? 'Hide' : 'Show'} completed (${vm.done.length})</button>
       ${state.showDone ? `<ul class="tasks">${vm.done.map((t) => taskRow(t, true)).join('')}</ul>` : ''}`
    : '';
  return `${quickForm()}${groups}${empty}${done}`;
}

export async function quickAdd(title, ctx) {
  title = title.trim();
  if (!title) return;
  await store.save('tasks', { title, category_id: ctx.category_id, due_date: ctx.due_date }, ctx.space);
}

export async function toggleTask(id) {
  const t = store.get('tasks', id);
  if (!t) return;
  const next = { ...t };
  if (t.completed_at) {
    next.completed_at = null;
  } else if (t.recurrence) {
    next.due_date = nextDue(t.due_date, t.recurrence, today());
    next.last_completed_at = nowIso();
    next.subtasks = (t.subtasks || []).map((s) => ({ ...s, done: false }));
    next.started_at = null; // the next occurrence starts as To do
    toast(`Done. Next: ${fmtDate(next.due_date)}`);
  } else {
    next.completed_at = nowIso();
  }
  await store.save('tasks', next);
}

async function toggleSub(id, subId) {
  const t = store.get('tasks', id);
  if (!t) return;
  await store.save('tasks', { ...t, subtasks: (t.subtasks || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) });
}

export const actions = {
  'task-toggle': (el) => toggleTask(el.dataset.id),
  'task-open': (el) => openTaskEditor(el.dataset.id),
  'task-expand': (el) => {
    const id = el.dataset.id;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    rerender();
  },
  'sub-toggle': (el) => toggleSub(el.dataset.id, el.dataset.sub),
  'toggle-done': () => { state.showDone = !state.showDone; rerender(); },
  'task-start': (el) => setStatus(el.dataset.id, 'ongoing'),
  'task-layout': (el) => { ls.set(LAYOUT_KEY, el.dataset.layout === 'board' ? 'board' : 'list'); rerender(); },
};

// ---------------------------------------------------------------- editor

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const UNITS = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' };

/** Open the editor for an existing task (pass its id) or a new one (pass a draft with `_space`). */
export function openTaskEditor(idOrDraft, onDone) {
  const existing = typeof idOrDraft === 'string' ? store.get('tasks', idOrDraft) : null;
  if (typeof idOrDraft === 'string' && !existing) return;
  const draft = existing || { priority: 0, subtasks: [], ...idOrDraft };
  const space = existing ? store.spaceOf(existing) : draft._space || 'personal';
  const cats = [...store.list('categories', space)].sort((a, b) => a.name.localeCompare(b.name));
  const ideas = space === 'personal' ? store.list('ideas').filter((i) => i.stage !== 'done' || i.id === draft.idea_id) : [];
  const rule = draft.recurrence || {};
  let subs = (draft.subtasks || []).map((s) => ({ ...s }));

  const opt = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  const subsHtml = () => subs.map((s, i) => `<li>
      <input type="checkbox" data-dact="sub-check" data-i="${i}" ${s.done ? 'checked' : ''} aria-label="Step done">
      <input type="text" class="sub-title" data-i="${i}" maxlength="300" value="${esc(s.title)}" aria-label="Step">
      <button type="button" class="icon-btn" data-dact="sub-del" data-i="${i}" aria-label="Remove step">${ICON.x}</button>
    </li>`).join('');

  const form = openDialog(`
    <header class="dlg-head"><h2${space === 'work' ? ' data-work-editor' : ''}>${existing ? 'Edit task' : 'New task'}${space === 'work' ? ' <span class="chip plain">Work</span>' : ''}</h2>
      <button type="button" class="icon-btn" data-dact="close" aria-label="Close">${ICON.x}</button></header>
    <div class="dlg-body">
      <label class="field"><span>Title</span><input name="title" maxlength="500" value="${esc(draft.title || '')}" ${existing ? '' : 'autofocus'}></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3" maxlength="20000">${esc(draft.notes || '')}</textarea></label>
      <div class="row">
        <label class="field"><span>Status</span><select name="status">${STATUSES.map(([k, l]) => opt(k, l, statusOf(draft))).join('')}</select></label>
        <label class="field"><span>Priority</span><select name="priority">${PRI.map((p, i) => opt(i, p, draft.priority || 0)).join('')}</select></label>
      </div>
      <label class="field"><span>Category</span><select name="category_id">${opt('', 'No category', draft.category_id)}${cats.map((c) => opt(c.id, c.name, draft.category_id)).join('')}</select></label>
      <div class="row">
        <label class="field"><span>Due date</span><input type="date" name="due_date" value="${esc(draft.due_date || '')}"></label>
        <label class="field"><span>Time (optional)</span><input type="time" name="due_time" value="${esc(draft.due_time || '')}"></label>
      </div>
      <div class="row">
        <label class="field"><span>Repeat</span><select name="freq">
          ${opt('', 'Never', rule.freq)}${opt('daily', 'Daily', rule.freq)}${opt('weekly', 'Weekly', rule.freq)}${opt('monthly', 'Monthly', rule.freq)}${opt('yearly', 'Yearly', rule.freq)}</select></label>
        <label class="field" data-show="repeat"><span>Every</span>
          <span class="inline"><input type="number" name="interval" min="1" max="365" value="${Number(rule.interval) || 1}"><em data-unit></em></span></label>
      </div>
      <div class="field" data-show="weekly"><span>On these days</span>
        <div class="days">${DAYS.map(([n, label]) => `<label class="day"><input type="checkbox" name="days" value="${n}" ${(rule.days || []).includes(n) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div></div>
      ${ideas.length ? `<label class="field"><span>Part of project idea</span><select name="idea_id">${opt('', 'None', draft.idea_id)}${ideas.map((i) => opt(i.id, i.title, draft.idea_id)).join('')}</select></label>` : ''}
      <div class="field"><span>Steps</span>
        <ul class="sub-edit" data-subs>${subsHtml()}</ul>
        <span class="inline"><input type="text" id="sub-new" maxlength="300" placeholder="Add a step…"><button type="button" class="btn ghost" data-dact="sub-add">Add</button></span></div>
    </div>
    <footer class="dlg-foot">
      ${existing
        ? '<button type="button" class="btn danger ghost" data-dact="delete" data-no-autosave>Delete</button>'
        : '<button type="button" class="btn ghost" data-dact="discard" data-no-autosave>Discard</button>'}
      <span class="grow"></span>
      <span class="autosave-status" data-autosave aria-live="polite"></span>
      <button class="btn primary">Done</button>
    </footer>`, {
    onSubmit: async (fd) => {
      if (!String(fd.get('title')).trim()) { toast('Give the task a title', 'warn'); return false; }
      readSubs(); addPendingSub();
      await persist(build(fd));
      if (onDone) setTimeout(onDone, 0);
    },
    // Saved while typing; a new task is created as soon as it has a title.
    autosave: {
      collect: (f) => { readSubs(); const fd = new FormData(f); return String(fd.get('title')).trim() ? build(fd) : null; },
      persist: (rec) => persist(rec),
    },
    onAction: async (name, el) => {
      if (name === 'sub-add') { readSubs(); addPendingSub(); drawSubs(); $('#sub-new', form).focus(); }
      if (name === 'sub-del') { readSubs(); subs.splice(Number(el.dataset.i), 1); drawSubs(); }
      if (name === 'sub-check') { subs[Number(el.dataset.i)].done = el.checked; }
      if (name === 'discard') {
        await form.discardAutosave();
        if (savedId) await store.remove('tasks', savedId);
        closeDialog();
      }
      if (name === 'delete' && await confirmDialog(`Delete “${draft.title}”?`)) {
        await form.discardAutosave(); // never re-save a deleted task
        await store.remove('tasks', draft.id);
        closeDialog();
        if (onDone) setTimeout(onDone, 0);
      }
    },
    onInput: (target) => { if (target.name === 'freq') showRepeat(); },
  });

  // The id of this task once it exists (a new task gets one at its first save).
  let savedId = existing?.id || null;
  function build(fd) {
    let dueDate = fd.get('due_date') || null;
    const freq = fd.get('freq');
    if (freq && !dueDate) dueDate = today(); // a repeating task needs a starting date
    const recurrence = freq
      ? anchorRule({ freq, interval: Number(fd.get('interval')) || 1, days: fd.getAll('days').map(Number) }, dueDate)
      : null;
    // Status: keep the original start / finish time while the stage stays the same.
    const cur = (savedId && store.get('tasks', savedId)) || draft;
    const status = fd.get('status') || 'todo';
    const started_at = status === 'todo' ? null : cur.started_at || nowIso();
    const completed_at = status === 'done' ? cur.completed_at || nowIso() : null;
    return {
      ...draft,
      started_at,
      completed_at,
      title: String(fd.get('title')).trim(),
      notes: String(fd.get('notes')),
      category_id: fd.get('category_id') || null,
      priority: Number(fd.get('priority')) || 0,
      due_date: dueDate,
      due_time: dueDate ? fd.get('due_time') || null : null,
      recurrence,
      idea_id: fd.has('idea_id') ? fd.get('idea_id') || null : draft.idea_id || null,
      subtasks: subs.filter((s) => s.title.trim()).map((s) => ({ ...s })),
    };
  }
  async function persist(rec) {
    // Saves run one after another, so after the first one every save updates the same task.
    const current = savedId ? store.get('tasks', savedId) : null;
    savedId = await store.save('tasks', { ...rec, id: savedId || undefined, last_completed_at: current ? current.last_completed_at : rec.last_completed_at }, space);
  }

  function readSubs() {
    form.querySelectorAll('.sub-title').forEach((inp) => { const s = subs[Number(inp.dataset.i)]; if (s) s.title = inp.value; });
  }
  function addPendingSub() {
    const inp = $('#sub-new', form);
    const v = inp.value.trim();
    if (v) { subs.push({ id: uid(), title: v, done: false }); inp.value = ''; }
  }
  function drawSubs() { form.querySelector('[data-subs]').innerHTML = subsHtml(); }
  function showRepeat() {
    const freq = form.elements.freq.value;
    form.querySelector('[data-show="repeat"]').hidden = !freq;
    form.querySelector('[data-show="weekly"]').hidden = freq !== 'weekly';
    form.querySelector('[data-unit]').textContent = UNITS[freq] || '';
  }
  $('#sub-new', form).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); readSubs(); addPendingSub(); drawSubs(); $('#sub-new', form).focus(); }
  });
  showRepeat();
}
