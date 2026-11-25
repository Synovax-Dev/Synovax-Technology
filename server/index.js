// The vault server. It stores ciphertext and keeps the read log; it never sees
// a passphrase, a vault key, a folder key, an app's secret or a word of a memory.
import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { newTotpSecret, matchStep, otpauthUri } from './totp.js';
import { ensurePassword, verifyPassword, readPasswordHash, savePasswordHash, hashPassword, checkNewPassword } from './admin-password.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { createRpcIndex, fromBlockscout } from './holders.js';
import { startSealer, proofFor, sealOut } from './seals.js';
import { leafHash, GENESIS, merkleProof } from '../shared/merkle.js';
import { runRound, roundHash, STRAINS, DISGUISES } from './immune-round.js';
import { PBKDF2_ITERATIONS, keyFingerprint } from '../shared/crypto.js';
import { APP_NAME } from '../shared/brand.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const SEAL_PERIOD_MS = Number(process.env.SEAL_PERIOD_MS ?? 3_600_000);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const LIMITS = { folders: 200, memories: 20_000, apps: 50, suggestions: 500, sharesPerFolder: 20, shares: 200 };
// Legacy counts inactivity in days. Tests shorten a day; a real server leaves it at 24 hours.
const LEGACY_DAY_MS = Number(process.env.LEGACY_DAY_MS ?? 86_400_000);
// how often a busy session refreshes "last seen": often enough to be exact to a small part of a day
const SEEN_EVERY_MS = Math.min(60_000, Math.max(100, LEGACY_DAY_MS / 20));
// Every new vault and passphrase uses exactly this many PBKDF2 rounds, so the salt
// endpoint answers the same for names that exist and names that do not.
const KDF_ITERATIONS = Number(process.env.KDF_ITERATIONS ?? PBKDF2_ITERATIONS);
// Behind a reverse proxy, the client's IP comes from X-Forwarded-For. Set this to the
// number of proxies in front of the server (usually 1). Off by default, because a
// client talking to the server directly could otherwise fake its IP.
const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? 0);
// The landing page shows its live counts only from this many vaults on (0 = always).
const STATS_MIN_VAULTS = (() => { const n = Number.parseInt(process.env.STATS_MIN_VAULTS ?? '100', 10); return Number.isFinite(n) ? Math.max(0, n) : 100; })();
if (!Number.isInteger(KDF_ITERATIONS) || KDF_ITERATIONS < 100_000 || KDF_ITERATIONS > 10_000_000) {
  console.error('KDF_ITERATIONS must be a whole number from 100000 to 10000000.'); process.exit(1);
}
if (!Number.isInteger(TRUST_PROXY) || TRUST_PROXY < 0 || TRUST_PROXY > 10) {
  console.error('TRUST_PROXY must be the number of proxies in front of the server (0 to 10).'); process.exit(1);
}

await mkdir(DATA_DIR, { recursive: true });
const secretFile = path.join(DATA_DIR, 'server-secret');
if (!existsSync(secretFile)) await writeFile(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const SERVER_SECRET = readFileSync(secretFile, 'utf8').trim();
const db = openDb(path.join(DATA_DIR, 'vault.db'));

// ---------- helpers

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const need = (ok, status, message) => { if (!ok) throw new HttpError(status, message); };
const now = () => Date.now();
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const newToken = (n) => randomBytes(n).toString('base64url');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const RE = {
  id: /^[A-Za-z0-9_-]{22}$/,
  key: /^[A-Za-z0-9_-]{43}$/,
  salt: /^[A-Za-z0-9_-]{22}$/,
  b64: /^[A-Za-z0-9_-]+$/,
  ct: /^v1\.[A-Za-z0-9_-]{38,}$/,
  box: /^box1\.[A-Za-z0-9_-]+\.v1\.[A-Za-z0-9_-]+$/,
  user: /^[a-z0-9][a-z0-9_.-]{2,31}$/,
};

function field(v, re, name, max = 1_000_000) {
  need(typeof v === 'string' && v.length <= max && re.test(v), 400, `Invalid ${name}.`);
  return v;
}
const username = (v) => field(typeof v === 'string' ? v.trim().toLowerCase() : v, RE.user, 'name (3 to 32 letters, digits, dot, dash or underscore)');

function intParam(v, min, max, dflt) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// Attempts are kept in the database, so restarting the server does not reset them.
const recentHits = (key, windowMs) => db.prepare('SELECT COUNT(*) n FROM rate_hits WHERE key = ? AND ts > ?').get(key, now() - windowMs).n;
const noteHit = (key) => { db.prepare('INSERT INTO rate_hits (key, ts) VALUES (?, ?)').run(key, now()); };
const TOO_MANY = 'Too many attempts. Wait a moment and try again.';
function rateLimit(key, max, windowMs) {
  need(recentHits(key, windowMs) < max, 429, TOO_MANY);
  noteHit(key);
}

// Guessing limits for one account. Only failed attempts count, and they count
// per (account, IP), so a stranger typing wrong passphrases cannot lock the owner
// out. A high per-account cap still stops a guesser spread over many IPs, and it
// only blocks IPs that have themselves failed on that account.
function checkGuesses(kind, u, ip, perIpMax, perIpWindowMs, accountMax) {
  need(recentHits(`${kind}-fail:${u}|${ip}`, perIpWindowMs) < perIpMax, 429, TOO_MANY);
  need(!(recentHits(`${kind}-fail:${u}`, 3_600_000) >= accountMax && recentHits(`${kind}-fail:${u}|${ip}`, 3_600_000) > 0), 429, TOO_MANY);
}
function noteGuessFailed(kind, u, ip) {
  noteHit(`${kind}-fail:${u}|${ip}`);
  noteHit(`${kind}-fail:${u}`);
}

function clientIp(req) {
  const direct = req.socket.remoteAddress ?? '?';
  if (!TRUST_PROXY) return direct;
  // Each proxy appends the address it saw, so the trustworthy entry is the
  // TRUST_PROXY-th from the right; anything left of it the client could have written.
  const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - TRUST_PROXY] ?? direct;
}
setInterval(() => {
  const t = now();
  db.prepare('DELETE FROM rate_hits WHERE ts < ?').run(t - 3_600_000); // the longest window is one hour
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(t);
}, 600_000).unref();

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

// The admin password guards the public token details on the landing page. Only
// a scrypt hash is stored (DATA_DIR/admin-password); see server/admin-password.js.
const ADMIN_TTL_MS = 12 * 3600 * 1000;
try { await ensurePassword(DATA_DIR); } catch (e) { console.error(e.message); process.exit(1); }
// the password may have been reset since the last run: no admin session outlives a restart
db.prepare('DELETE FROM admin_sessions').run();

