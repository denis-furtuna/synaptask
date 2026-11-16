// deno test -A supabase/tests/rls_test.ts
// Applies the migrations to PGlite (Postgres compiled to WebAssembly) with a stub of Supabase's
// auth schema, then checks Row Level Security as each kind of caller: the app, a password-only
// session, another user, the Claude connector, and anonymous visitors.
import { PGlite } from 'npm:@electric-sql/pglite@0.5.16';

const dir = new URL('../migrations/', import.meta.url);
const files = [...Deno.readDirSync(dir)].map((f) => f.name).filter((n) => n.endsWith('.sql')).sort();
const migration = files.map((f) => Deno.readTextFileSync(new URL(f, dir))).join('\n');
const db = new PGlite();

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create table auth.sessions (id uuid primary key, user_id uuid, oauth_client_id uuid, aal text, created_at timestamptz default clock_timestamp());
  -- Same definitions Supabase uses.
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  -- What Supabase's "Enable automatic RLS" option creates (0004_lockdown.sql revokes it from the API).
  create function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$ begin end $$;
`);
await db.exec(migration);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
await db.exec(`insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com')`);

const failures: string[] = [];
const ok = (cond: unknown, msg: string) => { if (!cond) failures.push(msg); };

/** Run SQL as a caller. claims = null means anon. Returns { rows, error }. */
// deno-lint-ignore no-explicit-any
async function as(claims: Record<string, string> | null, sql: string, params: unknown[] = []): Promise<{ rows: any[]; affected?: number; error: any }> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
  await db.exec(`set role ${claims ? (claims.role || 'authenticated') : 'anon'}`);
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows, affected: r.affectedRows, error: null };
  } catch (e) {
    return { rows: [], error: e };
  } finally {
    await db.exec('reset role');
  }
}

const userA = { sub: A, role: 'authenticated', aal: 'aal2' };
const userAaal1 = { sub: A, role: 'authenticated', aal: 'aal1' };
const userB = { sub: B, role: 'authenticated', aal: 'aal2' };
// Supabase issues connector tokens at aal1; trust comes from the session bound at approval (0005).
const S1 = '5e550000-0000-4000-8000-000000000001', S2 = '5e550000-0000-4000-8000-000000000002', S3 = '5e550000-0000-4000-8000-000000000003';
const newSession = (id: string, user = A) => db.exec(`insert into auth.sessions (id, user_id, oauth_client_id, aal) values ('${id}', '${user}', 'c1a0de00-0000-4000-8000-000000000001', 'aal1')`);
const claudeA = { sub: A, role: 'authenticated', aal: 'aal1', client_id: 'c1a0de00-0000-4000-8000-000000000001', session_id: S1 };

