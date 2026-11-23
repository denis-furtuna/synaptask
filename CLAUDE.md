# Synaptask

Personal to-do + project-ideas app with a Claude connector. This file is the handoff from the
session that started the build; it holds every product decision the owner made and the state of
the code. Read it fully before continuing. Delete the "Current status" section once the build is done.

## What the owner asked for (all decided, do not re-ask)

- **Name: Synaptask** (synapse + task), chosen on 2026-11-16 after checking the Play Store and the web:
  no app or product used it then. The owner plans to publish on Google Play later; run a trademark search
  (EUIPO / WIPO, class 9) before that. Small caution: it sounds a bit like "SnapTask" (an iOS task app).
  Tagline idea the owner liked: "clean your mind". Storage keys, the backup format and the TOTP label all use
  `synaptask`. Play Store package ID still to choose (e.g. `app.synaptask`).

- One app for to-dos per category and project ideas, usable on Windows laptop, other computers,
  Android and iPhone. So: an installable PWA, hosted online, with sync.
- A Claude "extension": tasks from a chat with Claude land in the app. Must work from Claude Code,
  claude.ai in the browser and the Claude mobile app. So: a remote MCP server with OAuth.
- Work tasks kept separate from personal ones: a **locked Work section** inside the same app,
  end-to-end encrypted with its own passphrase. (The owner considered linking to a Claude artifact
  on a work account instead and chose the locked section.)
- Claude access: full access to personal tasks and ideas (add, list, edit, complete).
  Work section: Claude can always **add** (sealed inbox). **Changed 2026-11-16:** the owner also wants Claude
  to read and manage work tasks, gated by approval on the phone: Claude asks, the owner gets a push, unlocks
  Work and taps Allow for a chosen time (1 h … until midnight, max 24 h). With access Claude may do
  everything (list, add, update, complete, delete). Outside a grant, work stays end-to-end encrypted.
  (Rejected alternatives: typing an authenticator code into the chat, because the server would have to hold
  the work key permanently; and always open.)
