// The vault app. Every key lives in this page's memory only; the server gets
// ciphertext. Reloading the page locks the vault.
import * as C from '/shared/crypto.js';
import { leafHash, verifyProof, verifySealChain, GENESIS } from '/shared/merkle.js';
import { APP_NAME } from '/shared/brand.js';
import { authArt } from '/vault/auth-art.js';
import * as Immune from '/shared/immune.js';

// Text that looks like instructions for an AI (shared/immune.js). Checked here as
// memories come in, so the owner sees it; the connector removes those places again
// before any model gets the text.
const flagCache = new Map();
function flagsOf(...texts) {
  const kinds = new Set();
  for (const t of texts) {
    const s = String(t ?? '');
    if (!s) continue;
    let k = flagCache.get(s);
    if (!k) {
      const r = Immune.inspect(s);
      k = r.flagged ? Immune.describe(r) : [];
      if (flagCache.size > 5000) flagCache.clear();
      flagCache.set(s, k);
    }
    k.forEach((x) => kinds.add(x));
  }
  return [...kinds];
}
const memoryFlags = (m) => flagsOf(m.title, m.body, ...(m.tags ?? []));
const heldNote = (kinds, what) => h('div', { class: 'held', role: 'note' },
  h('b', {}, 'Looks like instructions for an AI'),
  h('span', {}, `${what} has ${kinds.join(', ')}. Apps that read it get it with those places removed, and each time that happens it is in your read log.`));

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const blank = () => ({
  token: null, vaultId: null, username: null, vk: null, boxPub: null, boxPriv: null,
  folders: new Map(), memories: new Map(), apps: new Map(), inbox: [], log: null, seals: new Map(),
  view: 'memories', folder: 'all', query: '', editing: null,
  authMode: 'open', pendingPhrase: null, newAppKey: null, editingApp: null, verified: new Map(), chain: null,
});
const S = blank();
let config = { appName: APP_NAME, iterations: C.PBKDF2_ITERATIONS };

// ---------- DOM helper: text goes in as text, never as HTML

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  $toast.textContent = msg;
  $toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, kind === 'err' ? 6000 : 3000);
}

async function busy(btn, label, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { return await fn(); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : 'unknown');
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
const tagsFrom = (s) => [...new Set(String(s).split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20);
const copy = async (text) => { await navigator.clipboard.writeText(text); toast('Copied.'); };

// ---------- API

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = `Bearer s.${S.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S.token) { lock(); throw new Error('Your session ended. Open your vault again.'); }
    throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { data });
  }
  return data;
}

// ---------- open, create, recover

async function openVault(username, pass, totp) {
  const { salt, iterations } = await api('POST', '/api/auth/salt', { username });
  const k = await C.keysFromPassphrase(pass, salt, iterations);
  const r = await api('POST', '/api/auth/login', { username, authKey: k.authKey, totp: totp || undefined });
  const vk = await C.unwrapKey(k.kek, r.keys.wrappedVaultKey, 'vk/passphrase');
  await enter(r, vk, username);
}

async function createVault(username, pass) {
  const salt = C.b64(C.randomBytes(16));
  const iterations = config.iterations;
  const k = await C.keysFromPassphrase(pass, salt, iterations);
  const phrase = C.newRecoveryPhrase();
  const rec = await C.keysFromRecovery(phrase);
  const vk = C.randomBytes(32);
  const box = await C.newBoxKeyPair();
  const r = await api('POST', '/api/auth/register', {
    username, salt, iterations,
    authKey: k.authKey,
    recoveryAuthKey: rec.authKey,
    wrappedVaultKey: await C.wrapKey(k.kek, vk, 'vk/passphrase'),
    wrappedVaultKeyRecovery: await C.wrapKey(rec.kek, vk, 'vk/recovery'),
    boxPub: box.pub,
    boxPrivWrapped: await C.wrapKey(vk, box.priv, 'box/private'),
  });
  S.pendingPhrase = phrase;
  await enter(r, vk, username, false);
  for (const name of ['About me', 'Work', 'Personal']) await saveFolder(null, name);
  render();
}

async function recoverVault(username, phrase, newPass) {
  const rec = await C.keysFromRecovery(phrase);
  const r = await api('POST', '/api/auth/recover', { username, recoveryAuthKey: rec.authKey });
  const vk = await C.unwrapKey(rec.kek, r.keys.wrappedVaultKeyRecovery, 'vk/recovery');
  S.token = r.token;
  await setPassphrase(vk, newPass);
  await enter(r, vk, username);
  toast(r.twoFactorReset
    ? 'Vault recovered and your new passphrase is set. Two-step sign-in was turned off; turn it on again in Settings.'
    : 'Vault recovered. Your new passphrase is set.');
}

async function setPassphrase(vk, pass) {
  const salt = C.b64(C.randomBytes(16));
  const k = await C.keysFromPassphrase(pass, salt, config.iterations);
  await api('PUT', '/api/account/passphrase', {
    salt, iterations: config.iterations, authKey: k.authKey, wrappedVaultKey: await C.wrapKey(k.kek, vk, 'vk/passphrase'),
  });
}

async function enter(r, vk, username, doRender = true) {
  Object.assign(S, { token: r.token, vaultId: r.keys.vaultId, username, vk, boxPub: r.keys.boxPub });
  S.boxPriv = await C.unwrapKey(vk, r.keys.boxPrivWrapped, 'box/private');
  await loadAll();
  if (doRender) render();
}

function lock() {
  if (S.token) fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer s.${S.token}` } }).catch(() => {});
  Object.assign(S, blank());
  render();
}

// ---------- loading and decrypting

async function loadAll() {
  const v = await api('GET', '/api/vault');
  S.folders.clear();
  for (const f of v.folders) {
    try {
      const key = await C.unwrapKey(S.vk, f.wrappedKey, `folder:${f.id}:key`);
      const meta = await C.decryptJSON(key, f.meta, `folder:${f.id}:meta`);
      S.folders.set(f.id, { id: f.id, key, name: meta.name });
    } catch {
      S.folders.set(f.id, { id: f.id, key: null, name: 'Unreadable folder', broken: true });
    }
  }
  S.memories.clear();
  for (const m of v.memories) {
    const f = S.folders.get(m.folderId);
    try {
      const d = await C.decryptJSON(f.key, m.body, `memory:${m.id}:body`);
      S.memories.set(m.id, { id: m.id, folderId: m.folderId, title: d.title, body: d.body, tags: d.tags ?? [], source: d.source, createdAt: m.createdAt, updatedAt: m.updatedAt });
    } catch {
      S.memories.set(m.id, { id: m.id, folderId: m.folderId, title: 'Unreadable memory', body: '', tags: [], broken: true, createdAt: m.createdAt, updatedAt: m.updatedAt });
    }
  }
  await Promise.all([loadApps(), loadInbox()]);
}

async function loadApps() {
  const { apps } = await api('GET', '/api/apps');
  S.apps.clear();
  for (const a of apps) {
    try {
      const meta = await C.decryptJSON(S.vk, a.meta, `app:${a.id}:meta`);
      S.apps.set(a.id, { ...a, name: meta.name, secret: C.unb64(meta.secret) });
    } catch {
      S.apps.set(a.id, { ...a, name: 'Unreadable app', broken: true });
    }
  }
}

async function loadInbox() {
  const { suggestions } = await api('GET', '/api/inbox');
  S.inbox = [];
  for (const s of suggestions) {
    try {
      S.inbox.push({ ...s, data: await C.boxOpen(S.boxPriv, S.boxPub, s.box) });
    } catch {
      S.inbox.push({ ...s, broken: true });
    }
  }
}

// ---------- writing

async function saveFolder(id, name) {
  const existing = id ? S.folders.get(id) : null;
  id ??= C.newId();
  const key = existing?.key ?? C.randomBytes(32);
  await api('PUT', `/api/folders/${id}`, {
    meta: await C.encryptJSON(key, { name }, `folder:${id}:meta`),
    wrappedKey: await C.wrapKey(S.vk, key, `folder:${id}:key`),
  });
  S.folders.set(id, { id, key, name });
  return id;
}

async function saveMemory({ id, folderId, title, body, tags, source }) {
  id ??= C.newId();
  const f = S.folders.get(folderId);
  if (!f?.key) throw new Error('Pick a folder first.');
  const head = { title, tags, snippet: body.slice(0, 240), source };
  await api('PUT', `/api/memories/${id}`, {
    folderId,
    head: await C.encryptJSON(f.key, head, `memory:${id}:head`),
    body: await C.encryptJSON(f.key, { title, body, tags, source }, `memory:${id}:body`),
  });
  const prev = S.memories.get(id);
  S.memories.set(id, { id, folderId, title, body, tags, source, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now() });
  return id;
}

