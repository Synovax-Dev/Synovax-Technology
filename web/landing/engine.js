// The landing page's motion engine: one rAF ticker, a react-spring-style
// damped spring, word/letter reveals, scroll triggers, in-view gates, the
// sticky-stack recede, the chequered seam and the contour canvas.

export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------- ticker ----------
const subs = new Set();
let raf = 0;
function loop(time) {
  for (const s of [...subs]) {
    if (!subs.has(s)) continue;
    if (time - s.last > s.rate()) { s.last = time; s.fn(time); }
  }
  raf = subs.size ? requestAnimationFrame(loop) : 0;
}
export function subscribe(fn, rate = () => 0) {
  const s = { fn, rate, last: -Infinity };
  subs.add(s);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => subs.delete(s);
}

// ---------- spring ----------
export const C = {
  REVEAL: { tension: 90, friction: 26 }, ROW: { tension: 170, friction: 24 }, ITEM: { tension: 170, friction: 24 },
  SHEET: { tension: 190, friction: 26 }, FIGURE: { tension: 200, friction: 24 }, TYPE: { tension: 210, friction: 24 },
  YEAR: { tension: 190, friction: 24 }, COPY: { tension: 110, friction: 26 }, COPY2: { tension: 150, friction: 24 },
  NAME: { tension: 190, friction: 24 }, VEIL: { tension: 70, friction: 24 }, CLEAR: { tension: 140, friction: 26 },
  LABEL: { tension: 110, friction: 26 }, WAIT: { tension: 10, friction: 30 }, READY: { tension: 170, friction: 26 },
  YEAR_SETTLE: { tension: 32, friction: 26 }, TRIGGER: { tension: 140, friction: 30 },
};

export class Spring {
  constructor(value, { config = C.REVEAL, precision = 0.001, onChange = () => {} } = {}) {
    this.value = value; this.target = value; this.velocity = 0;
    this.config = config; this.precision = precision; this.onChange = onChange;
    this.startAt = 0; this.unsub = null; this.last = 0; this.resolve = null;
  }
  set(v) { this.stop(); this.value = this.target = v; this.velocity = 0; this.onChange(v); return this; }
  to(target, { delay = 0, config } = {}) {
    if (config) this.config = config;
    this.target = target;
    this.startAt = performance.now() + delay;
    if (reduced) { this.set(target); return Promise.resolve(); }
    if (this.config.duration != null) { this.tweenFrom = this.value; }
    if (!this.unsub) {
      this.last = 0;
      this.unsub = subscribe((t) => this.step(t));
    }
    return new Promise((r) => { this.resolve = r; });
  }
  stop() { this.unsub?.(); this.unsub = null; }
  step(now) {
    if (now < this.startAt) { this.last = now; return; }
    const dt = Math.min(64, this.last ? now - this.last : 16);
    this.last = now;
    const cfg = this.config;
    if (cfg.duration != null) {
      const e = this.tweenStart ?? (this.tweenStart = now);
      const p = clamp01((now - e) / cfg.duration);
      this.value = lerp(this.tweenFrom, this.target, (cfg.easing ?? ((x) => x))(p));
      this.onChange(this.value);
      if (p >= 1) { this.tweenStart = null; this.finish(); }
      return;
    }
    let x = this.value, v = this.velocity;
    const to = this.target, steps = Math.ceil(dt);
    for (let i = 0; i < steps; i++) {
      const a = -cfg.tension * 1e-6 * (x - to) - cfg.friction * 1e-3 * v;
      v += a; x += v;
    }
    this.value = x; this.velocity = v;
    if (Math.abs(v) < this.precision / 10 && Math.abs(to - x) <= this.precision) { this.value = to; this.velocity = 0; this.onChange(to); this.finish(); return; }
    this.onChange(x);
  }
  finish() { this.stop(); const r = this.resolve; this.resolve = null; r?.(); }
}

// Animate a 0→1 "presence" on an element: opacity plus a rise.
export function rise(el, { delay = 0, config = C.REVEAL, y = '0.75rem', from = 0, scaleX = false } = {}) {
  if (!el) return Promise.resolve();
  const apply = (p) => {
    el.style.opacity = String(p);
    el.style.transform = scaleX ? `scaleX(${p})` : (p >= 1 ? '' : `translateY(calc(${y} * ${1 - p}))`);
  };
  apply(from);
  const s = new Spring(from, { config, onChange: apply });
  return s.to(1, { delay });
}

