// Blocks below the hero: the data-path map, the steps timeline, connect, footer.

import { subscribe, Spring, C, split, rise, reduced, clamp01, inView, loopInView, scrub, fitCanvas, token } from './engine.js';
import { WORDS } from '/shared/wordlist.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.append(el);
  return el;
};
const easeOutQuad = (x) => 1 - (1 - x) * (1 - x);

// A two-line display heading: word reveals per line, then the full stop.
function heading(h2, delay = 0) {
  const lines = $$('[data-line]', h2);
  const splits = lines.map((l) => split(l, { unit: 'word' }));
  const stop = document.createElement('span');
  stop.className = h2.dataset.stop === 'accent' ? 'stop stop--accent' : 'stop';
  stop.textContent = '.'; stop.setAttribute('aria-hidden', 'true');
  splits.at(-1).units.at(-1).append(stop);
  return () => {
    splits.forEach((s, i) => s.play(delay + i * 130, { stagger: 110, config: C.REVEAL }));
    rise(stop, { delay: delay + 130 + 110, y: '0em' });
  };
}

// ================= 2 · how it stays yours =================
const STATIONS = [
  { x: 470, y: 610, label: 'your device', flag: true },
  { x: 470, y: 330, label: 'encrypt · aes-256-gcm' },
  { x: 730, y: 215, label: 'ciphertext only' },
  { x: 1010, y: 265, label: 'server · stores noise' },
  { x: 1230, y: 430, label: 'sealed every hour' },
  { x: 1100, y: 625, label: 'ai app · allowed folders' },
  { x: 790, y: 665, label: null },
];
const HUB = { x: 850, y: 440 };

// Round every corner of the closed polygon and sample it every ~2 artboard px.
function buildRoute() {
  const n = STATIONS.length, R = 70, pts = [], stationAt = [];
  const P = (i) => STATIONS[(i + n) % n];
  for (let i = 0; i < n; i++) {
    const a = P(i - 1), b = P(i), c = P(i + 1);
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(R, l1 / 2.2, l2 / 2.2);
    const p0 = { x: b.x + (a.x - b.x) * (r / l1), y: b.y + (a.y - b.y) * (r / l1) };
    const p2 = { x: b.x + (c.x - b.x) * (r / l2), y: b.y + (c.y - b.y) * (r / l2) };
    if (pts.length) {
      const last = pts.at(-1), d = Math.hypot(p0.x - last.x, p0.y - last.y), m = Math.max(1, Math.ceil(d / 2));
      for (let k = 1; k <= m; k++) pts.push({ x: last.x + ((p0.x - last.x) * k) / m, y: last.y + ((p0.y - last.y) * k) / m });
    } else pts.push(p0);
    const m = 40;
    for (let k = 1; k <= m; k++) {
      const t = k / m, u = 1 - t;
      pts.push({ x: u * u * p0.x + 2 * u * t * b.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * b.y + t * t * p2.y });
      if (k === m / 2) stationAt[i] = pts.length - 1;
    }
  }
  // close back to the start
  const first = pts[0], last = pts.at(-1), d = Math.hypot(first.x - last.x, first.y - last.y), m = Math.max(1, Math.ceil(d / 2));
  for (let k = 1; k <= m; k++) pts.push({ x: last.x + ((first.x - last.x) * k) / m, y: last.y + ((first.y - last.y) * k) / m });
  // the lap starts at the flag (station 0)
  const s0 = stationAt[0];
  const route = [...pts.slice(s0), ...pts.slice(1, s0 + 1)];
  const remap = stationAt.map((i) => (i - s0 + pts.length - 1) % (pts.length - 1));
  // time per sample: brake through corners, run down the straights
  const curv = route.map((p, i) => {
    const a = route[Math.max(0, i - 6)], b = route[Math.min(route.length - 1, i + 6)];
    const h1 = Math.atan2(p.y - a.y, p.x - a.x), h2 = Math.atan2(b.y - p.y, b.x - p.x);
    let d = Math.abs(h2 - h1); if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  });
  const time = [0];
  for (let i = 1; i < route.length; i++) {
    const ds = Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
    time.push(time[i - 1] + ds * (1 + curv[i] * 5));
  }
  const total = time.at(-1);
  return { route, stationAt: remap, time: time.map((t) => t / total) };
}

