// SYNOVAX admin · token control. Publishes the token details the landing page
// shows. The session token lives in sessionStorage only: closing the tab signs out.

import { split, rise, contours, C } from '/landing/engine.js';
import { spinCoin } from '/landing/coin.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEY = 'synovax.admin';
const FIELDS = ['status', 'contract', 'explorerUrl', 'twitter', 'supply', 'launchDate'];
const LABEL = { status: 'status', contract: 'contract', explorerUrl: 'explorer link', twitter: 'x account', supply: 'supply', launchDate: 'launch date' };

let token = null;
try { token = sessionStorage.getItem(KEY); } catch {}
let current = null; // what the server has published

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer adm.${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { signOut(false); throw new Error(data.error || 'Signed out.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------- look and motion

for (const c of $$('[data-contours]')) contours(c, c.dataset.contours);
const coins = new Map();
const coinFor = (view) => {
  const c = $(`[data-view="${view}"] [data-coin]`);
  if (c && !coins.has(c)) coins.set(c, spinCoin(c));
  return coins.get(c);
};

const revealed = new WeakSet();
function reveal(root) {
  for (const h of $$('[data-head]', root)) {
    if (revealed.has(h)) continue;
    revealed.add(h);
    const lines = $$('[data-line]', h).map((l) => split(l, { unit: 'word' }));
    const stop = document.createElement('span'); stop.className = 'stop'; stop.textContent = '.'; stop.setAttribute('aria-hidden', 'true');
    lines.at(-1).units.at(-1).append(stop);
    lines.forEach((s, i) => s.play(120 + i * 130, { stagger: 110, config: C.REVEAL }));
  }
  [...$$('.tile', root), ...$$('.step', root), ...$$('.preview, .log', root)].forEach((el, i) => {
    if (revealed.has(el)) return;
    revealed.add(el);
    rise(el, { delay: 260 + i * 70, y: '1.25rem' });
  });
}

const show = (view) => {
  for (const v of $$('[data-view]')) v.hidden = v.dataset.view !== view;
  for (const el of $$('[data-signed-in]')) el.hidden = view !== 'editor';
  coinFor(view);
  reveal($(`[data-view="${view}"]`));
};

const clock = $('[data-clock]');
const tickClock = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
tickClock(); setInterval(tickClock, 1000);

// ---------- sign in / out

$('[data-signin-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('[data-signin-error]'), input = e.target.key, btn = e.target.querySelector('.btn');
  err.textContent = '';
  btn.classList.add('is-busy');
  try {
    const out = await api('POST', '/api/admin/login', { key: input.value });
    token = out.token;
    try { sessionStorage.setItem(KEY, token); } catch {}
    input.value = '';
    await load();
  } catch (ex) { err.textContent = ex.message; }
  finally { btn.classList.remove('is-busy'); }
});

function signOut(tell = true) {
  if (tell && token) api('POST', '/api/admin/logout').catch(() => {});
  token = null; current = null;
  try { sessionStorage.removeItem(KEY); } catch {}
  show('signin');
}
$('[data-signout]').addEventListener('click', () => signOut(true));

// ---------- the form

const form = $('[data-token-form]');
const meter = $('[data-hexmeter]');
const cells = Array.from({ length: 40 }, (_, i) => { const li = document.createElement('li'); li.style.setProperty('--i', String(i * 12)); meter.append(li); return li; });

const read = () => Object.fromEntries(FIELDS.map((k) => [k, k === 'status' ? (form.querySelector('[name=status]:checked')?.value ?? 'pre-launch') : form.elements[k].value.trim()]));
function fill(t) {
  for (const k of FIELDS) {
    if (k === 'status') for (const r of form.querySelectorAll('[name=status]')) r.checked = r.value === t.status;
    else form.elements[k].value = t[k] ?? '';
  }
  check();
}

const handleOf = (v) => /^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/.exec(v)?.[1] ?? null;
const short = (ca) => `${ca.slice(0, 6)}…${ca.slice(-4)}`;
const isCA = (v) => /^0x[0-9a-fA-F]{40}$/.test(v);

let lastPv = {};
// client-side checks mirror the server's; the server has the last word
function check() {
  const v = read();
  const problems = {};
  if (v.contract && !isCA(v.contract)) problems.contract = /^0x/i.test(v.contract) || v.contract.length < 2 ? `Needs 40 hex characters after 0x · ${Math.max(0, v.contract.length - 2)}/40` : 'Must start with 0x.';
  if (v.twitter && !handleOf(v.twitter)) problems.twitter = 'Use a handle like synovax, @synovax or an x.com link.';
  if (v.explorerUrl && !/^https:\/\/\S+$/.test(v.explorerUrl)) problems.explorerUrl = 'Must start with https://';
  if (v.status === 'live' && !v.contract) problems.contract = problems.contract ?? 'Live needs a contract address.';
  const isNew = v.contract && isCA(v.contract) && current && v.contract.toLowerCase() !== current.contract.toLowerCase();
  for (const k of ['contract', 'twitter', 'explorerUrl']) {
    const hint = $(`[data-hint="${k}"]`), input = form.elements[k];
    hint.dataset.base ??= hint.textContent;
    hint.textContent = problems[k] ?? (k === 'contract' && isNew ? 'New address · you will confirm it before it goes live.' : hint.dataset.base);
    hint.classList.toggle('is-bad', !!problems[k]);
    hint.classList.toggle('is-new', k === 'contract' && !problems[k] && !!isNew);
    input.classList.toggle('is-bad', !!problems[k]);
  }
  // hex meter: one cell per hex character after 0x
  const hex = v.contract.replace(/^0x/i, '');
  cells.forEach((c, i) => {
    const ch = hex[i];
    c.classList.toggle('is-on', !!ch && /[0-9a-f]/i.test(ch));
    c.classList.toggle('is-bad', !!ch && !/[0-9a-f]/i.test(ch));
  });
  meter.classList.toggle('is-full', isCA(v.contract));

  // preview
  const h = handleOf(v.twitter);
  const pv = {
    launchDate: v.launchDate || '', supply: v.supply || '',
    contract: v.contract && !problems.contract ? v.contract : '', twitter: h ? `@${h}` : '',
  };
  const fallback = { launchDate: 'tba', supply: 'tba', contract: 'posted here at launch', twitter: 'tba' };
  for (const k of Object.keys(pv)) {
    const el = $(`[data-pv="${k}"]`);
    el.textContent = pv[k] || fallback[k];
    el.classList.toggle('is-tba', !pv[k]);
    if (lastPv[k] !== undefined && lastPv[k] !== pv[k]) { el.classList.remove('is-flash'); void el.offsetWidth; el.classList.add('is-flash'); }
  }
  lastPv = pv;
  const st = $('[data-pv="status"]');
  st.querySelector('span').textContent = v.status === 'live' ? 'live on robinhood chain' : 'pre-launch · not live yet';
  st.classList.toggle('is-live', v.status === 'live');

  // unsaved changes
  const changed = current ? FIELDS.filter((k) => (k === 'twitter' ? (h ?? v.twitter) !== current.twitter : v[k] !== current[k])) : [];
  const bad = Object.keys(problems).length > 0;
  $('[data-publish]').disabled = !changed.length || bad;
  $('[data-reset]').disabled = !changed.length;
  $('[data-bar]').classList.toggle('is-dirty', changed.length > 0);
  $('[data-dirty]').textContent = changed.length ? `${changed.length} unsaved · ${changed.map((k) => LABEL[k]).join(', ')}` : 'no unsaved changes';
  return { v, problems };
}
form.addEventListener('input', check);
$('[data-reset]').addEventListener('click', () => current && fill(current));

// ---------- tiles and history

const fmt = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
function tiles(t) {
  const set = (k, v, sub, on) => {
    $(`[data-tile-v="${k}"]`).textContent = v;
    $(`[data-tile-s="${k}"]`).textContent = sub;
    const tile = $(`[data-tile="${k}"]`);
    if (k === 'contract') $('[data-tile-v="contract"]').classList.toggle('mono', on === true);
    tile.classList.toggle('is-on', on === true); tile.classList.toggle('is-off', on === false);
  };
  set('status', t.status === 'live' ? 'live' : 'pre-launch', t.status === 'live' ? 'on robinhood chain' : 'not live yet', t.status === 'live');
  set('contract', t.contract ? short(t.contract) : 'not set', t.contract ? 'published' : 'posted at launch', t.contract ? true : false);
  set('twitter', t.twitter ? `@${t.twitter}` : 'not set', t.twitter ? 'shown on the site' : 'add the official account', t.twitter ? true : false);
  set('published', t.updatedAt ? ago(t.updatedAt) : 'never', t.updatedAt ? fmt(t.updatedAt) : 'nothing published yet', t.updatedAt ? undefined : false);
}
setInterval(() => current && tiles(current), 30_000);

function history(rows) {
  $('[data-log-count]').textContent = rows.length ? `· ${rows.length}` : '';
  $('[data-history]').replaceChildren(...(rows.length ? rows : [null]).map((r) => {
    const li = document.createElement('li');
    if (!r) { li.className = 'hist-empty'; li.textContent = 'no changes yet'; return li; }
    const t = document.createElement('span'); t.className = 'h-at'; t.textContent = fmt(r.at);
    const f = document.createElement('span'); f.className = 'h-f'; f.textContent = LABEL[r.field] ?? r.field;
    const d = document.createElement('span'); d.className = 'h-d';
    const o = document.createElement('s'); o.textContent = r.old || '(empty)';
    const n = document.createElement('b'); n.textContent = r.new || '(empty)';
    d.append(o, ' → ', n);
    li.append(t, f, d);
    return li;
  }));
}

async function load() {
  const data = await api('GET', '/api/admin/token');
  current = data.token;
  fill(current);
  tiles(current);
  history(data.history);
  show('editor');
}

// ---------- toast

let toastTimer = 0;
function toast(title, sub) {
  const t = $('[data-toast]');
  $('[data-toast-t]').textContent = title;
  $('[data-toast-s]').textContent = sub;
  t.hidden = false; t.classList.remove('is-out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.add('is-out'); setTimeout(() => { t.hidden = true; }, 320); }, 3200);
}

// ---------- publish, with a confirm step for a new contract address

const dialog = $('[data-confirm]');
function confirmContract(ca) {
  return new Promise((resolve) => {
    const f = $('[data-confirm-form]');
    f.tail.value = '';
    $('[data-confirm-error]').textContent = '';
    const groups = ca.slice(2).match(/.{4}/g);
    const items = [Object.assign(document.createElement('li'), { className: 'is-0x', textContent: '0x' })];
    // the last 6 characters, the ones to type, are underlined exactly
    groups.forEach((g, i) => {
      const li = document.createElement('li');
      [...g].forEach((ch, j) => {
        if (i * 4 + j >= 34) { const u = document.createElement('u'); u.textContent = ch; li.append(u); } else li.append(ch);
      });
      items.push(li);
    });
    $('[data-confirm-ca]').replaceChildren(...items);
    const onClose = () => { dialog.removeEventListener('close', onClose); resolve(dialog.returnValue === 'ok' ? f.tail.value.trim() : null); };
    dialog.returnValue = '';
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    f.tail.focus();
  });
}
$('[data-confirm-ok]').addEventListener('click', (e) => {
  const f = $('[data-confirm-form]');
  if (f.tail.value.trim().toLowerCase() !== read().contract.slice(-6).toLowerCase()) {
    e.preventDefault();
    $('[data-confirm-error]').textContent = 'Those are not the last 6 characters.';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('[data-form-error]');
  err.textContent = '';
  const { v, problems } = check();
  if (Object.keys(problems).length) return;
  const body = { ...v, rev: current.rev };
  if (v.contract && v.contract.toLowerCase() !== current.contract.toLowerCase()) {
    const tail = await confirmContract(v.contract);
    if (tail === null) return;
    body.confirmContract = tail;
  }
  const btn = $('[data-publish]'), label = $('[data-publish-label]');
  btn.disabled = true; btn.classList.add('is-busy'); label.textContent = 'publishing';
  try {
    const out = await api('PUT', '/api/admin/token', body);
    await load();
    if (out.changed.length) {
      toast('published', out.changed.map((k) => LABEL[k]).join(' · '));
      for (const c of coins.values()) c.kick();
    } else toast('nothing changed', 'the page already shows this');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.classList.remove('is-busy'); label.textContent = 'publish';
    check();
  }
});

// ---------- start

if (token) load().catch(() => signOut(false)); else show('signin');