- Commits: never add Claude as co-author or any Claude attribution line (owner's explicit wish).
- **Added 2026-11-23:** task stages like the project board, To do / Ongoing / Done (`tasks.started_at`, migration 0007;
  Ongoing = started_at set and not completed). Every task view has a List / Board switch (remembered per device,
  `synaptask:task-layout`; search always shows the list); cards drag between columns (`tasks.setStatus`), To do cards
  have ▶ Start for touch screens, the editor has a Status field. Done on a repeating task = next occurrence, back to
  To do. MCP: tasks report `status`, `list_tasks` view `ongoing`, `update_task` / `update_work_task` take `status`.
- **Added 2026-11-23:** autosave in every editor (the owner lost notes by forgetting Save), and a **Shopping list**
  ("lista de cumpărături") with its own editable categories (starters: Groceries, For projects, Fun), items with
  quantity, notes and an optional project idea, ticked off as bought; Claude can list, add, update and remove items.
- "Secure everything well."
- Task features: due dates + reminders, priorities, subtasks, recurring tasks
  (daily, weekly, monthly, yearly; the owner explicitly asked for daily, weekly and annual).
- Project ideas: a board with stages Idea / Planning / Building / Done; each idea has notes, tags,
  links and its own task list.
- Sign-in: email + password + authenticator-app code (TOTP 2FA). The owner asked for the
  easiest secure option; this was the recommendation.
- Reminders: push notifications **and** email.
- Themes: 12, with a switcher. Default is **Control Panel** (`panel`). The exact CSS variables for
  all 12 are in `docs/theme-preview.html`; port them to `web/css/themes.css` as `[data-theme="x"]` blocks.
- Accounts: the owner has a personal GitHub account only. Supabase (free) still has to be created,
  plus Resend (free) for reminder emails. Use personal accounts, never work ones.
- The first session ran on a work laptop where nothing may be installed. Work now continues on the
  owner's personal laptop, where installing tools is allowed.

## Architecture

- `web/` is a static PWA: vanilla JS ES modules, no build step, no framework. Hosted on GitHub Pages
  (`.github/workflows/pages.yml`: tests, then deploy). `web/vendor/supabase.js` is supabase-js 2.119.0
  (UMD, global `supabase`), vendored so the CSP can be `script-src 'self'`.
- Front-end modules: `main.js` (boot, shell, routing, delegated events, sync timers), `auth.js` (sign-in
  screens until aal2), `settings.js` (themes, category manager, reminders, connector, backup, account),
  `consent.js` (OAuth consent page), plus `app`, `tasks`, `ideas`, `work`, `store`, `vault`, `backend`,
  `recurrence`, `util`. `theme-boot.js` also refuses to render inside a frame (anti-clickjacking).
- Backend is Supabase: Postgres with Row Level Security, Supabase Auth (password + TOTP),
  Edge Functions for the MCP server and for reminders.
- **Local mode**: when `web/js/config.js` is empty the app runs without a backend and keeps data in
  localStorage. This is how the UI can be tested before Supabase exists (`python -m http.server` in `web/`).
- Local-first sync (`web/js/store.js`): every change is applied locally, marked `_dirty`, pushed with
  an upsert, then remote rows with a newer `updated_at` are pulled. Deletes are soft (`deleted_at`).
  The server owns `updated_at` (trigger) and `reminded_at`; the client never sends them. Each table syncs on its
  own (`syncTable`): one failing table (e.g. a new one not yet migrated) shows "Sync problem" but the rest still sync.
  So when adding a table, push the migration before the web app.
- Autosave (`openDialog(..., { autosave: { collect, persist } })` in `app.js`): saves 700 ms after the last edit and on
  every close (X, Esc, backdrop, another dialog, page hidden). `collect` reads the form synchronously, `persist` calls
  are serialised (a new task gets its id from the first save). Delete/Discard call `form.discardAutosave()` first so a
  deleted record is never re-saved. Footer status `[data-autosave]`; buttons that must not trigger a save carry
  `data-no-autosave`. `work.lockNow()` flushes an open work-task editor before dropping the key, then closes it.
- Shopping list (`shopping.js`, `0006_shopping.sql`): tables `shopping_categories` and `shopping_items` (personal, same
  RLS as tasks incl. `trusted_clients_only`). Starter categories are seeded once (local mode at init, online after the
  first clean sync) with ids derived from SHA-256(user id + name), so two devices write the same rows. The category
  manager is shared: `openCategoryManager(space, 'shopping_categories')`. Per project (owner's request 2026-11-23):
  items with `idea_id` show in the idea editor ("To buy for this project", new ones go to the category named like
  "project"), as a chip on the idea card, and at `#/shopping/project/<ideaId>` (the project picker in the filters).
  "Clear bought" clears only the current view. `list_shopping` takes `idea_id`; `list_ideas` with an id returns
  its `shopping` items. MCP tools: `list_shopping`,
  `add_shopping_items` (up to 50), `update_shopping_item` (incl. `bought`), `delete_shopping_item`; 19 tools in all.

## Security model

- RLS on every table: `user_id = auth.uid()`, plus a RESTRICTIVE policy requiring
  `auth.jwt()->>'aal' = 'aal2'` so a stolen password alone reads nothing.
- OAuth tokens (the Claude connector) carry a `client_id` claim. Tables the connector must not touch
  (`vaults`, `vault_items`, `push_subscriptions`) get a RESTRICTIVE policy `client_id IS NULL`.
  `vault_inbox` allows INSERT from OAuth clients but SELECT/UPDATE/DELETE only for direct sessions.
- Work vault (`web/js/vault.js`): PBKDF2-SHA256 600k -> key-encryption key -> wraps a random
  AES-256-GCM vault key. Every work item is encrypted with the vault key, item id bound as AAD.
  A recovery key (160 random bits, shown once) wraps the same vault key.
  An RSA-OAEP 3072 key pair lets the MCP server seal new work tasks to the public key
  (hybrid: random AES key wrapped with RSA, payload AES-GCM with AAD `inbox`); the app opens them
  on unlock and turns them into normal encrypted work items. `vault.sealTo()` shows the exact format
  the Deno side must produce: `{ wk, iv, ct }`, all base64.
- The server sees only ciphertext for work items, plus `remind_at` (a timestamp) so a generic
  "a work task is due" notification can be sent without revealing content.
- Vault key lives in memory only; auto-lock after N idle minutes (default 5) or when the tab was hidden that long.
- Claude's Work access (`supabase/migrations/0002_work_access.sql`): the unlocked app exports the raw vault key,
  seals it to `CONFIG.grantPublicKey` with AAD `work-grant` (`vault.sealTo(..., 'work-grant')`) and upserts
  `work_grants { sealed_key, expires_at }`. A trigger caps expiry at 24 h. RLS: only direct sessions insert,
  update or delete grants, and the connector sees only an unexpired one. `vault_items` admits OAuth tokens only
  while `work_grant_active()`. The MCP function opens the grant with the `GRANT_PRIVATE_JWK` secret
  (`_shared/workvault.ts`) and reads and writes items in the app's exact format. Without a grant, work tools record
  `work_access_requests` and push "Claude wants to use your Work section" (at most every 2 min). The reminders
  cron deletes expired grants every minute. Locking the app does not end a grant.
- Trusted connector apps (`0003_trusted_clients.sql`, owner asked to "secure it well" after enabling dynamic client
  registration): `consent.js` approves only apps whose `redirect_uri` is Claude's callback (`CLAUDE_CALLBACKS` /
  `claudeRedirect()` in `util.js`: `https://claude.ai|claude.com/api/mcp/auth_callback`, or http loopback for Claude
  Code); anything else gets a "Blocked" page with Refuse only, and its redirect is never followed. Allow needs a fresh
  TOTP code (`challengeAndVerify`), then upserts `trusted_clients(client_id, name, redirect_uri)`, then approves.
  A restrictive `trusted_clients_only` policy on every OAuth-reachable table requires
  `client_id IS NULL OR oauth_client_trusted()`; the list itself is direct-session + aal2 only. The MCP function wraps
  every tool with an `oauth_client_trusted` RPC check for a clear error. Settings → Connected apps lists trusted rows +
  `auth.oauth.listGrants()`; Disconnect deletes the row (immediate cut-off) and calls `revokeGrant`.
  If Anthropic changes the callback URL, update `CLAUDE_CALLBACKS`.
- Front end: every user string goes through `esc()`; strict CSP via meta tag
  (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://*.supabase.co;
  base-uri 'none'; object-src 'none'; form-action 'none'`). Links in ideas are limited to http/https.
- Sign-out clears the local cache (`store.clearLocal()`).

## State (2026-11-16, second session, on the owner's personal laptop)

The build is complete and the Supabase project is set up (see "Owner's setup progress" below); the app has not
yet been used end to end against it (no account, no Claude connection yet). What was verified:

- `deno test -A supabase/` (also runs in GitHub Actions before every deploy):
  - `supabase/tests/rls_test.ts`: the migration applied to PGlite with a stub of Supabase's `auth`
    schema; ~60 checks of RLS as the app (aal2), a password-only session (aal1), another user, the
    connector (`client_id` set), and anon; triggers; check constraints. A mutation check confirmed it fails
    when a connector restriction is removed.
  - `supabase/functions/tests/mcp_test.ts`: the real MCP function under Deno with test-signed ES256 JWTs
    against a mock REST API: discovery, 401 + `WWW-Authenticate`, forged token, all 15 tools, sealing a work
    task that `web/js/vault.js` then opens, and the Work grant flow (request, real grant sealed by `vault.js`,
    list/add/update/complete/delete with the app decrypting what the server wrote, expiry).
  - `supabase/functions/tests/reminders_test.ts`: the real reminders function against mock REST, push and
    Resend (`_push_shim.ts` redirects `https://push.test` in tests only).
  - `supabase/functions/tests/shared_test.ts`: recurrence JS/TS parity on 20,000 random cases, time zones
    and DST, vault round trips.
- `tools/selftest.html` in Edge: 83 checks (recurrence, vault, consent address rule, local store).
- Trusted apps: RLS checks for trusted / untrusted / disconnected apps and a policy-coverage query over every
  public table (a mutation check confirmed failures when one table's policy is removed); MCP test for an untrusted
  token (refused before any table is touched) and a mid-session disconnect; the online walkthrough covers the
  consent code, the blocked look-alike app and Settings → Connected apps → Disconnect.
- Every screen driven headless in Edge (playwright-core, kept outside the repo) at desktop and phone size,
  in local mode and in online mode against a mocked Supabase: sign-in, authenticator enrolment, consent
  page from a signed-out start through to Claude's redirect, sync (incl. the paged pull), Work setup,
  sign-out wiping the cache. No console errors.

Installed on this laptop: Deno 2.9.8 (winget), Supabase CLI 3.1.0 in `%LOCALAPPDATA%\Programs\supabase`
(on the user PATH; restart the terminal), Node 24, Python 3.14. No Docker: test the database against the
real project rather than `supabase start`.

### Open questions, in the order to check them once the project exists

1. **RESOLVED 2026-11-16 (`0005_trusted_sessions.sql`, applied live).** Claude's session was `aal1` as expected.
   `oauth_client_trusted()` now also requires the token's `session_id` to be the FIRST `auth.sessions` row of that
   app created after the approval (`trusted_clients.updated_at`) and within 10 minutes; `require_mfa` on the
   connector tables is `aal2 OR oauth_client_trusted()`. A reconnect that skips the consent page ("already
   approved") gets an untrusted session: Disconnect in Settings, then connect again. Confirmed live the same day: Claude listed the
   owner's tasks on claude.ai and in a new Claude Code session (claude.ai connectors carry over to Claude Code). Original note: Supabase's token-security doc shows `"aal": "aal1"` in its example OAuth token, so
   expect the connector to be blocked by `require_mfa` at first. After connecting Claude, ask it to list tasks; if it
   sees nothing, check `aal` in the token (Edge Function logs, or log `jwtClaims` once). The trusted list already
   stops a password-only attacker who registers their *own* app. Remaining risk if `require_mfa` is relaxed to
   `aal2 OR oauth_client_trusted()`: an aal1 session could approve a new authorization for an *already trusted*
   client_id (only matters if Claude reuses one client_id across users). So before relaxing, either prove the consent
   endpoint refuses aal1 sessions, or bind trust to the OAuth session: the token has `session_id`, and the live
   `auth.sessions` has `oauth_client_id uuid`, `aal`, `factor_id`, `created_at` (checked 2026-11-16; also
   `auth.oauth_authorizations(client_id, user_id, approved_at, status)` and `auth.oauth_consents`); accept only sessions
   created within minutes after a trusted approval (`trusted_clients.updated_at`). The token's `client_id` is
   `auth.oauth_clients.id` (uuid), the same value `getAuthorizationDetails` returns as `client.id`. Tables: categories, tasks, ideas,
   vault_inbox, user_settings (read), work_grants (read), work_access_requests, vault_items (under a grant).
2. **Shape of `getAuthorizationDetails`** on the live server (`client.name`, `redirect_uri`,
   "already approved" returning only `redirect_url`): `consent.js` handles the documented shape.
3. **Push on iPhone**: `@pushforge/builder` 2.0.5 only sends the older `aesgcm` content coding. WebKit's
   source decrypts it, but test on a real iPhone (installed to the Home Screen). If it fails, switch the
   reminders function to an `aes128gcm` implementation.
4. **Resend without a domain** delivers only to the Resend account's own address (fine for one user).
5. Before Google Play: trademark search (EUIPO / WIPO, class 9), choose the package ID (e.g. `app.synaptask`),
   wrap the PWA as a Trusted Web Activity (Bubblewrap / PWABuilder) with `/.well-known/assetlinks.json`.
   GitHub Pages serves a project site under `/synaptask/`, so assetlinks needs a custom domain or a
   `<you>.github.io` user-site repo.
6. **Work grants in practice**: after connecting Claude, ask for work tasks, check that the push arrives and
   Allow works, and that the grant row disappears after expiry (`select * from work_grants`).

Owner's setup progress (2026-11-16): Supabase project `mcixodikgxqggzqcvmmh` (org "furtunalabs", Frankfurt) created
and linked with the CLI; Auth settings done (email + confirm, min length 12, TOTP, URL config, OAuth server with
`/consent.html` and dynamic registration). Done by Claude with the CLI: migrations 0001–0004 pushed (`db push
--remote`), `mcp` and `reminders` deployed (`--use-api`, no Docker), secrets `VAPID_PRIVATE_JWK`, `GRANT_PRIVATE_JWK`,
`APP_URL` set (generated like tools/keys.html, never printed), `web/js/config.js` fully filled. Live checks: every
public table has RLS + require_mfa + (trusted_clients_only or no_oauth_clients); MCP metadata/401 and reminders 401
work. `db advisors --type security` leaves only the three intended SECURITY DEFINER helpers; the 32
`auth_rls_initplan` performance notes are linter false positives (it misreads `(select auth.jwt() ->> 'x')`).
Owner still to do: `RESEND_API_KEY` + `VAPID_CONTACT` secrets (dashboard), the cron SQL with the secret key,
GitHub repo public + Pages source "GitHub Actions", commit/push, create the account, then turn off
"Allow new users to sign up".
The database password is in `.secrets/supabase-db-password.txt` (gitignored; never print or commit it).
The two existing commits were rewritten to drop the Claude co-author line and force-pushed (owner's OK).
JWT signing key checked: ECC P-256 is current, nothing to do. License: the owner chose **none** (public repo,
all rights reserved); do not add a LICENSE file.

## Facts checked against the docs on 2026-11-16 (re-check versions before relying on them)

- Supabase has an official pattern for MCP on Edge Functions with OAuth:
  <https://supabase.com/docs/guides/getting-started/byo-mcp>. Imports used there:
  `npm:@modelcontextprotocol/server@^2.0.0` (`createMcpHandler`, `McpServer`, `registerTool`),
  `npm:@supabase/middleware@1` (`pipeline`), `npm:@supabase/server@1`
  (`withOAuthProtectedResource()`, `withSupabase({ auth: 'user' })` giving an RLS-scoped `supabase`;
  `auth: 'secret'` gives `supabaseAdmin` for the cron-invoked function), `npm:zod@^4.3.6`.
  Both functions need `verify_jwt = false` in `supabase/config.toml`. The project must use an
  asymmetric JWT signing key (ES256 / RS256).
- Supabase Auth as OAuth 2.1 server (beta): enable under Authentication > OAuth Server, turn on dynamic
  client registration, set the authorization path. The consent page receives `?authorization_id=` and uses
  `supabase.auth.oauth.getAuthorizationDetails(id)`, `approveAuthorization(id)`, `denyAuthorization(id)`,
  then redirects to the returned `redirect_url`. Plan: Site URL = the GitHub Pages URL, path `/consent.html`.
  The consent page must require an `aal2` session; if signed out, stash its URL in sessionStorage
  (`synaptask:returnTo`) and send the user to `index.html`, which returns there after sign-in.
  <https://supabase.com/docs/guides/auth/oauth-server/getting-started>
- OAuth access tokens include `client_id`, `aal`, `amr`, `sub`, `role: authenticated`.
  **Unverified:** whether a token approved from an `aal2` session carries `aal2`. If it carries `aal1`,
  the restrictive MFA policy blocks the connector; test this first and adjust the policy to
  "`aal2` OR (`client_id` IS NOT NULL AND the table is connector-allowed)" only if consent itself
  can be shown to require `aal2`. <https://supabase.com/docs/guides/auth/oauth-server/token-security>
- Claude's OAuth callback is `https://claude.ai/api/mcp/auth_callback` (may also become
  `https://claude.com/api/mcp/auth_callback`); Claude registers itself through dynamic client registration.
- Web Push from Deno: `@pushforge/builder` `buildPushHTTPRequest({ privateJWK, subscription, message:
  { payload, adminContact, options } })` returns `{ endpoint, headers, body }` to POST with `fetch`.
  It requires https endpoints and uses the `aesgcm` coding (see open question 3).
- Versions in use (checked 2026-11-16): `@modelcontextprotocol/server` 2.4.0, `@supabase/server` 1.9.2
  (context has `supabase`, `supabaseAdmin`, `userClaims`, `jwtClaims`; `auth: 'secret'` matches the secret
  key named `default` sent in the `apikey` header), `@supabase/middleware` 1.0.0, `zod` 4.6.7,
  `@pushforge/builder` 2.0.5, supabase-js 2.119.0 (implicit flow; `approveAuthorization(id, { skipBrowserRedirect })`),
  GitHub actions checkout v7, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, setup-deno v2.
- `registerTool` takes a zod object as `inputSchema`; a thrown error becomes an `isError` tool result.
- Scheduling: <https://supabase.com/docs/guides/functions/schedule-functions> (secrets in Vault,
  `cron.schedule` + `net.http_post` with the secret key in the `apikey` header).
- GitHub Pages on a private repo needs a paid plan. The repo contains no secrets, so it can be public;
  otherwise host `web/` on Cloudflare Pages.

## Conventions

- No build step and no dependencies in `web/` beyond the vendored supabase-js. Keep it that way.
- Never put the Supabase secret key, the VAPID private key or the Resend key in the repo; they are
  Edge Function secrets.
- Keep `web/js/recurrence.js` and `supabase/functions/_shared/recurrence.ts` identical in behaviour
  (`shared_test.ts` compares them).
- Column limits live in three places that must agree: the check constraints in the migration,
  `sanitize()` in `web/js/store.js`, and the zod schemas in `supabase/functions/mcp/index.ts`.
- `supabase/config.toml` holds only function settings. Auth settings are set in the dashboard; never
  run `supabase config push`.
- `web/sw.js` precaches the app shell. When adding a file to `web/`, add it to `SHELL`. The deploy
  workflow renames the cache per commit. GitHub Pages sends `max-age=600`, so the worker fetches with
  `cache: 'no-cache'` / `'reload'` (otherwise a deploy shows up 10 minutes late, with old and new files mixed).
  `main.js` calls `registration.update()` when the app becomes visible (at most once a minute, and every 30 min)
  and reloads on `controllerchange`, or defers with a notice while a dialog is open or text is being typed.
- Run `deno test -A supabase/` and `tools/selftest.html` before committing.
