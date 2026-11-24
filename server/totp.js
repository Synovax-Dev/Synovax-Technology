// Time-based one-time codes (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits),
// the kind Google Authenticator, Aegis, 1Password and the like generate.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_MS = 30_000;

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function unbase32(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32.');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

export function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const currentStep = (t = Date.now()) => Math.floor(t / STEP_MS);

/** The step the code belongs to (now, or one step either side for clock drift), or null. */
export function matchStep(secretB32, code, t = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const now = currentStep(t);
  for (const s of [now, now - 1, now + 1]) if (totpAt(secretB32, s) === String(code)) return s;
  return null;
}

export const otpauthUri = (secretB32, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
