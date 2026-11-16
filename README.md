# Synaptask

*Clean your mind.* A personal to-do and project-ideas app that works on Windows, other computers,
Android and iPhone (installable PWA), syncs through Supabase, reminds you by push and email, and lets
Claude add and manage your tasks from any chat.

- **Tasks** per category: due dates and times, reminders, priorities, steps (subtasks), and
  daily / weekly / monthly / yearly repeats.
- **Project ideas** board: Idea → Planning → Building → Done, each idea with notes, tags, links and its own tasks.
- **Work section**: locked with its own passphrase and end-to-end encrypted on your device. Claude can always
  *add* work tasks; to read or change them it has to ask, and you approve in the app for a limited time
  (1 hour up to a day). Outside those windows nobody but you can read it, not even the server.
- **Claude connector** (MCP over OAuth): works from claude.ai, the Claude desktop and mobile apps, and Claude Code.
- **12 themes**, default *Control Panel*.

## How it is built

| Part | Where | Notes |
|---|---|---|
| Web app (PWA) | `web/` | Plain JavaScript modules, no build step. Hosted on GitHub Pages. |
| Database, sign-in | Supabase | Postgres with Row Level Security; email + password + authenticator code (TOTP). |
| Claude connector | `supabase/functions/mcp` | Edge Function; Supabase Auth is the OAuth server. |
| Reminders | `supabase/functions/reminders` | Edge Function run every minute by `pg_cron`; push (Web Push) and email (Resend). |
| Schema | `supabase/migrations/` | Tables, limits, RLS policies; `0002` Work access grants, `0003` trusted connector apps. |
| Tools | `tools/` | Server key generator, browser self-test. |

Without a server the app runs in **local mode**: everything stays in that browser. That is how it runs
until `web/js/config.js` is filled in.

## Try it locally (no accounts needed)

```powershell
python -m http.server 8000      # in the repo folder
```

- App: <http://localhost:8000/web/>
- Self-test (recurrence, Work-vault crypto, local store): <http://localhost:8000/tools/selftest.html>

## Go online: one-time setup

You need a personal GitHub account (you have it), a free **Supabase** account and a free **Resend**
account. Use personal accounts, not work ones. Below, `<you>` is your GitHub user name and `<ref>` is
your Supabase project ref (the part before `.supabase.co`).

### 1. GitHub Pages

1. Make the repository public (GitHub Pages on a private repo needs a paid plan; the repo holds no secrets).
2. Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` runs the tests and deploys `web/` to `https://<you>.github.io/synaptask/`.

### 2. Supabase project

1. Create a project at <https://supabase.com> (free plan): name `synaptask`, region close to you (e.g. Central EU
   / Frankfurt), *Enable Data API* **on**, *Automatically expose new tables* **off** (the migrations grant access
   table by table), *Enable automatic RLS* **on** (a safety net; the migrations enable RLS anyway), Postgres type
   **Postgres** (default). Keep the database password in a password manager, or in `.secrets/` in this folder,
   which git ignores. The CLI asks for it on `supabase link`. Anyone with it can bypass every security rule.
2. **Project Settings → JWT Keys**: the project must sign tokens with an asymmetric key (ES256 or RS256).
   New projects do; on an older one, create a standby ES256 key and rotate to it.
3. **Authentication → Sign In / Providers → Email**: enabled, *Confirm email* on, *Minimum password length* 12.
4. **Authentication → Multi-Factor**: TOTP (authenticator app) enabled.
5. **Authentication → URL Configuration**:
   - Site URL: `https://<you>.github.io/synaptask`
   - Redirect URLs: `https://<you>.github.io/synaptask/**` (add `http://localhost:8000/**` too if you test locally online)
6. **Authentication → OAuth Server**: enable it, *Authorization path* `/consent.html`, turn on *Allow Dynamic OAuth Apps*
   (Claude registers itself; the consent page and the trusted list keep every other app out, see *Security model*).
7. After you have created your Synaptask account (step 7 below): **Authentication → Sign In / Providers →
   Allow new users to sign up: off**. It is a one-person app.
8. **Project Settings → API Keys**: note the **publishable** key (`sb_publishable_…`) and the **secret** key named
   `default` (`sb_secret_…`). The secret key never goes in the repo.

