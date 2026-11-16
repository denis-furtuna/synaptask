// OAuth consent page for the Claude connector (Supabase Auth acts as the OAuth server).
// Supabase sends the browser here with ?authorization_id=…. Dynamic client registration lets anyone
// register an app with the project, so this page is strict:
//  * only an app that returns to Claude (claude.ai / claude.com, or localhost for Claude Code) can be
//    approved; any other app can only be refused (util.js claudeRedirect);
//  * approving needs a fresh authenticator code typed here;
//  * the approved app goes on the trusted list (0003_trusted_clients.sql). The database lets an OAuth
//    token in only if its app is on that list, so an approval made anywhere else gets nothing.
import { online, sb, authStatus, totpFactorId, verifyCode } from './backend.js';
import { esc, ICON, claudeRedirect } from './util.js';

const root = document.getElementById('app');

const page = (inner) => `<div class="auth"><div class="auth-card">
  <div class="brand">${ICON.logo}<span>synap<i>task</i></span></div>
  <p class="tagline">Connect an app</p>${inner}</div></div>`;

function fail(msg) {
  root.innerHTML = page(`<h2>Cannot continue</h2><p class="auth-error">${esc(msg)}</p><a class="btn" href="index.html">Open Synaptask</a>`);
}

function done(title, msg) {
  root.innerHTML = page(`<h2>${esc(title)}</h2><p>${esc(msg)}</p><a class="btn" href="index.html">Open Synaptask</a>`);
}

const target = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; } };

/** Follow the server's redirect only to an allowed address (and, if given, the one the app registered). */
function follow(url, expected = '') {
  if (!claudeRedirect(url) || (expected && target(url) !== target(expected))) {
    return fail('The app asked to be sent to an address that is not allowed.');
  }
  location.assign(new URL(url).href);
}

function friendly(err) {
  const m = String(err?.message || err || 'Something went wrong');
  if (/invalid.*(totp|code)|code.*invalid|expired|verification/i.test(m)) return 'That code did not work. Type the current code from your authenticator app.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
  if (/failed to fetch|network/i.test(m)) return 'No connection to the server. Check your internet.';
  return m;
}

function where(redirectUri) {
  try {
    const u = new URL(redirectUri);
    return u.protocol === 'http:' ? 'this computer (Claude Code)' : u.host;
  } catch { return 'an unknown address'; }
}

async function main() {
  if (!online) return fail('This copy of Synaptask has no server configured, so nothing can connect to it.');
  const id = new URLSearchParams(location.search).get('authorization_id');
  // supabase-js puts the id into the request path unescaped: allow only id-like characters.
  if (!id || !/^[\w-]{1,256}$/.test(id)) return fail('This link is missing its authorization request. Start connecting again from Claude.');

  const st = await authStatus();
  if (st.step !== 'ready') {
    // Sign in (password + authenticator code) first, then come back here.
    try { sessionStorage.setItem('synaptask:returnTo', location.href); } catch { /* ignore */ }
    location.replace('index.html');
    return;
  }

  const { data, error } = await sb.auth.oauth.getAuthorizationDetails(id);
  if (error) return fail(error.message || 'This request has expired. Start connecting again from Claude.');
  if (data?.redirect_url && !data.authorization_id) return follow(data.redirect_url); // approved before

  const client = data?.client || {};
  const clientId = String(client.id || '');
  const name = String(client.name || client.client_name || 'An app').slice(0, 200);
  const redirectUri = String(data?.redirect_uri || '');
  const allowed = claudeRedirect(redirectUri) && /^[\w-]{1,200}$/.test(clientId);

  if (!allowed) {
    root.innerHTML = page(`
      <h2>Blocked</h2>
      <div class="warn-box">This request does not come from Claude, so Synaptask will not connect it.
        If you did not start it yourself just now, someone may be trying to trick you into giving them access.</div>
      <p><b>${esc(name)}</b> wanted to return to <b>${esc(where(redirectUri))}</b>.</p>
      <div class="consent-actions"><button type="button" class="btn primary" data-decide="deny">Refuse</button></div>`);
    root.onclick = async (e) => {
      if (!e.target.closest('[data-decide]')) return;
      root.onclick = null;
      await sb.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true }).catch(() => null);
      done('Refused', 'Nothing was shared. You can close this tab.'); // never follow this app's redirect
    };
    return;
  }

  root.innerHTML = page(`
    <h2>Allow access?</h2>
    <div class="consent-client"><b>${esc(name)}</b></div>
    <p>wants to connect to Synaptask as <b>${esc(st.user.email || 'you')}</b>. It returns to <b>${esc(where(redirectUri))}</b>.</p>
    <ul class="consent-list">
      <li>Read, add, change and complete your <b>personal tasks, categories and project ideas</b>.</li>
      <li><b>Add</b> tasks to your Work section. To read or change work tasks it has to ask: you approve in the app, for at most a day at a time.</li>
      <li>It never sees your work passphrase, your push devices or your account settings.</li>
    </ul>
    <form data-consent>
      <p class="auth-error" role="alert" hidden></p>
      <label class="field"><span>Authenticator code, to approve</span><input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus></label>
      <div class="consent-actions">
        <button type="button" class="btn" data-decide="deny">Deny</button>
        <button class="btn primary">Allow</button>
      </div>
    </form>
    <p class="hint">Only allow this if you clicked <i>Connect</i> in Claude yourself just now. You can disconnect it any time in Synaptask → Settings → Connected apps.</p>`);
  root.querySelector('[autofocus]')?.focus();

  const form = root.querySelector('[data-consent]');
  const errEl = form.querySelector('.auth-error');
  const busy = (on) => form.querySelectorAll('button, input').forEach((x) => { x.disabled = on; });
  const showError = (msg) => { errEl.textContent = msg; errEl.hidden = false; busy(false); form.code.value = ''; form.code.focus(); };

  root.onclick = async (e) => {
    if (!e.target.closest('[data-decide="deny"]')) return;
    busy(true);
    const res = await sb.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
    if (res.error) return fail(res.error.message);
    if (!res.data?.redirect_url) return done('Denied', 'Nothing was shared. You can close this tab.');
    follow(res.data.redirect_url, redirectUri);
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    busy(true);
    errEl.hidden = true;
    let added = false;
    try {
      // 1. A fresh second factor for this approval.
      const factorId = await totpFactorId();
      if (!factorId) throw new Error('This account has no authenticator app. Open Synaptask and set it up first.');
      await verifyCode(factorId, String(form.code.value));
    } catch (err) {
      return showError(friendly(err));
    }
    try {
      // 2. Put the app on the trusted list, so its token can reach your data.
      const { data: before } = await sb.from('trusted_clients').select('client_id').eq('client_id', clientId).maybeSingle();
      const { error: tErr } = await sb.from('trusted_clients')
        .upsert({ user_id: st.user.id, client_id: clientId, name, redirect_uri: redirectUri }, { onConflict: 'user_id,client_id' });
      if (tErr) throw new Error(tErr.message);
      added = !before;
      // 3. Approve and go back to Claude.
      const res = await sb.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true });
      if (res.error) throw new Error(res.error.message);
      if (!res.data?.redirect_url) throw new Error('The server did not say where to go next.');
      follow(res.data.redirect_url, redirectUri);
    } catch (err) {
      if (added) await sb.from('trusted_clients').delete().eq('client_id', clientId);
      fail(friendly(err));
    }
  };
}

main().catch((e) => fail(e?.message || String(e)));
