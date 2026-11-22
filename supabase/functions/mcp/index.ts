// Synaptask MCP server: the Claude connector.
//
// Claude signs in through Supabase Auth's OAuth 2.1 server and calls these tools with the
// user's access token. Every query runs through Row Level Security as that user. The token
// carries a client_id claim, which the database uses to keep the connector out of the Work
// vault except while the user has approved a time-limited grant in the app
// (supabase/migrations/0002_work_access.sql). Without a grant, add_work_task seals new work
// tasks to the vault's public key and the connector cannot read anything back.
// Only apps on the user's trusted list (recorded by the consent page after an authenticator
// code, 0003_trusted_clients.sql) get anywhere; every tool checks that first.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@^2.4.0';
import { pipeline } from 'npm:@supabase/middleware@^1.0.0';
import { withOAuthProtectedResource, withSupabase } from 'npm:@supabase/server@^1.9.2';
import { z } from 'npm:zod@^4.3.6';

import type { Database, Json } from '../_shared/database.types.ts';
import { anchorRule, describeRule, nextDue, type Rule } from '../_shared/recurrence.ts';
import { remindAt, safeTimeZone, todayIn } from '../_shared/time.ts';
import { sealTo, type Sealed } from '../_shared/seal.ts';
import { decryptItem, encryptItem, openGrant } from '../_shared/workvault.ts';
import { sendPush } from '../_shared/push.ts';

const GRANT_KEY = Deno.env.get('GRANT_PRIVATE_JWK') ?? '';
const VAPID = Deno.env.get('VAPID_PRIVATE_JWK') ?? '';
const CONTACT = Deno.env.get('VAPID_CONTACT') ?? '';
const REQUEST_PUSH_EVERY_MS = 2 * 60 * 1000;
const UNTRUSTED = 'This connection is not on the trusted list in Synaptask, so it cannot see or change anything. ' +
  'It was disconnected in Synaptask → Settings, or approved without the Synaptask consent page. ' +
  'To use it, remove the Synaptask connector in Claude, add it again and approve it in Synaptask.';

const PRIORITY = ['none', 'low', 'medium', 'high'] as const;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const STAGES = ['idea', 'planning', 'building', 'done'] as const;
const VIEWS = ['open', 'today', 'overdue', 'upcoming', 'inbox', 'completed', 'all'] as const;

const id = z.uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const priority = z.enum(PRIORITY);
const recurrence = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).optional().describe('Every N days/weeks/months/years. Default 1.'),
  days: z.array(z.enum(DOW)).max(7).optional().describe('Weekly only: the weekdays it falls on.'),
});
const httpUrl = z.url({ protocol: /^https?$/ }).max(2000);
const viewArg = z.enum(VIEWS).default('open');
const searchArg = z.string().max(200).optional().describe('Text to look for in titles, notes and steps');
const limitArg = z.number().int().min(1).max(200).default(50);

// Fields shared by personal and work tasks.
const addFields = {
  title: z.string().min(1).max(500),
  notes: z.string().max(20000).optional(),
  priority: priority.optional(),
  due_date: date.optional(),
  due_time: time.optional().describe('Needs due_date. A reminder fires at this time (else 09:00 on the due date).'),
  recurrence: recurrence.optional(),
  steps: z.array(z.string().min(1).max(300)).max(100).optional().describe('Subtasks'),
};
const updateFields = {
  id,
  title: z.string().min(1).max(500).optional(),
  notes: z.string().max(20000).optional(),
  priority: priority.optional(),
  due_date: date.nullable().optional(),
  due_time: time.nullable().optional(),
  recurrence: recurrence.nullable().optional(),
  steps: z.array(z.object({ title: z.string().min(1).max(300), done: z.boolean().default(false) })).max(100).optional(),
  add_steps: z.array(z.string().min(1).max(300)).max(100).optional(),
  completed: z.boolean().optional().describe('false re-opens a completed task. To complete, prefer the complete tool.'),
};
const UPDATE_HELP = 'Only the fields you pass change; pass null to clear a date, time, recurrence or category. ' +
  '`steps` replaces the whole step list; `add_steps` appends.';

