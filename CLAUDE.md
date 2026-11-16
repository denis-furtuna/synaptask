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
- Claude access: full access to personal tasks and ideas (add, list, edit, complete);
  **add-only** to the Work section. Claude must never be able to read work items.
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
- The first session ran on a work laptop where nothing may be installed (only Python and Git were
  present), so nothing has been run or tested yet. The owner continues on a personal laptop where
  Node, the Supabase CLI and Deno can be installed.

## Architecture

- `web/` is a static PWA: vanilla JS ES modules, no build step, no framework. Hosted on GitHub Pages
  (workflow still to write). `web/vendor/supabase.js` is supabase-js 2.119.0 (UMD, global `supabase`),
  vendored so the CSP can be `script-src 'self'`.
- Backend is Supabase: Postgres with Row Level Security, Supabase Auth (password + TOTP),
  Edge Functions for the MCP server and for reminders.
- **Local mode**: when `web/js/config.js` is empty the app runs without a backend and keeps data in
  localStorage. This is how the UI can be tested before Supabase exists (`python -m http.server` in `web/`).
- Local-first sync (`web/js/store.js`): every change is applied locally, marked `_dirty`, pushed with
  an upsert, then remote rows with a newer `updated_at` are pulled. Deletes are soft (`deleted_at`).
  The server owns `updated_at` (trigger) and `reminded_at`; the client never sends them.

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
- Front end: every user string goes through `esc()`; strict CSP via meta tag
  (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://*.supabase.co;
  base-uri 'none'; object-src 'none'; form-action 'none'`). Links in ideas are limited to http/https.
- Sign-out clears the local cache (`store.clearLocal()`).

## Current status

Written, **never executed** (expect small bugs):

| File | Contents |
|---|---|
| `web/js/config.js` | Supabase URL / publishable key / VAPID public key (empty = local mode) |
| `web/js/theme-boot.js` | applies saved theme before paint |
| `web/js/util.js` | DOM helpers, `esc`, dates, base64, toast, event bus, `ls` storage wrapper, icons |
| `web/js/recurrence.js` | `nextDue`, `anchorRule`, `describeRule` |
| `web/js/vault.js` | all work-vault crypto |
| `web/js/backend.js` | Supabase client, sign-in / sign-up / TOTP enrol and verify |
| `web/js/store.js` | local store, sync, work vault storage, inbox import, export / import |
| `web/js/app.js` | UI state, hash routes, `openDialog`, `confirmDialog` |
| `web/js/tasks.js` | task views (`viewModel`, `renderTasks`), quick add, task editor |
| `web/js/ideas.js` | ideas board, idea editor |
| `web/js/work.js` | vault setup / unlock / recovery screens, auto-lock |

Still to write:

1. `web/js/settings.js`: theme picker (swatches using nested `data-theme`), category manager dialog
   `openCategoryManager(space)` (referenced by `data-act="cats-manage"` with `data-space`), reminders
   (enable push on this device, email toggle, stored in `user_settings`), security (auto-lock minutes in
   `ls` key `synaptask:autolock`, change work passphrase via `work.openPassphraseChange()`, sign out),
   Claude connector instructions (URL `${supabaseUrl}/functions/v1/mcp`), export / import JSON, local-mode notice.
2. `web/js/auth.js`: sign in, create account (min 12 chars), forgot password, TOTP enrol (QR is an SVG
   data URL from `startEnroll()`), TOTP challenge.
3. `web/js/main.js`: boot, shell (sidebar: Today, Upcoming, Inbox, All tasks, Project ideas, categories,
   Work, Settings, sync status), one delegated click listener on `[data-act]`, submit listener on
   `[data-form]` (`quick-task`, `quick-idea`, `vault-create`, `vault-unlock`), search input bound to
   `state.search`, drag-and-drop of `.idea-card` onto `.col[data-stage]` calling `ideas.moveIdea`,
   re-render on bus events `render` / `change` while preserving focus of the element with the same id,
   `hashchange` routing via `parseRoute`, load the vault record into `state.vaultRecord` / `state.vaultLoaded`,
   call `work.armAutoLock()` on user input and `work.onVisibility()` on `visibilitychange`, sync on load /
   focus / every 60 s, upsert the timezone into `user_settings`, service-worker registration.
   Work view header needs a Lock button (`data-act="vault-lock"`).
4. `web/index.html` (needs `<dialog id="dlg">`, `<dialog id="confirm">`, `<div id="toasts">`, `<div id="app">`),
   `web/consent.html` (OAuth consent page, see below), `web/css/themes.css`, `web/css/app.css`
   (must include `[hidden]{display:none!important}`), `web/sw.js` (app-shell cache, `push` and
   `notificationclick` handlers), `web/manifest.webmanifest`, icons (SVG + 180/192/512 PNG).
5. `supabase/migrations/0001_init.sql`: tables `categories`, `tasks`, `ideas`, `vault_items`, `vaults`
   (`user_id` pk, `record jsonb`, `public_key jsonb`), `vault_inbox` (`sealed jsonb`), `push_subscriptions`
   (`endpoint` unique, `p256dh`, `auth`), `user_settings` (`timezone`, `email_reminders`, `push_reminders`).
   Column lists are in `COLUMNS` in `store.js`. Every table: `user_id uuid not null default auth.uid()`,
   `updated_at` trigger, length check constraints, RLS as described above. Trigger on `tasks` and
   `vault_items`: when `remind_at` changes, set `reminded_at = null`. A `security definer` function
   returning the caller's vault public key for the MCP server.
6. `supabase/functions/mcp/index.ts`: tools `list_categories`, `list_tasks`, `add_task`, `update_task`,
   `complete_task` (recurring tasks advance instead of completing), `delete_task`, `list_ideas`, `add_idea`,
   `update_idea`, `add_work_task` (sealed, insert without `.select()`). Tasks from Claude get `source = 'claude'`.
   Needs `supabase/functions/_shared/recurrence.ts` (copy of the JS logic) and a zoned-time helper so
   `remind_at` is computed in the user's timezone from `user_settings`.
7. `supabase/functions/reminders/index.ts` + `supabase/sql/schedule_reminders.sql` (pg_cron + pg_net every
   minute): due personal tasks get a push with the title and an email via Resend; due work items get a
   generic push with no content. Then set `reminded_at`.
8. `tools/vapid-keys.html`: generate a VAPID key pair in the browser with WebCrypto (ECDSA P-256):
   public key as base64url raw, private key as JWK.
9. `.github/workflows/pages.yml` deploying `web/`, and `README.md` with the setup steps for Supabase,
   Resend, GitHub Pages and adding the connector in Claude.
10. A self-test page that exercises recurrence, vault round-trips (`create` / `lock` / `unlock` / `rewrap` /
    `sealTo` + `openSealed`) and the store in local mode, then a manual pass through every screen.

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
- Scheduling: <https://supabase.com/docs/guides/functions/schedule-functions> (secrets in Vault,
  `cron.schedule` + `net.http_post` with the secret key in the `apikey` header).
- GitHub Pages on a private repo needs a paid plan. The repo contains no secrets, so it can be public;
  otherwise host `web/` on Cloudflare Pages.

## Conventions

- No build step and no dependencies in `web/` beyond the vendored supabase-js. Keep it that way.
- Never put the Supabase secret key, the VAPID private key or the Resend key in the repo; they are
  Edge Function secrets.
- Keep `web/js/recurrence.js` and `supabase/functions/_shared/recurrence.ts` identical in behaviour.