async function grantsFor(appId, secret, folderIds) {
  const { wrap } = await C.appKeyMaterial(secret);
  return Promise.all(folderIds.map(async (fid) => ({
    folderId: fid, wrappedKey: await C.wrapKey(wrap, S.folders.get(fid).key, `app:${appId}:folder:${fid}`),
  })));
}

async function createApp(name, folderIds, canSuggest) {
  const appId = C.newId();
  const secret = C.randomBytes(32);
  const m = await C.appKeyMaterial(secret);
  await api('PUT', `/api/apps/${appId}`, {
    // The app's secret is kept here, encrypted with the vault key, so you can grant it new folders later.
    meta: await C.encryptJSON(S.vk, { name, secret: C.b64(secret) }, `app:${appId}:meta`),
    authKey: m.auth,
    vouch: await C.vouchFor(m.vouch, appId, S.boxPub),
    canSuggest,
    folderKeys: await grantsFor(appId, secret, folderIds),
  });
  await loadApps();
  return C.formatAppKey(appId, secret);
}

// Give a folder a brand-new key: every memory in it is re-encrypted here, and only
// the apps that still have access (by S.apps, after any change) get the new key.
// An app whose access was taken away keeps only the old key, which opens nothing
// written from now on.
async function rotateFolder(folderId) {
  const f = S.folders.get(folderId);
  if (!f?.key) throw new Error('This folder cannot be opened, so its key cannot be replaced.');
  const mems = [...S.memories.values()].filter((m) => m.folderId === folderId);
  if (mems.some((m) => m.broken)) throw new Error(`"${f.name}" has a memory that cannot be opened, so its key cannot be replaced.`);
  const key = C.randomBytes(32);
  const keep = [...S.apps.values()].filter((a) => !a.broken && a.folderIds.includes(folderId));
  const r = await api('POST', `/api/folders/${folderId}/rotate`, {
    meta: await C.encryptJSON(key, { name: f.name }, `folder:${folderId}:meta`),
    wrappedKey: await C.wrapKey(S.vk, key, `folder:${folderId}:key`),
    memories: await Promise.all(mems.map(async (m) => ({
      id: m.id,
      head: await C.encryptJSON(key, { title: m.title, tags: m.tags, snippet: m.body.slice(0, 240), source: m.source }, `memory:${m.id}:head`),
      body: await C.encryptJSON(key, { title: m.title, body: m.body, tags: m.tags, source: m.source }, `memory:${m.id}:body`),
    }))),
    grants: await Promise.all(keep.map(async (a) => {
      const { wrap } = await C.appKeyMaterial(a.secret);
      return { appId: a.id, wrappedKey: await C.wrapKey(wrap, key, `app:${a.id}:folder:${folderId}`) };
    })),
  });
  f.key = key;
  return r;
}

// After an app loses folders, replace those folders' keys. Reports problems
// without undoing the access change, which already took effect on the server.
async function rotateAfterRevoke(folderIds, appName) {
  const failed = [];
  for (const fid of folderIds) {
    try { await rotateFolder(fid); } catch (e) { console.error(e); failed.push(S.folders.get(fid)?.name ?? fid); }
  }
  if (failed.length) toast(`${appName} lost access, but the key of ${failed.join(', ')} could not be replaced. Open the folder and press “Replace key”.`, 'err');
  return !failed.length;
}

// ---------- views

// Every render rebuilds the screen, so entrance motion is keyed: the sidebar
// animates only when the dashboard first opens, a view only when it changes,
// and the editor only when a different memory is opened.
let lastKey = '';
let lastEditing = null;
let motion = { area: true, view: true, editor: true };
let indRect = null;
let lastTab = null;

// Set when the person types anything; background refreshes do not re-render
// over unsaved text.
let dirty = false;
$app.addEventListener('input', () => { dirty = true; });

function render() {
  dirty = false;
  document.title = config.appName;
  const key = !S.vk ? 'auth' : S.pendingPhrase ? 'phrase' : `shell:${S.view}:${S.folder}`;
  motion = { area: key.split(':')[0] !== lastKey.split(':')[0], view: key !== lastKey, editor: S.editing !== lastEditing };
  lastKey = key;
  lastEditing = S.editing;
  if (!S.vk) $app.replaceChildren(viewAuth());
  else if (S.pendingPhrase) $app.replaceChildren(viewPhrase());
  else {
    $app.replaceChildren(viewShell());
    if (motion.view) scrollTo(0, 0);
    placeInd(true);
    countUp();
    // On a phone the editor sits above the list; bring it into view when it opens.
    if (motion.editor && S.editing && matchMedia('(max-width: 860px)').matches) {
      $app.querySelector('.editor')?.scrollIntoView({ block: 'start', behavior: still.matches ? 'auto' : 'smooth' });
    }
  }
}

// The white block behind the active nav item slides from where it was.
function placeInd(animate) {
  const nav = $app.querySelector('.nav');
  const on = nav?.querySelector('.nav-item.on');
  const ind = nav?.querySelector('.nav-ind');
  if (!on || !ind) return;
  const r = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
  const set = (q) => { ind.style.transform = `translate(${q.x}px, ${q.y}px)`; ind.style.width = `${q.w}px`; ind.style.height = `${q.h}px`; };
  if (animate && indRect && !motion.area) {
    ind.classList.add('is-still');
    set(indRect);
    void ind.offsetWidth;
    ind.classList.remove('is-still');
  } else if (!animate) ind.classList.add('is-still');
  set(r);
  if (!animate) { void ind.offsetWidth; ind.classList.remove('is-still'); }
  indRect = r;
}
addEventListener('resize', () => { if (S.vk && !S.pendingPhrase) placeInd(false); });
document.fonts?.ready.then(() => { if (S.vk && !S.pendingPhrase) placeInd(false); });

const still = matchMedia('(prefers-reduced-motion: reduce)');
function countUp() {
  if (!motion.view) return;
  for (const el of $app.querySelectorAll('[data-count]')) {
    const n = Number(el.dataset.count);
    if (still.matches || !n) { el.textContent = String(n); continue; }
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 900);
      el.textContent = String(Math.round(n * (1 - (1 - p) ** 3)));
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  }
}

// ---------- sign-in: icons (SVG needs its own namespace)

const ICONS = {
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M2.5 7h11v8h-11ZM8 10v2.4',
  eye: 'M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5ZM8 10.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z',
  'eye-off': 'M2 2l12 12M6.4 3.3C6.9 3.1 7.4 3 8 3c4.4 0 7 5 7 5a12 12 0 0 1-2 2.6M4 4.9C2.1 6.2 1 8 1 8s2.6 5 7 5c1.3 0 2.4-.4 3.3-1M6.4 6.5a2.3 2.3 0 0 0 3.1 3.1',
  arrow: 'M1 8h13M9.5 3.5 14 8l-4.5 4.5',
  check: 'M3 8.5l3.2 3L13 4.5',
  warn: 'M8 1.6 15 14H1ZM8 6v4M8 11.4v1.4',
  key: 'M8.3 8H15M12.5 8v2.6M14.5 8v2M5 11.3a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z',
  db: 'M2.5 3.5c0-1.1 2.5-2 5.5-2s5.5.9 5.5 2-2.5 2-5.5 2-5.5-.9-5.5-2Zm0 0v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2',
  seal: 'M8 1l6 3.5v7L8 15l-6-3.5v-7ZM5.2 8.2l1.9 1.9 3.8-4',
  copy: 'M5.5 5.5h8v8h-8ZM10.5 5.5v-3h-8v8h3',
  stack: 'M8 1.5 14.5 5 8 8.5 1.5 5ZM1.5 8 8 11.5 14.5 8M1.5 11 8 14.5 14.5 11',
  inbox: 'M1.5 9.5 3.5 2.5h9l2 7v4h-13ZM1.5 9.5h4l1 2h3l1-2h4',
  apps: 'M2 2h5v5H2ZM9 2h5v5H9ZM2 9h5v5H2ZM9 9h5v5H9Z',
  log: 'M5.5 3h8.5M5.5 8h8.5M5.5 13h8.5M2 3h.5M2 8h.5M2 13h.5',
  sliders: 'M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7M10.5 2.5v4M5.5 9.5v4',
  folder: 'M1.5 3h4.5l1.5 1.5h7v9h-13Z',
  plus: 'M8 2.5v11M2.5 8h11',
  out: 'M6 2.5H2.5v11H6M10 4.5 13.5 8 10 11.5M13.5 8H6',
  download: 'M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.6 10.6 14 14',
};
const MARK = 'M21.64 1L4.2 7.77L10.6 12.33C9.72 11.6 9.72 10.34 10.75 9.98L17.59 6.89ZM2.36 23L19.8 16.23L13.4 11.67C14.28 12.4 14.28 13.66 13.25 14.02L6.41 17.11Z';
function icon(name, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.4');
  p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}