type TaskRow = Database['public']['Tables']['tasks']['Row'];
type IdeaRow = Database['public']['Tables']['ideas']['Row'];
type ShopRow = Database['public']['Tables']['shopping_items']['Row'];
type Sub = { id: string; title: string; done: boolean };
type Cat = { id: string; name: string };
type RuleIn = z.infer<typeof recurrence>;
interface Task {
  id: string; title: string; notes: string; category_id: string | null; idea_id?: string | null; priority: number;
  due_date: string | null; due_time: string | null; recurrence: Rule | null; subtasks: Sub[];
  completed_at: string | null; last_completed_at?: string | null; remind_at?: string | null; source?: string;
  [extra: string]: unknown;
}
type AddArgs = { title: string; notes?: string; priority?: (typeof PRIORITY)[number]; due_date?: string; due_time?: string; recurrence?: RuleIn; steps?: string[] };
type UpdateArgs = {
  title?: string; notes?: string; priority?: (typeof PRIORITY)[number]; due_date?: string | null; due_time?: string | null;
  recurrence?: RuleIn | null; steps?: { title: string; done: boolean }[]; add_steps?: string[]; completed?: boolean;
};

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const toRule = (r: RuleIn | null | undefined, due: string | null): Rule | null =>
  r ? anchorRule({ freq: r.freq, interval: r.interval ?? 1, days: (r.days || []).map((d) => DOW.indexOf(d)) }, due) : null;
const subsOf = (v: unknown): Sub[] => (Array.isArray(v) ? (v as Sub[]) : []);
const newSub = (title: string, done = false): Sub => ({ id: crypto.randomUUID(), title: title.slice(0, 300), done });
const fromRow = (r: TaskRow): Task => ({ ...r, recurrence: r.recurrence as unknown as Rule | null, subtasks: subsOf(r.subtasks) });
const toDb = (p: Partial<Task>) => p as unknown as Database['public']['Tables']['tasks']['Update'];
const matchesSearch = (t: Task, s: string) =>
  `${t.title}\n${t.notes}\n${t.subtasks.map((x) => x.title).join('\n')}`.toLowerCase().includes(s.toLowerCase());

function findCategory(cats: Cat[], input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input.trim() === '') return null;
  const want = input.trim().toLowerCase();
  const hit = cats.find((c) => c.id === input) || cats.find((c) => c.name.toLowerCase() === want);
  if (!hit) {
    throw new Error(`There is no category "${input}". Categories: ${cats.map((c) => c.name).join(', ') || '(none)'}. ` +
      'Leave the category empty for no category.');
  }
  return hit.id;
}

/** Resolve a shopping category name (or id); null/'' means no category. */
function findShopCategory(cats: Cat[], input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input.trim() === '') return null;
  const want = input.trim().toLowerCase();
  const hit = cats.find((c) => c.id === input) || cats.find((c) => c.name.toLowerCase() === want);
  if (!hit) {
    throw new Error(`There is no shopping category "${input}". Shopping categories: ${cats.map((c) => c.name).join(', ') || '(none)'}. ` +
      'Leave the category empty for no category.');
  }
  return hit.id;
}

function shopOut(i: ShopRow, cats: Cat[]) {
  return {
    id: i.id,
    title: i.title,
    ...(i.quantity ? { quantity: i.quantity } : {}),
    category: i.category_id ? cats.find((c) => c.id === i.category_id)?.name ?? null : null,
    ...(i.notes ? { notes: i.notes } : {}),
    ...(i.idea_id ? { idea_id: i.idea_id } : {}),
    bought: !!i.bought_at,
  };
}

function taskOut(t: Task, cats: Cat[]) {
  return {
    id: t.id,
    title: t.title,
    ...(t.notes ? { notes: t.notes } : {}),
    category: t.category_id ? cats.find((c) => c.id === t.category_id)?.name ?? null : null,
    priority: PRIORITY[t.priority] ?? 'none',
    due_date: t.due_date,
    ...(t.due_time ? { due_time: t.due_time } : {}),
    ...(t.recurrence ? { repeats: describeRule(t.recurrence) } : {}),
    ...(t.subtasks.length ? { steps: t.subtasks.map((s) => ({ title: s.title, done: !!s.done })) } : {}),
    done: !!t.completed_at,
    ...(t.idea_id ? { idea_id: t.idea_id } : {}),
    ...(t.source === 'claude' ? { added_by_claude: true } : {}),
  };
}

/** Fields of a new task (personal or work). */
function newTask(a: AddArgs, zone: string, categoryId: string | null) {
  const due = a.due_date ?? (a.recurrence ? todayIn(zone) : null);
  const dueTime = due ? a.due_time ?? null : null;
  return {
    title: a.title.trim(), notes: a.notes ?? '', category_id: categoryId, priority: PRIORITY.indexOf(a.priority ?? 'none'),
    due_date: due, due_time: dueTime, recurrence: toRule(a.recurrence, due), remind_at: remindAt(due, dueTime, zone),
    subtasks: (a.steps ?? []).map((s) => newSub(s)), completed_at: null, source: 'claude',
  };
}

