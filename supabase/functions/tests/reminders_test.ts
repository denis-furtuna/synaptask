// deno test -A supabase/functions/tests/reminders_test.ts
// Runs the real reminders function against a mock Supabase API, a mock push service and a mock Resend.
const FN_PORT = 18741, DB_PORT = 18742;
const DB = `http://127.0.0.1:${DB_PORT}`;
const FN = `http://127.0.0.1:${FN_PORT}/functions/v1/reminders`;
const SECRET = 'sb_secret_test_reminders';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// VAPID key (server) and a browser-like push subscription key (client)
const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const vapidJwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
const client = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const p256dh = b64url(await crypto.subtle.exportKey('raw', client.publicKey));
const authSecret = b64url(crypto.getRandomValues(new Uint8Array(16)));

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  tasks: [
    { id: 't1', user_id: A, title: 'Call the bank', due_date: '2026-11-16', due_time: '10:00', remind_at: iso(now - 60000), reminded_at: null, completed_at: null, deleted_at: null },
    { id: 't2', user_id: A, title: 'Not yet', due_date: '2026-11-17', due_time: null, remind_at: iso(now + 3600000), reminded_at: null, completed_at: null, deleted_at: null },
    { id: 't3', user_id: A, title: 'Too old', due_date: '2026-11-01', due_time: null, remind_at: iso(now - 3 * 86400000), reminded_at: null, completed_at: null, deleted_at: null },
    { id: 't4', user_id: B, title: 'B task', due_date: '2026-11-16', due_time: null, remind_at: iso(now - 1000), reminded_at: null, completed_at: null, deleted_at: null },
  ],
  vault_items: [
    { id: 'w1', user_id: A, remind_at: iso(now - 5000), reminded_at: null, deleted_at: null },
  ],
  user_settings: [
    { user_id: A, push_reminders: true, email_reminders: true },
    { user_id: B, push_reminders: false, email_reminders: false },
  ],
  work_grants: [
    { user_id: A, sealed_key: {}, expires_at: iso(now - 1000) },
    { user_id: B, sealed_key: {}, expires_at: iso(now + 3600000) },
  ],
  work_access_requests: [{ user_id: A, requested_at: iso(now - 2 * 86400000) }],
  push_subscriptions: [
    { id: 'p1', user_id: A, endpoint: 'https://push.test/push/ok', p256dh, auth: authSecret },
    { id: 'p2', user_id: A, endpoint: 'https://push.test/push/gone', p256dh, auth: authSecret },
  ],
};
const pushes: { endpoint: string; headers: Headers }[] = [];
const emails: any[] = [];

function match(r: Row, k: string, v: string) {
  const [op, ...rest] = v.split('.');
  const val = rest.join('.');
  if (op === 'is' && val === 'null') return r[k] == null;
  if (op === 'eq') return String(r[k]) === val;
  if (op === 'lte') return String(r[k]) <= val;
  if (op === 'gt') return String(r[k]) > val;
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/"/g, '')).includes(String(r[k]));
  return true;
}
const filterRows = (rows: Row[], p: URLSearchParams) =>
  rows.filter((r) => [...p].every(([k, v]) => ['select', 'order', 'limit', 'columns'].includes(k) || match(r, k, v)));

const server = Deno.serve({ port: DB_PORT, hostname: '127.0.0.1', onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/push/')) {
    pushes.push({ endpoint: url.pathname, headers: req.headers });
    await req.arrayBuffer();
    return new Response(null, { status: url.pathname.endsWith('gone') ? 410 : 201 });
  }
  if (url.pathname === '/resend') { emails.push(await req.json()); return Response.json({ id: 'e1' }); }
  if (req.headers.get('apikey') !== SECRET) return Response.json({ message: 'admin key expected' }, { status: 401 });
  const m = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
  if (m) return Response.json({ id: m[1], email: m[1] === A ? 'a@example.com' : 'b@example.com' });
  const rows = tables[url.pathname.replace('/rest/v1/', '')];
  if (!rows) return Response.json({ message: 'unknown' }, { status: 404 });
  const hit = filterRows(rows, url.searchParams);
  if (req.method === 'GET') return Response.json(hit);
  if (req.method === 'PATCH') { const patch = await req.json(); hit.forEach((r) => Object.assign(r, patch)); return Response.json(hit); }
  if (req.method === 'DELETE') {
    tables[url.pathname.replace('/rest/v1/', '')] = rows.filter((r) => !hit.includes(r));
    return (req.headers.get('prefer') || '').includes('return=representation') ? Response.json(hit) : new Response(null, { status: 204 });
  }
  return new Response(null, { status: 405 });
});