function how() {
  const section = $('[data-how]');
  const frame = $('.stage-frame', section), stage = $('[data-stage]', section);
  const svg = $('[data-stage-svg]', section), dots = $('[data-dots]', section), trace = $('[data-trace]', section);
  const { route, stationAt, time } = buildRoute();

  // --- svg: grid axes, rings, hub, ghost route, stations ---
  const grid = svgEl('g', {}, svg);
  const axes = [svgEl('path', { class: 'grid', d: `M-200 ${HUB.y}H1640` }, grid), svgEl('path', { class: 'grid', d: `M${HUB.x} -200V1000` }, grid)];
  svgEl('circle', { class: 'ring', cx: HUB.x, cy: HUB.y, r: 330 }, svg);
  svgEl('circle', { class: 'ring', cx: HUB.x, cy: HUB.y, r: 230 }, svg);
  svgEl('circle', { class: 'ring ring--in', cx: HUB.x, cy: HUB.y, r: 120 }, svg);
  const ping = svgEl('circle', { class: 'ping', cx: HUB.x, cy: HUB.y, r: 8 }, svg);
  svgEl('rect', { class: 'hub', x: HUB.x - 5, y: HUB.y - 5, width: 10, height: 10 }, svg);
  const hubLabel = svgEl('text', { class: 'nlabel', x: HUB.x + 14, y: HUB.y - 12 }, svg); hubLabel.textContent = 'your vault';
  svgEl('path', { class: 'ghost', d: `M${route.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z` }, svg);
  const nodes = [];
  STATIONS.forEach((s, i) => {
    if (!s.label) return;
    const p = route[stationAt[i]];
    const g = svgEl('g', {}, svg);
    if (s.flag) {
      const f = svgEl('g', { class: 'flag' }, g);
      for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2 === 0) svgEl('rect', { x: p.x - 12 + x * 6, y: p.y - 9 + y * 6, width: 6, height: 6 }, f);
    } else {
      nodes.push({ i: stationAt[i], el: svgEl('rect', { class: 'node', x: p.x - 6, y: p.y - 6, width: 12, height: 12 }, g), label: null });
    }
    // labels sit outside the lap, pushed away from the hub
    const dx = p.x - HUB.x, dy = p.y - HUB.y, dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl;
    const lx = p.x + ux * 24, ly = p.y + uy * 24;
    const anchor = ux > 0.35 ? 'start' : ux < -0.35 ? 'end' : 'middle';
    const [ny, ly2] = uy < -0.35 ? [ly - 18, ly - 3] : uy > 0.35 ? [ly + 10, ly + 25] : [ly - 4, ly + 12];
    const num = svgEl('text', { class: 'nnum', x: lx, y: ny, 'text-anchor': anchor }, g);
    num.textContent = String(i + 1).padStart(2, '0');
    const lab = svgEl('text', { class: 'nlabel', x: lx, y: ly2, 'text-anchor': anchor }, g);
    lab.textContent = s.label;
    if (!s.flag) nodes.at(-1).label = lab;
  });

  // --- fit the 1440×800 artboard ---
  const xs = route.map((p) => p.x), ys = route.map((p) => p.y);
  const box = { x: Math.min(...xs) - 46 - 170, y: Math.min(...ys) - 46, w: Math.max(...xs) - Math.min(...xs) + 92 + 340, h: Math.max(...ys) - Math.min(...ys) + 92 };
  let fit = { s: 1, tx: 0, ty: 0 };
  const refit = () => {
    const w = frame.clientWidth, h = frame.clientHeight;
    let s, tx, ty;
    if (w >= 1024) { s = Math.max(w / 1440, h / 800); tx = (w - 1440 * s) / 2; ty = (h - 800 * s) / 2; }
    else { s = w / box.w; tx = w / 2 - (box.x + box.w / 2) * s; ty = h * 0.56 - (box.y + box.h / 2) * s; }
    fit = { s, tx, ty };
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    const coarse = matchMedia('(pointer: coarse)').matches;
    fitCanvas(dots, 1440, 800, coarse ? 1 : Math.min(2, Math.max(1, s * (devicePixelRatio || 1))));
    fitCanvas(trace, 1440, 800, coarse ? 1 : 2);
    drawDots(); drawTrace();
  };

  // --- halftone ---
  const STEP = 12, cols = Math.ceil(1440 / STEP), rows = Math.ceil(800 / STEP);
  const land = (x, y) => {
    const nx = x / 1440, ny = y / 800;
    let f = Math.sin(nx * 7.1 + 1.3) * 0.5 + Math.sin(ny * 6.3 - 0.4) * 0.45 + Math.sin((nx + ny) * 9.7 + 2.1) * 0.3 + Math.sin((nx - ny) * 13.1) * 0.22;
    f += Math.sin(nx * 23.0 + ny * 5.0) * 0.12;
    return f;
  };
  const cells = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = i * STEP + STEP / 2, y = j * STEP + STEP / 2;
    const f = land(x, y);
    if (f < -0.1) continue;
    // nearest route sample, for lighting as the trace passes
    let best = 1e9, bi = 0;
    for (let k = 0; k < route.length; k += 3) { const d = (route[k].x - x) ** 2 + (route[k].y - y) ** 2; if (d < best) { best = d; bi = k; } }
    cells.push({ i, j, x, y, r: 0.6 + Math.min(1, (f + 0.1) / 1.1) * 1.9, near: bi, dist: Math.sqrt(best) });
  }
  const dctx = dots.getContext('2d');
  let headIdx = -1, done = false, ret = null;
  const colDot = token('--map-dot'), colLit = '#ffffff', colAcc = token('--accent');
  function drawDots() {
    const ratio = dots.width / 1440;
    dctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    dctx.clearRect(0, 0, 1440, 800);
    for (const c of cells) {
      let lit = 0;
      if (headIdx >= 0 && (done || c.near <= headIdx) && c.dist < 70) lit = 1 - c.dist / 70;
      let square = false, accent = false;
      if (ret) {
        const di = c.i - ret.i, dj = c.j - ret.j;
        if ((dj === 0 && Math.abs(di) <= 12) || (di === 0 && Math.abs(dj) <= 12)) { square = true; lit = Math.max(lit, 0.9 - 0.05 * Math.max(Math.abs(di), Math.abs(dj))); }
        if (Math.abs(di) <= 3 && Math.abs(dj) <= 3) { if ((di + dj) % 2 === 0) { square = true; accent = di === 0 && dj === 0; lit = 1; } else continue; }
      }
      dctx.globalAlpha = 0.55 + lit * 0.45;
      dctx.fillStyle = accent ? colAcc : lit > 0.05 ? colLit : colDot;
      if (square) { const s = STEP * 0.62; dctx.fillRect(c.x - s / 2, c.y - s / 2, s, s); }
      else { dctx.beginPath(); dctx.arc(c.x, c.y, c.r * (1 + lit * 0.25), 0, Math.PI * 2); dctx.fill(); }
    }
    dctx.globalAlpha = 1;
  }

  // --- the lap ---
  const tctx = trace.getContext('2d');
  let lapT = 0;
  function drawTrace() {
    const ratio = trace.width / 1440;
    tctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    tctx.clearRect(0, 0, 1440, 800);
    if (headIdx < 1) return;
    const end = done ? route.length - 1 : headIdx;
    const path = () => { tctx.beginPath(); tctx.moveTo(route[0].x, route[0].y); for (let k = 1; k <= end; k++) tctx.lineTo(route[k].x, route[k].y); };
    tctx.lineJoin = 'round'; tctx.lineCap = 'round';
    if (!done) {
      tctx.globalCompositeOperation = 'lighter';
      path(); tctx.strokeStyle = 'rgba(255,255,255,0.16)'; tctx.lineWidth = 14; tctx.stroke();
      tctx.globalCompositeOperation = 'source-over';
    }
    path(); tctx.strokeStyle = colAcc; tctx.lineWidth = 3; tctx.stroke();
    if (!done) {
      const from = Math.max(0, end - 24);
      tctx.beginPath(); tctx.moveTo(route[from].x, route[from].y);
      for (let k = from + 1; k <= end; k++) tctx.lineTo(route[k].x, route[k].y);
      tctx.strokeStyle = '#fff'; tctx.lineWidth = 1.6; tctx.shadowColor = colAcc; tctx.shadowBlur = 12; tctx.stroke(); tctx.shadowBlur = 0;
      const h = route[end];
      tctx.fillStyle = '#fff'; tctx.beginPath(); tctx.arc(h.x, h.y, 3.2, 0, Math.PI * 2); tctx.fill();
    }
  }
  const idxAt = (t) => { let lo = 0, hi = time.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (time[m] < t) lo = m + 1; else hi = m; } return lo; };
  const light = () => { for (const n of nodes) { const on = done || n.i <= headIdx; n.el.classList.toggle('is-lit', on); n.label.classList.toggle('is-lit', on); } };
  function runLap() {
    if (reduced) { headIdx = route.length - 1; done = true; light(); drawDots(); drawTrace(); return; }
    const t0 = performance.now() + 300;
    const unsub = subscribe((now) => {
      lapT = clamp01((now - t0) / 6000);
      headIdx = idxAt(lapT);
      if (lapT >= 1) { done = true; unsub(); }
      light(); drawDots(); drawTrace();
    });
  }

  // --- reticle after the lap ---
  section.addEventListener('pointermove', (e) => {
    if (!done || matchMedia('(pointer: coarse)').matches) return;
    const r = frame.getBoundingClientRect();
    const scale = r.width / frame.offsetWidth || 1; // the stack may be scaling this layer
    const x = ((e.clientX - r.left) / scale - fit.tx) / fit.s, y = ((e.clientY - r.top) / scale - fit.ty) / fit.s;
    const i = Math.floor(x / STEP), j = Math.floor(y / STEP);
    if (ret && ret.i === i && ret.j === j) return;
    ret = { i, j };
    requestAnimationFrame(drawDots);
  });
  section.addEventListener('pointerleave', () => { ret = null; requestAnimationFrame(drawDots); });

  // --- ambient: crawling axes, ping, the globe's meridian ---
  const meridian = $('[data-meridian]', section);
  if (!reduced) loopInView(section, (t) => {
    const off = -((t / 60) % 8);
    for (const a of axes) a.setAttribute('stroke-dashoffset', off.toFixed(2));
    const v = easeOutQuad((t % 4000) / 4000);
    ping.setAttribute('r', (8 + v * 120).toFixed(1));
    ping.setAttribute('stroke-opacity', (0.6 * (1 - v) ** 2).toFixed(3));
    const turn = ((t % 10000) / 10000) * Math.PI * 2;
    meridian.setAttribute('rx', Math.max(0.5, Math.abs(Math.cos(turn)) * 18).toFixed(2));
  }, () => 16);

  new ResizeObserver(refit).observe(frame);
  refit();

  // --- copy ---
  const playHead = heading($('[data-head]', section));
  const intro = split($('.how-intro', section), { unit: 'word', gap: 0.22 });
  const plate = $('[data-splate]', section);
  const tag = $$('.splate-tag [data-letters]', plate).map((el) => split(el, { unit: 'letter' }));
  const rowsDl = $$('.splate-stats > div', plate).map((d) => [split($('dt', d), { unit: 'letter' }), split($('dd', d), { unit: 'letter' })]);
  inView(section, () => {
    playHead();
    rise($('[data-rule]', section), { delay: 260, scaleX: true });
    intro.play(260 + 90, { stagger: 34, config: C.COPY2 });
    rise(plate, { delay: 260 });
    tag[0].play(430, { stagger: 22, config: C.TYPE }); tag[1].play(490, { stagger: 22, config: C.TYPE });
    rowsDl.forEach(([dt, dd], r) => { dt.play(430 + r * 110, { stagger: 22, config: C.TYPE }); dd.play(500 + r * 110, { stagger: 12, config: C.TYPE }); });
    runLap();
  }, { rootMargin: '0% 0% -35% 0%' });
}