function markSvg(cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', MARK); p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

// a rough, honest strength read: length and variety only, no promises about crack times
function strength(pw) {
  if (!pw) return { score: 0, label: '' };
  const words = pw.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3).length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 16) s++;
  if (pw.length >= 24 || words >= 5) s++;
  if (classes >= 3 || words >= 4) s++;
  if (/^(.)\1+$/.test(pw) || /^\d+$/.test(pw) || /password|qwerty|123456|synovax/i.test(pw)) s = Math.min(s, 1);
  if (pw.length < 10) s = 0;
  const label = ['too short', 'weak', 'fair', 'strong', 'excellent'][s];
  const tip = s < 3 ? (pw.length < 16 ? 'Add another word or two.' : 'Mix in a word nobody would guess.') : 'Good. Write it down somewhere safe.';
  return { score: s, label, tip };
}

function authShell(...right) {
  return h('div', { class: `au${motion.area ? ' is-enter' : ''}` },
    h('section', { class: 'au-art' },
      authArt(),
      h('div', { class: 'au-art-top' },
        h('a', { class: 'au-brand', href: '/' }, markSvg('au-mark'), h('span', {}, config.appName)),
        h('span', { class: 'au-chip' }, h('i', {}), 'end-to-end encrypted')),
      h('div', { class: 'au-art-copy' },
        h('h2', { class: 'au-big' }, h('span', {}, 'Your memory.'), h('span', {}, 'Your keys.')),
        h('ul', { class: 'au-trust' },
          h('li', {}, icon('lock'), h('span', {}, h('b', {}, 'AES-256-GCM'), 'Encrypted in this browser')),
          h('li', {}, icon('key'), h('span', {}, h('b', {}, `${(config.iterations ?? 600000).toLocaleString('en-US')} rounds`), 'PBKDF2 before any key exists')),
          h('li', {}, icon('db'), h('span', {}, h('b', {}, 'Zero plaintext'), 'The server only holds ciphertext'))))),
    h('section', { class: 'au-side' },
      h('header', { class: 'au-top' },
        h('a', { class: 'au-back', href: '/' }, '← Home'),
        h('nav', { class: 'au-links' }, h('a', { href: '/docs/' }, 'Docs'), h('a', { href: '/#security' }, 'Security'))),
      h('div', { class: 'au-body' }, ...right),
      h('footer', { class: 'au-foot' },
        h('span', {}, icon('seal'), 'Every read sealed hourly'),
        h('span', {}, 'Not independently audited yet'))));
}

const AUTH_TEXT = {
  open: { title: 'Welcome back.', sub: 'Open your vault with your passphrase. It is checked here, in this browser, and never sent.', cta: 'Open vault', busy: 'Deriving your key…' },
  create: { title: 'Create your vault.', sub: 'Pick a name and a long passphrase. Nobody can reset it, not even us, so you also get 24 recovery words.', cta: 'Create vault', busy: 'Making your keys…' },
  recover: { title: 'Recover access.', sub: 'Your 24 recovery words open the vault here and set a new passphrase.', cta: 'Recover vault', busy: 'Checking your words…' },
};

function passField(name, label, autocomplete, extra = {}) {
  const input = h('input', { name, type: 'password', required: true, autocomplete, spellcheck: 'false', autocapitalize: 'none', ...extra });
  const eye = h('button', { type: 'button', class: 'au-eye', 'aria-label': 'Show passphrase', 'aria-pressed': 'false' }, icon('eye'));
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
    eye.replaceChildren(icon(show ? 'eye-off' : 'eye'));
    input.focus();
  });
  const caps = h('p', { class: 'au-caps', hidden: true }, icon('warn'), 'Caps Lock is on');
  const onKey = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
  input.addEventListener('keydown', onKey); input.addEventListener('keyup', onKey);
  input.addEventListener('blur', () => { caps.hidden = true; });
  return { input, el: h('label', { class: 'au-field' }, h('span', { class: 'au-label' }, label), h('span', { class: 'au-pass' }, input, eye), caps) };
}

