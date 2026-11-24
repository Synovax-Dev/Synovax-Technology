// The showpieces: a particle field that morphs with scroll, a giant-type band
// that runs at your scroll speed, and a note that encrypts as you watch.

import { subscribe, loopInView, reduced, clamp01, token, fitCanvas, split, C } from './engine.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.append(el);
  return el;
};
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Progress through a pinned section: 0 when its top meets the viewport top,
// 1 when its bottom meets the viewport bottom.
const pinProgress = (sec) => {
  const r = sec.getBoundingClientRect();
  return clamp01(-r.top / Math.max(1, r.height - innerHeight));
};

const LOCK_PATH = 'M43 0C26.4 0 13 13.4 13 30v14H8a8 8 0 0 0-8 8v42a8 8 0 0 0 8 8h70a8 8 0 0 0 8-8V52a8 8 0 0 0-8-8h-5V30C73 13.4 59.6 0 43 0Zm0 12c9.9 0 18 8.1 18 18v14H25V30c0-9.9 8.1-18 18-18Zm0 46a9 9 0 0 0-4 17.1V86h8V75.1A9 9 0 0 0 43 58Z';

// ======================= particle morph =======================
function morph() {
  const sec = $('[data-morph]');
  const canvas = $('[data-morph-canvas]', sec), ctx = canvas.getContext('2d');
  const caps = $$('[data-morph-caps] > li', sec), bar = $('[data-morph-bar]', sec);
  const stepEl = $('[data-morph-step]', sec), countEl = $('[data-morph-count]', sec);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const N = innerWidth < 768 || coarse ? 1800 : 4200;
  countEl.textContent = N.toLocaleString('en-US');

  const seed = new Float32Array(N), cyan = new Uint8Array(N), size = new Float32Array(N);
  for (let i = 0; i < N; i++) { seed[i] = Math.random(); cyan[i] = Math.random() < 0.07 ? 1 : 0; size[i] = 0.7 + Math.random() * 0.9; }
  // the four shapes: x,y pairs relative to the canvas centre (sphere kept in 3D)
  let noise = new Float32Array(N * 2), sphere = new Float32Array(N * 3), lock = new Float32Array(N * 2), word = new Float32Array(N * 2);
  const cur = new Float32Array(N * 2);
  let W = 0, H = 0, R = 1, ratio = 1, ready = false;

  // Sample N points from whatever `draw` paints on an offscreen canvas.
  const sampleShape = (out, w, h, draw, ox, oy) => {
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const o = off.getContext('2d'); draw(o);
    const data = o.getImageData(0, 0, w, h).data, pts = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (data[(y * w + x) * 4 + 3] > 128) pts.push(x, y);
    const n = pts.length / 2 || 1;
    for (let i = 0; i < N; i++) {
      const k = (Math.random() * n) | 0;
      out[i * 2] = pts[k * 2] - w / 2 + ox + (Math.random() - 0.5) * 2;
      out[i * 2 + 1] = pts[k * 2 + 1] - h / 2 + oy + (Math.random() - 0.5) * 2;
    }
  };

  const build = () => {
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    ratio = fitCanvas(canvas, W, H, coarse ? 1 : 1.5);
    const narrow = W < 900;
    R = Math.min(W, H) * (narrow ? 0.3 : 0.3);
    const cx = narrow ? 0 : W * 0.14; // shapes sit right of the captions on wide screens
    const cy = narrow ? -H * 0.12 : 0;
    for (let i = 0; i < N; i++) { noise[i * 2] = (Math.random() - 0.5) * W * 1.1; noise[i * 2 + 1] = (Math.random() - 0.5) * H * 1.1; }
    // Fibonacci sphere
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = golden * i;
      sphere[i * 3] = Math.cos(th) * r; sphere[i * 3 + 1] = y; sphere[i * 3 + 2] = Math.sin(th) * r;
    }
    sphere.cx = cx; sphere.cy = cy;
    // padlock, from the same path as the loading veil
    const lh = Math.round(R * 2.1), lw = Math.round(lh * 86 / 102);
    sampleShape(lock, lw + 4, lh + 4, (o) => {
      o.translate(2, 2); o.scale(lw / 86, lh / 102); o.fill(new Path2D(LOCK_PATH), 'evenodd');
    }, cx, cy);
    // the wordmark
    const fs = Math.round(Math.min(W * (narrow ? 0.2 : 0.115), H * 0.3));
    const ww = Math.round(fs * 4.6), wh = Math.round(fs * 1.2);
    sampleShape(word, ww, wh, (o) => {
      o.font = `700 ${fs}px Oswald, Impact, sans-serif`; o.textAlign = 'center'; o.textBaseline = 'middle';
      o.fillText('SYNOVAX', ww / 2, wh / 2 + fs * 0.04);
    }, narrow ? cx : W * 0.2, cy);
    if (!ready) for (let i = 0; i < N * 2; i++) cur[i] = noise[i];
    ready = true;
  };

  let mx = -1e4, my = -1e4;
  sec.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left - W / 2; my = e.clientY - r.top - H / 2; });
  sec.addEventListener('pointerleave', () => { mx = my = -1e4; });

  const bg = token('--surface-black'), acc = token('--accent');
  let sp = 0, lastStep = -1;
  const frame = (now) => {
    if (!ready) return;
    const t = reduced ? 0 : now / 1000;
    const p = pinProgress(sec);
    sp += (p - sp) * (coarse ? 0.2 : 0.35);
    const f = sp * 3, seg = Math.min(2, Math.floor(f)), local = f - seg;
    const e = easeInOut(smoothstep(0.18, 0.82, local));
    const shapes = [noise, sphere, lock, word];
    const A = shapes[seg], B = shapes[seg + 1];
    // sphere rotation, eased into place as the next shape takes over
    const rotY = t * 0.35, tilt = 0.35;
    const cY = Math.cos(rotY), sY = Math.sin(rotY), cX = Math.cos(tilt), sX = Math.sin(tilt);
    const sphereAt = (i, out) => {
      const x = sphere[i * 3], y = sphere[i * 3 + 1], z = sphere[i * 3 + 2];
      const x1 = x * cY + z * sY, z1 = -x * sY + z * cY;
      const y2 = y * cX - z1 * sX, z2 = y * sX + z1 * cX;
      const k = 1 / (1 + z2 * 0.35);
      out[0] = x1 * R * k + sphere.cx; out[1] = y2 * R * k + sphere.cy; out[2] = z2;
      return out;
    };
    const tmp = [0, 0, 0], tmp2 = [0, 0, 0];

    // trails: a translucent wash instead of a clear
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = reduced ? 1 : 0.32;
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(W / 2, H / 2);
    const swirl = Math.sin(Math.PI * e);
    for (let i = 0; i < N; i++) {
      let ax, ay, bx, by, depthA = 0, depthB = 0;
      if (A === sphere) { sphereAt(i, tmp); ax = tmp[0]; ay = tmp[1]; depthA = tmp[2]; } else { ax = A[i * 2]; ay = A[i * 2 + 1]; }
      if (B === sphere) { sphereAt(i, tmp2); bx = tmp2[0]; by = tmp2[1]; depthB = tmp2[2]; } else { bx = B[i * 2]; by = B[i * 2 + 1]; }
      if (A === noise) { ax += Math.sin(t * 0.4 + seed[i] * 40) * 18; ay += Math.cos(t * 0.33 + seed[i] * 30) * 18; }
      let x = ax + (bx - ax) * e, y = ay + (by - ay) * e;
      // a curl through the middle of every transition
      const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1;
      const amp = swirl * (40 + seed[i] * 140) * (seed[i] > 0.5 ? 1 : -1);
      x += (-dy / d) * amp; y += (dx / d) * amp;
      // breathing
      x += Math.sin(t * 1.3 + seed[i] * 20) * 0.9; y += Math.cos(t * 1.1 + seed[i] * 17) * 0.9;
      // cursor lens
      const px = x - mx, py = y - my, pd = Math.hypot(px, py);
      if (pd < 120) { const k = (1 - pd / 120) ** 2 * 42; x += (px / (pd || 1)) * k; y += (py / (pd || 1)) * k; }
      // ease each particle toward its target so nothing ever pops
      cur[i * 2] += (x - cur[i * 2]) * 0.5; cur[i * 2 + 1] += (y - cur[i * 2 + 1]) * 0.5;
      const depth = depthA * (1 - e) + depthB * e;
      const a = (A === sphere || B === sphere) ? 0.35 + 0.65 * (1 - (depth + 1) / 2) : 0.85;
      ctx.globalAlpha = a * (A === noise ? 0.55 + 0.45 * e : 1);
      ctx.fillStyle = cyan[i] ? acc : '#efefef';
      const s = size[i] * (cyan[i] ? 2 : 1.4);
      ctx.fillRect(cur[i * 2] - s / 2, cur[i * 2 + 1] - s / 2, s, s);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

    // captions, bar, counter
    for (let i = 0; i < caps.length; i++) {
      const d = f - i;
      const o = clamp01(1 - Math.abs(d) * 2.4);
      caps[i].style.opacity = o.toFixed(3);
      caps[i].style.transform = `translateY(${(-d * 48).toFixed(1)}px)`;
      caps[i].style.visibility = o > 0.001 ? 'visible' : 'hidden';
    }
    bar.style.transform = `scaleX(${sp.toFixed(4)})`;
    const step = Math.min(3, Math.round(f));
    if (step !== lastStep) { stepEl.textContent = String(step + 1).padStart(2, '0'); lastStep = step; }
  };

  const ro = new ResizeObserver(() => { build(); frame(performance.now()); });
  ro.observe(canvas);
  document.fonts?.ready.then(() => { build(); });
  loopInView(sec, frame, () => (coarse ? 1000 / 60 - 2 : 0));
}

