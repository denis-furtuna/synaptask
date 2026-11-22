// deno test -A supabase/functions/tests/mcp_test.ts
// Runs the real MCP function against a tiny mock of the Supabase REST API, with JWTs signed by a
// test key, and talks to it the way Claude does (JSON-RPC over Streamable HTTP).
import * as vault from '../../../web/js/vault.js';
import { nextDue } from '../_shared/recurrence.ts';
import { todayIn } from '../_shared/time.ts';

const FN_PORT = 18731, DB_PORT = 18732;
const DB = `http://127.0.0.1:${DB_PORT}`;
const FN = `http://127.0.0.1:${FN_PORT}/functions/v1/mcp`;
const USER = '11111111-1111-4111-8111-111111111111';

// ------------------------------------------------------------------ test signing key + JWT

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
async function jwt(claims: Record<string, unknown>) {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ iat: now, exp: now + 600, aud: 'authenticated', iss: `${DB}/auth/v1`, ...claims }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// ------------------------------------------------------------------ mock REST API

const { record: vaultRecord } = await vault.create('test passphrase long');
// The server's Work-access key pair (tools/keys.html makes the real one).
const grantPair = await crypto.subtle.generateKey(
  { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
const grantPublic = await crypto.subtle.exportKey('jwk', grantPair.publicKey);
const grantPrivate = JSON.stringify(await crypto.subtle.exportKey('jwk', grantPair.privateKey));
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  user_settings: [{ user_id: USER, timezone: 'Europe/Bucharest' }],
  categories: [{ id: 'c0000000-0000-4000-8000-000000000001', name: 'Home', position: 0, deleted_at: null }],
  tasks: [], ideas: [], vault_inbox: [], vault_items: [], work_grants: [], work_access_requests: [], push_subscriptions: [],
  shopping_categories: [
    { id: 's0000000-0000-4000-8000-000000000001', name: 'Groceries', position: 0, deleted_at: null },
    { id: 's0000000-0000-4000-8000-000000000002', name: 'For projects', position: 1, deleted_at: null },
  ],
  shopping_items: [],
};
const seen: string[] = [];
/** The user's trusted apps (trusted_clients); the mock answers rpc/oauth_client_trusted from it. */
const trustedClients = new Set(['claude']);

function filterRows(rows: Row[], params: URLSearchParams) {
  return rows.filter((r) => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'or', 'columns'].includes(k)) continue;
      if (v === 'is.null' && r[k] != null) return false;
      if (v.startsWith('eq.') && String(r[k]) !== v.slice(3)) return false;
    }
    return true;
  });
}