function viewAuth() {
  const mode = S.authMode;
  const T = AUTH_TEXT[mode];
  const err = h('div', { class: 'au-err', role: 'alert', hidden: true });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 3, maxlength: 32, autocapitalize: 'none', spellcheck: 'false', placeholder: 'your-vault-name' });
  const pass = passField('pass', mode === 'open' ? 'Passphrase' : 'New passphrase', mode === 'open' ? 'current-password' : 'new-password', { minlength: mode === 'open' ? 1 : 10 });
  let extra = [];
  if (mode !== 'open') {
    const bars = h('span', { class: 'au-bars' }, h('i'), h('i'), h('i'), h('i'));
    const lab = h('span', { class: 'au-meter-l' });
    const tip = h('span', { class: 'au-meter-t' }, 'At least 10 characters. Four or five words is best.');
    const meter = h('div', { class: 'au-meter', 'data-s': '0' }, bars, lab, tip);
    pass.input.addEventListener('input', () => {
      const s = strength(pass.input.value);
      meter.dataset.s = String(s.score);
      lab.textContent = s.label;
      tip.textContent = pass.input.value ? s.tip : 'At least 10 characters. Four or five words is best.';
      match();
    });
    const pass2 = passField('pass2', 'Repeat passphrase', 'new-password');
    const ok = h('span', { class: 'au-match', hidden: true }, icon('check'), 'Matches');
    const match = () => { ok.hidden = !(pass2.input.value && pass2.input.value === pass.input.value); };
    pass2.input.addEventListener('input', match);
    pass2.el.append(ok);
    extra = [meter, pass2.el];
  }
  let phrase = null;
  if (mode === 'recover') {
    const ta = h('textarea', { name: 'phrase', rows: 3, required: true, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', placeholder: 'word word word …' });
    const n = h('span', { class: 'au-count' }, '0 / 24 words');
    ta.addEventListener('input', () => {
      const c = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
      n.textContent = `${c} / 24 words`;
      n.classList.toggle('is-ok', c === 24);
    });
    phrase = h('label', { class: 'au-field' }, h('span', { class: 'au-label' }, 'Recovery phrase', n), ta);
  }
  const btn = h('button', { class: 'au-submit', type: 'submit' }, h('span', { class: 'au-submit-l' }, T.cta), h('span', { class: 'au-spin', 'aria-hidden': 'true' }), icon('arrow', 'ic au-submit-a'));
  const form = h('form', { class: 'au-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); submitAuth(form, mode, btn, err, T); } },
    h('label', { class: 'au-field' }, h('span', { class: 'au-label' }, 'Vault name'), user),
    phrase,
    pass.el,
    ...extra,
    err,
    btn);
  const modes = [['open', 'Sign in'], ['create', 'Create'], ['recover', 'Recover']];
  const tabI = String(modes.findIndex((m) => m[0] === mode));
  // The tab block slides from the last tab: render it there, then move it.
  const ind = h('span', { class: 'au-tab-ind', 'data-i': lastTab ?? tabI });
  if (lastTab != null && lastTab !== tabI) requestAnimationFrame(() => requestAnimationFrame(() => { ind.dataset.i = tabI; }));
  lastTab = tabI;
  const tabs = h('div', { class: 'au-tabs', role: 'tablist', 'aria-label': 'What do you want to do' }, modes.map(([m, label]) =>
    h('button', { type: 'button', role: 'tab', class: `au-tab${m === mode ? ' on' : ''}`, 'aria-selected': String(m === mode), onclick: () => { S.authMode = m; render(); } }, label)),
    ind);
  const swap = mode === 'open'
    ? h('p', { class: 'au-swap' }, 'New here? ', h('button', { type: 'button', onclick: () => { S.authMode = 'create'; render(); } }, 'Create a vault'))
    : h('p', { class: 'au-swap' }, 'Already have one? ', h('button', { type: 'button', onclick: () => { S.authMode = 'open'; render(); } }, 'Sign in'));
  const view = authShell(
    h('div', { class: `au-card ${motion.area ? 'is-first' : 'is-swap'}` },
      h('p', { class: 'au-eyebrow' }, icon('lock'), 'secure sign-in'),
      h('h1', { class: 'au-title' }, T.title),
      h('p', { class: 'au-sub' }, T.sub),
      tabs,
      form,
      mode === 'open' && h('p', { class: 'au-forgot' }, 'Forgot your passphrase? ', h('button', { type: 'button', onclick: () => { S.authMode = 'recover'; render(); } }, 'Use your 24 words')),
      swap));
  requestAnimationFrame(() => (S.lastUser ? pass.input : user).focus({ preventScroll: true }));
  if (S.lastUser) user.value = S.lastUser;
  return view;
}

async function submitAuth(form, mode, btn, err, T) {
  const f = form.elements;
  const username = f.username.value.trim().toLowerCase();
  err.hidden = true;
  const fail = (msg) => {
    err.replaceChildren(icon('warn'), h('span', {}, msg));
    err.hidden = false;
    form.classList.remove('is-shake'); void form.offsetWidth; form.classList.add('is-shake');
  };
  if (username.length < 3) return fail('Vault names are 3 to 32 characters.');
  if (!f.pass.value) return fail('Enter your passphrase.');
  if (mode !== 'open') {
    if (f.pass.value.length < 10) return fail('Use a passphrase of at least 10 characters.');
    if (f.pass.value !== f.pass2.value) return fail('The two passphrases are not the same.');
  }
  if (mode === 'recover' && f.phrase.value.trim().split(/\s+/).length !== 24) return fail('The recovery phrase has exactly 24 words.');
  btn.disabled = true; btn.classList.add('is-busy');
  const label = btn.querySelector('.au-submit-l'); label.textContent = T.busy;
  for (const el of f) if (el !== btn) el.readOnly = true;
  try {
    S.lastUser = username;
    if (mode === 'open') await openVault(username, f.pass.value, f.totp?.value.replace(/\s/g, ''));
    if (mode === 'create') await createVault(username, f.pass.value);
    if (mode === 'recover') await recoverVault(username, f.phrase.value, f.pass.value);
  } catch (e) {
    if (e.data?.needTotp && btn.isConnected) {
      // The passphrase was right and this vault has two-step sign-in: ask for the code
      // in place, so what was typed stays.
      if (!f.totp) {
        const code = h('input', { name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, pattern: '[0-9 ]*', placeholder: '123 456' });
        err.before(h('label', { class: 'au-field' }, h('span', { class: 'au-label' }, 'Code from your authenticator app'), code));
        requestAnimationFrame(() => code.focus());
      } else f.totp.value = '';
      fail(e.message);
    } else {
      console.error(e);
      if (btn.isConnected) fail(e.message || String(e));
    }
  } finally {
    if (btn.isConnected) {
      btn.disabled = false; btn.classList.remove('is-busy'); label.textContent = T.cta;
      for (const el of f) el.readOnly = false;
    }
  }
}

function viewPhrase() {
  const words = S.pendingPhrase.split(' ');
  const ok = h('input', { type: 'checkbox', onchange: () => { go.disabled = !ok.checked; } });
  const go = h('button', { class: 'au-submit', disabled: true, onclick: () => { S.pendingPhrase = null; render(); } }, h('span', { class: 'au-submit-l' }, 'Enter my vault'), icon('arrow', 'ic au-submit-a'));
  const copyBtn = h('button', { type: 'button', class: 'au-ghost', onclick: async () => { try { await copy(S.pendingPhrase); copyBtn.replaceChildren(icon('check'), 'Copied'); } catch { toast('Copy did not work here. Select the words instead.', 'err'); } } }, icon('copy'), 'Copy words');
  return authShell(
    h('div', { class: 'au-card au-card--wide' },
      h('p', { class: 'au-eyebrow' }, icon('key'), 'step 2 of 2 · recovery'),
      h('h1', { class: 'au-title' }, 'Save these 24 words.'),
      h('p', { class: 'au-sub' }, 'Write them down in order and keep them somewhere safe. They are the only way back in if you forget your passphrase, and this is the only time they are shown.'),
      h('ol', { class: 'au-words' }, words.map((w, i) => h('li', {}, h('b', {}, String(i + 1).padStart(2, '0')), h('span', {}, w)))),
      h('div', { class: 'au-row' }, copyBtn, h('span', { class: 'au-note' }, icon('warn'), 'Paper beats a screenshot.')),
      h('label', { class: 'au-check' }, ok, h('span', {}, 'I wrote down all 24 words, in order.')),
      go));
}

const NAV = [
  ['memories', 'Memories', 'stack'],
  ['inbox', 'Inbox', 'inbox'],
  ['apps', 'Apps', 'apps'],
  ['log', 'Read log', 'log'],
  ['settings', 'Settings', 'sliders'],
];

function viewShell() {
  const counts = { memories: S.memories.size, inbox: S.inbox.length || null, apps: S.apps.size || null };
  const folders = [...S.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const side = h('aside', { class: 'side' },
    h('div', { class: 'side-top' },
      h('a', { class: 'side-brand', href: '/' }, markSvg('side-mark'), h('span', {}, config.appName)),
      h('span', { class: 'side-live', title: 'Your keys live in this tab only' }, h('i'), 'unlocked')),
    h('p', { class: 'side-head' }, h('span', {}, 'Vault')),
    h('nav', { class: 'nav', 'aria-label': 'Vault' },
      h('span', { class: 'nav-ind', 'aria-hidden': 'true' }),
      NAV.map(([v, label, ic]) =>
        h('button', { class: `nav-item${S.view === v ? ' on' : ''}`, 'aria-current': S.view === v ? 'page' : null, onclick: () => go(v) },
          icon(ic), h('span', { class: 'nav-l' }, label), counts[v] != null && h('span', { class: 'count' }, counts[v])))),
    h('p', { class: 'side-head' }, h('span', {}, 'Folders'), h('span', {}, String(folders.length).padStart(2, '0'))),
    h('div', { class: 'folders' },
      folderButton('all', 'All memories', S.memories.size),
      folders.map((f) => folderButton(f.id, f.name, [...S.memories.values()].filter((m) => m.folderId === f.id).length))),
    newFolderForm(),
    h('div', { class: 'side-foot' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (S.username || '?').slice(0, 1).toUpperCase()),
      h('span', { class: 'who' }, h('b', {}, S.username), h('small', {}, 'locks on tab close')),
      h('button', { class: 'side-lock', onclick: lock, title: 'Lock vault' }, icon('lock'), h('span', {}, 'Lock'))));
  const views = { memories: viewMemories, inbox: viewInbox, apps: viewApps, log: viewLog, settings: viewSettings };
  const here = NAV.find((n) => n[0] === S.view)?.[1];
  const folder = S.view === 'memories' && S.folders.get(S.folder);
  return h('div', { class: `shell${motion.area ? ' is-enter' : ''}` }, side,
    h('main', { class: 'main' },
      h('div', { class: 'topbar' },
        h('p', { class: 'crumbs' }, h('span', {}, config.appName), h('span', {}, here), folder && h('span', {}, folder.name)),
        h('span', { class: 'top-chip' }, icon('lock'), 'end-to-end encrypted')),
      h('div', { class: `view${motion.view ? ' is-enter' : ''}` }, views[S.view]())));
}

// Page header: a numbered eyebrow, a display title that rises out of a mask.
function pageHead(no, eyebrow, title, sub, ...actions) {
  return h('header', { class: 'head' },
    h('div', { class: 'head-l' },
      h('p', { class: 'eyebrow' }, h('b', {}, no), h('span', {}, eyebrow)),
      h('h1', { class: 'h-title' }, h('span', {}, title)),
      sub && h('p', { class: 'head-sub' }, sub)),
    actions.flat().filter(Boolean).length ? h('div', { class: 'head-r' }, actions) : null);
}

function go(view) {
  S.view = view;
  S.newAppKey = null;
  S.editingApp = null;
  render();
  if (view === 'log') refreshLog();
}

function folderButton(id, name, n) {
  return h('button', { class: `folder${S.view === 'memories' && S.folder === id ? ' on' : ''}`, onclick: () => { S.folder = id; S.editing = null; S.view = 'memories'; render(); } },
    icon(id === 'all' ? 'stack' : 'folder'), h('span', { class: 'fname' }, name), h('span', { class: 'count' }, n));
}

function newFolderForm() {
  const input = h('input', { name: 'name', placeholder: 'New folder', maxlength: 60, required: true });
  const form = h('form', { class: 'new-folder', onsubmit: (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), '…', async () => {
      const id = await saveFolder(null, input.value.trim());
      S.folder = id;
      S.view = 'memories';
      render();
    });
  } }, input, h('button', { class: 'nf-add', type: 'submit', title: 'Add folder', 'aria-label': 'Add folder' }, '+'));
  return form;
}

// ---------- memories

function visibleMemories() {
  const q = S.query.trim().toLowerCase();
  return [...S.memories.values()]
    .filter((m) => S.folder === 'all' || m.folderId === S.folder)
    .filter((m) => !q || `${m.title}\n${m.body}\n${m.tags.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function viewMemories() {
  const folder = S.folders.get(S.folder);
  const list = h('div', { class: 'list' });
  const fill = () => {
    const items = visibleMemories();
    list.replaceChildren(...(items.length ? items.map((m, i) =>
      h('button', { class: `item${S.editing === m.id ? ' on' : ''}`, onclick: () => { S.editing = m.id; render(); } },
        h('span', { class: 'item-no' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'item-body' },
          h('span', { class: 'item-title' }, m.title || 'Untitled'),
          h('span', { class: 'item-snippet' }, m.body.slice(0, 140)),
          h('span', { class: 'item-meta' },
            S.folder === 'all' && h('span', { class: 'chip' }, S.folders.get(m.folderId)?.name ?? '?'),
            memoryFlags(m).length ? h('span', { class: 'chip flag', title: memoryFlags(m).join(', ') }, 'held for review') : null,
            m.tags.slice(0, 4).map((t) => h('span', { class: 'chip ghost' }, t)),
            h('span', { class: 'item-ago' }, ago(m.updatedAt)))),
        icon('arrow', 'ic item-go'))) : [emptyState(S.query ? 'Nothing matches that search.' : 'No memories here yet.', S.query ? 'Try fewer words, or search all folders.' : 'Add what your AI apps should know about you.')]));
  };
  fill();
  const search = h('label', { class: 'search' }, icon('search'),
    h('input', { type: 'search', placeholder: 'Search your vault', 'aria-label': 'Search your vault', value: S.query, oninput: (e) => { S.query = e.target.value; fill(); } }));
  const stats = [
    ['Memories', S.memories.size, null],
    ['Folders', S.folders.size, null],
    ['Apps', S.apps.size, 'apps'],
    ['Inbox', S.inbox.length, 'inbox'],
  ];
  return h('div', { class: 'memories' },
    pageHead(folder ? 'F' : '01', folder ? 'folder · own key' : 'your vault', folder ? folder.name : 'All memories', null,
      folder && h('button', { class: 'link', onclick: () => renameFolder(folder) }, 'Rename'),
      folder && !folder.broken && h('button', { class: 'link', title: 'Re-encrypt this folder with a new key', onclick: (e) => replaceKey(folder, e.currentTarget) }, 'Replace key'),
      folder && h('button', { class: 'link danger', onclick: () => deleteFolder(folder) }, 'Delete folder')),
    S.folder === 'all' && h('div', { class: 'stats' }, stats.map(([label, n, to]) =>
      h(to ? 'button' : 'div', { class: 'stat', onclick: to ? () => go(to) : null },
        h('span', { class: 'stat-l' }, label), h('b', { class: 'stat-n', 'data-count': n }, String(n)), to && icon('arrow', 'ic stat-go')))),
    h('div', { class: 'toolbar' }, search,
      h('button', { class: 'btn primary', onclick: () => { S.editing = 'new'; render(); } }, icon('plus'), h('span', {}, 'New memory'))),
    h('div', { class: `split${S.editing ? ' editing' : ''}` }, list, S.editing && editor()));
}

function emptyState(title, sub) {
  return h('div', { class: 'empty' }, h('span', { class: 'empty-mark' }, markSvg('empty-svg')), h('b', {}, title), h('span', {}, sub));
}

async function renameFolder(folder) {
  const name = prompt('Folder name', folder.name)?.trim();
  if (!name || name === folder.name) return;
  await busy(null, '', async () => { await saveFolder(folder.id, name); render(); });
}

async function replaceKey(folder, btn) {
  if (!confirm(`Give "${folder.name}" a new key? Every memory in it is re-encrypted on this device. Apps that still have access get the new key.`)) return;
  await busy(btn, 'Re-encrypting…', async () => {
    const r = await rotateFolder(folder.id);
    toast(`New key for "${folder.name}": ${r.rotated} memories re-encrypted, ${r.apps} app${r.apps === 1 ? '' : 's'} given the new key.`);
  });
}

async function deleteFolder(folder) {
  const n = [...S.memories.values()].filter((m) => m.folderId === folder.id).length;
  if (!confirm(`Delete "${folder.name}" and its ${n} memories? This cannot be undone.`)) return;
  await busy(null, '', async () => {
    await api('DELETE', `/api/folders/${folder.id}`);
    S.folders.delete(folder.id);
    for (const m of [...S.memories.values()]) if (m.folderId === folder.id) S.memories.delete(m.id);
    S.folder = 'all';
    S.editing = null;
    await loadApps();
    render();
  });
}

function folderSelect(name, selected) {
  return h('select', { name, value: selected },
    [...S.folders.values()].filter((f) => !f.broken).sort((a, b) => a.name.localeCompare(b.name)).map((f) => h('option', { value: f.id }, f.name)));
}

function editor() {
  const isNew = S.editing === 'new';
  const m = isNew
    ? { title: '', body: '', tags: [], folderId: S.folders.has(S.folder) ? S.folder : [...S.folders.keys()][0] }
    : S.memories.get(S.editing);
  if (!m) return null;
  const fname = S.folders.get(m.folderId)?.name;
  const form = h('form', { class: `editor card${motion.editor ? ' is-in' : ''}`, onsubmit: (e) => {
    e.preventDefault();
    const f = form.elements;
    busy(form.querySelector('[type=submit]'), 'Saving…', async () => {
      const id = await saveMemory({ id: isNew ? null : m.id, folderId: f.folder.value, title: f.title.value.trim(), body: f.body.value, tags: tagsFrom(f.tags.value), source: m.source });
      S.editing = id;
      toast('Saved, encrypted.');
      render();
    });
  } },
    h('p', { class: 'ed-top' }, h('span', {}, icon('lock'), isNew ? 'New memory' : 'Editing'),
      h('span', { class: 'ed-key' }, fname ? `sealed with the ${fname} key` : 'sealed with its folder key')),
    !isNew && memoryFlags(m).length ? heldNote(memoryFlags(m), 'This memory') : null,
    h('input', { name: 'title', class: 'title-input', placeholder: 'Title', value: m.title, required: true, maxlength: 200 }),
    h('textarea', { name: 'body', rows: 12, placeholder: 'What should your AI apps know?', value: m.body, maxlength: 200000 }),
    h('div', { class: 'grid2' },
      h('label', {}, 'Folder', folderSelect('folder', m.folderId)),
      h('label', {}, 'Tags', h('input', { name: 'tags', placeholder: 'comma, separated', value: m.tags.join(', ') }))),
    !isNew && h('p', { class: 'fine' }, `Created ${fmt(m.createdAt)} · updated ${fmt(m.updatedAt)}`, m.source && ` · from ${m.source}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Save memory' : 'Save changes'),
      h('button', { class: 'btn', type: 'button', onclick: () => { S.editing = null; render(); } }, 'Close'),
      !isNew && h('button', { class: 'btn danger push', type: 'button', onclick: (e) => deleteMemory(m, e.target) }, 'Delete')));
  return form;
}