async function logRead(vaultId, appId, action, target) {
  const entry = { id: newToken(16), ts: now(), vault_id: vaultId, app_id: appId, action, target: target ?? null, salt: newToken(16) };
  const leaf = await leafHash(entry);
  db.prepare('INSERT INTO read_log (id, vault_id, app_id, action, target, ts, salt, leaf) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(entry.id, vaultId, appId, action, entry.target, entry.ts, entry.salt, leaf);
}

// A short label for the session list, from the User-Agent. Only browser and OS
// families are kept, never the full string.
function deviceLabel(ua) {
  ua = String(ua ?? '');
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function newSession(vaultId, req) {
  const token = newToken(32);
  const t = now();
  db.prepare('INSERT INTO sessions (token_hash, id, vault_id, expires_at, created_at, last_used_at, agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256hex(token), newToken(12), vaultId, t + SESSION_TTL_MS, t, t, deviceLabel(req.headers['user-agent']));
  db.prepare('UPDATE vaults SET last_seen_at = ? WHERE id = ?').run(t, vaultId);
  return token;
}
// vaults from before legacy existed count as seen now, so nothing opens early
db.prepare('UPDATE vaults SET last_seen_at = ? WHERE last_seen_at IS NULL').run(Date.now());

// sessions from before the session list existed get an id now
for (const s of db.prepare('SELECT token_hash FROM sessions WHERE id IS NULL').all()) {
  db.prepare('UPDATE sessions SET id = ?, agent = COALESCE(agent, ?) WHERE token_hash = ?').run(newToken(12), 'Unknown device', s.token_hash);
}

const keyBundle = (v) => ({ vaultId: v.id, wrappedVaultKey: v.wrapped_vk, boxPub: v.box_pub, boxPrivWrapped: v.box_priv_wrapped });

// A made-up but stable salt for names that do not exist, so the salt endpoint
// does not tell anyone which names are registered.
const fakeSalt = (u) => createHmac('sha256', SERVER_SECRET).update(`salt:${u}`).digest().subarray(0, 16).toString('base64url');

// Two-step sign-in secrets are the one thing the server must be able to read
// (it checks the codes), so they are encrypted with a key from server-secret
// rather than stored as they are.
const TOTP_KEY = createHmac('sha256', SERVER_SECRET).update('totp-at-rest/v1').digest();
function sealServer(text, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', TOTP_KEY, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `s1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}
function openServer(token, aad) {
  const all = Buffer.from(String(token).slice(3), 'base64url');
  const d = createDecipheriv('aes-256-gcm', TOTP_KEY, all.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(all.subarray(12, 28));
  return Buffer.concat([d.update(all.subarray(28)), d.final()]).toString('utf8');
}
const totpAad = (vaultId) => `totp:${vaultId}`;

// A code is good once: its time step must be newer than the last one accepted.
function useTotp(v, code) {
  const step = matchStep(openServer(v.totp_enc, totpAad(v.id)), String(code ?? '').replace(/\s/g, ''));
  if (step == null || step <= (v.totp_last ?? -1)) return false;
  db.prepare('UPDATE vaults SET totp_last = ? WHERE id = ?').run(step, v.id);
  return true;
}

// ---------- auth

function ownerAuth(req) {
  const m = /^Bearer s\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
  need(m, 401, 'Not signed in.');
  const tokenHash = sha256hex(m[1]);
  const row = db.prepare('SELECT id, vault_id, expires_at, last_used_at FROM sessions WHERE token_hash = ?').get(tokenHash);
  need(row && row.expires_at > now(), 401, 'Your session has ended. Open your vault again.');
  if (!row.last_used_at || now() - row.last_used_at > SEEN_EVERY_MS) {
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?').run(now(), tokenHash);
    db.prepare('UPDATE vaults SET last_seen_at = ? WHERE id = ?').run(now(), row.vault_id);
  }
  return { vaultId: row.vault_id, tokenHash, sessionId: row.id };
}

function appAuth(req) {
  const m = /^Bearer a\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
  need(m, 401, 'Missing app key.');
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(m[1]);
  need(app && safeEqualHex(app.auth_hash, sha256hex(m[2])), 401, 'This app key was revoked or is not valid.');
  db.prepare('UPDATE apps SET last_used_at = ? WHERE id = ?').run(now(), app.id);
  return app;
}

function adminAuth(req) {
  const m = /^Bearer adm\.([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
  need(m, 401, 'Not signed in to the admin panel.');
  const tokenHash = sha256hex(m[1]);
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(tokenHash);
  need(row && row.expires_at > now(), 401, 'Your admin session has ended. Sign in again.');
  return { tokenHash };
}

// ---------- routing

const routes = [];
function route(method, pattern, auth, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]+)'; }) + '$');
  routes.push({ method, re, keys, auth, handler, maxBody: opts.maxBody ?? MAX_BODY });
}

async function readJson(req, maxBody = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBody) throw new HttpError(413, 'Request is too large.');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    need(v && typeof v === 'object' && !Array.isArray(v), 400, 'Expected a JSON object.');
    return v;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON.');
  }
}

// ---------- public

route('GET', '/api/config', 'none', () => ({
  appName: APP_NAME,
  sealPeriodMs: SEAL_PERIOD_MS,
  iterations: KDF_ITERATIONS,
  statsMinVaults: STATS_MIN_VAULTS,
  // A server started with `npx synovax` lives in npx's cache, which can be cleared,
  // so the vault then shows the npx form of the connector instead of this path.
  connectorPath: LOOPBACK && !process.env.SYNOVAX_CLI ? path.join(ROOT, 'connector', 'index.js') : null,
}));

route('GET', '/api/stats', 'none', () => ({
  vaults: count('SELECT COUNT(*) n FROM vaults'),
  memories: count('SELECT COUNT(*) n FROM memories'),
  reads: count('SELECT COUNT(*) n FROM read_log'),
  seals: count('SELECT COUNT(*) n FROM seals'),
}));

route('GET', '/api/seals', 'none', ({ url }) => ({
  // ?from=<seq> walks forward from a seal you already know (to check the chain); otherwise newest first
  seals: (url.searchParams.has('from')
    ? db.prepare('SELECT * FROM seals WHERE seq >= ? ORDER BY seq ASC LIMIT ?').all(intParam(url.searchParams.get('from'), 1, Number.MAX_SAFE_INTEGER, 1), intParam(url.searchParams.get('limit'), 1, 500, 500))
    : db.prepare('SELECT * FROM seals ORDER BY seq DESC LIMIT ?').all(intParam(url.searchParams.get('limit'), 1, 500, 50))).map(sealOut),
  periodMs: SEAL_PERIOD_MS,
  nextCloseAt: (Math.floor(now() / SEAL_PERIOD_MS) + 1) * SEAL_PERIOD_MS,
}));

// ---------- status and the public test of the hidden-instruction checks

const STARTED_AT = now();
const HOUR_MS = 3_600_000;
const IMMUNE_ON = process.env.IMMUNE_TEST !== 'off';
const IMMUNE_KEEP_MS = 90 * 24 * HOUR_MS;
let sealer = null; // set when the sealer starts, below
let lastBackupAt = null;

function immuneTick() {
  if (!IMMUNE_ON) return;
  try {
    const hourStart = Math.floor(now() / HOUR_MS) * HOUR_MS;
    if (db.prepare('SELECT 1 FROM immune_rounds WHERE hour_start = ?').get(hourStart)) return;
    const round = runRound(hourStart);
    const prev = db.prepare('SELECT hash FROM immune_rounds ORDER BY hour_start DESC LIMIT 1').get()?.hash ?? GENESIS;
    const results = round.results.map((x) => [x.strain, x.disguise, x.held ? 1 : 0]);
    db.prepare('INSERT OR IGNORE INTO immune_rounds (hour_start, created_at, total, held, results, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hourStart, now(), round.total, round.held, JSON.stringify(results), prev, roundHash(round, prev));
    db.prepare('DELETE FROM immune_rounds WHERE hour_start < ?').run(hourStart - IMMUNE_KEEP_MS);
  } catch (e) {
    console.error('[immune]', e.message);
  }
}
immuneTick();
setInterval(immuneTick, 60_000).unref();

const roundOut = (r, full) => ({
  hourStart: r.hour_start, ranAt: r.created_at, total: r.total, held: r.held, prev: r.prev, hash: r.hash,
  ...(full ? { results: JSON.parse(r.results).map(([strain, disguise, held]) => ({ strain, disguise, held: !!held })) } : {}),
});

route('GET', '/api/immune', 'none', ({ url }) => {
  const latest = db.prepare('SELECT * FROM immune_rounds ORDER BY hour_start DESC LIMIT 1').get();
  const recent = db.prepare('SELECT * FROM immune_rounds ORDER BY hour_start DESC LIMIT ?').all(intParam(url.searchParams.get('limit'), 1, 500, 48));
  return {
    enabled: IMMUNE_ON,
    periodMs: HOUR_MS,
    nextAt: (Math.floor(now() / HOUR_MS) + 1) * HOUR_MS,
    strains: STRAINS.map(({ id, name, text }) => ({ id, name, text })),
    disguises: DISGUISES.map(({ id, name }) => ({ id, name })),
    latest: latest ? roundOut(latest, true) : null,
    recent: recent.map((r) => roundOut(r, false)),
  };
});

route('GET', '/api/immune/:hour', 'none', ({ params }) => {
  const r = db.prepare('SELECT * FROM immune_rounds WHERE hour_start = ?').get(Number(params.hour));
  need(r, 404, 'No round for that hour.');
  return roundOut(r, true);
});

route('GET', '/api/status', 'none', () => {
  const t0 = performance.now();
  let database = 'ok', vaults = 0;
  try { vaults = count('SELECT COUNT(*) n FROM vaults'); } catch { database = 'failed'; }
  const dbMs = Math.round((performance.now() - t0) * 10) / 10;
  const t = now();
  const periodStart = Math.floor(t / SEAL_PERIOD_MS) * SEAL_PERIOD_MS;
  const open = count('SELECT COUNT(*) n FROM read_log WHERE seal_seq IS NULL AND ts >= ?', periodStart);
  // reads of a finished period still unsealed a while after it ended (the job runs every few seconds)
  const overdue = t - periodStart > 120_000 ? count('SELECT COUNT(*) n FROM read_log WHERE seal_seq IS NULL AND ts < ?', periodStart) : 0;
  const s = sealer?.state;
  const job = !s ? 'starting' : s.lastError && (!s.lastTickAt || s.lastError.at > s.lastTickAt) ? 'failed'
    : !s.lastTickAt || t - s.lastTickAt > Math.max(120_000, s.intervalMs * 4) ? 'late' : overdue ? 'behind' : 'ok';
  const last = db.prepare('SELECT * FROM seals ORDER BY seq DESC LIMIT 1').get();
  const round = db.prepare('SELECT hour_start, created_at, total, held FROM immune_rounds ORDER BY hour_start DESC LIMIT 1').get();
  const shown = vaults >= STATS_MIN_VAULTS;
  return {
    ok: database === 'ok' && (job === 'ok' || job === 'starting'),
    time: new Date(t).toISOString(),
    startedAt: STARTED_AT,
    uptimeMs: t - STARTED_AT,
    database: { state: database, ms: dbMs },
    seals: {
      job, periodMs: SEAL_PERIOD_MS, nextCloseAt: periodStart + SEAL_PERIOD_MS, open, overdue,
      lastRunAt: s?.lastTickAt ?? null, latest: last ? sealOut(last) : null, total: count('SELECT COUNT(*) n FROM seals'),
      published: !!process.env.SEAL_PUBLISH_URL,
    },
    immune: { enabled: IMMUNE_ON, latest: round ? { hourStart: round.hour_start, ranAt: round.created_at, total: round.total, held: round.held } : null },
    backups: { enabled: BACKUP_INTERVAL_MS > 0, intervalMs: BACKUP_INTERVAL_MS, lastAt: lastBackupAt },
    // the same rule as the landing page: counts only once this server has a real crowd
    counts: shown ? {
      vaults, memories: count('SELECT COUNT(*) n FROM memories'), apps: count('SELECT COUNT(*) n FROM apps'),
      reads: count('SELECT COUNT(*) n FROM read_log'), seals: count('SELECT COUNT(*) n FROM seals'),
    } : null,
    statsMinVaults: STATS_MIN_VAULTS,
  };
});

// The proof for one leaf of a seal, for anyone: a leaf is a salted hash and says
// nothing about the read behind it.
route('GET', '/api/seals/:seq/proof', 'none', async ({ params, url }) => {
  const s = db.prepare('SELECT * FROM seals WHERE seq = ?').get(Number(params.seq));
  need(s, 404, 'No such seal.');
  const leaf = String(url.searchParams.get('leaf') ?? '').toLowerCase().replace(/^0x/, '');
  need(/^[0-9a-f]{64}$/.test(leaf), 400, 'Give the leaf as 64 hex characters.');
  const row = db.prepare('SELECT idx FROM seal_leaves WHERE seal_seq = ? AND leaf = ?').get(s.seq, leaf);
  need(row, 404, 'That leaf is not part of this seal.');
  const leaves = db.prepare('SELECT leaf FROM seal_leaves WHERE seal_seq = ? ORDER BY idx').all(s.seq).map((r) => r.leaf);
  return { seal: sealOut(s), leaf, leafIndex: row.idx, proof: await merkleProof(leaves, row.idx) };
});

route('GET', '/api/seals/:seq', 'none', ({ params }) => {
  const s = db.prepare('SELECT * FROM seals WHERE seq = ?').get(Number(params.seq));
  need(s, 404, 'No such seal.');
  return sealOut(s);
});

route('POST', '/api/auth/salt', 'none', ({ body, ip }) => {
  rateLimit(`salt:${ip}`, 60, 60_000);
  const u = username(body.username);
  const v = db.prepare('SELECT salt, kdf_iter FROM vaults WHERE username = ?').get(u);
  return { salt: v ? v.salt : fakeSalt(u), iterations: v ? v.kdf_iter : KDF_ITERATIONS };
});

const checkIterations = (n) => need(n === KDF_ITERATIONS, 400, `Invalid iterations (this server uses ${KDF_ITERATIONS}).`);

route('POST', '/api/auth/register', 'none', ({ req, body, ip }) => {
  rateLimit(`register:${ip}`, 10, 3_600_000);
  const u = username(body.username);
  checkIterations(body.iterations);
  const v = {
    id: newToken(16),
    username: u,
    salt: field(body.salt, RE.salt, 'salt'),
    kdf_iter: body.iterations,
    auth_hash: sha256hex(field(body.authKey, RE.key, 'authKey')),
    rec_auth_hash: sha256hex(field(body.recoveryAuthKey, RE.key, 'recoveryAuthKey')),
    wrapped_vk: field(body.wrappedVaultKey, RE.ct, 'wrappedVaultKey', 200),
    wrapped_vk_rec: field(body.wrappedVaultKeyRecovery, RE.ct, 'wrappedVaultKeyRecovery', 200),
    box_pub: field(body.boxPub, RE.b64, 'boxPub', 300),
    box_priv_wrapped: field(body.boxPrivWrapped, RE.ct, 'boxPrivWrapped', 500),
  };
  need(!db.prepare('SELECT 1 FROM vaults WHERE username = ?').get(u), 409, 'That name is taken.');
  db.prepare(`INSERT INTO vaults (id, username, salt, kdf_iter, auth_hash, rec_auth_hash, wrapped_vk, wrapped_vk_rec, box_pub, box_priv_wrapped, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(v.id, v.username, v.salt, v.kdf_iter, v.auth_hash, v.rec_auth_hash, v.wrapped_vk, v.wrapped_vk_rec, v.box_pub, v.box_priv_wrapped, now());
  return { token: newSession(v.id, req), keys: keyBundle(v) };
});

route('POST', '/api/auth/login', 'none', ({ req, body, ip }) => {
  const u = username(body.username);
  rateLimit(`login:${ip}`, 20, 60_000);
  checkGuesses('login', u, ip, 10, 60_000, 200);
  const v = db.prepare('SELECT * FROM vaults WHERE username = ?').get(u);
  const given = sha256hex(field(body.authKey, RE.key, 'authKey'));
  if (!(v && safeEqualHex(v.auth_hash, given))) {
    noteGuessFailed('login', u, ip);
    throw new HttpError(401, 'Wrong name or passphrase.');
  }
  if (v.totp_enc) {
    if (!body.totp) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', { needTotp: true });
    if (!useTotp(v, body.totp)) {
      noteGuessFailed('login', u, ip);
      throw new HttpError(401, 'That code is not right, or it was already used. Wait for the next one.', { needTotp: true });
    }
  }
  return { token: newSession(v.id, req), keys: keyBundle(v) };
});

route('POST', '/api/auth/recover', 'none', ({ req, body, ip }) => {
  const u = username(body.username);
  rateLimit(`recover:${ip}`, 10, 600_000);
  checkGuesses('recover', u, ip, 5, 600_000, 50);
  const v = db.prepare('SELECT * FROM vaults WHERE username = ?').get(u);
  const given = sha256hex(field(body.recoveryAuthKey, RE.key, 'recoveryAuthKey'));
  if (!(v && safeEqualHex(v.rec_auth_hash, given))) {
    noteGuessFailed('recover', u, ip);
    throw new HttpError(401, 'Wrong name or recovery phrase.');
  }
  // The 24 words are the way back in after losing everything, the authenticator
  // phone included, so they also turn two-step sign-in off. The person is told.
  const twoFactorReset = !!v.totp_enc;
  if (twoFactorReset) db.prepare('UPDATE vaults SET totp_enc = NULL, totp_pending_enc = NULL, totp_last = NULL WHERE id = ?').run(v.id);
  return { token: newSession(v.id, req), twoFactorReset, keys: { ...keyBundle(v), wrappedVaultKeyRecovery: v.wrapped_vk_rec } };
});

route('POST', '/api/auth/logout', 'owner', ({ auth }) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
});

// ---------- owner: signed-in devices

route('GET', '/api/sessions', 'owner', ({ auth }) => ({
  sessions: db.prepare('SELECT id, agent, created_at, last_used_at, expires_at FROM sessions WHERE vault_id = ? AND expires_at > ? ORDER BY last_used_at DESC')
    .all(auth.vaultId, now())
    .map((s) => ({ id: s.id, agent: s.agent, createdAt: s.created_at, lastUsedAt: s.last_used_at, expiresAt: s.expires_at, current: s.id === auth.sessionId })),
}));

route('DELETE', '/api/sessions/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM sessions WHERE id = ? AND vault_id = ?').run(params.id, auth.vaultId);
  need(r.changes, 404, 'No such session.');
});

route('POST', '/api/sessions/sign-out-others', 'owner', ({ auth }) => ({
  signedOut: Number(db.prepare('DELETE FROM sessions WHERE vault_id = ? AND token_hash != ?').run(auth.vaultId, auth.tokenHash).changes),
}));

// ---------- owner: vault contents

route('GET', '/api/vault', 'owner', ({ auth }) => {
  const v = db.prepare('SELECT * FROM vaults WHERE id = ?').get(auth.vaultId);
  return {
    keys: keyBundle(v),
    folders: db.prepare('SELECT id, meta, wrapped_key, updated_at FROM folders WHERE vault_id = ?').all(auth.vaultId)
      .map((f) => ({ id: f.id, meta: f.meta, wrappedKey: f.wrapped_key, updatedAt: f.updated_at })),
    memories: db.prepare('SELECT id, folder_id, body, created_at, updated_at FROM memories WHERE vault_id = ? ORDER BY updated_at DESC').all(auth.vaultId)
      .map((m) => ({ id: m.id, folderId: m.folder_id, body: m.body, createdAt: m.created_at, updatedAt: m.updated_at })),
  };
});

route('PUT', '/api/folders/:id', 'owner', ({ auth, params, body }) => {
  const id = field(params.id, RE.id, 'folder id');
  const meta = field(body.meta, RE.ct, 'meta', 4000);
  const wrappedKey = field(body.wrappedKey, RE.ct, 'wrappedKey', 200);
  const existing = db.prepare('SELECT vault_id FROM folders WHERE id = ?').get(id);
  if (existing) {
    need(existing.vault_id === auth.vaultId, 404, 'No such folder.');
    db.prepare('UPDATE folders SET meta = ?, wrapped_key = ?, updated_at = ? WHERE id = ?').run(meta, wrappedKey, now(), id);
  } else {
    need(count('SELECT COUNT(*) n FROM folders WHERE vault_id = ?', auth.vaultId) < LIMITS.folders, 400, 'Too many folders.');
    db.prepare('INSERT INTO folders (id, vault_id, meta, wrapped_key, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, auth.vaultId, meta, wrappedKey, now());
  }
});

// Key rotation: the folder gets a new key, every memory in it is re-encrypted
// with that key, and only the apps listed in `grants` get the new key. An app
// that had the old key can no longer open anything written from now on. It all
// happens in one transaction, and it is refused if the folder changed meanwhile.
route('POST', '/api/folders/:id/rotate', 'owner', ({ auth, params, body }) => {
  const id = field(params.id, RE.id, 'folder id');
  need(db.prepare('SELECT 1 FROM folders WHERE id = ? AND vault_id = ?').get(id, auth.vaultId), 404, 'No such folder.');
  const meta = field(body.meta, RE.ct, 'meta', 4000);
  const wrappedKey = field(body.wrappedKey, RE.ct, 'wrappedKey', 200);
  need(Array.isArray(body.memories) && body.memories.length <= LIMITS.memories, 400, 'Invalid memories.');
  const mems = body.memories.map((m) => ({
    id: field(m?.id, RE.id, 'memory id'), head: field(m.head, RE.ct, 'head', 8000), body: field(m.body, RE.ct, 'body', 1_500_000),
  }));
  const have = db.prepare('SELECT id FROM memories WHERE folder_id = ?').all(id).map((r) => r.id).sort();
  const sent = mems.map((m) => m.id).sort();
  need(have.length === sent.length && have.every((x, i) => x === sent[i]), 409, 'This folder changed while its key was being replaced. Reload and try again.');
  need(Array.isArray(body.grants) && body.grants.length <= LIMITS.apps, 400, 'Invalid grants.');
  const seen = new Set();
  const grants = body.grants.map((g) => {
    const appId = field(g?.appId, RE.id, 'appId');
    need(!seen.has(appId), 400, 'An app is listed twice.');
    seen.add(appId);
    need(db.prepare('SELECT 1 FROM apps WHERE id = ? AND vault_id = ?').get(appId, auth.vaultId), 400, 'No such app.');
    return { appId, wrappedKey: field(g.wrappedKey, RE.ct, 'wrappedKey', 200) };
  });
  // A shared folder's new key must go to every vault it is still shared with,
  // so the request carries a fresh sealed box for each of them, and no others.
  const shareIds = db.prepare('SELECT id FROM shares WHERE folder_id = ?').all(id).map((r) => r.id).sort();
  need(body.shares === undefined ? !shareIds.length : Array.isArray(body.shares), 409, 'This folder is shared, so its new key must go to those vaults too. Reload and try again.');
  const reshares = (body.shares ?? []).map((s) => ({ id: field(s?.id, RE.id, 'share id'), box: field(s.box, RE.box, 'share box', 4000) }));
  const sentShares = reshares.map((s) => s.id).sort();
  need(sentShares.length === shareIds.length && sentShares.every((x, i) => x === shareIds[i]), 409, 'The vaults this folder is shared with changed while its key was being replaced. Reload and try again.');
  const t = now();
  tx(db, () => {
    db.prepare('UPDATE folders SET meta = ?, wrapped_key = ?, updated_at = ? WHERE id = ?').run(meta, wrappedKey, t, id);
    const reseal = db.prepare('UPDATE shares SET box = ? WHERE id = ? AND folder_id = ?');
    for (const s of reshares) reseal.run(s.box, s.id, id);
    // updated_at is left alone: the memory's words did not change, only the lock on them
    const upd = db.prepare('UPDATE memories SET head = ?, body = ? WHERE id = ? AND folder_id = ?');
    for (const m of mems) upd.run(m.head, m.body, m.id, id);
    db.prepare('DELETE FROM app_folder_keys WHERE folder_id = ?').run(id);
    const ins = db.prepare('INSERT INTO app_folder_keys (app_id, folder_id, wrapped_key) VALUES (?, ?, ?)');
    for (const g of grants) ins.run(g.appId, id, g.wrappedKey);
  });
  return { rotated: mems.length, apps: grants.length, shares: reshares.length };
}, { maxBody: 64 * 1024 * 1024 });

route('DELETE', '/api/folders/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM folders WHERE id = ? AND vault_id = ?').run(params.id, auth.vaultId);
  need(r.changes, 404, 'No such folder.');
});

route('PUT', '/api/memories/:id', 'owner', ({ auth, params, body }) => {
  const id = field(params.id, RE.id, 'memory id');
  const folderId = field(body.folderId, RE.id, 'folderId');
  const head = field(body.head, RE.ct, 'head', 8000);
  const content = field(body.body, RE.ct, 'body', 1_500_000);
  need(db.prepare('SELECT 1 FROM folders WHERE id = ? AND vault_id = ?').get(folderId, auth.vaultId), 400, 'No such folder.');
  const existing = db.prepare('SELECT vault_id FROM memories WHERE id = ?').get(id);
  if (existing) {
    need(existing.vault_id === auth.vaultId, 404, 'No such memory.');
    db.prepare('UPDATE memories SET folder_id = ?, head = ?, body = ?, updated_at = ? WHERE id = ?').run(folderId, head, content, now(), id);
  } else {
    need(count('SELECT COUNT(*) n FROM memories WHERE vault_id = ?', auth.vaultId) < LIMITS.memories, 400, 'Too many memories.');
    db.prepare('INSERT INTO memories (id, vault_id, folder_id, head, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, auth.vaultId, folderId, head, content, now(), now());
  }
});

route('DELETE', '/api/memories/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM memories WHERE id = ? AND vault_id = ?').run(params.id, auth.vaultId);
  need(r.changes, 404, 'No such memory.');
});

// ---------- owner: apps

function checkFolderKeys(vaultId, appId, list) {
  need(Array.isArray(list) && list.length <= LIMITS.folders, 400, 'Invalid folderKeys.');
  const seen = new Set();
  return list.map((k) => {
    const folderId = field(k?.folderId, RE.id, 'folderId');
    need(!seen.has(folderId), 400, 'A folder is listed twice.');
    seen.add(folderId);
    need(db.prepare('SELECT 1 FROM folders WHERE id = ? AND vault_id = ?').get(folderId, vaultId), 400, 'No such folder.');
    return { appId, folderId, wrappedKey: field(k.wrappedKey, RE.ct, 'wrappedKey', 200) };
  });
}

function writeGrants(appId, grants) {
  db.prepare('DELETE FROM app_folder_keys WHERE app_id = ?').run(appId);
  const ins = db.prepare('INSERT INTO app_folder_keys (app_id, folder_id, wrapped_key) VALUES (?, ?, ?)');
  for (const g of grants) ins.run(appId, g.folderId, g.wrappedKey);
}

route('GET', '/api/apps', 'owner', ({ auth }) => ({
  apps: db.prepare('SELECT * FROM apps WHERE vault_id = ? ORDER BY created_at').all(auth.vaultId).map((a) => ({
    id: a.id,
    meta: a.meta,
    canSuggest: !!a.can_suggest,
    createdAt: a.created_at,
    lastUsedAt: a.last_used_at,
    folderIds: db.prepare('SELECT folder_id FROM app_folder_keys WHERE app_id = ?').all(a.id).map((r) => r.folder_id),
  })),
}));

route('PUT', '/api/apps/:id', 'owner', ({ auth, params, body }) => {
  const id = field(params.id, RE.id, 'app id');
  need(!db.prepare('SELECT 1 FROM apps WHERE id = ?').get(id), 409, 'That app already exists.');
  need(count('SELECT COUNT(*) n FROM apps WHERE vault_id = ?', auth.vaultId) < LIMITS.apps, 400, 'Too many apps.');
  const meta = field(body.meta, RE.ct, 'meta', 4000);
  const authHash = sha256hex(field(body.authKey, RE.key, 'authKey'));
  const vouch = field(body.vouch, RE.key, 'vouch');
  const grants = checkFolderKeys(auth.vaultId, id, body.folderKeys ?? []);
  tx(db, () => {
    db.prepare('INSERT INTO apps (id, vault_id, meta, auth_hash, vouch, can_suggest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, auth.vaultId, meta, authHash, vouch, body.canSuggest ? 1 : 0, now());
    writeGrants(id, grants);
  });
});

route('PATCH', '/api/apps/:id', 'owner', ({ auth, params, body }) => {
  const app = db.prepare('SELECT id FROM apps WHERE id = ? AND vault_id = ?').get(params.id, auth.vaultId);
  need(app, 404, 'No such app.');
  const grants = body.folderKeys !== undefined ? checkFolderKeys(auth.vaultId, app.id, body.folderKeys) : null;
  const meta = body.meta !== undefined ? field(body.meta, RE.ct, 'meta', 4000) : null;
  tx(db, () => {
    if (meta) db.prepare('UPDATE apps SET meta = ? WHERE id = ?').run(meta, app.id);
    if (body.canSuggest !== undefined) db.prepare('UPDATE apps SET can_suggest = ? WHERE id = ?').run(body.canSuggest ? 1 : 0, app.id);
    if (grants) writeGrants(app.id, grants);
  });
});

// Revoke: the key stops working on its next request, and its wrapped folder keys are deleted.
route('DELETE', '/api/apps/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM apps WHERE id = ? AND vault_id = ?').run(params.id, auth.vaultId);
  need(r.changes, 404, 'No such app.');
});

// ---------- owner: sharing a folder with another vault
// The server matches vault names and passes sealed boxes along. It can neither
// open a share nor make one up: the box is sealed for the recipient and tagged
// with a key only the two vaults can make.

route('POST', '/api/share-key', 'owner', async ({ auth, body }) => {
  rateLimit(`share-key:${auth.vaultId}`, 60, 3_600_000);
  const u = username(body.username);
  const fp = field(body.fingerprint, /^[A-Za-z0-9_-]{20}$/, 'fingerprint');
  const v = db.prepare('SELECT id, box_pub FROM vaults WHERE username = ?').get(u);
  // the same answer for a name that does not exist and a fingerprint that does not match
  need(v && (await keyFingerprint(v.box_pub)) === fp, 404, 'No vault matches that share code. Check it with the person who sent it.');
  need(v.id !== auth.vaultId, 400, 'That is your own share code.');
  return { boxPub: v.box_pub };
});

route('GET', '/api/shares', 'owner', ({ auth }) => ({
  shares: db.prepare('SELECT s.id, s.folder_id, s.meta, s.created_at, v.username, v.box_pub FROM shares s JOIN vaults v ON v.id = s.recipient_id WHERE s.owner_id = ? ORDER BY s.created_at')
    .all(auth.vaultId).map((s) => ({ id: s.id, folderId: s.folder_id, meta: s.meta, recipient: s.username, recipientBoxPub: s.box_pub, createdAt: s.created_at })),
}));

route('PUT', '/api/shares/:id', 'owner', ({ auth, params, body }) => {
  const id = field(params.id, RE.id, 'share id');
  const folderId = field(body.folderId, RE.id, 'folderId');
  need(db.prepare('SELECT 1 FROM folders WHERE id = ? AND vault_id = ?').get(folderId, auth.vaultId), 404, 'No such folder.');
  const r = db.prepare('SELECT id FROM vaults WHERE username = ?').get(username(body.recipient));
  need(r, 404, 'No such vault.');
  need(r.id !== auth.vaultId, 400, 'You cannot share a folder with your own vault.');
  need(!db.prepare('SELECT 1 FROM shares WHERE id = ?').get(id), 409, 'That share already exists.');
  need(!db.prepare('SELECT 1 FROM shares WHERE folder_id = ? AND recipient_id = ?').get(folderId, r.id), 409, 'This folder is already shared with that vault.');
  need(count('SELECT COUNT(*) n FROM shares WHERE folder_id = ?', folderId) < LIMITS.sharesPerFolder, 400, `A folder can be shared with ${LIMITS.sharesPerFolder} vaults at most.`);
  need(count('SELECT COUNT(*) n FROM shares WHERE owner_id = ?', auth.vaultId) < LIMITS.shares, 400, 'Too many shares.');
  db.prepare('INSERT INTO shares (id, folder_id, owner_id, recipient_id, box, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, folderId, auth.vaultId, r.id, field(body.box, RE.box, 'box', 4000), field(body.meta, RE.ct, 'meta', 2000), now());
});

// Either side can end a share: the owner stops sharing, or the recipient leaves.
route('DELETE', '/api/shares/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM shares WHERE id = ? AND (owner_id = ? OR recipient_id = ?)').run(params.id, auth.vaultId, auth.vaultId);
  need(r.changes, 404, 'No such share.');
});

// The recipient's side: folders shared with this vault, and their memories.
route('GET', '/api/shared', 'owner', ({ auth }) => ({
  shares: db.prepare('SELECT s.id, s.folder_id, s.box, s.created_at, v.username, v.box_pub FROM shares s JOIN vaults v ON v.id = s.owner_id WHERE s.recipient_id = ? ORDER BY s.created_at')
    .all(auth.vaultId).map((s) => ({ id: s.id, folderId: s.folder_id, box: s.box, owner: s.username, ownerBoxPub: s.box_pub, createdAt: s.created_at })),
}));

route('GET', '/api/shared/:id', 'owner', async ({ auth, params }) => {
  const s = db.prepare('SELECT id, folder_id, owner_id FROM shares WHERE id = ? AND recipient_id = ?').get(params.id, auth.vaultId);
  need(s, 404, 'This folder is no longer shared with you.');
  rateLimit(`shared:${s.id}`, 120, 3_600_000);
  // the owner sees every opening in their read log, sealed like any read
  await logRead(s.owner_id, null, 'shared', s.id);
  return {
    memories: db.prepare('SELECT id, body, created_at, updated_at FROM memories WHERE folder_id = ? ORDER BY updated_at DESC').all(s.folder_id)
      .map((m) => ({ id: m.id, body: m.body, createdAt: m.created_at, updatedAt: m.updated_at })),
  };
});
// ---------- legacy: who receives the vault, and only when
// The owner seals the vault key for an heir's vault. The server hands that box,
// with the vault's ciphertext, to the heir only once the owner has not opened the
// vault for the chosen number of days. Opening the vault again closes it.

const legacyOpenNow = (l) => now() - (l.last_seen_at ?? l.vault_created) >= l.wait_days * LEGACY_DAY_MS;
const waitDays = (v) => { need(Number.isInteger(v) && v >= 1 && v <= 3650, 400, 'Choose a wait of 1 to 3650 days.'); return v; };

route('GET', '/api/legacy', 'owner', ({ auth }) => ({
  heirs: db.prepare('SELECT l.id, l.meta, l.wait_days, l.created_at, v.username, v.box_pub FROM legacy l JOIN vaults v ON v.id = l.heir_id WHERE l.owner_id = ? ORDER BY l.created_at')
    .all(auth.vaultId).map((l) => ({ id: l.id, meta: l.meta, waitDays: l.wait_days, heir: l.username, heirBoxPub: l.box_pub, createdAt: l.created_at })),
  dayMs: LEGACY_DAY_MS,
}));

route('PUT', '/api/legacy/:id', 'owner', ({ auth, params, body }) => {
  const id = field(params.id, RE.id, 'legacy id');
  const h = db.prepare('SELECT id FROM vaults WHERE username = ?').get(username(body.heir));
  need(h, 404, 'No such vault.');
  need(h.id !== auth.vaultId, 400, 'You cannot leave your vault to yourself.');
  need(!db.prepare('SELECT 1 FROM legacy WHERE id = ?').get(id), 409, 'That already exists.');
  need(!db.prepare('SELECT 1 FROM legacy WHERE owner_id = ? AND heir_id = ?').get(auth.vaultId, h.id), 409, 'That vault is already named.');
  need(count('SELECT COUNT(*) n FROM legacy WHERE owner_id = ?', auth.vaultId) < 3, 400, 'You can name up to 3 vaults.');
  db.prepare('INSERT INTO legacy (id, owner_id, heir_id, box, meta, wait_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, auth.vaultId, h.id, field(body.box, RE.box, 'box', 4000), field(body.meta, RE.ct, 'meta', 2000), waitDays(body.waitDays), now());
});

// the owner removes an heir, or the heir declines
route('DELETE', '/api/legacy/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM legacy WHERE id = ? AND (owner_id = ? OR heir_id = ?)').run(params.id, auth.vaultId, auth.vaultId);
  need(r.changes, 404, 'No such entry.');
});

// The heir's side. It says whether the vault can be opened now, never when the
// owner was last seen.
route('GET', '/api/legacy-for-me', 'owner', ({ auth }) => ({
  vaults: db.prepare('SELECT l.id, l.wait_days, l.created_at, v.username, v.box_pub, v.last_seen_at, v.created_at AS vault_created FROM legacy l JOIN vaults v ON v.id = l.owner_id WHERE l.heir_id = ? ORDER BY l.created_at')
    .all(auth.vaultId).map((l) => ({ id: l.id, owner: l.username, ownerBoxPub: l.box_pub, waitDays: l.wait_days, createdAt: l.created_at, open: legacyOpenNow(l) })),
}));

route('GET', '/api/legacy-for-me/:id', 'owner', async ({ auth, params }) => {
  const l = db.prepare('SELECT l.*, v.username, v.box_pub, v.last_seen_at, v.created_at AS vault_created FROM legacy l JOIN vaults v ON v.id = l.owner_id WHERE l.id = ? AND l.heir_id = ?').get(params.id, auth.vaultId);
  need(l, 404, 'No such entry.');
  need(legacyOpenNow(l), 403, `This vault opens for you only after ${l.username} has not opened it for ${l.wait_days} day${l.wait_days === 1 ? '' : 's'}.`);
  rateLimit(`legacy:${l.id}`, 60, 3_600_000);
  await logRead(l.owner_id, null, 'legacy', l.id);
  return {
    owner: l.username,
    ownerBoxPub: l.box_pub,
    box: l.box,
    folders: db.prepare('SELECT id, meta, wrapped_key FROM folders WHERE vault_id = ?').all(l.owner_id).map((f) => ({ id: f.id, meta: f.meta, wrappedKey: f.wrapped_key })),
    memories: db.prepare('SELECT id, folder_id, body, created_at, updated_at FROM memories WHERE vault_id = ? ORDER BY updated_at DESC').all(l.owner_id)
      .map((m) => ({ id: m.id, folderId: m.folder_id, body: m.body, createdAt: m.created_at, updatedAt: m.updated_at })),
  };
});
// ---------- adding a device by QR code
// 1. A signed-in device starts a pairing and shows its id and a secret as a QR code.
// 2. The new device joins with a fresh public key and an HMAC made with that secret.
// 3. The signed-in device checks the HMAC, shows a code to compare, and on approval
//    seals the vault key for the new device (with its own HMAC); the server adds a session.
// 4. The new device collects the session and the sealed key with the ticket it got at 2.

const PAIR_MS = 5 * 60_000;
const livePairing = (id) => {
  db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(now());
  return db.prepare('SELECT * FROM pairings WHERE id = ?').get(id);
};

route('POST', '/api/pair', 'owner', ({ auth }) => {
  rateLimit(`pair:${auth.vaultId}`, 20, 3_600_000);
  db.prepare('DELETE FROM pairings WHERE expires_at < ? OR vault_id = ?').run(now(), auth.vaultId);
  const id = newToken(16);
  db.prepare('INSERT INTO pairings (id, vault_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(id, auth.vaultId, now(), now() + PAIR_MS);
  return { id, expiresAt: now() + PAIR_MS };
});

route('GET', '/api/pair/:id', 'owner', ({ auth, params }) => {
  const p = livePairing(params.id);
  need(p && p.vault_id === auth.vaultId, 404, 'This code has expired. Make a new one.');
  return { devicePub: p.device_pub, deviceMac: p.device_mac, deviceAgent: p.device_agent, expiresAt: p.expires_at, approved: !!p.box };
});

route('DELETE', '/api/pair/:id', 'owner', ({ auth, params }) => {
  db.prepare('DELETE FROM pairings WHERE id = ? AND vault_id = ?').run(params.id, auth.vaultId);
});

route('POST', '/api/pair/:id/join', 'none', ({ req, params, body, ip }) => {
  rateLimit(`pair-join:${ip}`, 30, 600_000);
  const p = livePairing(params.id);
  need(p, 404, 'This code has expired. Make a new one on the other device.');
  need(!p.device_pub, 409, 'This code was already used by another device.');
  const ticket = newToken(32);
  db.prepare('UPDATE pairings SET device_pub = ?, device_mac = ?, device_agent = ?, ticket_hash = ? WHERE id = ? AND device_pub IS NULL')
    .run(field(body.pub, RE.b64, 'pub', 300), field(body.mac, RE.key, 'mac'), deviceLabel(req.headers['user-agent']), sha256hex(ticket), p.id);
  return { ticket };
});

route('POST', '/api/pair/:id/approve', 'owner', ({ req, auth, params, body }) => {
  const p = livePairing(params.id);
  need(p && p.vault_id === auth.vaultId, 404, 'This code has expired. Make a new one.');
  need(p.device_pub && !p.box, 409, 'Nothing is waiting to be approved.');
  const token = newSession(p.vault_id, req);
  db.prepare('UPDATE sessions SET agent = ? WHERE token_hash = ?').run(p.device_agent, sha256hex(token));
  db.prepare('UPDATE pairings SET box = ?, box_mac = ?, token = ? WHERE id = ?').run(field(body.box, RE.box, 'box', 4000), field(body.mac, RE.key, 'mac'), token, p.id);
});

route('POST', '/api/pair/:id/collect', 'none', ({ params, body, ip }) => {
  rateLimit(`pair-collect:${ip}`, 600, 600_000);
  const p = livePairing(params.id);
  need(p && p.ticket_hash && safeEqualHex(p.ticket_hash, sha256hex(field(body.ticket, RE.key, 'ticket'))), 404, 'This code has expired. Make a new one on the other device.');
  if (!p.box) return { waiting: true };
  db.prepare('DELETE FROM pairings WHERE id = ?').run(p.id);
  return { token: p.token, box: p.box, mac: p.box_mac };
});
// ---------- owner: inbox, log, account

route('GET', '/api/inbox', 'owner', ({ auth }) => ({
  suggestions: db.prepare('SELECT id, app_id, box, created_at FROM suggestions WHERE vault_id = ? ORDER BY created_at').all(auth.vaultId)
    .map((s) => ({ id: s.id, appId: s.app_id, box: s.box, createdAt: s.created_at })),
}));

route('DELETE', '/api/inbox/:id', 'owner', ({ auth, params }) => {
  const r = db.prepare('DELETE FROM suggestions WHERE id = ? AND vault_id = ?').run(params.id, auth.vaultId);
  need(r.changes, 404, 'No such suggestion.');
});

route('GET', '/api/log', 'owner', ({ auth, url }) => ({
  entries: db.prepare('SELECT * FROM read_log WHERE vault_id = ? ORDER BY seq DESC LIMIT ?')
    .all(auth.vaultId, intParam(url.searchParams.get('limit'), 1, 1000, 200))
    .map((e) => ({ id: e.id, appId: e.app_id, action: e.action, target: e.target, ts: e.ts, salt: e.salt, leaf: e.leaf, sealSeq: e.seal_seq })),
  periodMs: SEAL_PERIOD_MS,
  nextCloseAt: (Math.floor(now() / SEAL_PERIOD_MS) + 1) * SEAL_PERIOD_MS,
}));

route('GET', '/api/log/:id/proof', 'owner', async ({ auth, params }) => {
  const p = await proofFor(db, auth.vaultId, params.id);
  need(p, 404, 'No such log entry.');
  return p;
});

// The key bundle and account switches, for the Settings page (checking the
// current passphrase happens in the browser, by unwrapping the vault key).
route('GET', '/api/account', 'owner', ({ auth }) => {
  const v = db.prepare('SELECT * FROM vaults WHERE id = ?').get(auth.vaultId);
  return { username: v.username, twoFactor: !!v.totp_enc, keys: keyBundle(v) };
});

route('POST', '/api/account/2fa/setup', 'owner', ({ auth }) => {
  const v = db.prepare('SELECT id, username, totp_enc FROM vaults WHERE id = ?').get(auth.vaultId);
  need(!v.totp_enc, 409, 'Two-step sign-in is already on.');
  const secret = newTotpSecret();
  db.prepare('UPDATE vaults SET totp_pending_enc = ? WHERE id = ?').run(sealServer(secret, totpAad(v.id)), v.id);
  return { secret, uri: otpauthUri(secret, v.username, APP_NAME) };
});

route('POST', '/api/account/2fa/enable', 'owner', ({ auth, body }) => {
  rateLimit(`2fa:${auth.vaultId}`, 10, 600_000);
  const v = db.prepare('SELECT id, totp_pending_enc FROM vaults WHERE id = ?').get(auth.vaultId);
  need(v.totp_pending_enc, 400, 'Start the setup again.');
  const step = matchStep(openServer(v.totp_pending_enc, totpAad(v.id)), String(body.code ?? '').replace(/\s/g, ''));
  need(step != null, 400, 'That code is not right. Check the time on your phone and try the next code.');
  db.prepare('UPDATE vaults SET totp_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last = ? WHERE id = ?').run(step, v.id);
});

route('POST', '/api/account/2fa/disable', 'owner', ({ auth, body }) => {
  rateLimit(`2fa:${auth.vaultId}`, 10, 600_000);
  const v = db.prepare('SELECT * FROM vaults WHERE id = ?').get(auth.vaultId);
  need(v.totp_enc, 400, 'Two-step sign-in is already off.');
  need(useTotp(v, body.code), 400, 'That code is not right, or it was already used.');
  db.prepare('UPDATE vaults SET totp_enc = NULL, totp_pending_enc = NULL, totp_last = NULL WHERE id = ?').run(v.id);
});

route('PUT', '/api/account/passphrase', 'owner', ({ auth, body }) => {
  checkIterations(body.iterations);
  const salt = field(body.salt, RE.salt, 'salt');
  const authHash = sha256hex(field(body.authKey, RE.key, 'authKey'));
  const wrapped = field(body.wrappedVaultKey, RE.ct, 'wrappedVaultKey', 200);
  tx(db, () => {
    db.prepare('UPDATE vaults SET salt = ?, kdf_iter = ?, auth_hash = ?, wrapped_vk = ? WHERE id = ?').run(salt, body.iterations, authHash, wrapped, auth.vaultId);
    db.prepare('DELETE FROM sessions WHERE vault_id = ? AND token_hash != ?').run(auth.vaultId, auth.tokenHash);
  });
});

route('DELETE', '/api/account', 'owner', ({ auth, body }) => {
  const v = db.prepare('SELECT username FROM vaults WHERE id = ?').get(auth.vaultId);
  need(body.confirm === v.username, 400, 'Type your vault name to confirm.');
  tx(db, () => {
    db.prepare('DELETE FROM read_log WHERE vault_id = ?').run(auth.vaultId);
    db.prepare('DELETE FROM vaults WHERE id = ?').run(auth.vaultId); // cascades to everything else
  });
});

// ---------- connected apps (through the connector)

const grantedFolder = (appId, folderId) => db.prepare('SELECT 1 FROM app_folder_keys WHERE app_id = ? AND folder_id = ?').get(appId, folderId);

route('GET', '/api/app/info', 'app', async ({ app }) => {
  await logRead(app.vault_id, app.id, 'folders', null);
  const v = db.prepare('SELECT box_pub FROM vaults WHERE id = ?').get(app.vault_id);
  return {
    appId: app.id,
    canSuggest: !!app.can_suggest,
    boxPub: v.box_pub,
    vouch: app.vouch,
    folders: db.prepare('SELECT f.id, f.meta, k.wrapped_key FROM app_folder_keys k JOIN folders f ON f.id = k.folder_id WHERE k.app_id = ?')
      .all(app.id).map((f) => ({ id: f.id, meta: f.meta, wrappedKey: f.wrapped_key })),
  };
});

route('GET', '/api/app/memories', 'app', async ({ app, url }) => {
  const folderId = url.searchParams.get('folderId');
  let rows;
  if (folderId) {
    need(grantedFolder(app.id, folderId), 403, 'This app has no access to that folder.');
    rows = db.prepare('SELECT id, folder_id, head, created_at, updated_at FROM memories WHERE folder_id = ?').all(folderId);
  } else {
    rows = db.prepare(`SELECT m.id, m.folder_id, m.head, m.created_at, m.updated_at FROM memories m
                       JOIN app_folder_keys k ON k.folder_id = m.folder_id AND k.app_id = ?`).all(app.id);
  }
  await logRead(app.vault_id, app.id, 'list', folderId ?? '*');
  return { memories: rows.map((m) => ({ id: m.id, folderId: m.folder_id, head: m.head, createdAt: m.created_at, updatedAt: m.updated_at })) };
});

route('GET', '/api/app/memories/:id', 'app', async ({ app, params }) => {
  const m = db.prepare(`SELECT m.* FROM memories m JOIN app_folder_keys k ON k.folder_id = m.folder_id AND k.app_id = ? WHERE m.id = ?`)
    .get(app.id, params.id);
  need(m, 404, 'No such memory, or this app has no access to its folder.');
  await logRead(app.vault_id, app.id, 'read', m.id); // written before the answer goes out
  return { id: m.id, folderId: m.folder_id, head: m.head, body: m.body, createdAt: m.created_at, updatedAt: m.updated_at };
});

// The connector removed text that looked like instructions for an AI from these
// memories before a model saw them. Only the ids are sent, never the text; each
// becomes a "caught" line in the owner's read log, sealed like any read.
route('POST', '/api/app/caught', 'app', async ({ app, body }) => {
  rateLimit(`caught:${app.id}`, 300, 3_600_000);
  need(Array.isArray(body.ids) && body.ids.length >= 1 && body.ids.length <= 50, 400, 'Invalid ids.');
  const ids = [...new Set(body.ids.map((x) => field(x, RE.id, 'memory id')))];
  const mine = db.prepare('SELECT 1 FROM memories m JOIN app_folder_keys k ON k.folder_id = m.folder_id AND k.app_id = ? WHERE m.id = ?');
  let logged = 0;
  for (const id of ids) {
    if (!mine.get(app.id, id)) continue;
    await logRead(app.vault_id, app.id, 'caught', id);
    logged++;
  }
  return { logged };
});

route('POST', '/api/app/suggest', 'app', async ({ app, body }) => {
  need(app.can_suggest, 403, 'This app is not allowed to suggest memories.');
  rateLimit(`suggest:${app.id}`, 30, 3_600_000);
  const box = field(body.box, RE.box, 'box', 200_000);
  need(count('SELECT COUNT(*) n FROM suggestions WHERE vault_id = ?', app.vault_id) < LIMITS.suggestions, 429, 'The inbox is full.');
  const id = newToken(16);
  db.prepare('INSERT INTO suggestions (id, vault_id, app_id, box, created_at) VALUES (?, ?, ?, ?, ?)').run(id, app.vault_id, app.id, box, now());
  await logRead(app.vault_id, app.id, 'suggest', id);
  return { id };
});

// ---------- token details (public) and the admin panel that edits them

const TOKEN_FIELDS = { status: 'pre-launch', contract: '', explorerUrl: '', twitter: '', supply: '', launchDate: '' };

function tokenInfo() {
  const row = db.prepare("SELECT value, rev, updated_at FROM site_settings WHERE key = 'token'").get();
  const saved = row ? JSON.parse(row.value) : {};
  const out = {};
  for (const k of Object.keys(TOKEN_FIELDS)) out[k] = typeof saved[k] === 'string' ? saved[k] : TOKEN_FIELDS[k];
  return { ...out, rev: row?.rev ?? 0, updatedAt: row?.updated_at ?? null };
}

function cleanToken(body) {
  const text = (v, name, max) => {
    need(v === undefined || v === null || typeof v === 'string', 400, `Invalid ${name}.`);
    const s = (v ?? '').trim();
    need(s.length <= max, 400, `The ${name} is too long (${max} characters at most).`);
    need(!/[\u0000-\u001f\u007f<>]/.test(s), 400, `The ${name} has characters that are not allowed.`);
    return s;
  };
  const status = text(body.status, 'status', 20) || 'pre-launch';
  need(status === 'pre-launch' || status === 'live', 400, 'Status must be pre-launch or live.');
  const contract = text(body.contract, 'contract address', 42);
  need(!contract || /^0x[0-9a-fA-F]{40}$/.test(contract), 400, 'The contract address must be 0x followed by 40 hex characters.');
  const tw = text(body.twitter, 'X account', 120);
  const m = /^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/.exec(tw);
  need(!tw || m, 400, 'The X account must be a handle like @synovax or an x.com link.');
  let explorerUrl = text(body.explorerUrl, 'explorer link', 300);
  if (explorerUrl) {
    let u = null;
    try { u = new URL(explorerUrl); } catch {}
    need(u && u.protocol === 'https:' && !u.username && !u.password, 400, 'The explorer link must start with https://.');
    explorerUrl = u.href;
  }
  const out = { status, contract, explorerUrl, twitter: m ? m[1] : '', supply: text(body.supply, 'supply', 40), launchDate: text(body.launchDate, 'launch date', 40) };
  need(status !== 'live' || contract, 400, 'Add the contract address before setting the status to live.');
  return out;
}

route('GET', '/api/token', 'none', () => {
  const { rev, ...pub } = tokenInfo();
  return pub;
});

// Top holders of the published contract. By default the server reads the token's
// Transfer events from Robinhood Chain's own RPC (HOLDERS_SOURCE=rpc); a Blockscout
// API can be used instead (HOLDERS_SOURCE=blockscout). The answer is cached, so the
// page keeps connect-src 'self', and a failed refresh serves the last good list,
// marked stale.
const CHAIN_RPC = process.env.CHAIN_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER_URL = (process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com').replace(/\/+$/, '');
const EXPLORER_API = (process.env.EXPLORER_API || EXPLORER_URL).replace(/\/+$/, '');
const HOLDERS_SOURCE = process.env.HOLDERS_SOURCE === 'blockscout' ? 'blockscout' : 'rpc';
const HOLDERS_TTL_MS = Math.max(Number(process.env.HOLDERS_TTL_MS) || 60_000, 1000), HOLDERS_SHOWN = 20;
const holdersCache = { contract: '', at: 0, data: null, pending: null };
const rpcIndex = createRpcIndex({ url: CHAIN_RPC, startBlock: BigInt(Number(process.env.TOKEN_START_BLOCK) || 0) });

async function loadHolders(contract) {
  const data = HOLDERS_SOURCE === 'blockscout'
    ? await fromBlockscout({ api: EXPLORER_API, contract, shown: HOLDERS_SHOWN })
    : await rpcIndex.top(contract, HOLDERS_SHOWN);
  return { available: true, contract, source: HOLDERS_SOURCE, ...data, explorer: EXPLORER_URL };
}

// start counting as soon as there is a contract, so the first visitor does not wait
function warmHolders() {
  const { contract } = tokenInfo();
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract) || HOLDERS_SOURCE !== 'rpc') return;
  rpcIndex.sync(contract).catch((e) => console.warn('[holders]', e.message));
}
setTimeout(warmHolders, 1000).unref();

route('GET', '/api/token/holders', 'none', async () => {
  const { contract } = tokenInfo();
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return { available: false, reason: 'no-contract' };
  const c = holdersCache;
  if (c.contract !== contract) Object.assign(c, { contract, at: 0, data: null, pending: null });
  if (c.data && Date.now() - c.at < HOLDERS_TTL_MS) return { ...c.data, updatedAt: c.at, stale: false };
  if (!c.pending) {
    c.pending = loadHolders(contract)
      .then((data) => { if (c.contract === contract) Object.assign(c, { data, at: Date.now() }); })
      .catch((e) => console.warn('[holders]', e.message))
      .finally(() => { c.pending = null; });
  }
  await c.pending;
  if (c.data) return { ...c.data, updatedAt: c.at, stale: Date.now() - c.at >= HOLDERS_TTL_MS };
  return { available: false, reason: 'source-unreachable' };
});

route('POST', '/api/admin/login', 'none', async ({ body, ip }) => {
  // only failed attempts count: 5 per 15 minutes per address
  need(recentHits(`admin-fail:${ip}`, 15 * 60_000) < 5, 429, TOO_MANY);
  rateLimit(`admin:${ip}`, 30, 15 * 60_000);
  const password = typeof body.password === 'string' ? body.password : typeof body.key === 'string' ? body.key.trim() : '';
  if (!(await verifyPassword(password, await readPasswordHash(DATA_DIR).catch(() => '')))) {
    noteHit(`admin-fail:${ip}`);
    throw new HttpError(401, 'That password is not right.');
  }
  const token = newToken(32), expiresAt = now() + ADMIN_TTL_MS;
  db.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)').run(sha256hex(token), expiresAt);
  return { token, expiresAt };
});

// Change the admin password from the panel: the current one is required, and
// every other admin session is signed out.
route('POST', '/api/admin/password', 'admin', async ({ admin, body, ip }) => {
  rateLimit(`admin-pw:${ip}`, 5, 15 * 60_000);
  need(await verifyPassword(String(body.current ?? ''), await readPasswordHash(DATA_DIR)), 400, 'The current password is not right.');
  const next = String(body.next ?? '');
  const problem = checkNewPassword(next);
  need(!problem, 400, problem);
  need(next !== body.current, 400, 'The new password is the same as the current one.');
  await savePasswordHash(DATA_DIR, await hashPassword(next));
  db.prepare('DELETE FROM admin_sessions WHERE token_hash != ?').run(admin.tokenHash);
  db.prepare('INSERT INTO admin_audit (at, ip, field, old, new) VALUES (?, ?, ?, ?, ?)').run(now(), ip, 'password', '', 'changed');
});

route('POST', '/api/admin/logout', 'admin', ({ admin }) => {
  db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(admin.tokenHash);
});

route('GET', '/api/admin/token', 'admin', () => ({
  token: tokenInfo(),
  history: db.prepare('SELECT at, field, old, new FROM admin_audit ORDER BY seq DESC LIMIT 50').all(),
}));

route('PUT', '/api/admin/token', 'admin', ({ body, ip }) => {
  const cur = tokenInfo();
  need(Number(body.rev) === cur.rev, 409, 'Someone saved a newer version. Reload the panel and try again.');
  const next = cleanToken(body);
  // a new contract address has to be confirmed by typing its last 6 characters again
  if (next.contract && next.contract.toLowerCase() !== cur.contract.toLowerCase()) {
    const c = typeof body.confirmContract === 'string' ? body.confirmContract.trim().toLowerCase() : '';
    need(c === next.contract.slice(-6).toLowerCase(), 400, 'To publish a new contract address, type its last 6 characters to confirm.');
  }
  const changed = Object.keys(TOKEN_FIELDS).filter((k) => next[k] !== cur[k]);
  if (!changed.length) return { token: cur, changed };
  const t = now();
  tx(db, () => {
    db.prepare(`INSERT INTO site_settings (key, value, rev, updated_at) VALUES ('token', ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, rev = excluded.rev, updated_at = excluded.updated_at`)
      .run(JSON.stringify(next), cur.rev + 1, t);
    const add = db.prepare('INSERT INTO admin_audit (at, ip, field, old, new) VALUES (?, ?, ?, ?, ?)');
    for (const k of changed) add.run(t, ip, k, cur[k], next[k]);
  });
  if (changed.includes('contract')) warmHolders();
  return { token: tokenInfo(), changed };
});

// ---------- static files

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip',
};

function send(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad path.'); }
  // A share from a phone's share menu, when the vault's service worker is not active yet:
  // hand it back to the page in the #fragment. Nothing of it is kept. (With the service
  // worker, which is the usual case, this request never reaches the server.)
  if (p === '/vault/share') {
    const q = new URLSearchParams();
    for (const k of ['title', 'text', 'url']) { const v = url.searchParams.get(k); if (v) q.set(k, v.slice(0, 100_000)); }
    res.writeHead(303, { location: `/vault/#share=${encodeURIComponent(q.toString())}`, 'cache-control': 'no-store' }); return res.end();
  }
  // a page folder asked for without its slash: /docs -> /docs/
  if (/^\/[a-z0-9-]+$/.test(p) && existsSync(path.join(ROOT, 'web', p.slice(1), 'index.html'))) {
    res.writeHead(301, { location: `${p}/` }); return res.end();
  }
  const isShared = p.startsWith('/shared/');
  const base = path.join(ROOT, isShared ? 'shared' : 'web');
  let file = path.resolve(base, isShared ? p.slice('/shared/'.length) : p.slice(1));
  if (file !== base && !file.startsWith(base + path.sep)) throw new HttpError(404, 'Not found.');
  if (p.endsWith('/')) file = path.join(file, 'index.html');
  let data;
  try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found.'); }
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ---------- server

// HTTPS without a proxy: set TLS_CERT and TLS_KEY to PEM files, or TLS_PFX to a
// .pfx/.p12 file (what Windows exports), with TLS_PFX_PASSPHRASE if it has one.
const TLS = process.env.TLS_PFX
  ? { pfx: readFileSync(process.env.TLS_PFX), passphrase: process.env.TLS_PFX_PASSPHRASE ?? '' }
  : process.env.TLS_CERT || process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT ?? ''), key: readFileSync(process.env.TLS_KEY ?? '') }
    : null;
if (TLS) SECURITY_HEADERS['strict-transport-security'] = 'max-age=31536000';

const server = (TLS ? (handler) => https.createServer(TLS, handler) : (handler) => http.createServer(handler))(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const ctx = { req, url, ip: clientIp(req), params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
        if (r.auth === 'owner') ctx.auth = ownerAuth(req);
        if (r.auth === 'app') ctx.app = appAuth(req);
        if (r.auth === 'admin') ctx.admin = adminAuth(req);
        ctx.body = req.method === 'GET' ? {} : await readJson(req, r.maxBody);
        return send(res, 200, (await r.handler(ctx)) ?? { ok: true });
      }
      throw new HttpError(404, 'Not found.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { ...e.extra, error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

// ---------- backups
// A consistent copy of the database (ciphertext, hashes and the log, the same
// things the server already holds) every BACKUP_INTERVAL_MS, newest BACKUP_KEEP kept.
// Copy DATA_DIR/backups to another machine or drive yourself: a backup on the same
// disk does not survive that disk.
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS ?? 6 * 3_600_000);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 14);
const backupDir = path.join(DATA_DIR, 'backups');
async function backup() {
  try {
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(backupDir, `vault-${stamp}.db`);
    if (existsSync(file)) return;
    db.prepare('VACUUM INTO ?').run(file);
    lastBackupAt = now();
    const all = (await readdir(backupDir)).filter((f) => /^vault-\d{8}-\d{6}\.db$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) await rm(path.join(backupDir, old), { force: true });
  } catch (e) {
    console.error('[backup]', e.message);
  }
}
if (BACKUP_INTERVAL_MS > 0) {
  const latest = existsSync(backupDir) ? (await readdir(backupDir)).filter((f) => f.startsWith('vault-')).sort().at(-1) : null;
  const age = latest ? now() - (await stat(path.join(backupDir, latest))).mtimeMs : Infinity;
  if (latest) lastBackupAt = now() - age;
  if (age >= BACKUP_INTERVAL_MS) backup();
  setInterval(backup, Math.max(60_000, BACKUP_INTERVAL_MS)).unref();
}

sealer = startSealer(db, SEAL_PERIOD_MS, { publishUrl: process.env.SEAL_PUBLISH_URL ?? '' });
server.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} running at ${TLS ? 'https' : 'http'}://${HOST.includes(':') ? `[${HOST}]` : HOST}:${server.address().port}`);
  console.log(`Vault: /vault/   Data: ${DATA_DIR}`);
  console.log(`Admin panel: /admin/ (forgot the password? ${process.env.SYNOVAX_CLI ? 'npx synovax admin-password' : 'npm run admin:password'})`);
});