/** The changed fields for update_task / update_work_task. */
function taskUpdate(t: Task, a: UpdateArgs, zone: string): Partial<Task> {
  const patch: Partial<Task> = {};
  if (a.title !== undefined) patch.title = a.title.trim();
  if (a.notes !== undefined) patch.notes = a.notes;
  if (a.priority !== undefined) patch.priority = PRIORITY.indexOf(a.priority);
  let subs = t.subtasks;
  if (a.steps) {
    const pool = [...subs]; // keep each step's id when its title is unchanged
    subs = a.steps.map((s) => {
      const i = pool.findIndex((x) => x.title === s.title);
      return i >= 0 ? { ...pool.splice(i, 1)[0], done: s.done } : newSub(s.title, s.done);
    });
  }
  if (a.add_steps) subs = [...subs, ...a.add_steps.map((s) => newSub(s))];
  if (a.steps || a.add_steps) patch.subtasks = subs.slice(0, 100);

  let due = a.due_date !== undefined ? a.due_date : t.due_date;
  let rule = a.recurrence !== undefined ? toRule(a.recurrence, due) : t.recurrence;
  if (rule && !due) due = todayIn(zone);
  if (rule && (a.recurrence !== undefined || a.due_date !== undefined)) rule = anchorRule(rule, due);
  const dueTime = due ? (a.due_time !== undefined ? a.due_time : t.due_time) : null;
  let completedAt = t.completed_at;
  if (a.completed === false) completedAt = null;
  if (a.completed === true && !completedAt) completedAt = new Date().toISOString();
  return {
    ...patch, due_date: due, due_time: dueTime, recurrence: rule, completed_at: completedAt,
    remind_at: completedAt ? null : remindAt(due, dueTime, zone),
  };
}

/** Completing: a repeating task moves to its next date instead. */
function taskCompletion(t: Task, zone: string): { patch: Partial<Task>; message: string } {
  const now = new Date().toISOString();
  if (t.recurrence) {
    const next = nextDue(t.due_date, t.recurrence, todayIn(zone));
    return {
      patch: { due_date: next, last_completed_at: now, subtasks: t.subtasks.map((s) => ({ ...s, done: false })), remind_at: remindAt(next, t.due_time, zone) },
      message: `Done. “${t.title}” repeats (${describeRule(t.recurrence)}); next due ${next}.`,
    };
  }
  return { patch: { completed_at: now, remind_at: null }, message: `Completed “${t.title}”.` };
}

function inView(t: Task, view: (typeof VIEWS)[number], today: string): boolean {
  if (view === 'completed') return !!t.completed_at;
  if (view !== 'all' && t.completed_at) return false;
  if (view === 'today') return !!t.due_date && t.due_date <= today;
  if (view === 'overdue') return !!t.due_date && t.due_date < today;
  if (view === 'upcoming') return !!t.due_date && t.due_date > today;
  if (view === 'inbox') return !t.category_id;
  return true;
}
const byDue = (a: Task, b: Task) =>
  (a.due_date || '9999') < (b.due_date || '9999') ? -1 : (a.due_date || '9999') > (b.due_date || '9999') ? 1 : b.priority - a.priority;