async function deleteMemory(m, btn) {
  if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
  await busy(btn, 'Deleting…', async () => {
    await api('DELETE', `/api/memories/${m.id}`);
    S.memories.delete(m.id);
    S.editing = null;
    render();
  });
}

// ---------- inbox

function viewInbox() {
  return h('div', { class: 'page' },
    pageHead('02', 'suggestions', 'Inbox', 'Memories your apps suggested. They were sealed for your vault only, and nothing is saved until you approve it.',
      h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, 'Checking…', async () => { await loadInbox(); render(); }) }, 'Refresh')),
    S.inbox.length ? S.inbox.map(suggestionCard) : emptyState('Nothing waiting.', 'Apps you allow can suggest memories here.'));
}

function suggestionCard(s) {
  const app = S.apps.get(s.appId);
  const from = app?.name ?? 'a revoked app';
  if (s.broken) {
    return h('div', { class: 'card' }, h('p', {}, `A suggestion from ${from} could not be opened.`),
      h('button', { class: 'btn danger', onclick: (e) => reject(s, e.target) }, 'Remove'));
  }
  const d = s.data;
  const hint = [...S.folders.values()].find((f) => f.name.toLowerCase() === String(d.folderHint ?? '').toLowerCase());
  const form = h('form', { class: 'card suggestion', onsubmit: (e) => {
    e.preventDefault();
    const f = form.elements;
    busy(form.querySelector('[type=submit]'), 'Saving…', async () => {
      await saveMemory({ folderId: f.folder.value, title: f.title.value.trim(), body: f.body.value, tags: tagsFrom(f.tags.value), source: from });
      await api('DELETE', `/api/inbox/${s.id}`);
      S.inbox = S.inbox.filter((x) => x.id !== s.id);
      toast('Approved and saved to your vault.');
      render();
    });
  } },
    h('div', { class: 'meta-line' }, h('span', { class: 'app-badge' }, from.slice(0, 1).toUpperCase()), h('span', {}, h('strong', {}, from), ` suggested this ${ago(s.createdAt)}`)),
    (() => { const k = flagsOf(d.title, d.body, d.reason, d.folderHint, ...(d.tags ?? [])); return k.length ? heldNote(k, 'This suggestion') : null; })(),
    d.reason && h('p', { class: 'reason' }, d.reason),
    h('input', { name: 'title', class: 'title-input', value: d.title ?? '', required: true, maxlength: 200 }),
    h('textarea', { name: 'body', rows: 5, value: d.body ?? '' }),
    h('div', { class: 'grid2' },
      h('label', {}, 'Save to folder', folderSelect('folder', hint?.id ?? [...S.folders.keys()][0])),
      h('label', {}, 'Tags', h('input', { name: 'tags', value: (d.tags ?? []).join(', ') }))),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Approve'),
      h('button', { class: 'btn', type: 'button', onclick: (e) => reject(s, e.target) }, 'Reject')));
  return form;
}

