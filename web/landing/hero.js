// Hero: the loading veil, the WebGL scene, live server data and the entrance.

import { subscribe, Spring, C, split, rise, reduced, clamp01, contours } from './engine.js';
import { Scene, getTier } from './scene.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const compact = (n) => {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
};
export const periodWords = (ms) => {
  if (ms === 3_600_000) return { text: 'hourly', short: '1h' };
  if (ms % 3_600_000 === 0) return { text: `every ${ms / 3_600_000} hours`, short: `${ms / 3_600_000}h` };
  if (ms % 60_000 === 0) return { text: `every ${ms / 60_000} min`, short: `${ms / 60_000}m` };
  return { text: `every ${Math.round(ms / 1000)}s`, short: `${Math.round(ms / 1000)}s` };
};

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

// ---------- live data ----------
async function loadData() {
  const [stats, seals, config] = await Promise.allSettled([getJSON('/api/stats'), getJSON('/api/seals?limit=1'), getJSON('/api/config')]);
  // The counts appear only once there are enough real vaults to be worth showing;
  // until then (or if anything fails) the panel says "early access".
  const min = config.status === 'fulfilled' && Number.isFinite(config.value.statsMinVaults) ? config.value.statsMinVaults : 100;
  const showCounts = stats.status === 'fulfilled' && (stats.value.vaults ?? 0) >= min;
  if (showCounts) {
    for (const dd of $$('[data-stat]')) dd.textContent = compact(stats.value[dd.dataset.stat] ?? 0);
  }
  const live = $('[data-hero-live]'), early = $('[data-hero-early]');
  if (live) live.hidden = !showCounts;
  if (early) early.hidden = showCounts;
  if (config.status === 'fulfilled' && config.value.sealPeriodMs) {
    const w = periodWords(config.value.sealPeriodMs);
    for (const el of $$('[data-period-text]')) el.textContent = w.text;
    for (const el of $$('[data-period-short]')) el.textContent = w.short;
  }
  if (seals.status === 'fulfilled') {
    const s = seals.value.seals?.[0];
    if (s) {
      $('[data-seal-title]').textContent = `seal #${s.seq}`;
      $('[data-seal-root]').textContent = `root ${s.root.slice(0, 4)}…${s.root.slice(-4)}`;
    }
    const next = seals.value.nextCloseAt;
    const el = $('[data-seal-next]');
    const tick = () => {
      const left = Math.max(0, next - Date.now());
      el.textContent = left < 60_000 ? `next in ${Math.ceil(left / 1000)}s` : `next in ${Math.ceil(left / 60_000)} min`;
    };
    if (next) { tick(); setInterval(tick, 1000); }
  }
}

// ---------- burger sheet ----------
function burger() {
  const btn = $('[data-burger]');
  let sheet = null, onKey = null;
  const close = () => {
    if (!sheet) return;
    const s = sheet; sheet = null;
    document.documentElement.classList.remove('is-locked');
    removeEventListener('keydown', onKey);
    btn.setAttribute('aria-expanded', 'false');
    new Spring(1, { config: C.SHEET, onChange: (v) => { s.style.opacity = String(v); } }).to(0).then(() => s.remove());
    btn.focus();
  };
  const open = () => {
    if (sheet) return;
    sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Menu');
    const top = document.createElement('div'); top.className = 'sheet-top';
    const logo = $('.mast .logo').cloneNode(true); logo.addEventListener('click', close);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'sheet-close'; x.setAttribute('aria-label', 'Close menu');
    x.append(document.createElement('span'), document.createElement('span'));
    x.addEventListener('click', close);
    top.append(logo, x);
    const nav = document.createElement('nav'); nav.setAttribute('aria-label', 'Menu');
    const gh = $('[data-github]')?.getAttribute('href');
const npm = $('[data-npm]')?.getAttribute('href');
    const links = [...$$('.mast-nav a').map((a) => [a.textContent, a.getAttribute('href')]), ...(gh ? [['github ↗', gh]] : []), ...(npm ? [['npm ↗', npm]] : []), ['open vault', '/vault/']];
    links.forEach(([label, href], i) => {
      const a = document.createElement('a'); a.href = href; a.textContent = label;
      if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.addEventListener('click', close);
      nav.append(a);
      rise(a, { delay: 120 + i * 55, config: C.ITEM });
    });
    sheet.append(top, nav);
    document.body.append(sheet);
    document.documentElement.classList.add('is-locked');
    btn.setAttribute('aria-expanded', 'true');
    new Spring(0, { config: C.SHEET, onChange: (v) => { if (sheet) sheet.style.opacity = String(v); } }).to(1);
    x.focus();
    onKey = (e) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', onKey);
  };
  btn.addEventListener('click', open);
  matchMedia('(min-width: 1280px)').addEventListener('change', (e) => { if (e.matches) close(); });
}

