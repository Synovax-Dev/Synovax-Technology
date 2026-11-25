// Crypto shared by the vault app (browser) and the connector (Node).
// WebCrypto only, no dependencies, so the exact same code runs in both places.
//
// Key layout
//   passphrase --PBKDF2--> master --HKDF--> authKey (sent to server, stored hashed)
//                                     \--> kek     (never leaves the device)
//   recovery phrase (24 words, 192 bits) --HKDF--> master --> authKey / kek, same split
//   vault key (VK, random)    wrapped by kek (passphrase) and by the recovery kek
//   folder key (FK, random)   wrapped by VK, and by each app's wrap key it is granted to
//   memory head/body          AES-GCM under the folder key
//   inbox box key pair        private key wrapped by VK; apps seal suggestions to the public key
//   app key = prefix.appId.secret --HKDF--> auth (server keeps a hash), wrap, vouch
import { WORDS } from './wordlist.js';
import { APP_KEY_PREFIX } from './brand.js';

const subtle = globalThis.crypto.subtle;
export const te = new TextEncoder();
export const td = new TextDecoder();
export const PBKDF2_ITERATIONS = 600_000;

export class CryptoError extends Error {}

// ---------- bytes and encodings

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// base64url without padding
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new CryptoError('Bad base64 data.');
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const newId = () => b64(randomBytes(16)); // 22 chars

// ---------- key derivation

export async function pbkdf2(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
}

export async function hkdf(ikm, info, length = 32) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) }, base, length * 8));
}

async function splitMaster(master) {
  return { authKey: b64(await hkdf(master, 'vault/auth/v1')), kek: await hkdf(master, 'vault/kek/v1') };
}

/** Keys from a passphrase: { authKey (base64, for the server), kek (bytes, stays here) } */
export async function keysFromPassphrase(passphrase, saltB64, iterations = PBKDF2_ITERATIONS) {
  return splitMaster(await pbkdf2(passphrase, unb64(saltB64), iterations));
}

export async function keysFromRecovery(phrase) {
  return splitMaster(await hkdf(phraseToEntropy(phrase), 'vault/recovery/v1'));
}

// ---------- recovery phrase

export function newRecoveryPhrase() {
  return Array.from(randomBytes(24), (b) => WORDS[b]).join(' ');
}

export function phraseToEntropy(phrase) {
  const words = String(phrase).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 24) throw new CryptoError(`A recovery phrase has 24 words; this one has ${words.length}.`);
  return Uint8Array.from(words.map((w) => {
    const i = WORDS.indexOf(w);
    if (i < 0) throw new CryptoError(`"${w}" is not one of the recovery words.`);
    return i;
  }));
}

// ---------- AES-256-GCM. Token format: "v1." + base64url(iv || ciphertext+tag)
// `aad` binds a ciphertext to where it belongs (e.g. "memory:<id>:body"), so the
// server cannot move a ciphertext to another record without decryption failing.

export async function encryptBytes(keyRaw, data, aad = '') {
  const iv = randomBytes(12);
  const key = await subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, data));
  return 'v1.' + b64(concat(iv, ct));
}

export async function decryptBytes(keyRaw, token, aad = '') {
  if (typeof token !== 'string' || !token.startsWith('v1.')) throw new CryptoError('Unknown ciphertext format.');
  const all = unb64(token.slice(3));
  if (all.length < 12 + 16) throw new CryptoError('Ciphertext is too short.');
  const key = await subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: te.encode(aad) }, key, all.subarray(12)));
  } catch {
    throw new CryptoError('Could not decrypt: wrong key, or the data was changed.');
  }
}

export const encryptJSON = (keyRaw, value, aad) => encryptBytes(keyRaw, te.encode(JSON.stringify(value)), aad);
export const decryptJSON = async (keyRaw, token, aad) => JSON.parse(td.decode(await decryptBytes(keyRaw, token, aad)));
export const wrapKey = (kek, key, aad) => encryptBytes(kek, key, aad);
export const unwrapKey = (kek, token, aad) => decryptBytes(kek, token, aad);

// ---------- sealed boxes (ECDH P-256 + HKDF + AES-GCM)
// Anyone with the public key can seal; only the private key opens.
// Format: "box1." + base64url(ephemeral public key, SPKI) + "." + v1 token

const P256 = { name: 'ECDH', namedCurve: 'P-256' };

export async function newBoxKeyPair() {
  const kp = await subtle.generateKey(P256, true, ['deriveBits']);
  return {
    pub: b64(new Uint8Array(await subtle.exportKey('spki', kp.publicKey))),
    priv: new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)),
  };
}

async function boxKey(shared, ephPubB64, recipientPubB64) {
  return hkdf(shared, `vault/box/v1|${ephPubB64}|${recipientPubB64}`);
}

export async function boxSeal(recipientPubB64, value) {
  const eph = await subtle.generateKey(P256, true, ['deriveBits']);
  const recipient = await subtle.importKey('spki', unb64(recipientPubB64), P256, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256));
  const ephPub = b64(new Uint8Array(await subtle.exportKey('spki', eph.publicKey)));
  const key = await boxKey(shared, ephPub, recipientPubB64);
  return `box1.${ephPub}.${await encryptJSON(key, value, 'box')}`;
}