// ---------- text engine ----------
// Splits an element's text into word or letter spans, keeping a hidden plain
// copy for assistive tech. Returns { play(delay), units }.
export function split(el, { unit = 'word', gap } = {}) {
  if (el._split) return el._split;
  const text = el.textContent.trim().replace(/\s+/g, ' ');
  el.textContent = '';
  const sr = document.createElement('span'); sr.className = 'sr'; sr.textContent = text;
  const box = document.createElement('span');
  box.className = unit === 'letter' ? 'tx tx--letters' : 'tx';
  box.setAttribute('aria-hidden', 'true');
  if (gap != null) box.style.columnGap = `${gap}em`;
  const parts = unit === 'letter' ? [...text] : text.split(' ');
  const units = parts.map((p) => {
    const s = document.createElement('span');
    if (p === ' ') { s.className = 'sp'; s.innerHTML = '&nbsp;'; } else s.textContent = p;
    s.style.opacity = '0';
    box.append(s);
    return s;
  });
  el.append(sr, box);
  const y = unit === 'letter' ? 0.3 : 0.35;
  let played = false;
  const api = {
    units, box,
    play(delay = 0, { stagger = unit === 'letter' ? 26 : 110, config = C.REVEAL } = {}) {
      if (played) return Promise.resolve();
      played = true;
      return Promise.all(units.map((u, i) => {
        const apply = (p) => { u.style.opacity = String(p); u.style.transform = p >= 1 ? '' : `translateY(${(1 - p) * y}em)`; };
        apply(0);
        return new Spring(0, { config, onChange: apply }).to(1, { delay: delay + i * stagger });
      }));
    },
    show() { played = true; for (const u of units) { u.style.opacity = '1'; u.style.transform = ''; } },
  };
  el._split = api;
  return api;
}

// ---------- in-view gate ----------
export function inView(el, cb, { rootMargin = '0% 0% -20% 0%', once = true } = {}) {
  if (!el) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { cb(true); if (once) io.disconnect(); } else if (!once) cb(false);
    }
  }, { rootMargin });
  io.observe(el);
  return () => io.disconnect();
}

// Runs fn on the ticker only while el is on screen (plus ten frames after it leaves).
export function loopInView(el, fn, rate = () => 0) {
  let unsub = null, grace = 0, visible = false;
  const tick = (t) => {
    if (!visible && --grace < 0) { unsub?.(); unsub = null; return; }
    fn(t);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) { grace = 10; if (!unsub) unsub = subscribe(tick, rate); } else grace = 10;
  });
  io.observe(el);
  return () => { io.disconnect(); unsub?.(); };
}

// ---------- scroll triggers ----------
const triggers = new Set();
let scrollQueued = false;
export function poses(el) {
  const bb = el.getBoundingClientRect(), vh = innerHeight;
  return {
    top_top: bb.top, center_top: bb.top + bb.height / 2, bottom_top: bb.bottom,
    top_bottom: bb.top - vh, center_bottom: bb.top + bb.height / 2 - vh, bottom_bottom: bb.bottom - vh,
    top_center: bb.top - vh / 2, center_center: bb.top + bb.height / 2 - vh / 2, bottom_center: bb.bottom - vh / 2,
  };
}
export function progressOf(el, start, end) {
  const p = poses(el);
  const s = p[start.replace(' ', '_')], e = p[end.replace(' ', '_')];
  const length = Math.abs(s - e) || 1;
  return clamp01(1 - (s + length) / length);
}
function runTriggers() {
  scrollQueued = false;
  for (const t of triggers) t.update();
}
export function requestTriggers() {
  if (scrollQueued || smooth.animating) return; // while gliding, the scroller runs them in its own frame
  scrollQueued = true;
  requestAnimationFrame(runTriggers);
}
addEventListener('scroll', requestTriggers, { passive: true });
addEventListener('resize', requestTriggers);

