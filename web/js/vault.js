// Work vault: everything in the Work section is encrypted in the browser
// before it is stored or synced. The server only ever sees ciphertext.
//
//   passphrase --PBKDF2-SHA256 (600k rounds)--> key-encryption key
//   key-encryption key --AES-256-GCM--> wraps the random 256-bit vault key
//   vault key --AES-256-GCM--> encrypts every work item (item id bound as AAD)
//   RSA-OAEP 3072 key pair: the public half lets the Claude connector drop
//   new tasks into a sealed inbox; only the unlocked vault can open them.
//
// The vault key lives in memory only and is dropped on lock, tab close or timeout.

import { b64 } from './util.js';

const te = new TextEncoder();
const td = new TextDecoder();
const ITERATIONS = 600000;
const RECOVERY_ITERATIONS = 1000; // the recovery key is 160 random bits, stretching adds nothing
const AES = { name: 'AES-GCM', length: 256 };
const RSA = { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

let vaultKey = null;   // CryptoKey, non-extractable
let privateKey = null; // CryptoKey, non-extractable

async function deriveKek(secret, saltB64, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64.dec(saltB64), iterations, hash: 'SHA-256' },
    base, AES, false, ['encrypt', 'decrypt'],
  );
}

async function seal(key, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = te.encode(aad);
  const ct = await crypto.subtle.encrypt(params, key, bytes);
  return { iv: b64.enc(iv), ct: b64.enc(ct) };
}

async function open(key, box, aad) {
  const params = { name: 'AES-GCM', iv: b64.dec(box.iv) };
  if (aad) params.additionalData = te.encode(aad);
  return new Uint8Array(await crypto.subtle.decrypt(params, key, b64.dec(box.ct)));
}

const importVaultKey = (raw) => crypto.subtle.importKey('raw', raw, AES, false, ['encrypt', 'decrypt']);
const newSalt = () => b64.enc(crypto.getRandomValues(new Uint8Array(16)));
const normRecovery = (s) => String(s).toLowerCase().replace(/[^0-9a-f]/g, '');

async function activate(rawVaultKey, record) {
  const vk = await importVaultKey(rawVaultKey);
  const pkcs8 = await open(vk, record.wrapped_private_key, 'private-key');
  privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  vaultKey = vk;
}

export const isUnlocked = () => vaultKey !== null;
export function lock() { vaultKey = null; privateKey = null; }

/** Create a new vault. Returns the record to store and the one-time recovery key to show. */
export async function create(passphrase) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = newSalt();
  const recoverySalt = newSalt();
  const recoveryBytes = crypto.getRandomValues(new Uint8Array(20));
  const recoveryHex = [...recoveryBytes].map((x) => x.toString(16).padStart(2, '0')).join('');

  const pair = await crypto.subtle.generateKey(RSA, true, ['encrypt', 'decrypt']);
  const vk = await importVaultKey(raw);
  const record = {
    version: 1,
    salt,
    iterations: ITERATIONS,
    recovery_salt: recoverySalt,
    wrapped_key: await seal(await deriveKek(passphrase, salt, ITERATIONS), raw, 'vault-key'),
    recovery_wrapped_key: await seal(await deriveKek(recoveryHex, recoverySalt, RECOVERY_ITERATIONS), raw, 'vault-key'),
    wrapped_private_key: await seal(vk, new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), 'private-key'),
    public_key: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
  await activate(raw, record);
  raw.fill(0);
  return { record, recoveryKey: recoveryHex.match(/.{4}/g).join('-') };
}

/** Unlock with the passphrase. Returns false when the passphrase is wrong. */
export async function unlock(record, passphrase) {
  try {
    const raw = await open(await deriveKek(passphrase, record.salt, record.iterations), record.wrapped_key, 'vault-key');
    await activate(raw, record);
    raw.fill(0);
    return true;
  } catch {
    return false;
  }
}

/** Set a new passphrase using either the old passphrase or the recovery key. Returns the updated record, or null. */
export async function rewrap(record, { passphrase, recoveryKey }, newPassphrase) {
  try {
    const raw = recoveryKey
      ? await open(await deriveKek(normRecovery(recoveryKey), record.recovery_salt, RECOVERY_ITERATIONS), record.recovery_wrapped_key, 'vault-key')
      : await open(await deriveKek(passphrase, record.salt, record.iterations), record.wrapped_key, 'vault-key');
    const salt = newSalt();
    const next = {
      ...record,
      salt,
      iterations: ITERATIONS,
      wrapped_key: await seal(await deriveKek(newPassphrase, salt, ITERATIONS), raw, 'vault-key'),
    };
    await activate(raw, next);
    raw.fill(0);
    return next;
  } catch {
    return null;
  }
}

export async function encryptItem(id, obj) {
  if (!vaultKey) throw new Error('Work section is locked');
  const box = await seal(vaultKey, te.encode(JSON.stringify(obj)), id);
  return { iv: box.iv, ciphertext: box.ct };
}

export async function decryptItem(row) {
  if (!vaultKey) throw new Error('Work section is locked');
  const bytes = await open(vaultKey, { iv: row.iv, ct: row.ciphertext }, row.id);
  return JSON.parse(td.decode(bytes));
}

/** Open a task the Claude connector sealed to the vault's public key. */
export async function openSealed(sealed) {
  if (!privateKey) throw new Error('Work section is locked');
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, b64.dec(sealed.wk));
  const key = await crypto.subtle.importKey('raw', raw, AES, false, ['decrypt']);
  return JSON.parse(td.decode(await open(key, { iv: sealed.iv, ct: sealed.ct }, 'inbox')));
}

/** Seal an object to a vault public key (used by tests; the connector does the same in Deno). */
export async function sealTo(publicJwk, obj) {
  const pub = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, AES, false, ['encrypt']);
  const box = await seal(key, te.encode(JSON.stringify(obj)), 'inbox');
  const wk = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw);
  return { wk: b64.enc(wk), iv: box.iv, ct: box.ct };
}

/** Rough passphrase strength check: length matters most. */
export function passphraseProblem(p) {
  if (p.length < 12) return 'Use at least 12 characters. A few random words works well.';
  if (/^(.)\1+$/.test(p) || /^(?:0123456789|1234567890|password|qwerty)/i.test(p)) return 'That passphrase is too easy to guess.';
  return '';
}