// ================= 3 · steps =================
function steps() {
  const section = $('[data-steps]');

  // mockup data
  const grid = $('[data-words-grid]', section);
  const pick = crypto.getRandomValues(new Uint8Array(24));
  for (const b of pick) { const li = document.createElement('li'); li.textContent = WORDS[b]; grid.append(li); }
  const cipher = $('[data-cipher]', section);
  const raw = crypto.getRandomValues(new Uint8Array(150));
  cipher.textContent = 'v1.' + btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // heading
  const playHead = heading($('[data-head]', section));
  inView($('[data-head]', section), playHead, { rootMargin: '0% 0% -15% 0%' });

  // rows: the number and copy rise in; the row nearest the middle of the screen is the live one
  const rows = $$('[data-row]', section);
  for (const row of rows) {
    const numSplit = split($('[data-num]', row), { unit: 'letter' });
    inView(row, () => {
      numSplit.play(0, { stagger: 26, config: C.YEAR });
      rise($('.st-t', row), { delay: 120, config: C.COPY });
      rise($('[data-copy]', row), { delay: 220, config: C.COPY });
      rise($('.st-plate', row), { delay: 160, y: '1.5rem' });
    }, { rootMargin: '0% 0% -20% 0%' });
  }
  const live = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('is-on', e.isIntersecting);
  }, { rootMargin: '-42% 0% -42% 0%' });
  rows.forEach((r) => live.observe(r));

  // rail: a thread that fills as you read, and a square that turns as it goes
  const list = $('[data-steps-list]', section);
  const run = $('[data-rail-run]', section), mark = $('[data-rail-mark]', section);
  scrub(list, 'top center', 'bottom center', (p) => {
    run.style.transform = `scaleY(${p.toFixed(4)})`;
    mark.style.transform = `translateY(${(p * list.offsetHeight).toFixed(1)}px) rotate(${(p * 900).toFixed(1)}deg)`;
  }, { smooth: reduced ? null : C.TRIGGER });
}

