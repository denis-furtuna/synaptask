// Server side of a Work grant (see supabase/migrations/0002_work_access.sql).
// The app sealed the raw vault key to the server's grant public key with AAD "work-grant";
// GRANT_PRIVATE_JWK opens it. Work items use the same format as web/js/vault.js:
// AES-256-GCM over JSON.stringify({ kind, ...fields }), AAD = the item id, base64 iv + ciphertext.
import { b64, type Sealed } from './seal.ts';

const te = new TextEncoder();
const td = new TextDecoder();
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Open a grant with the server's private key and return the vault key (non-extractable). */
export async function openGrant(sealed: Sealed, privateJwkJson: string): Promise<CryptoKey> {
  const { kty, n, e, d, p, q, dp, dq, qi } = JSON.parse(privateJwkJson) as JsonWebKey;
  const priv = await crypto.subtle.importKey(
    'jwk', { kty, n, e, d, p, q, dp, dq, qi, alg: 'RSA-OAEP-256', ext: false },
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt'],
  );
  const wrap = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, unb64(sealed.wk)));
  const wrapKey = await crypto.subtle.importKey('raw', wrap, 'AES-GCM', false, ['decrypt']);
  wrap.fill(0);
  const payload = JSON.parse(td.decode(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: te.encode('work-grant') }, wrapKey, unb64(sealed.ct),
  )));
  const raw = unb64(String(payload.k || ''));
  if (raw.length !== 32) throw new Error('The Work grant is not valid.');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return key;
}

export async function decryptItem(key: CryptoKey, row: { id: string; iv: string; ciphertext: string }): Promise<Record<string, unknown>> {
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(row.iv), additionalData: te.encode(row.id) }, key, unb64(row.ciphertext),
  );
  return JSON.parse(td.decode(bytes));
}

export async function encryptItem(key: CryptoKey, id: string, obj: Record<string, unknown>): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(id) }, key, te.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ciphertext: b64(ct) };
}