export async function boxOpen(privPkcs8, recipientPubB64, token) {
  const m = /^box1\.([A-Za-z0-9_-]+)\.(v1\.[A-Za-z0-9_-]+)$/.exec(String(token));
  if (!m) throw new CryptoError('Unknown sealed box format.');
  const priv = await subtle.importKey('pkcs8', privPkcs8, P256, false, ['deriveBits']);
  const eph = await subtle.importKey('spki', unb64(m[1]), P256, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: eph }, priv, 256));
  return decryptJSON(await boxKey(shared, m[1], recipientPubB64), m[2], 'box');
}

// ---------- sharing a folder with another vault
// The recipient hands over a share code: their vault name and a fingerprint of
// their inbox public key. The owner's vault fetches that key and checks the
// fingerprint, so a server that swapped in its own key is caught. The folder key
// then goes to the recipient in a sealed box, with a tag made from the two
// vaults' keys (static ECDH), so the recipient knows which vault sent it and the
// server cannot forge a share.

export const SHARE_PREFIX = 'synovax-share';

export async function keyFingerprint(boxPubB64) {
  const d = new Uint8Array(await subtle.digest('SHA-256', te.encode(`vault/fingerprint/v1|${boxPubB64}`)));
  return b64(d.subarray(0, 15)); // 20 characters
}

export function formatShareCode(username, fingerprint) {
  return `${SHARE_PREFIX}:${username}:${fingerprint}`;
}

export function parseShareCode(str) {
  const m = new RegExp(`^${SHARE_PREFIX}:([a-z0-9][a-z0-9_.-]{2,31}):([A-Za-z0-9_-]{20})$`).exec(String(str).trim());
  if (!m) throw new CryptoError(`That does not look like a share code (${SHARE_PREFIX}:<vault name>:<fingerprint>).`);
  return { username: m[1], fingerprint: m[2] };
}

// The same key from both sides: ECDH(owner private, recipient public) equals
// ECDH(recipient private, owner public).
async function pairKey(myPrivPkcs8, theirPubB64, ownerPubB64, recipientPubB64) {
  const priv = await subtle.importKey('pkcs8', myPrivPkcs8, P256, false, ['deriveBits']);
  const pub = await subtle.importKey('spki', unb64(theirPubB64), P256, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  return hkdf(shared, `vault/share/v1|${ownerPubB64}|${recipientPubB64}`);
}

const shareText = (s) => JSON.stringify(['share/v1', s.shareId, s.folderId, s.folderKey, s.folderName, s.owner, s.recipient]);

/** Seal a folder key for another vault. s: { shareId, folderId, folderKey (bytes), folderName, owner, recipient } */
export async function shareSeal(ownerPrivPkcs8, ownerPubB64, recipientPubB64, s) {
  const payload = { shareId: s.shareId, folderId: s.folderId, folderKey: b64(s.folderKey), folderName: s.folderName, owner: s.owner, recipient: s.recipient };
  const k = await subtle.importKey('raw', await pairKey(ownerPrivPkcs8, recipientPubB64, ownerPubB64, recipientPubB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const tag = b64(new Uint8Array(await subtle.sign('HMAC', k, te.encode(shareText(payload)))));
  return boxSeal(recipientPubB64, { ...payload, tag });
}

/** Open a share as its recipient, and check it came from the vault with ownerPubB64. */
export async function shareOpen(recipientPrivPkcs8, recipientPubB64, ownerPubB64, box) {
  const p = await boxOpen(recipientPrivPkcs8, recipientPubB64, box);
  const k = await subtle.importKey('raw', await pairKey(recipientPrivPkcs8, ownerPubB64, ownerPubB64, recipientPubB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (typeof p?.tag !== 'string' || !(await subtle.verify('HMAC', k, unb64(p.tag), te.encode(shareText(p))))) {
    throw new CryptoError('This share does not carry a valid tag from the vault it claims to come from.');
  }
  return { shareId: p.shareId, folderId: p.folderId, folderKey: unb64(p.folderKey), folderName: p.folderName, owner: p.owner, recipient: p.recipient };
}

// ---------- app keys

export function formatAppKey(appId, secret) {
  return `${APP_KEY_PREFIX}.${appId}.${b64(secret)}`;
}

export function parseAppKey(str) {
  const m = new RegExp(`^${APP_KEY_PREFIX}\\.([A-Za-z0-9_-]{22})\\.([A-Za-z0-9_-]{43})$`).exec(String(str).trim());
  if (!m) throw new CryptoError(`That does not look like an app key (${APP_KEY_PREFIX}.<id>.<secret>).`);
  return { appId: m[1], secret: unb64(m[2]) };
}

/** auth: base64 token the server checks (it stores only a hash). wrap: unlocks granted folder keys. vouch: proves the vault's public key. */
export async function appKeyMaterial(secret) {
  return {
    auth: b64(await hkdf(secret, 'vault/app/auth/v1')),
    wrap: await hkdf(secret, 'vault/app/wrap/v1'),
    vouch: await hkdf(secret, 'vault/app/vouch/v1'),
  };
}

// The vault signs (HMAC) its inbox public key with a key only the vault and the
// app know, so the server cannot swap in its own key to read suggestions.
export async function vouchFor(vouchKey, appId, boxPubB64) {
  const k = await subtle.importKey('raw', vouchKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await subtle.sign('HMAC', k, te.encode(`${appId}|${boxPubB64}`))));
}

export async function checkVouch(vouchKey, appId, boxPubB64, vouchB64) {
  const k = await subtle.importKey('raw', vouchKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return subtle.verify('HMAC', k, unb64(vouchB64), te.encode(`${appId}|${boxPubB64}`));
}