// ================= 4 · connect =================
const SESSION = [
  ['dim', '// synovax connector · stdio · 4 tools · this app holds 2 of 3 folders'],
  ['cmd', '> list_folders'],
  ['out', 'About me · Work   (2 of 3 folders allowed)'],
  ['cmd', '> search_memories {"query": "diet"}'],
  ['out', '[Kx3pQ…] Vegetarian since 2019 — About me'],
  ['cmd', '> read_memory {"id": "Kx3pQ…"}'],
  ['out', 'Vegetarian since 2019. No fish either. Allergic to peanuts.'],
  ['cmd', '> suggest_memory {"title": "Prefers metric units", "folder": "Work"}'],
  ['out', 'Sealed to the owner\'s key. Waiting in their inbox.'],
  ['dim', '// 3 reads logged · sealed at the top of the hour'],
];

function connect() {
  const section = $('[data-connect]');
  const playHead = heading($('[data-head]', section));
  const copy = split($('.connect-copy', section), { unit: 'word', gap: 0.22 });
  inView(section, () => {
    playHead();
    copy.play(260, { stagger: 34, config: C.COPY2 });
    $$('[data-rise]', section).forEach((el, i) => rise(el, { delay: 400 + i * 120 }));
  }, { rootMargin: '0% 0% -25% 0%' });

  // terminal: typed once when it comes into view
  const term = $('[data-term]', section), body = $('[data-term-body]', term);
  body.setAttribute('role', 'img');
  const caret = document.createElement('span'); caret.className = 't-caret';
  // the status strip counts the reads that will be logged and sealed
  const READS = /list_folders|search_memories|read_memory/;
  const readsEl = $('[data-term-reads]', term);
  let reads = 0;
  const count = (n) => { if (readsEl) readsEl.textContent = String(n); };
  inView(term, async () => {
    rise(term, { delay: 0, y: '1.25rem' });
    if (reduced) { for (const [k, t] of SESSION) line(k).textContent = t + '\n'; count(SESSION.filter(([k, t]) => k === 'cmd' && READS.test(t)).length); return; }
    body.append(caret);
    subscribe((t) => { caret.style.opacity = Math.floor(t / 530) % 2 ? '0' : '1'; }, () => 100);
    await new Promise((r) => setTimeout(r, 500));
    for (const [kind, text] of SESSION) {
      const el = line(kind);
      if (kind === 'cmd') {
        for (let i = 1; i <= text.length; i++) { el.textContent = text.slice(0, i); await new Promise((r) => setTimeout(r, 24 + Math.random() * 30)); }
        await new Promise((r) => setTimeout(r, 260));
      } else { el.textContent = text; await new Promise((r) => setTimeout(r, 380)); }
      el.textContent += '\n';
      if (kind === 'cmd' && READS.test(text)) count(++reads);
    }
  }, { rootMargin: '0% 0% -20% 0%' });
  function line(kind) {
    const el = document.createElement('span');
    el.className = kind === 'cmd' ? 't-cmd' : kind === 'out' ? 't-out' : '';
    body.insertBefore(el, caret.isConnected ? caret : null);
    return el;
  }

  // band: clients, crawling connectors, the live pulse and bracket
  const band = $('[data-band]', section);
  const clients = $$('.client', band), dashes = $$('.dash', band), bracket = $('.live-bracket', band), pulse = $('[data-pulse]', band);
  inView(band, () => {
    clients.forEach((c, i) => rise(c, { delay: 560 + i * 90, y: '0.5rem' }));
    dashes.forEach((d, i) => {
      const s = new Spring(0, { config: C.ROW, onChange: (v) => { d.style.transform = `scaleX(${v})`; } });
      s.to(1, { delay: 560 + i * 90 });
    });
    rise(bracket, { delay: 560 + 5 * 90, y: '0rem' });
  }, { rootMargin: '0% 0% -20% 0%' });
  if (!reduced) loopInView(band, (t) => {
    const off = ((t % 5200) / 5200) * 11.45;
    dashes.forEach((d, i) => { d.style.backgroundPositionX = `${i < 2 ? off : -off}px`; });
    const v = easeOutQuad((t % 3200) / 3200);
    pulse.setAttribute('r', (5.5 + v * 5.5 * 3.4).toFixed(2));
    pulse.setAttribute('stroke-opacity', (0.5 * (1 - v) ** 2).toFixed(3));
  }, () => 16);
  const live = $('.client--live', band);
  live.addEventListener('pointerenter', () => band.classList.add('is-live-hover'));
  live.addEventListener('pointerleave', () => band.classList.remove('is-live-hover'));
}