// ======================= giant type band =======================
function marquee() {
  const sec = $('[data-marquee]');
  const rows = $$('[data-mq]', sec).map((row) => {
    const track = $('.mq-track', row);
    const words = track.dataset.mqWords.split('|');
    const unit = document.createElement('div'); unit.className = 'mq-unit';
    words.forEach((w, i) => {
      const s = document.createElement('span'); s.className = i % 2 ? 'mq-word mq-word--fill' : 'mq-word'; s.textContent = w;
      const mark = svgEl('svg', { class: 'mq-mark', viewBox: '0 0 24 24' }); svgEl('use', { href: '#i-mark' }, mark);
      unit.append(s, mark);
    });
    track.append(unit, unit.cloneNode(true), unit.cloneNode(true));
    return { row, track, unit, dir: Number(row.dataset.mq), x: 0 };
  });
  let lastY = scrollY, vel = 0, skew = 0, last = 0;
  if (reduced) return;
  loopInView(sec, (now) => {
    const dt = last ? Math.min(64, now - last) : 16; last = now;
    const dy = scrollY - lastY; lastY = scrollY;
    vel += (dy / dt * 16 - vel) * 0.12;
    skew += (Math.max(-9, Math.min(9, vel * 0.25)) - skew) * 0.1;
    for (const r of rows) {
      const w = r.unit.offsetWidth || 1;
      r.x -= (0.06 + Math.abs(vel) * 0.04) * dt * r.dir * (vel < -0.5 ? -1 : 1);
      r.x = ((r.x % w) + w) % w;
      r.track.style.transform = `translate3d(${(-r.x).toFixed(2)}px,0,0) skewX(${(-skew * r.dir).toFixed(2)}deg)`;
    }
  });
}

