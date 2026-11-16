// Sign-in flow: email + password, then an authenticator-app code (TOTP).
// Resolves only once the session is at aal2, which is what the database requires.
import * as backend from './backend.js';
import { esc, ICON, toast } from './util.js';

const MIN_PASSWORD = 12;

const card = (inner) => `<div class="auth"><div class="auth-card">
  <div class="brand">${ICON.logo}<span>synap<i>task</i></span></div>
  <p class="tagline">clean your mind</p>
  ${inner}</div></div>`;

const errBox = (msg) => (msg ? `<p class="auth-error" role="alert">${esc(msg)}</p>` : '');
const infoBox = (msg) => (msg ? `<p role="status">${esc(msg)}</p>` : '');

const SCREENS = {
  signin: ({ error, info }) => card(`<h2>Sign in</h2>${errBox(error)}${infoBox(info)}
    <form data-auth="signin">
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required autofocus></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button>
    </form>
    <div class="auth-links">
      <button type="button" class="link-btn" data-go="signup">Create account</button>
      <button type="button" class="link-btn" data-go="forgot">Forgot password?</button>
    </div>`),

  signup: ({ error, info }) => card(`<h2>Create account</h2>${errBox(error)}${infoBox(info)}
    <form data-auth="signup">
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required autofocus></label>
      <label class="field"><span>Password (at least ${MIN_PASSWORD} characters)</span><input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
      <label class="field"><span>Repeat password</span><input type="password" name="password2" autocomplete="new-password" required></label>
      <button class="btn primary">Create account</button>
    </form>
    <p class="hint" style="margin-top:12px">Next you will connect an authenticator app. Both are needed to sign in.</p>
    <div class="auth-links"><button type="button" class="link-btn" data-go="signin">I already have an account</button></div>`),

  forgot: ({ error, info }) => card(`<h2>Reset password</h2>${errBox(error)}${infoBox(info)}
    <p>We will email you a link. You will still need your authenticator app to finish.</p>
    <form data-auth="forgot">
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required autofocus></label>
      <button class="btn primary">Send reset link</button>
    </form>
    <div class="auth-links"><button type="button" class="link-btn" data-go="signin">Back to sign in</button></div>`),

  enroll: ({ error, enroll }) => card(`<h2>Connect an authenticator app</h2>${errBox(error)}
    <p>Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, Aegis, 1Password…), then type the 6-digit code it shows.</p>
    <img class="qr" id="qr" alt="QR code for your authenticator app">
    <div class="secret"><small class="muted">Can't scan? Enter this key:</small><div class="code">${esc((enroll?.secret || '').replace(/(.{4})/g, '$1 ').trim())}</div></div>
    <p class="hint">Keep a copy of this key in your password manager. It is the only way to add the code to a new phone later.</p>
    <form data-auth="verify">
      <label class="field"><span>6-digit code</span><input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus></label>
      <button class="btn primary">Verify and continue</button>
    </form>
    <div class="auth-links"><button type="button" class="link-btn" data-go="signout">Sign out</button></div>`),

  challenge: ({ error }) => card(`<h2>Authenticator code</h2>${errBox(error)}
    <p>Open your authenticator app and type the current 6-digit code for Synaptask.</p>
    <form data-auth="verify">
      <label class="field"><span>6-digit code</span><input class="otp" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus></label>
      <button class="btn primary">Continue</button>
    </form>
    <div class="auth-links"><button type="button" class="link-btn" data-go="signout">Use a different account</button></div>`),

  newpass: ({ error }) => card(`<h2>Choose a new password</h2>${errBox(error)}
    <form data-auth="newpass">
      <label class="field"><span>New password (at least ${MIN_PASSWORD} characters)</span><input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required autofocus></label>
      <label class="field"><span>Repeat new password</span><input type="password" name="password2" autocomplete="new-password" required></label>
      <button class="btn primary">Save password</button>
    </form>`),
};

function passwordProblem(p, p2) {
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p !== p2) return 'The two passwords do not match.';
  return '';
}

