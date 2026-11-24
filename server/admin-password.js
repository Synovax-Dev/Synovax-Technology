// The admin password. Only a scrypt hash is kept, in DATA_DIR/admin-password.
//
// Forgot it? On the server:  npm run admin:password -- "a new password"
// (or with no argument to get a random one printed). That also signs out every
// admin session. Changing it from the admin panel works too, if you know the old one.
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 200;
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;

const derive = (password, salt, n = N, r = R, p = P) => new Promise((resolve, reject) =>
  scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored ?? '').trim());
  if (!m || typeof password !== 'string' || !password || password.length > MAX_LENGTH) return false;
  const want = Buffer.from(m[5], 'base64url');
  const got = await derive(password, Buffer.from(m[4], 'base64url'), Number(m[1]), Number(m[2]), Number(m[3]));
  return got.length === want.length && timingSafeEqual(got, want);
}

export function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (pw.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(pw)) return 'The password has characters that are not allowed.';
  return null;
}

export const passwordFile = (dataDir) => path.join(dataDir, 'admin-password');

export async function savePasswordHash(dataDir, hash) {
  const file = passwordFile(dataDir);
  await writeFile(`${file}.tmp`, `${hash}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  // an old plain-text key file would now be wrong, and should not linger
  await rm(path.join(dataDir, 'admin-key'), { force: true });
}

export const readPasswordHash = (dataDir) => readFile(passwordFile(dataDir), 'utf8').then((s) => s.trim());

/**
 * Makes sure a password hash exists. First run: ADMIN_PASSWORD (or the older
 * ADMIN_KEY), else an existing data/admin-key, else a random password that is
 * printed once. After that the file wins, so a password changed in the panel
 * survives restarts.
 */
export async function ensurePassword(dataDir, log = console.log) {
  if (existsSync(passwordFile(dataDir))) {
    if (process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY) log('Admin password: using the saved one; ADMIN_PASSWORD only applies on the very first start (reset with npm run admin:password).');
    return;
  }
  let initial = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY || '';
  let made = false;
  const legacy = path.join(dataDir, 'admin-key');
  if (!initial && existsSync(legacy)) initial = readFileSync(legacy, 'utf8').trim();
  if (!initial) { initial = randomBytes(18).toString('base64url'); made = true; }
  const problem = checkNewPassword(initial);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  await savePasswordHash(dataDir, await hashPassword(initial));
  if (made) log(`Admin password (shown once, change it in the panel): ${initial}`);
}

// ---------- command line reset
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
  const given = process.argv[2];
  const pw = given ?? randomBytes(18).toString('base64url');
  const problem = checkNewPassword(pw);
  if (problem) { console.error(problem); process.exit(1); }
  await savePasswordHash(dataDir, await hashPassword(pw));
  // sign out every admin session
  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = path.join(dataDir, 'vault.db');
  if (existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 5000');
    try { db.prepare('DELETE FROM admin_sessions').run(); } catch { /* table not there yet */ }
    db.close();
  }
  console.log(given ? 'Admin password changed. Every admin session was signed out.' : `New admin password: ${pw}\nEvery admin session was signed out.`);
}
