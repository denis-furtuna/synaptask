// Seal an object to the Work vault's RSA public key, exactly like vault.sealTo() in web/js/vault.js:
//   random AES-256 key --RSA-OAEP(SHA-256)--> wk
//   payload --AES-256-GCM, AAD "inbox" (or another label)--> iv, ct
// Only the unlocked app holds the private key, so the server cannot read what it stores.

const te = new TextEncoder();

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface Sealed { wk: string; iv: string; ct: string }

export async function sealTo(publicJwk: JsonWebKey, obj: unknown, aad = 'inbox'): Promise<Sealed> {
  const { kty, n, e } = publicJwk;
  if (kty !== 'RSA' || !n || !e) throw new Error('The Work vault public key is not valid.');
  const pub = await crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RSA-OAEP-256', ext: true }, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj)));
  const wk = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw);
  raw.fill(0);
  return { wk: b64(wk), iv: b64(iv), ct: b64(ct) };
}