Then, in a terminal in the repo folder (the Supabase CLI is installed):

```powershell
supabase login
supabase link --project-ref <ref>
supabase db push --remote                          # creates the tables and security rules
supabase functions deploy mcp --no-verify-jwt --use-api
supabase functions deploy reminders --no-verify-jwt --use-api
supabase db advisors --remote --type security      # optional: Supabase's own security check
```

(CLI 3.x targets a local database unless you pass `--remote`; `--use-api` bundles the functions on
Supabase's side, so Docker is not needed. The advisor lists three intended warnings: the helper functions
`oauth_client_trusted`, `vault_public_key` and `work_grant_active`, which only answer for the signed-in user.)

Do **not** run `supabase config push`: `supabase/config.toml` only holds function settings, and pushing
it would reset the Auth settings above.

### 3. Server keys (push notifications and Claude's Work access)

1. With the local server running, open <http://localhost:8000/tools/keys.html> and click *Generate both key pairs*.
2. Copy the two **public key** lines into `web/js/config.js` (`vapidPublicKey`, `grantPublicKey`).
3. Keep the tab open for the two private keys (step 5).

### 4. Email (Resend)

1. Create an account at <https://resend.com> **with the same email address you will use for Synaptask**.
   Without your own domain, Resend only delivers to your own address, which is all a personal app needs.
2. **API Keys → Create** (permission *Sending access*). Copy the key (`re_…`).
3. Later, if you add a domain in Resend, set `REMINDER_FROM` to an address on it.

### 5. Function secrets

Create the file `supabase/.env` (git ignores it) with:

```ini
VAPID_PRIVATE_JWK='{"kty":"EC",...}'        # the two lines from tools/keys.html
GRANT_PRIVATE_JWK='{"kty":"RSA",...}'
VAPID_CONTACT=mailto:you@example.com
RESEND_API_KEY=re_...
APP_URL=https://<you>.github.io/synaptask/
# REMINDER_FROM=Synaptask <reminders@your-domain>   (only with your own domain in Resend)
```

```powershell
supabase secrets set --env-file supabase/.env
Remove-Item supabase/.env
```

### 6. Schedule the reminders

Open **SQL Editor** in Supabase, paste `supabase/sql/schedule_reminders.sql`, replace `YOUR-PROJECT-REF`
and `YOUR-SECRET-KEY`, run it, and do not save the query with the key in it.

### 7. Point the app at the server