// ---------- smooth scroll ----------
// Wheel input is eased toward a target (frame-rate independent damping), and
// every scroll reader runs in the same frame the page moves, so nothing lags a
// frame behind. Touch, keyboard and the scrollbar stay native.
const smooth = { animating: false, enabled: false };
export function smoothScroll({ lerp = 0.085, wheelMultiplier = 1 } = {}) {
  const coarse = matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (reduced || coarse || smooth.enabled) return;
  smooth.enabled = true;
  const root = document.documentElement;
  const max = () => Math.max(0, root.scrollHeight - innerHeight);
  let target = scrollY, current = scrollY, last = 0, unsub = null, tween = null;

  const stop = () => { unsub?.(); unsub = null; smooth.animating = false; tween = null; };
  const sync = () => { if (!smooth.animating) target = current = scrollY; };
  const step = (now) => {
    const dt = last ? Math.min(64, now - last) / 1000 : 1 / 60;
    last = now;
    if (tween) {
      const p = clamp01((now - tween.t0) / tween.dur);
      current = lerp_(tween.from, tween.to, p >= 1 ? 1 : Math.min(1, 1.001 - 2 ** (-10 * p)));
      if (p >= 1) { current = tween.to; tween.done?.(); }
    } else {
      current = lerp_(current, target, 1 - Math.exp(-lerp * 60 * dt));
      if (Math.abs(target - current) < 0.4) current = target;
    }
    scrollTo(0, current);
    runTriggers();
    if (current === target && (!tween || current === tween.to)) stop();
  };
  const start = () => {
    if (unsub) return;
    smooth.animating = true; last = 0;
    unsub = subscribe(step);
  };
  const lerp_ = (a, b, t) => a + (b - a) * t;

  addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.defaultPrevented) return;               // pinch-zoom, or someone else's
    if (root.classList.contains('is-locked')) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;       // horizontal gestures stay native
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= innerHeight;
    if (!smooth.animating) current = scrollY;
    tween = null;
    target = Math.min(max(), Math.max(0, target + dy * wheelMultiplier));
    start();
  }, { passive: false });
  addEventListener('scroll', sync, { passive: true });
  // Native input takes over: keys and the scrollbar.
  for (const ev of ['keydown', 'mousedown', 'touchstart']) addEventListener(ev, () => { if (smooth.animating) { stop(); sync(); } }, { passive: true });
  addEventListener('resize', () => { target = Math.min(target, max()); });

  // Eased jump to a position (expo out, length scales with distance).
  smooth.to = (y, done) => {
    const to = Math.min(max(), Math.max(0, y));
    const from = scrollY, dist = Math.abs(to - from);
    if (dist < 1) { done?.(); return; }
    current = from; target = to;
    tween = { from, to, t0: performance.now(), dur: Math.min(1800, 700 + dist * 0.25), done };
    start();
  };
}

// Where an element sits in the document at rest. A pinned layer of the sticky
// stack reports where it is stuck, so measure its slot in the stack instead.
function restingTop(el) {
  const layer = el.closest('[data-layer]');
  if (!layer) return el.getBoundingClientRect().top + scrollY;
  let y = layer.parentElement.getBoundingClientRect().top + scrollY;
  for (let s = layer.parentElement.firstElementChild; s && s !== layer; s = s.nextElementSibling) y += s.offsetHeight;
  return y;
}

// In-page links glide instead of jumping.
export function smoothAnchors() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const id = a.getAttribute('href').slice(1);
    const el = id ? document.getElementById(id) : null;
    if (!el) return;
    e.preventDefault();
    const y = id === 'top' ? 0 : restingTop(el);
    const land = () => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      history.replaceState(null, '', `#${id}`);
    };
    if (smooth.to && !reduced) smooth.to(y, land);
    else { scrollTo(0, y); land(); }
  });
}

// scrub(el, 'top bottom', 'bottom top', (p, raw) => ...). With smooth, p is a spring-smoothed copy.
export function scrub(el, start, end, cb, { smooth = null } = {}) {
  let spring = null;
  if (smooth) spring = new Spring(0, { config: smooth, precision: 0.0005, onChange: (v) => cb(v) });
  const t = {
    update() {
      const raw = progressOf(el, start, end);
      if (spring) { if (raw !== spring.target) spring.to(raw); } else cb(raw);
    },
  };
  triggers.add(t);
  t.update();
  return t;
}

// ---------- sticky stack recede ----------
export function stack(root) {
  const layers = [...root.querySelectorAll(':scope > [data-layer]')];
  const pinned = layers.map((layer) => ({
    inner: layer.querySelector('[data-layer-in]'),
    shade: layer.querySelector('[data-shade]'),
    next: layer.nextElementSibling,
  }));
  const phone = matchMedia('(max-width: 639px)');
  const apply = () => {
    const view = innerHeight || 1;
    const shrink = phone.matches || reduced ? 0 : 0.1;
    for (const { inner, shade, next } of pinned) {
      const p = clamp01(1 - next.getBoundingClientRect().top / view);
      inner.style.transform = p > 0 && shrink > 0 ? `scale(${1 - shrink * p})` : '';
      inner.style.willChange = p > 0 && shrink > 0 ? 'transform' : '';
      shade.style.opacity = String(0.55 * p);
      inner.style.visibility = p >= 1 ? 'hidden' : 'visible';
    }
  };
  triggers.add({ update: apply });
  apply();
}

// ---------- token colours ----------
const probe = document.createElement('span');
export function token(name) {
  if (!probe.isConnected) { probe.style.display = 'none'; document.body.append(probe); }
  probe.style.color = `var(${name})`;
  return getComputedStyle(probe).color;
}
export function rgbOf(name) {
  const m = token(name).match(/[\d.]+/g).map(Number);
  return [m[0] / 255, m[1] / 255, m[2] / 255, m[3] ?? 1];
}