// ---------- entrance ----------
function entrance() {
  const mast = $('.mast');
  rise(mast, { delay: 0 });
  rise($('[data-hero-id]'), { delay: 180, y: '0rem' });
  split($('[data-hero-name]'), { unit: 'word' }).play(180, { stagger: 110, config: C.REVEAL });
  $$('[data-hero-meta]').forEach((el, i) => rise(el, { delay: 180 + 260 + i * 130 }));
  rise($('[data-hero-panels]'), { delay: 900, y: '1.25rem' });
  $$('[data-stat]').forEach((dd, i) => split(dd, { unit: 'letter' }).play(900 + i * 90, { stagger: 26, config: C.FIGURE }));
  rise($('[data-hero-actions]'), { delay: 1500 });
}

function showAll() {
  for (const el of $$('[data-hero-name], [data-stat]')) split(el, { unit: el.matches('[data-stat]') ? 'letter' : 'word' }).show();
}

// ---------- scene + veil ----------
export async function hero() {
  history.scrollRestoration = 'manual';
  scrollTo(0, 0);
  burger();
  const section = $('[data-hero]');
  const canvas = $('[data-scene]', section);
  const fitBox = $('[data-fit-box]', section);
  const veil = $('[data-veil]');
  veil.style.animation = 'none';

  // veil progress: creeps to 0.7, completes when ready
  const fill = $('[data-veil-fill]'), meter = $('[data-veil-meter]');
  const progress = new Spring(0, { config: C.WAIT, onChange: (v) => { fill.style.transform = `scaleY(${v})`; meter.style.transform = `scaleX(${v})`; } });
  progress.to(0.7);
  rise($('[data-veil-name]'), { delay: 260, config: C.LABEL, y: '0.6rem' });

  let tier = getTier();
  let scene = null;
  try { scene = new Scene(canvas, tier); } catch (err) {
    console.warn('Hero scene unavailable, using the 2D contour fallback.', err);
    canvas.hidden = true;
    const fb = $('[data-hero-fallback]', section); fb.hidden = false;
    contours(fb, '--surface-soft');
  }

  const measure = () => {
    if (!scene) return;
    let box = null;
    if (fitBox.offsetParent !== null) {
      const wrap = fitBox.offsetParent;
      box = { x: wrap.offsetLeft + fitBox.offsetLeft, y: wrap.offsetTop + fitBox.offsetTop, w: fitBox.offsetWidth, h: fitBox.offsetHeight };
    }
    scene.resize(section.clientWidth, section.clientHeight, box);
  };
  let running = false;
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(() => {
    const w = section.clientWidth, h = section.clientHeight;
    const coarse = matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (w === lastW && (coarse || h === lastH)) return;
    lastW = w; lastH = h;
    if (scene) {
      const next = getTier();
      if (next.name !== tier.name) { tier = next; scene.tier = next; scene.trail = []; bindPointer(); }
    }
    measure();
    if (scene && (reduced || !running)) scene.render(performance.now(), { frozen: reduced });
  });
  ro.observe(section);

  // pointer
  const onMove = (e) => scene.setPointer((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
  let bound = false;
  function bindPointer() {
    if (!scene) return;
    if (tier.pointer && !bound) { addEventListener('pointermove', onMove, { passive: true }); bound = true; }
    if (!tier.pointer && bound) { removeEventListener('pointermove', onMove); bound = false; scene.setPointer(0.3, 0.1); }
    if (!tier.pointer) scene.setPointer(0.3, 0.1);
  }
  bindPointer();

  // render loop: only while the hero is the thing on screen
  if (scene && !reduced) {
    subscribe((t) => {
      running = scrollY <= innerHeight * 1.15 && document.visibilityState === 'visible';
      if (running) scene.render(t);
    }, () => tier.frameInterval);
  }

  // ready = fonts in, data in (or 1.5s), scene compiled and one frame drawn
  const dataDone = Promise.race([loadData().catch(() => {}), wait(1500)]);
  await Promise.all([document.fonts?.ready, dataDone, wait(450)]);
  if (scene) {
    measure();
    scene.render(performance.now(), { frozen: reduced });
  }

  // exit: clear content, then lift the veil and start the page
  progress.to(1, { config: C.READY });
  veil.style.pointerEvents = 'none';
  veil.setAttribute('aria-label', 'Loaded');
  const content = $('[data-veil-content]'), meterBox = $('.veil-meter');
  new Spring(1, { config: C.CLEAR, onChange: (v) => {
    content.style.opacity = String(v); content.style.transform = `translateY(${(1 - v) * -0.75}rem)`; meterBox.style.opacity = String(v);
  } }).to(0);
  scene?.ready();
  await wait(reduced ? 0 : 430 + 240);
  new Spring(1, { config: C.VEIL, onChange: (v) => { veil.style.opacity = String(v); } }).to(0);
  scene?.beginRise();
  if (reduced) { showAll(); scene?.render(performance.now(), { frozen: true }); } else entrance();
  const t0 = performance.now();
  const unsub = subscribe(() => {
    if (Number(getComputedStyle(veil).opacity) <= 0.004 || performance.now() - t0 > 3000) { veil.remove(); unsub(); }
  });
  return { scene };
}
