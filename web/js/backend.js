// Thin wrapper around Supabase. When config.js is empty the app runs in
// local mode and `sb` is null.
import { CONFIG } from './config.js';

const lib = globalThis.supabase;
export const sb = CONFIG.supabaseUrl && CONFIG.supabaseKey && lib
  ? lib.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
export const online = sb !== null;

/** Where the user is in the sign-in flow: signin -> enroll | challenge -> ready. */
export async function authStatus() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { step: 'signin' };
  const { data: aal, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return { step: 'signin' };
  if (aal.currentLevel === 'aal2') return { step: 'ready', user: session.user };
  const { data: factors } = await sb.auth.mfa.listFactors();
  const verified = (factors?.all || []).filter((f) => f.factor_type === 'totp' && f.status === 'verified');
  return verified.length
    ? { step: 'challenge', user: session.user, factorId: verified[0].id }
    : { step: 'enroll', user: session.user };
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
  return { needsEmailConfirm: !data.session };
}

export async function sendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
}

export async function setPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}

/** Start authenticator-app enrolment. Returns the QR code and secret to show. */
export async function startEnroll() {
  const { data: factors } = await sb.auth.mfa.listFactors();
  for (const f of factors?.all || []) {
    if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id }); // clear abandoned attempts
  }
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Synaptask ${Date.now()}` });
  if (error) throw error;
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

export async function verifyCode(factorId, code) {
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') });
  if (error) throw error;
}

export async function signOut() {
  await sb.auth.signOut();
}