// ---------- canvas sizing ----------
export function fitCanvas(canvas, w, h, maxRatio = 2) {
  const ratio = Math.min(devicePixelRatio || 1, maxRatio);
  const bw = Math.max(1, Math.round(w * ratio)), bh = Math.max(1, Math.round(h * ratio));
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  return ratio;
}

// ---------- chequered dissolve seam ----------
const cellNoise = (x, y) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
export function seam(canvas) {
  const carry = canvas.dataset.seam;
  const ctx = canvas.getContext('2d');
  let progress = 0;
  const render = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const ratio = fitCanvas(canvas, w, h);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cell = w < 640 ? 16 : 24, SOLID = 0.16, LIFT = 2, ACCENT = 0.06;
    const surface = token(carry === 'light' ? '--background' : '--surface-black'), accent = token(carry === 'light' ? '--accent-on-light' : '--accent-on-dark');
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell), lift = progress * LIFT;
    for (let y = 0; y < rows; y++) {
      const depth = y / Math.max(1, rows - 1) + lift;
      if (depth > 1) break;
      const solid = depth <= SOLID;
      const fade = clamp01(1 - (depth - SOLID) / (1 - SOLID));
      if (!solid && fade <= 0) break;
      for (let x = 0; x < cols; x++) {
        if (!solid) {
          if ((x + y) % 2 !== 0) continue;
          if (cellNoise(x, y) > fade) continue;
        }
        ctx.fillStyle = !solid && cellNoise(x + 101, y + 57) < ACCENT ? accent : surface;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  };
  scrub(canvas, 'top bottom', 'top top', (p) => { progress = p; render(); }, { smooth: C.TRIGGER });
  new ResizeObserver(render).observe(canvas);
}

// ---------- contour backdrop (marching squares) ----------
export function contours(canvas, colourToken) {
  const ctx = canvas.getContext('2d');
  const LINE_SCALE = 3.8, LINE_COUNT = 2.5, WAVE_AMOUNT = 0.37, WAVE_SPEED = 1.66, LINE_OPACITY = 0.85, CELLS = 96;
  const field = (x, y, t) => {
    let f = Math.sin(x + t * 0.6) * 0.5;
    f += Math.sin(y * 0.85 - t * 0.45) * 0.45;
    f += Math.sin((x + y) * 0.65 + t * 0.35) * 0.35;
    f += Math.sin((x - y) * 0.95 - t * 0.55) * 0.25;
    return f * 0.5 + 0.5;
  };
  const start = performance.now();
  let colour = token(colourToken);
  let values = new Float32Array(0);
  const draw = (now) => {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = fitCanvas(canvas, width, height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const t = ((now - start) / 1000) * WAVE_SPEED;
    const cols = width >= height ? CELLS : Math.max(8, Math.round((CELLS * width) / height));
    const rows = Math.max(8, Math.round((cols * height) / width));
    const stepX = width / cols, stepY = height / rows, aspect = width / height;
    const n = (cols + 1) * (rows + 1);
    if (values.length !== n) values = new Float32Array(n);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const nx = ((i / cols) * 2 - 1) * aspect * LINE_SCALE;
      const ny = ((j / rows) * 2 - 1) * LINE_SCALE;
      const qx = nx + Math.sin(ny * 0.8 + t * 0.7) * WAVE_AMOUNT;
      const qy = ny + Math.cos(nx * 0.7 - t * 0.6) * WAVE_AMOUNT;
      values[j * (cols + 1) + i] = field(qx, qy, t) * LINE_COUNT;
    }
    ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.globalAlpha = LINE_OPACITY; ctx.beginPath();
    for (let level = 0.5; level < LINE_COUNT; level += 1)
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const a = values[j * (cols + 1) + i], b = values[j * (cols + 1) + i + 1];
        const c = values[(j + 1) * (cols + 1) + i + 1], d = values[(j + 1) * (cols + 1) + i];
        const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const x0 = i * stepX, y0 = j * stepY;
        const top = [x0 + stepX * ((level - a) / (b - a)), y0];
        const right = [x0 + stepX, y0 + stepY * ((level - b) / (c - b))];
        const bottom = [x0 + stepX * ((level - d) / (c - d)), y0 + stepY];
        const left = [x0, y0 + stepY * ((level - a) / (d - a))];
        const seg = (p, q) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
        switch (idx) {
          case 1: case 14: seg(left, bottom); break;
          case 2: case 13: seg(bottom, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(top, right); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, top); break;
          case 5: seg(left, top); seg(bottom, right); break;
          case 10: seg(left, bottom); seg(top, right); break;
        }
      }
    ctx.stroke(); ctx.globalAlpha = 1;
  };
  if (reduced) { draw(start); new ResizeObserver(() => draw(start)).observe(canvas); return; }
  loopInView(canvas, draw, () => 24);
  return { recolour() { colour = token(colourToken); } };
}