Deno.test({ name: 'rls: every caller sees exactly what it should', sanitizeResources: false, sanitizeOps: false }, async () => {
  let r;
  // --- user A, full session
  r = await as(userA, `insert into public.categories (id, name, color) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Home', '#4fa3e5') returning user_id, updated_at`);
  ok(!r.error && r.rows[0]?.user_id === A, `A inserts category: ${r.error?.message}`);
  r = await as(userA, `insert into public.tasks (id, title, due_date, due_time, remind_at, subtasks, recurrence)
    values ('aaaaaaaa-0000-4000-8000-000000000002', 'Task A', '2026-11-20', '09:30', '2026-11-20T08:30:00Z', '[{"id":"s1","title":"x","done":false}]', '{"freq":"weekly","interval":1,"days":[1]}')`);
  ok(!r.error, `A inserts task: ${r.error?.message}`);
  r = await as(userA, `insert into public.ideas (title, tags, links) values ('Idea A', '["pwa"]', '["https://example.com"]')`);
  ok(!r.error, `A inserts idea: ${r.error?.message}`);
  r = await as(userA, `insert into public.vaults (user_id, record, public_key) values ($1, '{"version":1}', '{"kty":"RSA","n":"x","e":"AQAB"}')`, [A]);
  ok(!r.error, `A inserts vault: ${r.error?.message}`);
  r = await as(userA, `insert into public.vaults (record, public_key) values ('{"version":2}', '{"kty":"RSA"}')`);
  ok(r.error?.code === '23505', `second vault insert must be a unique violation (got ${r.error?.code} ${r.error?.message})`);
  r = await as(userA, `insert into public.vault_items (id, ciphertext, iv, remind_at) values ('aaaaaaaa-0000-4000-8000-000000000003', 'CIPHER', 'IV', '2026-11-20T08:00:00Z')`);
  ok(!r.error, `A inserts vault item: ${r.error?.message}`);
  r = await as(userA, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/1', 'p', 'a')`);
  ok(!r.error, `A inserts push sub: ${r.error?.message}`);
  r = await as(userA, `insert into public.user_settings (timezone) values ('Europe/Bucharest')`);
  ok(!r.error, `A inserts settings: ${r.error?.message}`);
  r = await as(userA, `insert into public.user_settings (user_id, timezone) values ($1, 'Europe/Paris') on conflict (user_id) do update set timezone = excluded.timezone`, [A]);
  ok(!r.error, `A upserts settings: ${r.error?.message}`);

  // upsert like PostgREST does (conflict on id)
  r = await as(userA, `insert into public.tasks (id, title, priority) values ('aaaaaaaa-0000-4000-8000-000000000002', 'Task A edited', 2)
    on conflict (id) do update set title = excluded.title, priority = excluded.priority`);
  ok(!r.error, `A upserts own task: ${r.error?.message}`);

  // --- triggers
  await db.exec(`update public.tasks set reminded_at = now() where id = 'aaaaaaaa-0000-4000-8000-000000000002'`);
  r = await as(userA, `update public.tasks set title = 'same reminder' where id = 'aaaaaaaa-0000-4000-8000-000000000002' returning reminded_at`);
  ok(r.rows[0]?.reminded_at !== null, 'reminded_at kept when remind_at unchanged');
  r = await as(userA, `update public.tasks set remind_at = '2026-11-21T08:30:00Z' where id = 'aaaaaaaa-0000-4000-8000-000000000002' returning reminded_at`);
  ok(r.rows[0]?.reminded_at === null, 'reminded_at reset when remind_at changes');
  r = await as(userA, `select updated_at > created_at as bumped from public.tasks where id = 'aaaaaaaa-0000-4000-8000-000000000002'`);
  ok(r.rows[0]?.bumped === true, 'updated_at bumped by trigger');
  r = await as(userA, `insert into public.categories (name, updated_at) values ('Spoof', '2000-01-01') returning updated_at`);
  ok(new Date(r.rows[0]?.updated_at).getFullYear() > 2020, 'client cannot set updated_at');
  // (distinct updated_at per row needs microsecond clocks; PGlite only has milliseconds,
  //  and the client pages on (updated_at, id) so equal timestamps are safe anyway)

  // --- check constraints
  for (const [sql, what] of [
    [`insert into public.tasks (title, priority) values ('x', 5)`, 'priority 5'],
    [`insert into public.tasks (title, due_time) values ('x', '25:00')`, 'due_time 25:00'],
    [`insert into public.tasks (title, source) values ('x', 'evil')`, 'source evil'],
    [`insert into public.tasks (title, subtasks) values ('x', '{}')`, 'subtasks object'],
    [`insert into public.ideas (title, stage) values ('x', 'someday')`, 'stage someday'],
    [`insert into public.categories (name, color) values ('x', 'red;}')`, 'bad colour'],
    [`insert into public.tasks (title) values (repeat('x', 501))`, 'title 501 chars'],
    [`insert into public.vault_inbox (sealed) values ('{"wk":"a"}')`, 'sealed missing keys'],
    [`insert into public.push_subscriptions (endpoint, p256dh, auth) values ('http://insecure', 'p', 'a')`, 'http endpoint'],
    [`insert into public.user_settings (user_id, timezone) values ('${A}', 'Europe/Paris; drop')`, 'bad timezone'],
  ]) {
    r = await as(userA, sql);
    ok(r.error && /^2[23]/.test(r.error.code), `${what} must be rejected by a constraint (got ${r.error?.code || 'no error'})`);
  }

  // --- password only (aal1): nothing
  for (const t of ['categories', 'tasks', 'ideas', 'vault_items', 'vaults', 'push_subscriptions', 'user_settings', 'vault_inbox']) {
    r = await as(userAaal1, `select count(*)::int n from public.${t}`);
    ok(r.rows[0]?.n === 0, `aal1 reads nothing from ${t} (got ${r.rows[0]?.n})`);
  }
  r = await as(userAaal1, `insert into public.tasks (title) values ('sneaky')`);
  ok(r.error?.code === '42501', `aal1 cannot insert (got ${r.error?.code})`);

  // --- another user
  r = await as(userB, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'B sees none of A\'s tasks');
  r = await as(userB, `update public.tasks set title = 'hijack' where id = 'aaaaaaaa-0000-4000-8000-000000000002'`);
  ok(!r.error && r.affected === 0, 'B cannot update A\'s task');
  r = await as(userB, `insert into public.tasks (user_id, title) values ($1, 'planted')`, [A]);
  ok(r.error?.code === '42501', `B cannot insert rows for A (got ${r.error?.code})`);
  r = await as(userB, `insert into public.tasks (id, title) values ('aaaaaaaa-0000-4000-8000-000000000002', 'steal') on conflict (id) do update set title = excluded.title`);
  ok(r.error?.code === '42501', `B upsert onto A's id fails (got ${r.error?.code})`);
  r = await as(userB, `select public.vault_public_key() k`);
  ok(r.rows[0]?.k === null, 'B gets no public key for A');

  // --- trusted apps (0003_trusted_clients.sql): only the app itself, with MFA, edits the list
  r = await as(claudeA, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'connector reads nothing before its app is trusted');
  r = await as(claudeA, `insert into public.trusted_clients (client_id) values ('c1a0de00-0000-4000-8000-000000000001')`);
  ok(r.error?.code === '42501', `connector cannot trust itself (got ${r.error?.code})`);
  r = await as(userAaal1, `insert into public.trusted_clients (client_id) values ('c1a0de00-0000-4000-8000-000000000001')`);
  ok(r.error?.code === '42501', `password-only session cannot trust an app (got ${r.error?.code})`);
  r = await as(userB, `insert into public.trusted_clients (user_id, client_id) values ($1, 'c1a0de00-0000-4000-8000-000000000001')`, [A]);
  ok(r.error?.code === '42501', `B cannot trust an app for A (got ${r.error?.code})`);
  r = await as(userA, `insert into public.trusted_clients (client_id, name, redirect_uri) values ('c1a0de00-0000-4000-8000-000000000001', 'Claude', 'https://claude.ai/api/mcp/auth_callback')
    on conflict (user_id, client_id) do update set name = excluded.name returning user_id`);
  ok(!r.error && r.rows[0]?.user_id === A, `app trusts Claude: ${r.error?.message}`);
  r = await as(claudeA, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'trusted app without a session yet reads nothing');
  await newSession(S1); // Claude exchanges its code: the first session after the approval
  await newSession(S2); // a later session of the same app (password-only attacker reusing the client id)
  r = await as({ ...claudeA, session_id: S2 }, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'a second session of the trusted app reads nothing');
  r = await as({ ...claudeA, session_id: S2 }, `insert into public.tasks (title) values ('second session')`);
  ok(r.error?.code === '42501', `a second session of the trusted app cannot write (got ${r.error?.code})`);
  r = await as({ sub: A, role: 'authenticated', aal: 'aal1', client_id: claudeA.client_id }, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'a token without session_id reads nothing');
  r = await as({ ...claudeA, sub: B }, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'the session is bound to its user');
  await db.exec(`set session_replication_role = replica; update public.trusted_clients set updated_at = updated_at - interval '11 minutes'; set session_replication_role = origin;`);
  r = await as(claudeA, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'a session created more than 10 minutes after the approval reads nothing');
  await db.exec(`set session_replication_role = replica; update public.trusted_clients set updated_at = updated_at + interval '11 minutes'; set session_replication_role = origin;`);
  r = await as(userA, `insert into public.trusted_clients (client_id) values ('${'x'.repeat(201)}')`);
  ok(r.error?.code === '23514', `over-long client id refused (got ${r.error?.code})`);
  r = await as(claudeA, `select count(*)::int n from public.trusted_clients`);
  ok(r.rows[0]?.n === 0, 'connector cannot read the trusted list');
  r = await as(claudeA, `delete from public.trusted_clients`);
  ok(r.affected === 0, 'connector cannot edit the trusted list');
  r = await as(userB, `select count(*)::int n from public.trusted_clients`);
  ok(r.rows[0]?.n === 0, 'B does not see A\'s trusted apps');
  r = await as(claudeA, `select public.oauth_client_trusted() t`);
  ok(r.rows[0]?.t === true, 'oauth_client_trusted() true for the trusted app');
  r = await as(userA, `select public.oauth_client_trusted() t`);
  ok(r.rows[0]?.t === false, 'oauth_client_trusted() false for a direct session');
  r = await as(null, `select public.oauth_client_trusted()`);
  ok(r.error?.code === '42501', `anon cannot call oauth_client_trusted (got ${r.error?.code})`);

  // an app approved some other way (look-alike app, or approved with only the password)
  const evilA = { ...claudeA, client_id: 'evil-client' };
  for (const t of ['categories', 'tasks', 'ideas', 'user_settings']) {
    r = await as(evilA, `select count(*)::int n from public.${t}`);
    ok(r.rows[0]?.n === 0, `untrusted app reads nothing from ${t} (got ${r.rows[0]?.n})`);
  }
  for (const [sql, what] of [
    [`insert into public.tasks (title) values ('evil')`, 'tasks'],
    [`insert into public.ideas (title) values ('evil')`, 'ideas'],
    [`insert into public.vault_inbox (sealed) values ('{"wk":"a","iv":"b","ct":"c"}')`, 'the Work inbox'],
    [`insert into public.work_access_requests (requested_at) values (now())`, 'work access requests'],
  ]) {
    r = await as(evilA, sql);
    ok(r.error?.code === '42501', `untrusted app cannot write ${what} (got ${r.error?.code})`);
  }
  r = await as(evilA, `update public.tasks set title = 'evil'`);
  ok(!r.error && r.affected === 0, 'untrusted app cannot change tasks');

  // every table an OAuth token could reach is covered by trusted_clients_only (or bans OAuth outright)
  r = await as({ role: 'service_role' }, `select c.relname t,
      bool_or(p.polname = 'trusted_clients_only' and p.polpermissive = false) trusted,
      bool_or(p.polname = 'no_oauth_clients' and p.polpermissive = false) banned
    from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_policy p on p.polrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r' group by c.relname`);
  for (const row of r.rows) ok(row.trusted || row.banned, `${row.t} must have trusted_clients_only or no_oauth_clients`);
  ok(r.rows.length >= 11, `policy coverage query saw every table (got ${r.rows.length})`);

  // --- Claude connector (OAuth token for A, trusted)
  r = await as(claudeA, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n >= 1, 'connector reads personal tasks');
  r = await as(claudeA, `insert into public.tasks (title, source) values ('from claude', 'claude')`);
  ok(!r.error, `connector adds task: ${r.error?.message}`);
  r = await as(claudeA, `update public.ideas set stage = 'planning' where title = 'Idea A'`);
  ok(!r.error && r.affected === 1, 'connector updates idea');
  for (const t of ['vault_items', 'vaults', 'push_subscriptions']) {
    r = await as(claudeA, `select count(*)::int n from public.${t}`);
    ok(r.rows[0]?.n === 0, `connector reads nothing from ${t}`);
  }
  r = await as(claudeA, `insert into public.vault_items (ciphertext, iv) values ('x', 'y')`);
  ok(r.error?.code === '42501', `connector cannot write vault_items (got ${r.error?.code})`);
  r = await as(claudeA, `update public.vaults set record = '{}'`);
  ok(!r.error && r.affected === 0, 'connector cannot change the vault');
  r = await as(claudeA, `select public.vault_public_key() k`);
  ok(r.rows[0]?.k?.kty === 'RSA', 'connector gets the vault public key');
  r = await as(claudeA, `insert into public.vault_inbox (sealed) values ('{"wk":"a","iv":"b","ct":"c"}')`);
  ok(!r.error, `connector drops a sealed work task: ${r.error?.message}`);
  r = await as(claudeA, `select count(*)::int n from public.vault_inbox`);
  ok(r.rows[0]?.n === 0, 'connector cannot read the inbox back');
  r = await as(claudeA, `delete from public.vault_inbox`);
  ok(r.affected === 0, 'connector cannot delete inbox items');
  r = await as(claudeA, `select timezone from public.user_settings`);
  ok(r.rows[0]?.timezone === 'Europe/Paris', 'connector reads the time zone');
  r = await as(claudeA, `update public.user_settings set email_reminders = false`);
  ok(!r.error && r.affected === 0, 'connector cannot change settings');
  r = await as(userAaal1, `select public.vault_public_key() k`);
  ok(r.rows[0]?.k === null, 'password-only session gets no vault public key');

  // --- the app reads and empties the inbox
  r = await as(userA, `select count(*)::int n from public.vault_inbox`);
  ok(r.rows[0]?.n === 1, 'app reads the inbox');
  r = await as(userA, `delete from public.vault_inbox`);
  ok(r.affected === 1, 'app deletes imported inbox items');

  // --- anonymous
  for (const t of ['tasks', 'vaults', 'user_settings']) {
    r = await as(null, `select count(*) from public.${t}`);
    ok(r.error?.code === '42501', `anon has no privilege on ${t} (got ${r.error?.code})`);
  }
  r = await as(null, `select public.vault_public_key()`);
  ok(r.error?.code === '42501', `anon cannot call vault_public_key (got ${r.error?.code})`);
  r = await as({ role: 'service_role' }, `select has_function_privilege('anon', 'public.rls_auto_enable()', 'execute') a,
    has_function_privilege('authenticated', 'public.rls_auto_enable()', 'execute') u`);
  ok(r.rows[0]?.a === false && r.rows[0]?.u === false, `rls_auto_enable() not callable through the API (${JSON.stringify(r.rows[0])})`);

  // --- reminder query shape used by the reminders function (service role)
  r = await as({ role: 'service_role' }, `select id from public.tasks where reminded_at is null and completed_at is null and deleted_at is null and remind_at <= '2026-11-22' and remind_at > '2026-11-20'`);
  ok(r.rows.length === 1, `service role finds the due task (got ${r.rows.length})`);

  // --- Claude access to Work (0002_work_access.sql)
  const sealedJson = `'{"wk":"a","iv":"b","ct":"c"}'`;
  r = await as(claudeA, `insert into public.work_grants (sealed_key, expires_at) values (${sealedJson}, now() + interval '1 hour')`);
  ok(r.error?.code === '42501', `connector cannot grant itself access (got ${r.error?.code})`);
  r = await as(userA, `insert into public.work_grants (sealed_key, expires_at) values (${sealedJson}, now() + interval '25 hours')`);
  ok(r.error?.code === '23514', `grant longer than 24 h refused (got ${r.error?.code})`);
  r = await as(userA, `insert into public.work_grants (sealed_key, expires_at) values (${sealedJson}, now() - interval '1 minute')`);
  ok(r.error?.code === '23514', `grant in the past refused (got ${r.error?.code})`);
  r = await as(claudeA, `select public.work_grant_active() a`);
  ok(r.rows[0]?.a === false, 'no grant yet');

  r = await as(claudeA, `insert into public.work_access_requests (user_id, requested_at) values ($1, now())
    on conflict (user_id) do update set requested_at = excluded.requested_at`, [A]);
  ok(!r.error, `connector can ask for access: ${r.error?.message}`);
  r = await as(claudeA, `insert into public.work_access_requests (user_id, requested_at) values ($1, now())
    on conflict (user_id) do update set requested_at = excluded.requested_at`, [A]);
  ok(!r.error, `connector can ask again (upsert): ${r.error?.message}`);
  r = await as(claudeA, `delete from public.work_access_requests`);
  ok(r.affected === 0, 'connector cannot clear the request');
  r = await as(userB, `select count(*)::int n from public.work_access_requests`);
  ok(r.rows[0]?.n === 0, 'B does not see A\'s request');

  r = await as(userA, `insert into public.work_grants (sealed_key, expires_at) values (${sealedJson}, now() + interval '2 hours')`);
  ok(!r.error, `app grants access: ${r.error?.message}`);
  r = await as(userA, `delete from public.work_access_requests`);
  ok(r.affected === 1, 'app clears the request');
  r = await as(claudeA, `select public.work_grant_active() a`);
  ok(r.rows[0]?.a === true, 'grant active');
  r = await as(claudeA, `select sealed_key from public.work_grants`);
  ok(r.rows.length === 1, 'connector reads its active grant');
  r = await as(claudeA, `select count(*)::int n from public.vault_items`);
  ok(r.rows[0]?.n === 1, `connector reads work items during the grant (got ${r.rows[0]?.n})`);
  r = await as(claudeA, `update public.vault_items set ciphertext = 'NEW' where id = 'aaaaaaaa-0000-4000-8000-000000000003'`);
  ok(!r.error && r.affected === 1, `connector updates a work item during the grant: ${r.error?.message}`);
  r = await as(claudeA, `insert into public.vault_items (ciphertext, iv) values ('x', 'y')`);
  ok(!r.error, `connector adds a work item during the grant: ${r.error?.message}`);
  r = await as(claudeA, `update public.work_grants set expires_at = now() + interval '20 hours'`);
  ok(!r.error && r.affected === 0, 'connector cannot extend the grant');
  r = await as(claudeA, `delete from public.work_grants`);
  ok(r.affected === 0, 'connector cannot delete the grant');
  for (const t of ['vaults', 'push_subscriptions']) {
    r = await as(claudeA, `select count(*)::int n from public.${t}`);
    ok(r.rows[0]?.n === 0, `still nothing from ${t} during a grant`);
  }
  const claudeB = { ...claudeA, sub: B };
  r = await as(claudeB, `select count(*)::int n from public.vault_items`);
  ok(r.rows[0]?.n === 0, 'A\'s grant does nothing for another user');

  // Disconnect in Settings: the trusted row goes, the connector is cut off at once (even mid-grant)
  r = await as(userA, `delete from public.trusted_clients where client_id = 'c1a0de00-0000-4000-8000-000000000001'`);
  ok(r.affected === 1, 'app disconnects Claude');
  for (const t of ['tasks', 'vault_items', 'work_grants', 'user_settings']) {
    r = await as(claudeA, `select count(*)::int n from public.${t}`);
    ok(r.rows[0]?.n === 0, `disconnected app reads nothing from ${t} (got ${r.rows[0]?.n})`);
  }
  r = await as(claudeA, `insert into public.tasks (title) values ('after disconnect')`);
  ok(r.error?.code === '42501', `disconnected app cannot add tasks (got ${r.error?.code})`);
  r = await as(userA, `insert into public.trusted_clients (client_id, name) values ('c1a0de00-0000-4000-8000-000000000001', 'Claude')`);
  ok(!r.error, `app reconnects Claude: ${r.error?.message}`);
  r = await as(claudeA, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n === 0, 'the old session stays cut off after a new approval');
  await newSession(S3);
  claudeA.session_id = S3;
  r = await as(claudeA, `select count(*)::int n from public.tasks`);
  ok(r.rows[0]?.n >= 1, 'the session created after the new approval works');

  // the grant runs out
  await db.exec(`set session_replication_role = replica; update public.work_grants set expires_at = now() - interval '1 second'; set session_replication_role = origin;`);
  r = await as(claudeA, `select count(*)::int n from public.vault_items`);
  ok(r.rows[0]?.n === 0, 'expired grant: connector reads nothing');
  r = await as(claudeA, `select count(*)::int n from public.work_grants`);
  ok(r.rows[0]?.n === 0, 'expired grant is invisible to the connector');
  r = await as(userA, `select count(*)::int n from public.work_grants`);
  ok(r.rows[0]?.n === 1, 'the app still sees it (to show / clean up)');
  r = await as({ role: 'service_role' }, `delete from public.work_grants where expires_at <= now()`);
  ok(r.affected === 1, 'the cleanup query removes it');
  r = await as(null, `select count(*) from public.work_grants`);
  ok(r.error?.code === '42501', 'anon has no privilege on work_grants');

  await db.close();
  if (failures.length) throw new Error(`${failures.length} RLS check(s) failed:\n- ${failures.join('\n- ')}`);
});