async function reject(s, btn) {
  await busy(btn, '…', async () => {
    await api('DELETE', `/api/inbox/${s.id}`);
    S.inbox = S.inbox.filter((x) => x.id !== s.id);
    render();
  });
}

// ---------- apps

function folderChecks(selected) {
  const usable = [...S.folders.values()].filter((f) => !f.broken).sort((a, b) => a.name.localeCompare(b.name));
  return h('fieldset', { class: 'checks' }, h('legend', {}, 'Folders this app may read'),
    usable.length ? usable.map((f) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'folder', value: f.id, checked: selected.includes(f.id) }), f.name))
      : h('p', { class: 'fine' }, 'Make a folder first.'));
}
const checkedFolders = (form) => [...form.querySelectorAll('input[name=folder]:checked')].map((i) => i.value);

function viewApps() {
  return h('div', { class: 'page' },
    pageHead('03', 'connected apps', 'Apps', 'Each AI app gets its own key and sees only the folders you tick. Folders you do not grant are never unlocked for it.'),
    S.newAppKey ? newKeyPanel() : newAppForm(),
    h('h2', { class: 'sec-h' }, h('span', {}, 'Connected apps'), h('span', { class: 'sec-n' }, String(S.apps.size).padStart(2, '0'))),
    S.apps.size ? [...S.apps.values()].map(appCard) : emptyState('No apps connected yet.', 'Make a key above, then paste the config into your app.'));
}

function newAppForm() {
  const form = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    busy(form.querySelector('[type=submit]'), 'Making key…', async () => {
      const key = await createApp(name, checkedFolders(form), form.elements.suggest.checked);
      S.newAppKey = { name, key };
      render();
    });
  } },
    h('h2', {}, 'Connect a new app'),
    h('label', {}, 'App name', h('input', { name: 'name', placeholder: 'Claude Desktop', required: true, maxlength: 60 })),
    folderChecks([]),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'suggest' }), 'Allow it to suggest memories to my inbox'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Create app key'));
  return form;
}

function mcpConfig(key) {
  // A server run from a copy of the code on this computer gives the connector's
  // path; otherwise the connector comes from npm (on Windows, apps start npx via cmd).
  const env = { VAULT_APP_KEY: key, VAULT_URL: location.origin };
  const npx = ['-y', 'synovax', 'connector'];
  const server = config.connectorPath ? { command: 'node', args: [config.connectorPath], env }
    : /Windows/.test(navigator.userAgent) ? { command: 'cmd', args: ['/c', 'npx', ...npx], env }
    : { command: 'npx', args: npx, env };
  return JSON.stringify({ mcpServers: { [config.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')]: server } }, null, 2);
}

function newKeyPanel() {
  const { name, key } = S.newAppKey;
  const cfg = mcpConfig(key);
  return h('div', { class: 'card highlight' },
    h('h2', {}, `Key for ${name}`),
    h('p', { class: 'muted' }, 'Copy it now: it is shown only once and is not stored anywhere you can see it again. Anyone with this key can read the folders you granted.'),
    h('div', { class: 'keybox' }, h('code', {}, key), h('button', { class: 'btn small', onclick: () => copy(key) }, 'Copy key')),
    h('p', {}, 'Add this to your app’s MCP settings (for Claude Desktop: Settings → Developer → Edit Config):'),
    h('pre', { class: 'code' }, cfg),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => copy(cfg) }, 'Copy config'),
      h('button', { class: 'btn primary', onclick: () => { S.newAppKey = null; render(); } }, 'Done')));
}

function appCard(a) {
  const names = a.folderIds.map((id) => S.folders.get(id)?.name).filter(Boolean);
  if (S.editingApp === a.id) {
    const form = h('form', { class: 'card', onsubmit: (e) => {
      e.preventDefault();
      busy(form.querySelector('[type=submit]'), 'Saving…', async () => {
        const next = checkedFolders(form);
        const removed = a.folderIds.filter((id) => !next.includes(id));
        await api('PATCH', `/api/apps/${a.id}`, { canSuggest: form.elements.suggest.checked, folderKeys: await grantsFor(a.id, a.secret, next) });
        S.editingApp = null;
        await loadApps();
        if (!removed.length || await rotateAfterRevoke(removed, a.name)) {
          toast(removed.length ? `Access updated. ${removed.length === 1 ? 'That folder has' : `Those ${removed.length} folders have`} a new key now.` : 'Access updated.');
        }
        render();
      });
    } },
      h('h3', {}, a.name),
      folderChecks(a.folderIds),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'suggest', checked: a.canSuggest }), 'Allow it to suggest memories'),
      h('p', { class: 'fine' }, 'Removing a folder also gives that folder a new key, so this app cannot open anything written there from now on. What it already read, it may have kept.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Save access'),
        h('button', { class: 'btn', type: 'button', onclick: () => { S.editingApp = null; render(); } }, 'Cancel')));
    return form;
  }
  return h('div', { class: 'card app' },
    h('span', { class: 'app-badge big' }, (a.name || '?').slice(0, 1).toUpperCase()),
    h('div', { class: 'app-main' },
      h('h3', {}, a.name),
      h('p', { class: 'muted' }, names.length ? `Can read: ${names.join(', ')}` : 'Can read: nothing yet'),
      h('p', { class: 'fine' }, `Suggestions ${a.canSuggest ? 'on' : 'off'} · last used ${ago(a.lastUsedAt)} · added ${new Date(a.createdAt).toLocaleDateString()}`)),
    h('div', { class: 'row' },
      !a.broken && h('button', { class: 'btn', onclick: () => { S.editingApp = a.id; render(); } }, 'Edit access'),
      h('button', { class: 'btn danger', onclick: (e) => revokeApp(a, e.target) }, 'Revoke')));
}

async function revokeApp(a, btn) {
  if (!confirm(`Revoke ${a.name}? Its key stops working on its next request, and the folders it could read get new keys.`)) return;
  await busy(btn, 'Revoking…', async () => {
    await api('DELETE', `/api/apps/${a.id}`);
    S.apps.delete(a.id);
    await loadApps();
    if (!a.folderIds.length || await rotateAfterRevoke(a.folderIds, a.name)) toast(`${a.name} revoked.${a.folderIds.length ? ' Its folders have new keys.' : ''}`);
    render();
  });
}

// ---------- read log and seals

async function refreshLog() {
  try {
    const [log, seals] = await Promise.all([api('GET', '/api/log?limit=300'), api('GET', '/api/seals?limit=200')]);
    S.log = log;
    for (const s of seals.seals) S.seals.set(s.seq, s);
    S.chain = await checkChain(seals.seals);
    if (S.view === 'log' && !dirty) render();
  } catch (e) { toast(e.message, 'err'); }
}

// The seals form a hash chain. This browser remembers the newest chain hash it
// has seen; next time, the chain must still lead from that hash to the new head.
// If the server rewrote or dropped an old seal, the link breaks and it shows here.
const CHECKPOINT = 'synovax:seal-checkpoint';
async function checkChain(newestFirst) {
  const asc = [...newestFirst].sort((a, b) => a.seq - b.seq);
  if (!asc.length) return null;
  const head = asc.at(-1);
  let cp = null;
  try { cp = JSON.parse(localStorage.getItem(CHECKPOINT) ?? 'null'); } catch {}
  const bad = (reason) => ({ ok: false, reason });
  if (asc[0].seq === 1 && asc[0].prev !== GENESIS) return bad('The first seal does not start the chain.');
  if (!(await verifySealChain(asc, asc[0].prev)).ok) return bad('Two of the published seals do not link up.');
  let since = null;
  if (cp && Number.isInteger(cp.seq) && typeof cp.chain === 'string') {
    if (cp.seq > head.seq) return bad(`This browser saw seal #${cp.seq}, which is no longer published.`);
    // walk forward from the remembered seal to the newest one
    const walk = [];
    for (let from = cp.seq; from <= head.seq;) {
      const page = (await api('GET', `/api/seals?from=${from}&limit=500`)).seals;
      if (!page.length) break;
      walk.push(...page);
      from = page.at(-1).seq + 1;
    }
    if (walk[0]?.seq !== cp.seq || walk[0].chain !== cp.chain) return bad(`Seal #${cp.seq} was changed since this browser last saw it.`);
    if (!(await verifySealChain(walk.slice(1), cp.chain)).ok) return bad(`The chain no longer leads from seal #${cp.seq} to the newest seal.`);
    since = cp.seq;
  }
  try { localStorage.setItem(CHECKPOINT, JSON.stringify({ seq: head.seq, chain: head.chain })); } catch {}
  return { ok: true, since, head };
}