/** Show the sign-in screens in `root` until the user is fully signed in. Returns the user. */
export function ensureSignedIn(root) {
  return new Promise((resolve) => {
    let recovering = backend.recoveryLink;
    let ctx = { error: backend.linkError, info: '', enroll: null, factorId: null };
    let current = 'signin';

    backend.sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') recovering = true; });

    function show(name, extra = {}) {
      current = name;
      ctx = { ...ctx, ...extra };
      root.innerHTML = SCREENS[name](ctx);
      if (name === 'enroll' && ctx.enroll) {
        // Re-encode the SVG so characters such as '#' cannot break the data URL.
        const svg = ctx.enroll.qr.replace(/^data:image\/svg\+xml;[^,]*,/, '');
        root.querySelector('#qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      }
      root.querySelector('[autofocus]')?.focus();
      ctx.error = '';
      ctx.info = '';
    }

    async function next() {
      const st = await backend.authStatus();
      if (st.step === 'ready') {
        if (recovering) return show('newpass');
        root.onsubmit = null;
        root.onclick = null;
        if (/access_token|error_description|type=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
        return resolve(st.user);
      }
      if (st.step === 'enroll') return show('enroll', { enroll: await backend.startEnroll() });
      if (st.step === 'challenge') return show('challenge', { factorId: st.factorId });
      return show(['signup', 'forgot'].includes(current) ? current : 'signin');
    }

    const HANDLERS = {
      signin: async (fd) => {
        await backend.signIn(String(fd.get('email')).trim(), String(fd.get('password')));
        await next();
      },
      signup: async (fd) => {
        const p = String(fd.get('password'));
        const problem = passwordProblem(p, String(fd.get('password2')));
        if (problem) return show('signup', { error: problem });
        const { needsEmailConfirm } = await backend.signUp(String(fd.get('email')).trim(), p);
        if (needsEmailConfirm) return show('signin', { info: 'Check your inbox and open the confirmation link. Then sign in here.' });
        await next();
      },
      forgot: async (fd) => {
        await backend.sendPasswordReset(String(fd.get('email')).trim());
        show('forgot', { info: 'If that address has an account, a reset link is on its way.' });
      },
      verify: async (fd) => {
        let factorId = ctx.factorId;
        if (current === 'enroll') factorId = ctx.enroll?.factorId;
        await backend.verifyCode(factorId, String(fd.get('code')));
        await next();
      },
      newpass: async (fd) => {
        const p = String(fd.get('password'));
        const problem = passwordProblem(p, String(fd.get('password2')));
        if (problem) return show('newpass', { error: problem });
        await backend.setPassword(p);
        recovering = false;
        toast('Password updated');
        await next();
      },
    };

    root.onsubmit = async (e) => {
      const form = e.target.closest('[data-auth]');
      if (!form) return;
      e.preventDefault();
      const btn = form.querySelector('button:not([type="button"])');
      if (btn) btn.disabled = true;
      try {
        await HANDLERS[form.dataset.auth](new FormData(form));
      } catch (err) {
        console.error(err);
        show(current, { error: friendly(err) });
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
    };

    root.onclick = async (e) => {
      const el = e.target.closest('[data-go]');
      if (!el) return;
      if (el.dataset.go === 'signout') {
        await backend.signOut().catch(() => null);
        return show('signin', { enroll: null, factorId: null });
      }
      show(el.dataset.go);
    };

    next().catch((err) => show('signin', { error: friendly(err) }));
  });
}

function friendly(err) {
  const m = String(err?.message || err || 'Something went wrong');
  if (/invalid login credentials/i.test(m)) return 'Email or password is not right.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first: open the link we sent you.';
  if (/invalid.*(totp|code)|code.*invalid|expired/i.test(m)) return 'That code did not work. Wait for a fresh one and try again.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
  if (/failed to fetch|network/i.test(m)) return 'No connection to the server. Check your internet.';
  return m;
}