const fn = new Deno.Command(Deno.execPath(), {
  args: ['run', '-A', '--no-check', new URL('./_push_shim.ts', import.meta.url).href],
  env: {
    DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${FN_PORT}`,
    SUPABASE_URL: DB,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
    SUPABASE_JWKS: JSON.stringify({ keys: [] }),
    VAPID_PRIVATE_JWK: JSON.stringify(vapidJwk),
    VAPID_CONTACT: 'mailto:test@example.com',
    RESEND_API_KEY: 're_test',
    RESEND_API_URL: `${DB}/resend`,
    APP_URL: 'https://example.github.io/synaptask',
    TEST_PUSH_TARGET: DB,
  },
  stdout: 'piped', stderr: 'piped',
}).spawn();
const logs: string[] = [];
(async () => { for await (const c of fn.stderr.pipeThrough(new TextDecoderStream())) logs.push(c); })();
(async () => { for await (const c of fn.stdout.pipeThrough(new TextDecoderStream())) logs.push(c); })();
for (let i = 0; ; i++) {
  try { await fetch(FN, { method: 'OPTIONS' }).then((r) => r.body?.cancel()); break; } catch {
    if (i > 100) throw new Error(`function did not start:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(`${msg}\n--- logs ---\n${logs.join('').slice(-3000)}`); }

Deno.test({ name: 'reminders', sanitizeResources: false, sanitizeOps: false }, async () => {
  const denied = await fetch(FN, { method: 'POST', headers: { apikey: 'wrong' } });
  await denied.body?.cancel();
  assert(denied.status === 401, `wrong key -> 401 (got ${denied.status})`);

  const res = await fetch(FN, { method: 'POST', headers: { apikey: SECRET, 'content-type': 'application/json' }, body: '{}' });
  const out = await res.json();
  assert(res.status === 200, `run: ${res.status} ${JSON.stringify(out)}`);
  assert(out.tasks === 2 && out.work === 1, `claimed due rows only: ${JSON.stringify(out)}`);
  const byId = Object.fromEntries(tables.tasks.map((t) => [t.id, t]));
  assert(byId.t1.reminded_at && byId.t4.reminded_at, 'due tasks marked');
  assert(!byId.t2.reminded_at && !byId.t3.reminded_at, 'future and stale tasks untouched');

  const ok = pushes.filter((p) => p.endpoint === '/push/ok');
  assert(ok.length === 2, `user A: one task push + one work push on the live device (got ${ok.length})`);
  // pushforge sends the older "aesgcm" coding; Chrome, Firefox and WebKit all decrypt it.
  assert(ok.every((p) => ['aesgcm', 'aes128gcm'].includes(p.headers.get('content-encoding') || '') && /^vapid t=/.test(p.headers.get('authorization') || '')), 'encrypted, VAPID-signed');
  assert(!tables.push_subscriptions.some((s) => s.id === 'p2'), 'expired subscription (410) removed');
  assert(out.removed_subscriptions === 1, 'reported removal');

  assert(emails.length === 1 && emails[0].to[0] === 'a@example.com', `one email, to A only (B has email off): ${JSON.stringify(emails)}`);
  assert(/Call the bank/.test(emails[0].text) && /2026-11-16 10:00/.test(emails[0].text), 'email lists the task');
  assert(!/work/i.test(emails[0].text.split('You get this')[0]), 'no work content in email');
  assert(/https:\/\/example\.github\.io\/synaptask\/#\/today/.test(emails[0].text), 'link to the app');

  assert(out.expired_grants === 1 && tables.work_grants.length === 1 && tables.work_grants[0].user_id === B, `expired grant deleted, active kept: ${JSON.stringify(out)}`);
  assert(tables.work_access_requests.length === 0, 'stale access request cleaned up');

  const again = await fetch(FN, { method: 'POST', headers: { apikey: SECRET } }).then((r) => r.json());
  assert(again.tasks === 0 && again.work === 0, `second run sends nothing: ${JSON.stringify(again)}`);
});

Deno.test({ name: 'reminders: cleanup', sanitizeResources: false, sanitizeOps: false }, async () => {
  fn.kill();
  await fn.status;
  await server.shutdown();
});