Deno.serve(
  pipeline(
    [withOAuthProtectedResource(), withSupabase<Database>({ auth: 'user' })],
    async (req, { supabase, supabaseAdmin, userClaims }) => {
      const uid = userClaims?.id ?? '';

      // ------------------------------------------------------------ per-request helpers

      // The database already refuses apps that are not on the user's trusted list
      // (0003_trusted_clients.sql); this turns the resulting empty answers into a clear message.
      let trustCheck: Promise<void> | null = null;
      const assertTrusted = () => trustCheck ??= (async () => {
        const { data, error } = await supabase.rpc('oauth_client_trusted');
        if (error) throw new Error(error.message);
        if (data !== true) throw new Error(UNTRUSTED);
      })();

      let tzCache: string | null = null;
      const tz = async () => {
        if (tzCache) return tzCache;
        const { data } = await supabase.from('user_settings').select('timezone').maybeSingle();
        tzCache = safeTimeZone(data?.timezone);
        return tzCache;
      };

      let catCache: Cat[] | null = null;
      const categories = async () => {
        if (catCache) return catCache;
        const { data, error } = await supabase.from('categories').select('id, name, position').is('deleted_at', null).order('position');
        if (error) throw new Error(error.message);
        catCache = data;
        return catCache;
      };

      const getTask = async (taskId: string) => {
        const { data, error } = await supabase.from('tasks').select('*').eq('id', taskId).is('deleted_at', null).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`No task with id ${taskId}. Use list_tasks to find it.`);
        return fromRow(data);
      };
      const saveTask = async (taskId: string, patch: Partial<Task>) => {
        const { data, error } = await supabase.from('tasks').update(toDb(patch)).eq('id', taskId).select('*').single();
        if (error) throw new Error(error.message);
        return fromRow(data);
      };

      // ------------------------------------------------------------ shopping list

      let shopCatCache: Cat[] | null = null;
      const shopCategories = async () => {
        if (shopCatCache) return shopCatCache;
        const { data, error } = await supabase.from('shopping_categories').select('id, name, position').is('deleted_at', null).order('position');
        if (error) throw new Error(error.message);
        shopCatCache = data;
        return shopCatCache;
      };
      const getShopItem = async (itemId: string) => {
        const { data, error } = await supabase.from('shopping_items').select('*').eq('id', itemId).is('deleted_at', null).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`No shopping item with id ${itemId}. Use list_shopping to find it.`);
        return data;
      };

      const ideaOut = (i: IdeaRow, full: boolean) => ({
        id: i.id,
        title: i.title,
        stage: i.stage,
        ...(i.notes ? { notes: full || i.notes.length <= 400 ? i.notes : `${i.notes.slice(0, 400)}… (use list_ideas with id for the full notes)` } : {}),
        ...((i.tags as string[])?.length ? { tags: i.tags } : {}),
        ...((i.links as string[])?.length ? { links: i.links } : {}),
      });

      // ------------------------------------------------------------ Work section (needs a grant)

      /** Ask the user's app for access: shown in Work, plus a push at most every 2 minutes. */
      const requestWorkAccess = async () => {
        const { data: prev } = await supabase.from('work_access_requests').select('requested_at').maybeSingle();
        const now = Date.now();
        const { error } = await supabase.from('work_access_requests').upsert({ user_id: uid, requested_at: new Date(now).toISOString() }, { onConflict: 'user_id' });
        if (error) throw new Error(error.message); // never push for a request the database refused
        if (prev && now - Date.parse(prev.requested_at) < REQUEST_PUSH_EVERY_MS) return;
        if (!VAPID || !CONTACT || !uid) return;
        const { data: subs } = await supabaseAdmin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', uid);
        for (const s of subs ?? []) {
          const r = await sendPush(s, { title: 'Claude wants to use your Work section', body: 'Open Synaptask to allow or deny.', url: './#/work', tag: 'work-access' }, VAPID, CONTACT);
          if (r === 'gone') await supabaseAdmin.from('push_subscriptions').delete().eq('id', s.id);
        }
      };

      /** The vault key from an active grant, or null. With `ask`, a missing grant sends an access request. */
      const workKey = async (ask: boolean): Promise<{ key: CryptoKey; until: string } | null> => {
        const { data: grant, error } = await supabase.from('work_grants').select('sealed_key, expires_at').maybeSingle();
        if (error) throw new Error(error.message);
        if (!grant || Date.parse(grant.expires_at) <= Date.now()) {
          if (ask) await requestWorkAccess();
          return null;
        }
        if (!GRANT_KEY) throw new Error('Claude access to Work is not set up on the server: the GRANT_PRIVATE_JWK secret is missing (see README).');
        return { key: await openGrant(grant.sealed_key as unknown as Sealed, GRANT_KEY), until: grant.expires_at };
      };

      const LOCKED = 'The Work section is closed to Claude right now. An approval request was sent to the user\'s Synaptask app: ' +
        'ask them to open Synaptask → Work and tap Allow, then try again. (add_work_task works without approval.)';

      /** Decrypt the whole Work section. Throws LOCKED (after requesting access) without a grant. */
      const openWork = async () => {
        const g = await workKey(true);
        if (!g) throw new Error(LOCKED);
        const { data: rows, error } = await supabase.from('vault_items').select('id, ciphertext, iv').is('deleted_at', null);
        if (error) throw new Error(error.message);
        const cats: Cat[] = [], tasks: Task[] = [];
        for (const row of rows) {
          try {
            const { kind, ...o } = await decryptItem(g.key, row);
            if (kind === 'category') cats.push({ id: row.id, name: String(o.name ?? '') });
            else tasks.push({ ...(o as Partial<Task>), id: row.id, subtasks: subsOf(o.subtasks), recurrence: (o.recurrence ?? null) as Rule | null } as Task);
          } catch { /* written with another key: skip */ }
        }
        return { ...g, cats, tasks };
      };
      const writeWorkTask = async (key: CryptoKey, t: Task) => {
        const box = await encryptItem(key, t.id, { ...t, kind: 'task' });
        const { error } = await supabase.from('vault_items')
          .update({ ciphertext: box.ciphertext, iv: box.iv, remind_at: t.completed_at ? null : t.remind_at ?? null }).eq('id', t.id);
        if (error) throw new Error(error.message);
      };
      const workTask = (w: { tasks: Task[] }, taskId: string) => {
        const t = w.tasks.find((x) => x.id === taskId);
        if (!t) throw new Error(`No work task with id ${taskId}. Use list_work_tasks to find it.`);
        return t;
      };
      const until = (iso: string) => `Claude's access to Work ends ${iso}.`;

      // ------------------------------------------------------------ server

      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: 'synaptask', version: '1.2.0' });
        // Every tool first checks that this app is on the user's trusted list.
        const register = server.registerTool.bind(server);
        server.registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
          register(name, config as never, (async (...a: unknown[]) => {
            await assertTrusted();
            return cb(...a);
          }) as never)) as typeof server.registerTool;

        server.registerTool('list_categories', {
          title: 'List categories',
          description: 'List the personal task categories (name and id).',
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        }, async () => text((await categories()).map((c) => ({ id: c.id, name: c.name }))));

        server.registerTool('list_tasks', {
          title: 'List tasks',
          description: 'List personal tasks. Views: open (default, all unfinished), today (due today or overdue), overdue, ' +
            'upcoming (due after today), inbox (no category), completed, all. Dates are in the user\'s time zone.',
          inputSchema: z.object({
            view: viewArg,
            category: z.string().max(100).optional().describe('Category name or id'),
            idea_id: id.optional().describe('Only tasks belonging to this project idea'),
            search: searchArg,
            limit: limitArg,
          }),
          annotations: { readOnlyHint: true },
        }, async ({ view, category, idea_id, search, limit }) => {
          const today = todayIn(await tz());
          let q = supabase.from('tasks').select('*').is('deleted_at', null);
          if (view === 'completed') q = q.not('completed_at', 'is', null);
          else if (view !== 'all') q = q.is('completed_at', null);
          if (view === 'today') q = q.lte('due_date', today);
          if (view === 'overdue') q = q.lt('due_date', today);
          if (view === 'upcoming') q = q.gt('due_date', today);
          if (view === 'inbox') q = q.is('category_id', null);
          const cats = await categories();
          const catId = findCategory(cats, category);
          if (catId) q = q.eq('category_id', catId);
          if (idea_id) q = q.eq('idea_id', idea_id);
          q = view === 'completed'
            ? q.order('completed_at', { ascending: false })
            : q.order('due_date', { ascending: true, nullsFirst: false }).order('priority', { ascending: false });
          const { data, error } = await q.limit(search ? 1000 : limit);
          if (error) throw new Error(error.message);
          let rows = data.map(fromRow);
          if (search) rows = rows.filter((t) => matchesSearch(t, search));
          rows = rows.slice(0, limit);
          return text({ today, count: rows.length, tasks: rows.map((t) => taskOut(t, cats)) });
        });

        server.registerTool('add_task', {
          title: 'Add a task',
          description: 'Add a personal task. With a recurrence but no due date it starts today. For work tasks use add_work_task.',
          inputSchema: z.object({
            ...addFields,
            category: z.string().max(100).optional().describe('Category name or id. Omit for the Inbox.'),
            idea_id: id.optional().describe('Attach to a project idea'),
          }),
        }, async (a) => {
          const cats = await categories();
          const fields = newTask(a, await tz(), findCategory(cats, a.category) ?? null);
          const { data, error } = await supabase.from('tasks').insert({ ...toDb(fields), idea_id: a.idea_id ?? null }).select('*').single();
          if (error) throw new Error(error.message);
          return text({ added: taskOut(fromRow(data), cats) });
        });

        server.registerTool('update_task', {
          title: 'Update a task',
          description: `Change a personal task. ${UPDATE_HELP}`,
          inputSchema: z.object({ ...updateFields, category: z.string().max(100).nullable().optional(), idea_id: id.nullable().optional() }),
        }, async (a) => {
          const t = await getTask(a.id);
          const cats = await categories();
          const patch = taskUpdate(t, a, await tz());
          const cat = findCategory(cats, a.category);
          if (cat !== undefined) patch.category_id = cat;
          if (a.idea_id !== undefined) patch.idea_id = a.idea_id;
          return text({ updated: taskOut(await saveTask(a.id, patch), cats) });
        });

        server.registerTool('complete_task', {
          title: 'Complete a task',
          description: 'Mark a personal task done. A recurring task is not closed: it moves to its next due date.',
          inputSchema: z.object({ id }),
        }, async ({ id: taskId }) => {
          const t = await getTask(taskId);
          if (t.completed_at) return text(`“${t.title}” was already done.`);
          const { patch, message } = taskCompletion(t, await tz());
          await saveTask(taskId, patch);
          return text(message);
        });

        server.registerTool('delete_task', {
          title: 'Delete a task',
          description: 'Delete a personal task.',
          inputSchema: z.object({ id }),
          annotations: { destructiveHint: true },
        }, async ({ id: taskId }) => {
          const t = await getTask(taskId);
          await saveTask(taskId, { deleted_at: new Date().toISOString(), remind_at: null });
          return text(`Deleted “${t.title}”.`);
        });

        server.registerTool('list_ideas', {
          title: 'List project ideas',
          description: 'List project ideas (stages: idea, planning, building, done). Pass an id to get one idea in full with its tasks.',
          inputSchema: z.object({ id: id.optional(), stage: z.enum(STAGES).optional(), search: z.string().max(200).optional() }),
          annotations: { readOnlyHint: true },
        }, async ({ id: ideaId, stage, search }) => {
          if (ideaId) {
            const { data: idea, error } = await supabase.from('ideas').select('*').eq('id', ideaId).is('deleted_at', null).maybeSingle();
            if (error) throw new Error(error.message);
            if (!idea) throw new Error(`No idea with id ${ideaId}.`);
            const { data: tasks } = await supabase.from('tasks').select('*').eq('idea_id', ideaId).is('deleted_at', null);
            const cats = await categories();
            return text({ ...ideaOut(idea, true), tasks: (tasks ?? []).map((t) => taskOut(fromRow(t), cats)) });
          }
          let q = supabase.from('ideas').select('*').is('deleted_at', null).order('created_at', { ascending: false });
          if (stage) q = q.eq('stage', stage);
          const { data, error } = await q.limit(500);
          if (error) throw new Error(error.message);
          const s = search?.toLowerCase();
          const rows = s ? data.filter((i) => `${i.title}\n${i.notes}\n${JSON.stringify(i.tags)}`.toLowerCase().includes(s)) : data;
          return text({ count: rows.length, ideas: rows.map((i) => ideaOut(i, false)) });
        });

        server.registerTool('add_idea', {
          title: 'Add a project idea',
          description: 'Capture a project idea on the ideas board.',
          inputSchema: z.object({
            title: z.string().min(1).max(300),
            notes: z.string().max(50000).optional(),
            stage: z.enum(STAGES).default('idea'),
            tags: z.array(z.string().min(1).max(50)).max(20).optional(),
            links: z.array(httpUrl).max(30).optional(),
          }),
        }, async (a) => {
          const { data, error } = await supabase.from('ideas').insert({
            title: a.title.trim(), notes: a.notes ?? '', stage: a.stage,
            tags: [...new Set((a.tags ?? []).map((t) => t.trim().replace(/^#/, '')))] as unknown as Json,
            links: (a.links ?? []) as unknown as Json,
          }).select('*').single();
          if (error) throw new Error(error.message);
          return text({ added: ideaOut(data, true) });
        });

        server.registerTool('update_idea', {
          title: 'Update a project idea',
          description: 'Change a project idea. `append_notes` adds text to the end of the notes instead of replacing them.',
          inputSchema: z.object({
            id,
            title: z.string().min(1).max(300).optional(),
            notes: z.string().max(50000).optional(),
            append_notes: z.string().max(20000).optional(),
            stage: z.enum(STAGES).optional(),
            tags: z.array(z.string().min(1).max(50)).max(20).optional(),
            links: z.array(httpUrl).max(30).optional(),
          }),
        }, async (a) => {
          const { data: idea, error: e1 } = await supabase.from('ideas').select('*').eq('id', a.id).is('deleted_at', null).maybeSingle();
          if (e1) throw new Error(e1.message);
          if (!idea) throw new Error(`No idea with id ${a.id}.`);
          const patch: Database['public']['Tables']['ideas']['Update'] = {};
          if (a.title !== undefined) patch.title = a.title.trim();
          if (a.stage !== undefined) patch.stage = a.stage;
          if (a.tags !== undefined) patch.tags = [...new Set(a.tags.map((t) => t.trim().replace(/^#/, '')))] as unknown as Json;
          if (a.links !== undefined) patch.links = a.links as unknown as Json;
          let notes = a.notes !== undefined ? a.notes : idea.notes;
          if (a.append_notes) notes = notes ? `${notes}\n\n${a.append_notes}` : a.append_notes;
          if (notes.length > 50000) throw new Error('The notes would be longer than 50,000 characters.');
          if (a.notes !== undefined || a.append_notes) patch.notes = notes;
          const { data, error } = await supabase.from('ideas').update(patch).eq('id', a.id).select('*').single();
          if (error) throw new Error(error.message);
          return text({ updated: ideaOut(data, true) });
        });

        // ---------------------------------------------------------- Shopping list

        server.registerTool('list_shopping', {
          title: 'List the shopping list',
          description: 'What is on the shopping list, with its categories (for example Groceries, For projects, Fun). ' +
            'Bought items are left out unless include_bought is true.',
          inputSchema: z.object({
            category: z.string().max(100).optional().describe('Only this shopping category (name)'),
            include_bought: z.boolean().default(false),
            search: z.string().max(200).optional(),
          }),
          annotations: { readOnlyHint: true },
        }, async (a) => {
          const cats = await shopCategories();
          const catId = findShopCategory(cats, a.category);
          let q = supabase.from('shopping_items').select('*').is('deleted_at', null).order('created_at');
          if (!a.include_bought) q = q.is('bought_at', null);
          if (catId) q = q.eq('category_id', catId);
          const { data, error } = await q.limit(500);
          if (error) throw new Error(error.message);
          const s = a.search?.toLowerCase();
          const rows = s ? data.filter((i) => `${i.title}\n${i.quantity}\n${i.notes}`.toLowerCase().includes(s)) : data;
          return text({ categories: cats.map((c) => c.name), count: rows.length, items: rows.map((i) => shopOut(i, cats)) });
        });

        server.registerTool('add_shopping_items', {
          title: 'Add to the shopping list',
          description: 'Add one or more things to buy. Use the user\'s shopping category names (list_shopping shows them).',
          inputSchema: z.object({
            items: z.array(z.object({
              title: z.string().min(1).max(300),
              quantity: z.string().max(50).optional().describe('e.g. "2", "1 kg", "a pack"'),
              category: z.string().max(100).optional().describe('Shopping category name'),
              notes: z.string().max(5000).optional(),
              idea_id: id.optional().describe('The project idea this is for (list_ideas shows ids)'),
            })).min(1).max(50),
          }),
        }, async (a) => {
          const cats = await shopCategories();
          const rows = a.items.map((i) => ({
            title: i.title.trim(), quantity: (i.quantity ?? '').trim(), notes: i.notes ?? '',
            category_id: findShopCategory(cats, i.category) ?? null, idea_id: i.idea_id ?? null, source: 'claude',
          }));
          const added = [];
          for (const r of rows) {
            const { data, error } = await supabase.from('shopping_items').insert(r).select('*').single();
            if (error) throw new Error(error.message);
            added.push(shopOut(data, cats));
          }
          return text({ added });
        });

        server.registerTool('update_shopping_item', {
          title: 'Update a shopping list item',
          description: 'Change an item, or mark it bought (bought: true) or back on the list (bought: false). ' +
            'Pass null to clear the category or the project.',
          inputSchema: z.object({
            id,
            title: z.string().min(1).max(300).optional(),
            quantity: z.string().max(50).optional(),
            category: z.string().max(100).nullable().optional(),
            notes: z.string().max(5000).optional(),
            idea_id: id.nullable().optional(),
            bought: z.boolean().optional(),
          }),
        }, async (a) => {
          const item = await getShopItem(a.id);
          const cats = await shopCategories();
          const patch: Database['public']['Tables']['shopping_items']['Update'] = {};
          if (a.title !== undefined) patch.title = a.title.trim();
          if (a.quantity !== undefined) patch.quantity = a.quantity.trim();
          if (a.notes !== undefined) patch.notes = a.notes;
          if (a.category !== undefined) patch.category_id = findShopCategory(cats, a.category) ?? null;
          if (a.idea_id !== undefined) patch.idea_id = a.idea_id;
          if (a.bought !== undefined) patch.bought_at = a.bought ? (item.bought_at ?? new Date().toISOString()) : null;
          const { data, error } = await supabase.from('shopping_items').update(patch).eq('id', a.id).select('*').single();
          if (error) throw new Error(error.message);
          return text({ updated: shopOut(data, cats) });
        });

        server.registerTool('delete_shopping_item', {
          title: 'Remove from the shopping list',
          description: 'Remove an item from the shopping list entirely. To tick it off instead, use update_shopping_item with bought: true.',
          inputSchema: z.object({ id }),
          annotations: { destructiveHint: true },
        }, async ({ id: itemId }) => {
          const item = await getShopItem(itemId);
          const { error } = await supabase.from('shopping_items').update({ deleted_at: new Date().toISOString() }).eq('id', itemId);
          if (error) throw new Error(error.message);
          return text(`Removed “${item.title}” from the shopping list.`);
        });

        // ---------------------------------------------------------- Work

        server.registerTool('add_work_task', {
          title: 'Add a work task',
          description: 'Add a task to the locked Work section. Works at any time: while the user has granted Claude access it is ' +
            'saved directly; otherwise it is sealed for the Work vault and appears the next time the user unlocks Work.',
          inputSchema: z.object({ ...addFields, category: z.string().max(100).optional().describe('Work category name') }),
        }, async (a) => {
          const zone = await tz();
          const g = await workKey(false);
          if (g) {
            const w = await openWork();
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            const t: Task = { id, ...newTask(a, zone, findCategory(w.cats, a.category) ?? null), idea_id: null, last_completed_at: null, position: 0, created_at: now, deleted_at: null };
            const box = await encryptItem(w.key, id, { ...t, kind: 'task' });
            const { error } = await supabase.from('vault_items').insert({ id, ciphertext: box.ciphertext, iv: box.iv, remind_at: t.remind_at ?? null, created_at: now });
            if (error) throw new Error(error.message);
            return text({ added: taskOut(t, w.cats), note: until(w.until) });
          }
          const { data: jwk, error: e1 } = await supabase.rpc('vault_public_key');
          if (e1) throw new Error(e1.message);
          if (!jwk) throw new Error('The Work section has not been set up yet. Open Synaptask → Work once to create it.');
          const due = a.due_date ?? (a.recurrence ? todayIn(zone) : null);
          const sealed = await sealTo(jwk as JsonWebKey, {
            title: a.title.trim(),
            notes: a.notes ?? '',
            priority: PRIORITY.indexOf(a.priority ?? 'none'),
            due_date: due,
            due_time: due ? a.due_time ?? null : null,
            recurrence: toRule(a.recurrence, due),
            steps: a.steps ?? [],
            category: a.category ?? null,
          });
          // No .select(): without a grant the connector may insert into the inbox but not read it.
          const { error } = await supabase.from('vault_inbox').insert({ sealed: sealed as unknown as Json });
          if (error) throw new Error(error.message);
          return text('Added to the Work section (encrypted). It appears there the next time the Work section is unlocked.');
        });

        server.registerTool('list_work_categories', {
          title: 'List work categories',
          description: 'List the Work section\'s categories. Needs the user\'s approval in the app (requested automatically).',
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        }, async () => {
          const w = await openWork();
          return text({ categories: w.cats, note: until(w.until) });
        });

        server.registerTool('list_work_tasks', {
          title: 'List work tasks',
          description: 'List tasks in the Work section (same views as list_tasks). Needs the user\'s approval in the app: ' +
            'if Claude has no access, an approval request is sent and this returns an error asking the user to approve.',
          inputSchema: z.object({ view: viewArg, category: z.string().max(100).optional(), search: searchArg, limit: limitArg }),
          annotations: { readOnlyHint: true },
        }, async ({ view, category, search, limit }) => {
          const w = await openWork();
          const today = todayIn(await tz());
          const catId = findCategory(w.cats, category);
          let rows = w.tasks.filter((t) => inView(t, view, today) && (!catId || t.category_id === catId) && (!search || matchesSearch(t, search)));
          rows = view === 'completed' ? rows.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))) : rows.sort(byDue);
          rows = rows.slice(0, limit);
          return text({ today, count: rows.length, tasks: rows.map((t) => taskOut(t, w.cats)), note: until(w.until) });
        });

        server.registerTool('update_work_task', {
          title: 'Update a work task',
          description: `Change a task in the Work section (needs the user's approval in the app). ${UPDATE_HELP}`,
          inputSchema: z.object({ ...updateFields, category: z.string().max(100).nullable().optional().describe('Work category name') }),
        }, async (a) => {
          const w = await openWork();
          const t = workTask(w, a.id);
          const next: Task = { ...t, ...taskUpdate(t, a, await tz()) };
          const cat = findCategory(w.cats, a.category);
          if (cat !== undefined) next.category_id = cat;
          await writeWorkTask(w.key, next);
          return text({ updated: taskOut(next, w.cats) });
        });

        server.registerTool('complete_work_task', {
          title: 'Complete a work task',
          description: 'Mark a work task done (needs the user\'s approval in the app). A recurring task moves to its next due date.',
          inputSchema: z.object({ id }),
        }, async ({ id: taskId }) => {
          const w = await openWork();
          const t = workTask(w, taskId);
          if (t.completed_at) return text(`“${t.title}” was already done.`);
          const { patch, message } = taskCompletion(t, await tz());
          await writeWorkTask(w.key, { ...t, ...patch });
          return text(message);
        });

        server.registerTool('delete_work_task', {
          title: 'Delete a work task',
          description: 'Delete a task in the Work section (needs the user\'s approval in the app).',
          inputSchema: z.object({ id }),
          annotations: { destructiveHint: true },
        }, async ({ id: taskId }) => {
          const w = await openWork();
          const t = workTask(w, taskId);
          const { error } = await supabase.from('vault_items')
            .update({ ciphertext: '', iv: '', remind_at: null, deleted_at: new Date().toISOString() }).eq('id', taskId);
          if (error) throw new Error(error.message);
          return text(`Deleted “${t.title}”.`);
        });

        return server;
      }, { onerror: (error) => console.error('MCP request failed', error) });

      return handler.fetch(req);
    },
  ),
);