// ======================= live encryption =======================
function encrypt() {
  const sec = $('[data-enc]');
  const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const rnd = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => GLYPHS[x & 63]).join(''); };
  const fields = $$('[data-scr]', sec).map((el) => {
    const plain = el.textContent;
    const cipher = rnd(plain.length);
    const order = [...plain].map(() => 0.08 + Math.random() * 0.72);
    el.textContent = '';
    const spans = [...plain].map((ch) => { const s = document.createElement('span'); s.textContent = ch; el.append(s); return s; });
    return { el, plain, cipher, order, spans, state: new Int8Array(plain.length).fill(-1) };
  });
  const total = fields.reduce((n, f) => n + new TextEncoder().encode(f.plain).length, 0) + 28; // + iv and tag
  const bytesEl = $('[data-enc-bytes]', sec), roundEl = $('[data-core-round]', sec);

  // the core: 14 round segments, two rings, a padlock whose shackle closes
  const core = $('[data-core]', sec);
  svgEl('circle', { class: 'core-ring', r: 122 }, core);
  svgEl('circle', { class: 'core-ring core-ring--dash', r: 104 }, core);
  const spin = svgEl('g', {}, core);
  const segs = [];
  for (let k = 0; k < 14; k++) {
    const a0 = (k / 14) * Math.PI * 2 - Math.PI / 2 + 0.03, a1 = ((k + 1) / 14) * Math.PI * 2 - Math.PI / 2 - 0.03;
    const r1 = 86, r2 = 98;
    const d = `M${Math.cos(a0) * r2} ${Math.sin(a0) * r2}A${r2} ${r2} 0 0 1 ${Math.cos(a1) * r2} ${Math.sin(a1) * r2}L${Math.cos(a1) * r1} ${Math.sin(a1) * r1}A${r1} ${r1} 0 0 0 ${Math.cos(a0) * r1} ${Math.sin(a0) * r1}Z`;
    segs.push(svgEl('path', { class: 'core-seg', d }, spin));
  }
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    svgEl('line', { class: 'core-tick', x1: Math.cos(a) * 110, y1: Math.sin(a) * 110, x2: Math.cos(a) * (k % 4 ? 114 : 118), y2: Math.sin(a) * (k % 4 ? 114 : 118) }, core);
  }
  const shackle = svgEl('path', { class: 'core-shackle', d: 'M-20 0V-22a20 20 0 0 1 40 0V0' }, core);
  svgEl('rect', { class: 'core-body', x: -32, y: -4, width: 64, height: 50, rx: 4 }, core);
  const hole = svgEl('path', { class: 'core-hole', d: 'M0 10a6 6 0 0 0-3 11.2V30h6v-8.8A6 6 0 0 0 0 10Z' }, core);

  // a faint dotted grid that ripples out from the core while it works
  const grid = $('[data-enc-grid]', sec), g = grid.getContext('2d');
  const ink = token('--foreground'), acc = token('--accent-on-light');

  let sp = 0, last = -1;
  const frame = (now) => {
    const p = pinProgress(sec);
    sp += (p - sp) * 0.3;
    const q = smoothstep(0.05, 0.92, sp);
    // characters: plain → flicker → cipher, each at its own moment
    let shown = 0;
    for (const f of fields) {
      for (let i = 0; i < f.spans.length; i++) {
        const th = f.order[i];
        const st = q < th ? 0 : q < th + 0.07 ? 1 : 2;
        if (st === 1) { f.spans[i].textContent = GLYPHS[(Math.random() * 64) | 0]; f.spans[i].className = 'is-flip'; }
        else if (st !== f.state[i]) { f.spans[i].textContent = st === 0 ? f.plain[i] : f.cipher[i]; f.spans[i].className = st === 2 ? 'is-enc' : ''; }
        f.state[i] = st;
        if (st === 2) shown++;
      }
    }
    const chars = fields.reduce((n, f) => n + f.plain.length, 0);
    bytesEl.textContent = String(Math.round((shown / chars) * total));
    const rounds = Math.min(14, Math.floor(q * 14.999));
    if (rounds !== last) { roundEl.textContent = String(rounds).padStart(2, '0'); segs.forEach((s, k) => s.classList.toggle('is-on', k < rounds)); last = rounds; }
    spin.setAttribute('transform', `rotate(${(q * 360 + (reduced ? 0 : now / 80)).toFixed(1)})`);
    const close = smoothstep(0.35, 0.65, q);
    shackle.setAttribute('transform', `translate(0 ${(-14 * (1 - close)).toFixed(2)})`);
    hole.classList.toggle('is-locked', close > 0.98);
    sec.classList.toggle('is-sealed', q > 0.98);

    // ripple grid
    const w = grid.clientWidth, h = grid.clientHeight;
    if (!w) return;
    const r = fitCanvas(grid, w, h, 1.5);
    g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
    const coreBox = core.getBoundingClientRect(), gridBox = grid.getBoundingClientRect();
    const ccx = coreBox.left + coreBox.width / 2 - gridBox.left, ccy = coreBox.top + coreBox.height / 2 - gridBox.top;
    const step = 26, wave = reduced ? -1 : ((now / 1000) * 260) % Math.hypot(w, h);
    for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
      const d = Math.hypot(x - ccx, y - ccy);
      const ring = wave < 0 ? 0 : Math.exp(-(((d - wave) / 40) ** 2)) * (0.3 + 0.7 * q) * (q > 0.02 && q < 0.995 ? 1 : 0);
      g.globalAlpha = 0.1 + ring * 0.75;
      g.fillStyle = ring > 0.2 ? acc : ink;
      const s = 1.5 + ring * 2.5;
      g.fillRect(x - s / 2, y - s / 2, s, s);
    }
    g.globalAlpha = 1;
  };
  loopInView(sec, frame);
}

export function effects() {
  for (const block of [morph, marquee, encrypt]) {
    try { block(); } catch (err) { console.error(`${block.name} failed`, err); }
  }
  // the encrypt heading reveals like the others
  const h = $('[data-enc] [data-head]');
  if (h) {
    const lines = $$('[data-line]', h).map((l) => split(l, { unit: 'word' }));
    const stop = document.createElement('span'); stop.className = 'stop stop--accent'; stop.textContent = '.'; stop.setAttribute('aria-hidden', 'true');
    lines.at(-1).units.at(-1).append(stop);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      lines.forEach((s, i) => s.play(i * 130, { stagger: 110, config: C.REVEAL }));
      stop.style.opacity = '1';
    }, { rootMargin: '0% 0% -30% 0%' });
    io.observe(h);
  }
}