function describe(e) {
  const app = S.apps.get(e.appId)?.name ?? 'Revoked app';
  const what = {
    folders: () => 'Listed the folders it may read',
    list: () => (e.target === '*' ? 'Searched all its folders' : `Searched folder “${S.folders.get(e.target)?.name ?? 'deleted folder'}”`),
    read: () => `Read “${S.memories.get(e.target)?.title ?? 'a deleted memory'}”`,
    suggest: () => 'Suggested a memory to your inbox',
    caught: () => `Got “${S.memories.get(e.target)?.title ?? 'a deleted memory'}” with text that looked like instructions for an AI removed`,
  }[e.action]?.() ?? e.action;
  return { app, what };
}

function viewLog() {
  const latest = [...S.seals.values()].sort((a, b) => b.seq - a.seq)[0];
  return h('div', { class: 'page' },
    pageHead('04', 'audit trail', 'Read log', 'Every time an app touches your vault, it is written here. At the end of each period all reads are folded into one fingerprint (a Merkle root). Check any entry against its seal, right here in your browser.',
      h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, 'Loading…', refreshLog) }, 'Refresh')),
    latest && h('div', { class: 'card seal' },
      h('span', { class: 'seal-ic' }, icon('seal')),
      h('div', {},
        h('div', { class: 'seal-l' }, `Latest seal #${latest.seq} · ${fmt(latest.periodStart)} to ${fmt(latest.periodEnd)} · ${latest.count} reads`),
        h('code', { class: 'hash' }, `0x${latest.root}`),
        S.chain && h('span', { class: `chain-l ${S.chain.ok ? 'ok' : 'bad'}` },
          S.chain.ok
            ? `✓ Seal chain intact${S.chain.since ? ` since seal #${S.chain.since}, which this browser saw before` : ''} · head ${S.chain.head.chain.slice(0, 16)}…`
            : `✗ ${S.chain.reason} The server's history may have been rewritten.`))),
    !S.log ? h('div', { class: 'skeleton' }, h('i'), h('i'), h('i'))
      : !S.log.entries.length ? emptyState('No reads yet.', 'Connect an app and it will show up here.')
        : h('table', { class: 'log' },
          h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'App'), h('th', {}, 'What'), h('th', {}, 'Seal'))),
          h('tbody', {}, S.log.entries.map((e) => {
            const { app, what } = describe(e);
            return h('tr', {}, h('td', { class: 'nowrap' }, fmt(e.ts)), h('td', {}, app), h('td', {}, what), h('td', {}, sealCell(e)));
          }))));
}

function sealCell(e) {
  const v = S.verified.get(e.id);
  if (e.sealSeq == null) return h('span', { class: 'fine' }, `Pending · seals ${new Date(S.log.nextCloseAt).toLocaleTimeString()}`);
  // the entry with its salt, for checking it by hand on /verify/ or with your own code
  const copyBtn = h('button', { class: 'btn small ghost', title: 'Copy this entry to check it on the Verify page', onclick: () => copy(JSON.stringify(
    { format: 'synovax-read-v1', id: e.id, ts: e.ts, vault_id: S.vaultId, app_id: e.appId, action: e.action, target: e.target, salt: e.salt, seal: e.sealSeq })) }, 'Copy entry');
  if (v === true) return h('span', { class: 'seal-cell' }, h('span', { class: 'ok' }, `✓ Verified in seal #${e.sealSeq}`), copyBtn);
  if (v === false) return h('span', { class: 'bad' }, '✗ Does not match its seal');
  return h('span', { class: 'seal-cell' }, h('button', { class: 'btn small', onclick: (ev) => busy(ev.target, 'Checking…', () => verifyEntry(e)) }, `Verify #${e.sealSeq}`), copyBtn);
}

async function verifyEntry(e) {
  // 1. Recompute the leaf from the entry itself. 2. Walk the proof up to a root.
  // 3. Compare with the seal as published on the public seals list.
  const leaf = await leafHash({ id: e.id, ts: e.ts, vault_id: S.vaultId, app_id: e.appId, action: e.action, target: e.target, salt: e.salt });
  const p = await api('GET', `/api/log/${e.id}/proof`);
  const published = await api('GET', `/api/seals/${p.seal.seq}`);
  const ok = leaf === e.leaf && leaf === p.leaf && published.root === p.seal.root && await verifyProof(leaf, p.proof, published.root);
  S.verified.set(e.id, ok);
  render();
}

// ---------- settings

function viewSettings() {
  const pw = h('form', { class: 'card', onsubmit: (e) => {
    e.preventDefault();
    const f = pw.elements;
    busy(pw.querySelector('[type=submit]'), 'Making keys…', async () => {
      if (f.next.value.length < 10) throw new Error('Use a passphrase of at least 10 characters.');
      if (f.next.value !== f.next2.value) throw new Error('The two new passphrases are not the same.');
      // checked here: the current passphrase must unwrap the vault key
      const { salt, iterations } = await api('POST', '/api/auth/salt', { username: S.username });
      const k = await C.keysFromPassphrase(f.current.value, salt, iterations);
      const { keys } = await api('GET', '/api/account');
      await C.unwrapKey(k.kek, keys.wrappedVaultKey, 'vk/passphrase').catch(() => { throw new Error('Your current passphrase is wrong.'); });
      await setPassphrase(S.vk, f.next.value);
      pw.reset();
      toast('Passphrase changed. Other sessions were signed out.');
    });
  } },
    h('h2', {}, 'Change passphrase'),
    h('label', {}, 'Current passphrase', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, 'New passphrase', h('input', { name: 'next', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
    h('label', {}, 'Repeat new passphrase', h('input', { name: 'next2', type: 'password', required: true, autocomplete: 'new-password' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Change passphrase'));

  const del = h('form', { class: 'card danger-zone', onsubmit: (e) => {
    e.preventDefault();
    busy(del.querySelector('[type=submit]'), 'Deleting…', async () => {
      await api('DELETE', '/api/account', { confirm: del.elements.confirm.value.trim().toLowerCase() });
      Object.assign(S, blank());
      render();
      toast('Your vault was deleted.');
    });
  } },
    h('h2', {}, 'Delete everything'),
    h('p', { class: 'muted' }, 'Deletes your vault, every memory, every app key and your read log from the server. There is no undo.'),
    h('label', {}, `Type ${S.username} to confirm`, h('input', { name: 'confirm', required: true, autocomplete: 'off' })),
    h('button', { class: 'btn danger', type: 'submit' }, 'Delete my vault'));

  return h('div', { class: 'page' },
    pageHead('05', 'account', 'Settings', `Signed in as ${S.username}.`),
    sessionsCard(),
    twoFactorCard(),
    importCard(),
    h('div', { class: 'card' },
      h('h2', {}, 'Export'),
      h('p', { class: 'muted' }, 'Download every folder and memory, decrypted here on your device, as one JSON file.'),
      h('button', { class: 'btn', onclick: exportVault }, icon('download'), h('span', {}, 'Download export'))),
    pw, del);
}

// Two-step sign-in: after the passphrase, a 6-digit code from an authenticator app.
function twoFactorCard() {
  const body = h('div', {}, h('p', { class: 'fine' }, 'Loading…'));
  const card = h('div', { class: 'card' }, h('h2', {}, 'Two-step sign-in'), body);
  const codeForm = (label, onCode) => {
    const input = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, placeholder: '123 456' });
    const form = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); busy(form.querySelector('button'), '…', () => onCode(input.value.replace(/\s/g, ''))); } },
      h('label', { class: 'grow' }, 'Code from the app', input), h('button', { class: 'btn primary', type: 'submit' }, label));
    return form;
  };
  const show = async () => {
    const { twoFactor } = await api('GET', '/api/account');
    if (twoFactor) {
      body.replaceChildren(
        h('p', { class: 'ok' }, '✓ On. Opening this vault asks for a code from your authenticator app.'),
        h('p', { class: 'muted' }, 'Lost the phone? Your 24 recovery words still open the vault, and turn this off.'),
        codeForm('Turn off', async (code) => { await api('POST', '/api/account/2fa/disable', { code }); toast('Two-step sign-in is off.'); await show(); }));
    } else {
      body.replaceChildren(
        h('p', { class: 'muted' }, 'Off. Turn it on so that a stolen passphrase alone cannot open your vault.'),
        h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, '…', async () => {
          const { secret, uri } = await api('POST', '/api/account/2fa/setup');
          body.replaceChildren(
            h('p', {}, 'In your authenticator app (Google Authenticator, Aegis, 1Password, …) add an account by setup key, and type this key:'),
            h('div', { class: 'keybox' }, h('code', {}, secret.match(/.{1,4}/g).join(' ')), h('button', { class: 'btn small', type: 'button', onclick: () => copy(secret) }, 'Copy key')),
            h('p', { class: 'fine' }, 'On a phone, this link may open the app directly: ', h('a', { href: uri }, 'add to authenticator')),
            h('p', {}, 'Then type the 6-digit code it shows, to finish:'),
            codeForm('Turn on', async (code) => { await api('POST', '/api/account/2fa/enable', { code }); toast('Two-step sign-in is on.'); await show(); }),
            h('button', { class: 'btn', onclick: () => show() }, 'Cancel'));
        }) }, 'Turn on two-step sign-in'));
    }
  };
  show().catch((e) => body.replaceChildren(h('p', { class: 'bad' }, e.message)));
  return card;
}