const dbServer = Deno.serve({ port: DB_PORT, hostname: '127.0.0.1', onListen() {} }, async (req) => {
  const url = new URL(req.url);
  seen.push(`${req.method} ${url.pathname}${url.search}`);
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return Response.json({ message: 'no token forwarded' }, { status: 401 });
  const single = (req.headers.get('accept') || '').includes('vnd.pgrst.object');
  const send = (rows: Row[]) => (single ? (rows.length ? Response.json(rows[0]) : Response.json({ code: 'PGRST116' }, { status: 406 })) : Response.json(rows));
  if (url.pathname === '/rest/v1/rpc/vault_public_key') return Response.json(vaultRecord.public_key);
  if (url.pathname === '/rest/v1/rpc/oauth_client_trusted') {
    const claims = JSON.parse(atob(auth.slice(7).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Response.json(trustedClients.has(claims.client_id));
  }
  const table = url.pathname.replace('/rest/v1/', '');
  const rows = tables[table];
  if (!rows) return Response.json({ message: `unknown table ${table}` }, { status: 404 });
  if (req.method === 'GET') return send(filterRows(rows, url.searchParams));
  if (req.method === 'POST') {
    const body = await req.json();
    const now = new Date().toISOString();
    const conflict = url.searchParams.get('on_conflict');
    const existing = conflict ? rows.find((r) => r[conflict] === body[conflict]) : null;
    const row = existing ? Object.assign(existing, body, { updated_at: now })
      : { id: crypto.randomUUID(), user_id: USER, created_at: now, updated_at: now, deleted_at: null, completed_at: null,
        notes: '', priority: 0, subtasks: [], tags: [], links: [], source: 'app', ...body };
    if (!existing) rows.push(row);
    return (req.headers.get('prefer') || '').includes('return=representation') ? send([row]) : new Response(null, { status: 201 });
  }
  if (req.method === 'PATCH') {
    const patch = await req.json();
    const hit = filterRows(rows, url.searchParams);
    for (const r of hit) Object.assign(r, patch, { updated_at: new Date().toISOString() });
    return (req.headers.get('prefer') || '').includes('return=representation') ? send(hit) : new Response(null, { status: 204 });
  }
  return new Response('unsupported', { status: 405 });
});

// ------------------------------------------------------------------ the function under test

const fn = new Deno.Command(Deno.execPath(), {
  args: ['run', '-A', '--no-check', new URL('../mcp/index.ts', import.meta.url).href],
  env: {
    DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${FN_PORT}`,
    SUPABASE_URL: DB,
    SUPABASE_JWKS: JSON.stringify({ keys: [jwk] }),
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }),
    SUPABASE_FUNCTION_SLUG: 'mcp',
    GRANT_PRIVATE_JWK: grantPrivate,
  },
  stdout: 'piped', stderr: 'piped',
}).spawn();
const logs: string[] = [];
(async () => { for await (const c of fn.stderr.pipeThrough(new TextDecoderStream())) logs.push(c); })();
(async () => { for await (const c of fn.stdout.pipeThrough(new TextDecoderStream())) logs.push(c); })();

for (let i = 0; ; i++) {
  try { await fetch(`${FN}/oauth-protected-resource`).then((r) => r.body?.cancel()); break; } catch {
    if (i > 100) throw new Error(`function did not start:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params: unknown = {}) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  const data = raw.includes('data:') ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : raw;
  let body: any = null;
  try { body = JSON.parse(data); } catch { body = raw; }
  return { status: res.status, headers: res.headers, body };
}
const call = async (token: string, name: string, args: unknown) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const result = r.body?.result;
  if (!result) throw new Error(`no result for ${name}: ${JSON.stringify(r.body)}\n${logs.join('')}`);
  const txt = result.content?.[0]?.text ?? '';
  let parsed: any = txt;
  try { parsed = JSON.parse(txt); } catch { /* plain text */ }
  return { isError: !!result.isError, text: txt, json: parsed };
};
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(`${msg}\n--- function logs ---\n${logs.join('').slice(-3000)}`); }

const token = await jwt({ sub: USER, role: 'authenticated', aal: 'aal2', email: 'me@example.com', client_id: 'claude' });

Deno.test({ name: 'mcp: discovery and auth', sanitizeResources: false, sanitizeOps: false }, async () => {
  const meta = await fetch(`${FN}/oauth-protected-resource`).then((r) => r.json());
  assert(meta.resource?.endsWith('/functions/v1/mcp'), `resource metadata: ${JSON.stringify(meta)}`);
  assert(meta.authorization_servers?.[0]?.endsWith('/auth/v1'), 'authorization server listed');
  const anon = await rpc(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert(anon.status === 401, `no token -> 401 (got ${anon.status})`);
  assert(/resource_metadata=/.test(anon.headers.get('www-authenticate') || ''), 'WWW-Authenticate points at the metadata');
  const forged = await rpc(token.slice(0, -6) + 'AAAAAA', 'tools/list');
  assert(forged.status === 401, `bad signature -> 401 (got ${forged.status})`);
});

Deno.test({ name: 'mcp: tools', sanitizeResources: false, sanitizeOps: false }, async () => {
  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert(init.body?.result?.serverInfo?.name === 'synaptask', `initialize: ${JSON.stringify(init.body)}`);
  const list = await rpc(token, 'tools/list');
  const names = (list.body?.result?.tools || []).map((t: any) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['add_idea', 'add_shopping_items', 'add_task', 'add_work_task', 'complete_task', 'complete_work_task',
    'delete_shopping_item', 'delete_task', 'delete_work_task', 'list_categories', 'list_ideas', 'list_shopping', 'list_tasks',
    'list_work_categories', 'list_work_tasks', 'update_idea', 'update_shopping_item', 'update_task', 'update_work_task']), `tools: ${names}`);

  const added = await call(token, 'add_task', {
    title: 'Water the plants', category: 'home', priority: 'medium', due_date: '2026-11-20', due_time: '09:30',
    recurrence: { freq: 'weekly', days: ['mon', 'fri'] }, steps: ['Kitchen', 'Balcony'],
  });
  assert(!added.isError, `add_task: ${added.text}`);
  const row = tables.tasks[0];
  assert(row.source === 'claude', 'source = claude');
  assert(row.category_id === 'c0000000-0000-4000-8000-000000000001', 'category resolved by name, case-insensitive');
  assert(row.remind_at === '2026-11-20T07:30:00.000Z', `remind_at in the user's zone (got ${row.remind_at})`);
  assert(JSON.stringify(row.recurrence) === JSON.stringify({ freq: 'weekly', interval: 1, days: [1, 5] }), `rule ${JSON.stringify(row.recurrence)}`);
  assert(added.json.added.repeats === 'Every week on Mon, Fri', 'rule described back');

  const badCat = await call(token, 'add_task', { title: 'x', category: 'Nope' });
  assert(badCat.isError && /Home/.test(badCat.text), `unknown category -> helpful error: ${badCat.text}`);
  const badDate = await call(token, 'add_task', { title: 'x', due_date: '20-11-2026' });
  assert(badDate.isError, 'invalid date rejected by the schema');

  const done = await call(token, 'complete_task', { id: row.id });
  // The next date depends on today (it always lands after today), so compute what to expect.
  const expected = nextDue('2026-11-20', { freq: 'weekly', interval: 1, days: [1, 5] }, todayIn('Europe/Bucharest'));
  assert(!done.isError && done.text.includes(`next due ${expected}`), `recurring completes forward to ${expected}: ${done.text}`);
  assert(row.completed_at === null && row.due_date === expected, 'still open, moved to the next Mon/Fri');

  const upd = await call(token, 'update_task', { id: row.id, recurrence: null, due_date: null, add_steps: ['Garden'] });
  assert(!upd.isError, `update_task: ${upd.text}`);
  assert(row.remind_at === null && row.due_date === null && row.recurrence === null, 'cleared date and rule');
  assert((row.subtasks as unknown[]).length === 3, 'step appended');

  const fin = await call(token, 'complete_task', { id: row.id });
  assert(!fin.isError && row.completed_at, 'one-off task completes');

  const idea = await call(token, 'add_idea', { title: 'Home lab dashboard', tags: ['#homelab'], links: ['https://example.com'] });
  assert(!idea.isError && tables.ideas.length === 1 && JSON.stringify(tables.ideas[0].tags) === '["homelab"]', `add_idea: ${idea.text}`);
  const badLink = await call(token, 'add_idea', { title: 'x', links: ['javascript:alert(1)'] });
  assert(badLink.isError, 'non-http link rejected');
  const app = await call(token, 'update_idea', { id: tables.ideas[0].id, append_notes: 'Use Grafana', stage: 'planning' });
  assert(!app.isError && tables.ideas[0].notes === 'Use Grafana' && tables.ideas[0].stage === 'planning', `update_idea: ${app.text}`);

  const work = await call(token, 'add_work_task', { title: 'Prepare the Q4 review', priority: 'high', due_date: '2026-11-21' });
  assert(!work.isError, `add_work_task: ${work.text}`);
  assert(!seen.some((s) => s.startsWith('GET /rest/v1/vault_inbox')), 'never reads the inbox');
  const sealed = tables.vault_inbox[0].sealed as { wk: string; iv: string; ct: string };
  assert(!JSON.stringify(sealed).includes('Prepare the Q4 review'), 'stored sealed, not plain'); // spaces never occur in base64
  const opened = await vault.openSealed(sealed); // the vault from vault.create() above is still unlocked
  assert(opened.title === 'Prepare the Q4 review' && opened.priority === 3, `the app can open it: ${JSON.stringify(opened)}`);

  const listed = await call(token, 'list_tasks', { view: 'all' });
  assert(!listed.isError && listed.json.today && listed.json.tasks.length === 1, `list_tasks: ${listed.text}`);
});

Deno.test({ name: 'mcp: work section with and without a grant', sanitizeResources: false, sanitizeOps: false }, async () => {
  // The app's existing work data, encrypted by web/js/vault.js
  const catId = 'd0000000-0000-4000-8000-000000000001';
  const taskId = 'd0000000-0000-4000-8000-000000000002';
  for (const [id, obj] of [
    [catId, { kind: 'category', id: catId, name: 'Clients', color: '#4fa3e5', position: 0 }],
    [taskId, { kind: 'task', id: taskId, title: 'Send the invoice', notes: '', category_id: catId, priority: 2, due_date: '2026-11-16',
      due_time: null, recurrence: { freq: 'monthly', interval: 1, day: 16 }, subtasks: [], completed_at: null, source: 'app', position: 0 }],
  ] as const) {
    const box = await vault.encryptItem(id, obj);
    tables.vault_items.push({ id, user_id: USER, ciphertext: box.ciphertext, iv: box.iv, remind_at: null, deleted_at: null });
  }
  const openRow = (id: string) => {
    const r = tables.vault_items.find((x) => x.id === id)!;
    return vault.decryptItem({ id, iv: r.iv as string, ciphertext: r.ciphertext as string });
  };

  // 1. No grant: reading asks the user, adding goes to the sealed inbox.
  const locked = await call(token, 'list_work_tasks', {});
  assert(locked.isError && /Allow/.test(locked.text), `locked -> asks for approval: ${locked.text}`);
  assert(tables.work_access_requests.length === 1 && tables.work_access_requests[0].user_id === USER, 'access request recorded');
  await call(token, 'list_work_categories', {});
  assert(tables.work_access_requests.length === 1, 'asking again updates the same request');
  const inboxBefore = tables.vault_inbox.length;
  const queued = await call(token, 'add_work_task', { title: 'Book the venue', category: 'Clients', steps: ['Call', 'Pay deposit'], recurrence: { freq: 'yearly' } });
  assert(!queued.isError && tables.vault_inbox.length === inboxBefore + 1, `no grant -> inbox: ${queued.text}`);
  const q = await vault.openSealed(tables.vault_inbox.at(-1)!.sealed as never);
  assert(q.category === 'Clients' && q.steps.length === 2 && q.recurrence?.freq === 'yearly' && q.due_date, `inbox carries category, steps, rule: ${JSON.stringify(q)}`);

  // 2. The user taps Allow: the app seals the vault key to the server's grant key.
  const raw = await vault.exportVaultKey();
  const b64 = btoa(String.fromCharCode(...raw));
  raw.fill(0);
  tables.work_grants.push({ user_id: USER, sealed_key: await vault.sealTo(grantPublic, { v: 1, k: b64 }, 'work-grant'), expires_at: new Date(Date.now() + 3600e3).toISOString() });

  const cats = await call(token, 'list_work_categories', {});
  assert(!cats.isError && cats.json.categories[0]?.name === 'Clients', `work categories: ${cats.text}`);
  const list = await call(token, 'list_work_tasks', { view: 'today' });
  assert(!list.isError && list.json.tasks.length === 1 && list.json.tasks[0].title === 'Send the invoice' && list.json.tasks[0].category === 'Clients', `list_work_tasks: ${list.text}`);
  assert(/ends/.test(list.json.note), 'tells Claude when access ends');

  const add = await call(token, 'add_work_task', { title: 'Prepare slides', category: 'clients', due_date: '2026-11-18', due_time: '15:00', steps: ['Outline'] });
  assert(!add.isError, `add_work_task with grant: ${add.text}`);
  const newRow = tables.vault_items.at(-1)!;
  assert(newRow.remind_at === '2026-11-18T13:00:00.000Z', `only the reminder time is plain (got ${newRow.remind_at})`);
  const added = await openRow(newRow.id as string);
  assert(added.kind === 'task' && added.title === 'Prepare slides' && added.category_id === catId && added.source === 'claude' && added.subtasks.length === 1,
    `the app can decrypt what the server wrote: ${JSON.stringify(added)}`);

  const upd = await call(token, 'update_work_task', { id: taskId, title: 'Send the November invoice', priority: 'high' });
  assert(!upd.isError, `update_work_task: ${upd.text}`);
  const updated = await openRow(taskId);
  assert(updated.title === 'Send the November invoice' && updated.priority === 3 && updated.position === 0, `update kept other fields: ${JSON.stringify(updated)}`);

  const done = await call(token, 'complete_work_task', { id: taskId });
  assert(!done.isError && /next due 2026-12-16/.test(done.text), `monthly work task moves forward: ${done.text}`);
  assert((await openRow(taskId)).due_date === '2026-12-16', 'stored with the next date');

  const del = await call(token, 'delete_work_task', { id: newRow.id });
  assert(!del.isError && newRow.deleted_at && newRow.ciphertext === '', `delete wipes the ciphertext: ${del.text}`);

  // 3. The grant runs out.
  tables.work_grants[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const after = await call(token, 'list_work_tasks', {});
  assert(after.isError && /Allow/.test(after.text), 'expired grant -> locked again');
});

Deno.test({ name: 'mcp: shopping list', sanitizeResources: false, sanitizeOps: false }, async () => {
  const added = await call(token, 'add_shopping_items', { items: [
    { title: 'Milk', quantity: '2 l', category: 'groceries' },
    { title: 'PLA filament', category: 'For projects', notes: 'black' },
    { title: 'Batteries' },
  ] });
  assert(!added.isError && added.json.added.length === 3, `add_shopping_items: ${added.text}`);
  const milk = tables.shopping_items.find((r) => r.title === 'Milk')!;
  assert(milk.category_id === 's0000000-0000-4000-8000-000000000001' && milk.quantity === '2 l' && milk.source === 'claude',
    `category resolved by name, case-insensitive: ${JSON.stringify(milk)}`);
  assert(tables.shopping_items.find((r) => r.title === 'Batteries')!.category_id === null, 'no category');

  const badCat = await call(token, 'add_shopping_items', { items: [{ title: 'x', category: 'Nope' }] });
  assert(badCat.isError && /Groceries/.test(badCat.text) && !tables.shopping_items.some((r) => r.title === 'x'),
    `unknown shopping category -> helpful error, nothing added: ${badCat.text}`);

  const list = await call(token, 'list_shopping', {});
  assert(!list.isError && list.json.count === 3 && list.json.categories.join() === 'Groceries,For projects', `list_shopping: ${list.text}`);
  const onlyProjects = await call(token, 'list_shopping', { category: 'for projects' });
  assert(onlyProjects.json.count === 1 && onlyProjects.json.items[0].title === 'PLA filament', `category filter: ${onlyProjects.text}`);

  const bought = await call(token, 'update_shopping_item', { id: milk.id, bought: true, quantity: '3 l' });
  assert(!bought.isError && milk.bought_at && milk.quantity === '3 l', `mark bought: ${bought.text}`);
  const after = await call(token, 'list_shopping', {});
  assert(after.json.count === 2 && !after.json.items.some((i: any) => i.title === 'Milk'), 'bought items are left out');
  const withBought = await call(token, 'list_shopping', { include_bought: true });
  assert(withBought.json.count === 3 && withBought.json.items.find((i: any) => i.title === 'Milk').bought === true, 'include_bought shows them');

  const moved = await call(token, 'update_shopping_item', { id: milk.id, bought: false, category: null });
  assert(!moved.isError && milk.bought_at === null && milk.category_id === null, `back on the list, category cleared: ${moved.text}`);

  const bat = tables.shopping_items.find((r) => r.title === 'Batteries')!;
  const del = await call(token, 'delete_shopping_item', { id: bat.id });
  assert(!del.isError && bat.deleted_at, `delete_shopping_item: ${del.text}`);
  const missing = await call(token, 'update_shopping_item', { id: bat.id, bought: true });
  assert(missing.isError && /No shopping item/.test(missing.text), 'deleted item is gone');
});

Deno.test({ name: 'mcp: an app that is not on the trusted list gets nothing', sanitizeResources: false, sanitizeOps: false }, async () => {
  const evil = await jwt({ sub: USER, role: 'authenticated', aal: 'aal2', email: 'me@example.com', client_id: 'look-alike' });
  const list = await rpc(evil, 'tools/list');
  assert((list.body?.result?.tools || []).length === 19, 'tools/list still answers (nothing secret in it)');
  const before = seen.length;
  for (const [name, args] of [['list_tasks', {}], ['add_task', { title: 'planted' }], ['list_work_tasks', {}], ['add_work_task', { title: 'planted' }],
    ['list_shopping', {}], ['add_shopping_items', { items: [{ title: 'planted' }] }]] as const) {
    const r = await call(evil, name, args);
    assert(r.isError && /not on the trusted list/.test(r.text), `${name} refused for an untrusted app: ${r.text}`);
  }
  const touched = seen.slice(before).filter((s) => !s.includes('/rpc/oauth_client_trusted'));
  assert(touched.length === 0, `untrusted app reached the database: ${touched.join(', ')}`);

  // Disconnected in Settings while Claude still holds a valid token: refused on the next call.
  trustedClients.delete('claude');
  const cut = await call(token, 'list_tasks', {});
  assert(cut.isError && /not on the trusted list/.test(cut.text), `disconnected app refused: ${cut.text}`);
  trustedClients.add('claude');
  const back = await call(token, 'list_tasks', {});
  assert(!back.isError, `reconnected app works again: ${back.text}`);
});

Deno.test({ name: 'mcp: cleanup', sanitizeResources: false, sanitizeOps: false }, async () => {
  fn.kill();
  await fn.status;
  await dbServer.shutdown();
  vault.lock();
});