// ================= 5 · footer =================
function footer() {
  const foot = $('[data-foot]');
  // the dial figure
  const dial = $('[data-foot-dial]', foot);
  svgEl('circle', { class: 'fd-plate', r: 470 }, dial);
  svgEl('circle', { class: 'fd-ring', r: 470 }, dial);
  svgEl('circle', { class: 'fd-ring', r: 400 }, dial);
  for (let k = 0; k < 120; k++) {
    const a = (k / 120) * Math.PI * 2, big = k % 10 === 0, r1 = big ? 410 : 420, r2 = 455;
    svgEl('line', { class: big ? 'fd-tick fd-tick--big' : 'fd-tick', x1: Math.cos(a) * r1, y1: Math.sin(a) * r1, x2: Math.cos(a) * r2, y2: Math.sin(a) * r2 }, dial);
  }
  svgEl('circle', { class: 'fd-ring', r: 360 }, dial);
  const spokes = svgEl('g', {}, dial);
  for (let k = 0; k < 3; k++) {
    const g = svgEl('g', { transform: `rotate(${k * 120})` }, spokes);
    svgEl('path', { class: 'fd-spoke', d: 'M-26 -60L-26 -250A26 26 0 0 1 26 -250L26 -60Z' }, g);
    svgEl('circle', { class: 'fd-spoke', cy: -282, r: 44 }, g);
  }
  svgEl('circle', { class: 'fd-hub', r: 92 }, dial);
  svgEl('circle', { class: 'fd-ring fd-ring--acc', r: 60 }, dial);

  const par = $('[data-foot-par]', foot);
  scrub(foot, 'top bottom', 'bottom bottom', (p) => {
    const u = foot.clientWidth / 1440;
    par.style.top = reduced ? '' : `${(1 - p) * 60 * u}px`;
    spokes.setAttribute('transform', `rotate(${(-60 + p * 60).toFixed(2)})`);
  });

  const playHead = heading($('[data-head]', foot));
  const navs = $$('[data-letters-nav]', foot).map((a) => split(a, { unit: 'letter' }));
  inView(foot, () => {
    rise($('[data-fade]', foot), { delay: 120, y: '0rem' });
    playHead();
    navs.forEach((s, i) => s.play(260 + i * 80, { stagger: 22, config: C.ROW }));
    $$('[data-rise]', foot).forEach((el, i) => rise(el, { delay: 640 + i * 80 }));
  }, { rootMargin: '0% 0% -20% 0%' });
}

export function sections() {
  for (const block of [how, steps, connect, footer]) {
    try { block(); } catch (err) { console.error(`${block.name} failed`, err); }
  }
}