// Import: our own export file, or a list of facts pasted from another assistant
// (ChatGPT: Settings → Personalization → Manage memories; Claude: Settings →
// Memory), one memory per line, bullet or paragraph.
function parseImport(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('{') || t.startsWith('[')) {
    let data;
    try { data = JSON.parse(t); } catch { throw new Error('That looks like JSON, but it does not parse.'); }
    const list = Array.isArray(data) ? data : Array.isArray(data.memories) ? data.memories : null;
    if (!list) throw new Error('This JSON has no "memories" list.');
    return list.map((m) => (typeof m === 'string' ? fromLine(m) : {
      title: String(m.title ?? '').trim() || fromLine(String(m.body ?? m.content ?? m.text ?? '')).title,
      body: String(m.body ?? m.content ?? m.text ?? m.title ?? '').trim(),
      tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 20) : [],
      folder: typeof m.folder === 'string' ? m.folder : null,
    })).filter((m) => m.body);
  }
  const lines = t.split(/\r?\n/);
  const bulleted = lines.filter((l) => /^\s*([-*•–—]|\d+[.)])\s+/.test(l)).length;
  const items = bulleted >= 2 || lines.filter((l) => l.trim()).length === lines.length
    ? lines.map((l) => l.replace(/^\s*([-*•–—]|\d+[.)])\s+/, '').trim()).filter(Boolean)
    : t.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return items.map(fromLine);
}
function fromLine(s) {
  const body = String(s).trim();
  const first = body.split(/(?<=[.!?])\s/)[0];
  const title = (first.length <= 80 ? first : `${first.slice(0, 77).replace(/\s+\S*$/, '')}…`).replace(/[.!?]$/, '');
  return { title, body, tags: [], folder: null };
}

function importCard() {
  const ta = h('textarea', { rows: 6, placeholder: '- Prefers metric units\n- Works night shifts as an ER nurse\n- Allergic to penicillin' });
  const file = h('input', { type: 'file', accept: '.json,.txt,.md,text/plain,application/json' });
  const target = folderSelect('folder', [...S.folders.values()].find((f) => f.name === 'About me')?.id);
  const note = h('p', { class: 'fine' });
  // memories that look like they carry instructions for an AI stay out unless the owner says so
  const takeFlagged = h('input', { type: 'checkbox', name: 'flagged' });
  const flaggedRow = h('label', { class: 'check', hidden: true }, takeFlagged, h('span', {}));
  let found = [];
  const isFlagged = (m) => flagsOf(m.title, m.body, m.folder, ...m.tags).length > 0;
  const preview = () => {
    try {
      found = parseImport(ta.value);
      const have = new Set([...S.memories.values()].map((m) => `${m.title}\n${m.body}`));
      const dupes = found.filter((m) => have.has(`${m.title}\n${m.body}`)).length;
      const flagged = found.filter(isFlagged);
      note.className = 'fine';
      note.textContent = found.length ? `Found ${found.length} memor${found.length === 1 ? 'y' : 'ies'}${dupes ? `, ${dupes} already in your vault (skipped)` : ''}.` : '';
      flaggedRow.hidden = !flagged.length;
      flaggedRow.lastChild.textContent = `${flagged.length} of them look like they carry instructions for an AI (${flagged.slice(0, 3).map((m) => `“${m.title.slice(0, 40)}”`).join(', ')}${flagged.length > 3 ? ', …' : ''}). Import those too; apps will get them with those places removed.`;
    } catch (e) { found = []; note.className = 'bad'; note.textContent = e.message; flaggedRow.hidden = true; }
  };
  ta.addEventListener('input', preview);
  file.addEventListener('change', async () => { if (file.files[0]) { ta.value = await file.files[0].text(); preview(); } });
  const go = h('button', { class: 'btn primary', onclick: (e) => busy(e.currentTarget, 'Encrypting…', async () => {
    preview();
    if (!found.length) throw new Error('Paste some memories, or pick a file, first.');
    const have = new Set([...S.memories.values()].map((m) => `${m.title}\n${m.body}`));
    const byName = new Map([...S.folders.values()].map((f) => [f.name.toLowerCase(), f.id]));
    let n = 0, held = 0;
    for (const m of found) {
      if (have.has(`${m.title}\n${m.body}`)) continue;
      if (!takeFlagged.checked && isFlagged(m)) { held++; continue; }
      let folderId = target.value;
      if (m.folder) {
        folderId = byName.get(m.folder.toLowerCase()) ?? null;
        if (!folderId) { folderId = await saveFolder(null, m.folder.slice(0, 60)); byName.set(m.folder.toLowerCase(), folderId); }
      }
      await saveMemory({ folderId, title: m.title.slice(0, 200), body: m.body.slice(0, 200_000), tags: m.tags, source: 'import' });
      have.add(`${m.title}\n${m.body}`);
      n++;
    }
    ta.value = ''; found = []; note.textContent = ''; flaggedRow.hidden = true; takeFlagged.checked = false;
    toast(`Imported ${n} memor${n === 1 ? 'y' : 'ies'}, encrypted on this device.${held ? ` ${held} left out: they look like instructions for an AI.` : ''}`);
    render();
  }) }, 'Import');
  return h('div', { class: 'card' },
    h('h2', {}, 'Import'),
    h('p', { class: 'muted' }, 'Paste what another assistant remembers about you, one fact per line. In ChatGPT: Settings → Personalization → Manage memories. In Claude: Settings → Memory. A file exported from this vault (.json) also works, folders and all.'),
    ta,
    h('div', { class: 'grid2' }, h('label', {}, 'Or a file', file), h('label', {}, 'Save into folder', target)),
    note,
    flaggedRow,
    h('div', { class: 'row' }, go));
}

// Signed-in devices: each open vault is a session; sign out any of them here.
function sessionsCard() {
  const list = h('div', { class: 'sessions' }, h('p', { class: 'fine' }, 'Loading…'));
  const card = h('div', { class: 'card' },
    h('h2', {}, 'Signed-in devices'),
    h('p', { class: 'muted' }, 'Every place your vault is open right now. Sign out anything you do not recognize, then change your passphrase.'),
    list);
  const fill = async () => {
    try {
      const { sessions } = await api('GET', '/api/sessions');
      const others = sessions.filter((s) => !s.current);
      list.replaceChildren(
        ...sessions.map((s) => h('div', { class: 'row session' },
          h('span', { class: 'grow' }, h('b', {}, s.agent || 'Unknown device'), s.current ? ' · this device' : '',
            h('br'), h('small', { class: 'fine' }, `signed in ${fmt(s.createdAt)} · active ${ago(s.lastUsedAt)}`)),
          !s.current && h('button', { class: 'btn small', onclick: (e) => busy(e.currentTarget, '…', async () => { await api('DELETE', `/api/sessions/${s.id}`); toast('Signed out.'); await fill(); }) }, 'Sign out'))),
        others.length > 1 && h('button', { class: 'btn danger', onclick: (e) => busy(e.currentTarget, 'Signing out…', async () => {
          const r = await api('POST', '/api/sessions/sign-out-others');
          toast(`Signed out ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'}.`);
          await fill();
        }) }, `Sign out all ${others.length} other devices`));
    } catch (e) { list.replaceChildren(h('p', { class: 'bad' }, e.message)); }
  };
  fill();
  return card;
}

function exportVault() {
  const data = {
    exportedAt: new Date().toISOString(),
    vault: S.username,
    folders: [...S.folders.values()].map((f) => ({ id: f.id, name: f.name })),
    memories: [...S.memories.values()].filter((m) => !m.broken).map(({ id, folderId, title, body, tags, source, createdAt, updatedAt }) =>
      ({ id, folder: S.folders.get(folderId)?.name, title, body, tags, source, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(updatedAt).toISOString() })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `${S.username}-export-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- inbox, checked in the background

async function pollInbox() {
  if (!S.vk || S.pendingPhrase || document.hidden) return;
  const before = new Set(S.inbox.map((s) => s.id));
  try { await loadInbox(); } catch { return; }
  const fresh = S.inbox.filter((s) => !before.has(s.id)).length;
  const changed = fresh || S.inbox.length !== before.size;
  if (changed && !dirty) render();
  if (fresh) toast(`${fresh} new suggestion${fresh === 1 ? '' : 's'} in your inbox.`);
}
setInterval(pollInbox, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollInbox(); });

// ---------- boot

try { config = { ...config, ...(await (await fetch('/api/config')).json()) }; } catch { /* keep defaults */ }
render();