Fill in `web/js/config.js` (all values are public by design: the publishable key only works
together with the database's security rules, and the private halves of the two keys are secrets):

```js
export const CONFIG = {
  supabaseUrl: 'https://<ref>.supabase.co',
  supabaseKey: 'sb_publishable_...',
  vapidPublicKey: '...',
  grantPublicKey: { kty: 'RSA', n: '...', e: 'AQAB' },
};
```

Commit and push. When the GitHub Action is green, open `https://<you>.github.io/synaptask/`:

1. **Create account**, open the confirmation email, sign in.
2. **Scan the QR code** with an authenticator app. Also save the text key in your password manager:
   it is the only way to move the code to a new phone.
3. Open **Work**, choose a work passphrase (different from your password), and store the **recovery key**
   somewhere safe outside the app.
4. **Settings → Reminders → Turn on** on each device. On iPhone, first *Share → Add to Home Screen*
   and open Synaptask from the icon; iOS only allows push for installed web apps.
5. Install the app: Chrome/Edge show *Install app* in the sidebar; on Android use *Add to Home screen*.

### 8. Connect Claude

- **claude.ai / Claude Desktop / Claude mobile**: Settings → Connectors → *Add custom connector* →
  name `Synaptask`, URL `https://<ref>.supabase.co/functions/v1/mcp` → *Connect*. Sign in to Synaptask,
  type your authenticator code and approve. Connectors added on claude.ai are available in the mobile app too.
- **Claude Code**:
  ```powershell
  claude mcp add --transport http synaptask https://<ref>.supabase.co/functions/v1/mcp
  ```
  then run `/mcp` inside Claude Code and choose Synaptask to sign in.

Try: *"Add 'renew passport' to Synaptask for next Friday, high priority"*, *"What's due today?"*,
*"Put 'prepare Q4 review' in my work tasks"*, *"What's on my work list this week?"* (the last one asks for
your approval: a notification arrives, open Synaptask → Work, pick a duration and tap *Allow*, then tell
Claude to try again).

**First thing to check after connecting:** ask Claude to list your tasks.

## What Claude can and cannot do

| | Personal tasks, categories, ideas | Work section |
|---|---|---|
| Claude, normally | read, add, change, complete, delete | **add only** (sealed; can't read, list or change) |
| Claude, while you allow it | same | read, add, change, complete, delete, until the time you chose (max 24 h) |
| Someone with only your password | nothing (an authenticator code is required) | nothing |
| Supabase / the server | stores it | ciphertext and reminder times only; during an approved window the server can open the Work key |

Granting access: in **Work** (unlocked), pick a duration and tap *Let Claude in*, or *Allow* when Claude has asked.
*Stop now* ends it at once. Locking the app does **not** end it; the time limit or *Stop now* does.

Tools the connector offers: `list_categories`, `list_tasks`, `add_task`, `update_task`, `complete_task`
(a repeating task moves to its next date), `delete_task`, `list_ideas`, `add_idea`, `update_idea`, `add_work_task`,
and with your approval `list_work_categories`, `list_work_tasks`, `update_work_task`, `complete_work_task`, `delete_work_task`.

## Security model in short

- Row Level Security on every table: you only ever see your rows, and only with an MFA (`aal2`) session.
- **Only Claude can be connected.** The project allows dynamic client registration (Claude needs it), so anyone
  could register an app. The consent page therefore refuses every app that does not return to Claude
  (`claude.ai` / `claude.com`, or `localhost` for Claude Code), asks for a fresh authenticator code before approving,
  and then puts the app on your **trusted list** (`trusted_clients`). The database lets an OAuth token in only if its
  app is on that list, and only the app itself (with MFA) can edit the list. Trust covers exactly one session: the
  first one the app opens right after your approval (within 10 minutes). If Claude ever says it is "not on the
  trusted list", disconnect it in *Settings → Connected apps* and connect it again. An app approved any other way, even by
  someone who knows your password, gets nothing. *Settings → Connected apps → Disconnect* cuts an app off at once.
- OAuth tokens carry `client_id`; the vault keys and push devices refuse any token that has one, and work items
  refuse it unless you have an active grant. The connector may insert into the Work inbox but not read it.
- A grant is the Work key sealed in the app to the server's grant public key (private half: an Edge Function secret).
  The database caps it at 24 hours, only your app can create, extend or delete it, and expired grants are deleted
  every minute.
- Work items: PBKDF2-SHA256 (600k) → key-encryption key → wraps a random AES-256-GCM vault key; each item is bound
  to its id. The connector seals new work tasks to the vault's RSA-OAEP-3072 public key; the app opens them on unlock.
  The vault key lives only in memory and locks after 5 idle minutes (configurable).
- Strict Content-Security-Policy, all user text escaped, links limited to http/https, frames refused
  (the consent page cannot be clickjacked). Sign-out wipes the local cache.

## If something goes wrong

- **Lost the phone with the authenticator**: Supabase dashboard → Authentication → Users → your user →
  remove the MFA factor, then sign in and enrol again.
- **Forgot the work passphrase**: Work → *Forgot the passphrase? Use your recovery key*.
  Without the passphrase and the recovery key, work items cannot be recovered by anyone.
- **Reminders not arriving**: SQL Editor → `select * from cron.job_run_details order by start_time desc limit 5;`
  and Edge Functions → reminders → Logs.
- **The app looks out of date**: the service worker always fetches fresh files when online; reload once.

## Development

```powershell
deno test -A supabase/        # RLS (on PGlite), connector, reminders, recurrence parity, crypto
deno check supabase/functions/mcp/index.ts supabase/functions/reminders/index.ts
```

GitHub Actions runs both before every deploy. The browser self-test is `tools/selftest.html`.
Rules of the codebase: no build step and no dependencies in `web/` besides the vendored supabase-js;
secrets only as Edge Function secrets; `web/js/recurrence.js` and `supabase/functions/_shared/recurrence.ts`
must behave the same (a test checks 20,000 random cases).
