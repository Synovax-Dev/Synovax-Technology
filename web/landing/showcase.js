// Three more showpieces: a memory graph that fires like a neural net, the
// hourly Merkle seal built from real SHA-256 in your browser, and the MCP
// flow between an AI app, the connector on your machine and the server.

import { loopInView, reduced, clamp01, token, fitCanvas, split, C } from './engine.js';
import { leafHash, merkleRoot, merkleProof, verifyProof } from '/shared/merkle.js';

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
const pinProgress = (sec) => {
  const r = sec.getBoundingClientRect();
  return clamp01(-r.top / Math.max(1, r.height - innerHeight));
};
const HEX = '0123456789abcdef';
const scramble = (n) => Array.from({ length: n }, () => HEX[(Math.random() * 16) | 0]).join('');

// ======================= memory graph =======================
// Three folders drawn as rings, each memory a node on its ring. The app asks,
// wires run out to the memories that answer, and the folder it was never given
// stays hatched and locked.
const FOLDERS = [
  { name: 'about me', allowed: true, mems: [
    ['allergic to peanuts', 1], ['vegan on fridays', 1], ['lives in lisbon', 1], ['speaks portuguese', 0], ['morning person', 0], ['prefers metric units', 0]] },
  { name: 'work', allowed: true, mems: [
    ['team of six', 1], ['office near rossio', 1], ['ships on thursdays', 0], ['standup at 9:30', 0], ['writes typescript', 0], ['project atlas', 0]] },
  { name: 'personal', allowed: false, mems: [
    ['sister · maya', 0], ['therapy on tuesdays', 0], ['saving for a flat', 0], ['birthday 12 may', 0]] },
];
// links made by a shared tag across folders
const CROSS = [['lives in lisbon', 'office near rossio'], ['vegan on fridays', 'team of six'], ['morning person', 'standup at 9:30'],
  ['speaks portuguese', 'office near rossio'], ['sister · maya', 'prefers metric units'], ['birthday 12 may', 'project atlas']];
const QUERY = 'book a team dinner on friday';
const TAU = Math.PI * 2;

function graph() {
  const sec = $('[data-graph]');
  const canvas = $('[data-graph-canvas]', sec), ctx = canvas.getContext('2d');
  const qEl = $('[data-ga-q]', sec), hitsEl = $('[data-ga-hits]', sec), footEl = $('[data-ga-foot]', sec), ask = $('[data-graph-ask]', sec);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const SANS = '"Space Grotesk", system-ui, sans-serif', DISP = '"Oswald", Impact, "Arial Narrow", sans-serif';
  const font = (px, w = 500, fam = SANS) => `${w} ${px}px ${fam}`;
  const wa = (a) => `rgba(255,255,255,${a})`;
  const ga = (a) => `rgba(128,128,128,${a})`;
  const bg = token('--surface-black');

  const folders = FOLDERS.map((f) => ({ ...f, x: 0, y: 0, R: 0 }));
  const mems = [];
  folders.forEach((f, fi) => {
    const angs = f.mems.length === 6 ? [-150, -90, -30, 30, 90, 150] : [-135, -45, 45, 135];
    f.mems.forEach(([label, hit], i) => mems.push({ f, fi, i, label, hit: !!hit, a: angs[i] * Math.PI / 180,
      seed: ((mems.length + 1) * 0.618) % 1, bx: 0, by: 0, x: 0, y: 0, hover: 0, lit: 0, k: 0 }));
  });
  const byLabel = (l) => mems.find((m) => m.label === l);
  const cross = CROSS.map(([a, b]) => [byLabel(a), byLabel(b)]);
  const hits = mems.filter((m) => m.hit);
  const app = { x: 0, y: 0 };

  let W = 0, H = 0, ratio = 1, narrow = false, S = 1, cx = 0, cy = 0, grid = null;
  const build = () => {
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    ratio = fitCanvas(canvas, W, H, coarse ? 1.5 : 2);
    narrow = W < 900;
    S = narrow ? Math.min(W * 0.46, H * 0.21) : Math.min(W * 0.17, H * 0.34);
    cx = narrow ? W * 0.5 : W * 0.63; cy = H * 0.5;
    const L = narrow
      ? { app: [0, -0.95], pos: [[-0.52, -0.08], [0.52, -0.08], [0, 0.8]], R: [0.42, 0.42, 0.36] }
      : { app: [0, -0.92], pos: [[-0.92, 0.1], [0.92, 0.1], [0, 0.86]], R: [0.5, 0.5, 0.38] };
    app.x = cx + L.app[0] * S; app.y = cy + L.app[1] * S;
    folders.forEach((f, i) => { f.x = cx + L.pos[i][0] * S; f.y = cy + L.pos[i][1] * S; f.R = L.R[i] * S; });
    for (const m of mems) { m.bx = m.f.x + Math.cos(m.a) * m.f.R * 0.72; m.by = m.f.y + Math.sin(m.a) * m.f.R * 0.72; }
    // wires reach the nearest answers first
    hits.sort((p, q) => Math.hypot(p.bx - app.x, p.by - app.y) - Math.hypot(q.bx - app.x, q.by - app.y));
    hits.forEach((m, k) => { m.k = k; });
    // a faint dot grid, drawn once
    grid = document.createElement('canvas');
    grid.width = Math.round(W * ratio); grid.height = Math.round(H * ratio);
    const g = grid.getContext('2d');
    g.scale(ratio, ratio); g.fillStyle = wa(0.07);
    const step = narrow ? 22 : 28;
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) g.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
  };
  new ResizeObserver(build).observe(canvas);
  build();

  let mx = -1e4, my = -1e4;
  sec.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; });
  sec.addEventListener('pointerleave', () => { mx = my = -1e4; });

  const glow = (x, y, R, a) => {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
    gr.addColorStop(0, wa(a)); gr.addColorStop(1, wa(0));
    ctx.fillStyle = gr; ctx.fillRect(x - R, y - R, R * 2, R * 2);
  };
  // the wire from the app to a memory: a cubic that drops out of the chip and into the node
  const wire = (m) => {
    const x0 = app.x, y0 = app.y + (narrow ? 13 : 15), x1 = m.x, y1 = m.y, dy = y1 - y0;
    return (s) => {
      const u = 1 - s, c1x = x0, c1y = y0 + dy * 0.5, c2x = x1, c2y = y0 + dy * 0.3;
      return [u * u * u * x0 + 3 * u * u * s * c1x + 3 * u * s * s * c2x + s * s * s * x1,
        u * u * u * y0 + 3 * u * u * s * c1y + 3 * u * s * s * c2y + s * s * s * y1];
    };
  };
  const lock = (x, y, s, a) => {
    ctx.strokeStyle = wa(a); ctx.fillStyle = wa(a); ctx.lineWidth = Math.max(1.5, s * 0.16);
    ctx.beginPath(); ctx.arc(x, y - s * 0.2, s * 0.36, Math.PI, 0); ctx.stroke();
    ctx.fillRect(x - s * 0.55, y - s * 0.2, s * 1.1, s * 0.8);
  };

  let sp = 0, typed = -1, shownHits = -1;
  const frame = (now) => {
    if (!W) return;
    const p = pinProgress(sec);
    sp += (p - sp) * (coarse ? 0.25 : 0.3);
    const grow = smoothstep(0.0, 0.28, sp);      // rings, nodes and labels draw in
    const typeP = smoothstep(0.3, 0.46, sp);     // the question types in
    const wave = smoothstep(0.46, 0.74, sp);     // wires run out to the answers
    const answer = smoothstep(0.7, 0.86, sp);    // hits settle
    const t = reduced ? 0 : now / 1000;

    for (const m of mems) {
      m.x = m.bx + Math.sin(t * 0.7 + m.seed * 40) * 2; m.y = m.by + Math.cos(t * 0.6 + m.seed * 25) * 2;
      const near = Math.hypot(mx - m.x, my - m.y) < 36 ? 1 : 0;
      m.hover += (near - m.hover) * 0.2;
      m.bp = m.hit ? clamp01((wave * 1.7 - m.k * 0.14) / 0.6) : 0;
      m.lit = m.hit ? clamp01((m.bp - 0.85) / 0.15) : 0;
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    if (grid) { ctx.globalAlpha = grow; ctx.drawImage(grid, 0, 0, W, H); ctx.globalAlpha = 1; }
    ctx.lineCap = 'round';

    // folders: a soft disc, a ring that draws itself, compass ticks
    folders.forEach((f, fi) => {
      const g = clamp01((grow - fi * 0.12) / 0.55);
      if (g <= 0) return;
      const ease = 1 - Math.pow(1 - g, 3);
      ctx.globalAlpha = g;
      const gr = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.R * 1.2);
      gr.addColorStop(0, wa(f.allowed ? 0.05 + 0.04 * wave : 0.02)); gr.addColorStop(1, wa(0));
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(f.x, f.y, f.R * 1.2, 0, TAU); ctx.fill();
      if (!f.allowed) {
        ctx.save(); ctx.beginPath(); ctx.arc(f.x, f.y, f.R, 0, TAU); ctx.clip();
        ctx.strokeStyle = wa(0.06); ctx.lineWidth = 1; ctx.beginPath();
        for (let d = -2 * f.R; d < 2 * f.R; d += 7) { ctx.moveTo(f.x + d - f.R, f.y - f.R); ctx.lineTo(f.x + d + f.R, f.y + f.R); }
        ctx.stroke(); ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.strokeStyle = f.allowed ? wa(0.2 + 0.2 * wave) : ga(0.55);
      ctx.setLineDash(f.allowed ? [] : [3, 5]);
      ctx.beginPath(); ctx.arc(f.x, f.y, f.R, -Math.PI / 2, -Math.PI / 2 + ease * TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = wa(0.3 * g);
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2;
        ctx.beginPath(); ctx.moveTo(f.x + Math.cos(a) * (f.R + 4), f.y + Math.sin(a) * (f.R + 4)); ctx.lineTo(f.x + Math.cos(a) * (f.R + 10), f.y + Math.sin(a) * (f.R + 10)); ctx.stroke();
      }
      // a bright arc sweeps the folders the app may search
      if (f.allowed && wave > 0 && wave < 1) {
        const a0 = -Math.PI / 2 + wave * TAU * 2;
        ctx.strokeStyle = wa(0.85 * Math.sin(wave * Math.PI)); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.R, a0, a0 + 0.9); ctx.stroke(); ctx.lineWidth = 1;
      }
      // the ring between memories of one folder
      const own = mems.filter((m) => m.f === f);
      ctx.strokeStyle = f.allowed ? wa(0.13 * g * (1 - 0.5 * wave)) : ga(0.25 * g);
      ctx.setLineDash(f.allowed ? [] : [2, 4]);
      ctx.beginPath();
      own.forEach((m, i) => { const n = own[(i + 1) % own.length]; ctx.moveTo(m.x, m.y); ctx.lineTo(n.x, n.y); });
      ctx.stroke(); ctx.setLineDash([]);
    });

    // tag links across folders
    for (const [A, B] of cross) {
      const locked = !A.f.allowed || !B.f.allowed;
      const both = Math.min(A.lit, B.lit) * answer;
      const qx = (A.x + B.x) / 2 + (cx - (A.x + B.x) / 2) * 0.3, qy = (A.y + B.y) / 2 + (cy - (A.y + B.y) / 2) * 0.3;
      ctx.strokeStyle = locked ? ga(0.3 * grow) : wa((0.1 + 0.4 * both) * grow);
      ctx.lineWidth = both > 0.3 ? 1.2 : 1;
      ctx.setLineDash(locked ? [2, 5] : [1, 4]);
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(qx, qy, B.x, B.y); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.lineWidth = 1;

    // the app's reach: dashed to the folders it holds keys for, and a wall at the one it doesn't
    const reach = clamp01((grow - 0.4) / 0.45);
    if (reach > 0) {
      const y0 = app.y + (narrow ? 13 : 15);
      for (const f of folders.filter((q) => q.allowed)) {
        const a = Math.atan2(y0 - f.y, app.x - f.x);
        ctx.strokeStyle = wa(0.28 * reach * (1 - 0.6 * answer)); ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(app.x, y0); ctx.lineTo(f.x + Math.cos(a) * (f.R + 12), f.y + Math.sin(a) * (f.R + 12)); ctx.stroke();
      }
      const P = folders.find((q) => !q.allowed), wallY = P.y - P.R - 14;
      const probe = clamp01((wave - 0.02) / 0.3);
      ctx.strokeStyle = ga(0.45 * reach); ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(app.x, y0); ctx.lineTo(app.x, wallY); ctx.stroke(); ctx.setLineDash([]);
      if (probe > 0) {
        // a probe runs down, hits the wall, and the wall answers
        const py = y0 + (wallY - y0) * Math.min(1, probe * 1.15);
        glow(app.x, py, 10, 0.5 * (1 - probe));
        const hitW = clamp01((probe - 0.85) / 0.15);
        ctx.strokeStyle = wa(0.85 * hitW); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(app.x - 12, wallY); ctx.lineTo(app.x + 12, wallY); ctx.stroke(); ctx.lineWidth = 1;
        ctx.font = font(narrow ? 9 : 10, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = wa(0.75 * hitW);
        ctx.fillText('NO KEY · ACCESS DENIED', app.x + 20, wallY);
      }
    }

    // wires to the answers, then a signal running along each one
    for (const m of hits) {
      if (m.bp <= 0) continue;
      const P = wire(m);
      ctx.strokeStyle = wa(0.35 + 0.45 * answer); ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = 0; i <= 32; i++) { const [x, y] = P(m.bp * i / 32); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.lineWidth = 1;
      if (m.bp < 1) { const [x, y] = P(m.bp); glow(x, y, 14, 0.8); }
      else if (!reduced) { const [x, y] = P((t * 0.45 + m.k * 0.21) % 1); glow(x, y, 9, 0.7 * answer); }
    }

    // memories
    const placed = [];
    for (const m of mems) {
      const g = clamp01((grow * 1.4 - m.fi * 0.15 - m.i * 0.04 - 0.1) / 0.35);
      if (g <= 0) continue;
      const locked = !m.f.allowed;
      const pop = g < 1 ? 1 + Math.sin(g * Math.PI) * 0.6 : 1;
      const r = (narrow ? 3 : 4) * pop * (1 + 0.3 * m.hover + 0.3 * m.lit);
      const dim = m.hit ? 1 : 1 - 0.6 * wave;
      if (m.lit > 0.05) glow(m.x, m.y, r * 7, 0.45 * m.lit);
      ctx.globalAlpha = g * (locked ? 0.7 : dim);
      ctx.fillStyle = locked ? ga(1) : wa(m.lit > 0.5 ? 1 : 0.85);
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = locked ? ga(0.8) : wa(0.35 + 0.55 * m.lit);
      ctx.setLineDash(locked ? [2, 3] : []);
      ctx.beginPath(); ctx.arc(m.x, m.y, r + (m.lit > 0.05 ? 4 + 2 * m.lit : 3.5), 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      m.g = g; m.r = r;
    }

    // folder names in the middle of each ring
    for (const f of folders) {
      const g = clamp01((grow - 0.25) / 0.5);
      if (g <= 0) continue;
      const fs = Math.max(13, Math.min(30, f.R * 0.2));
      ctx.globalAlpha = g; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const n = f.mems.filter((q) => q[1]).length;
      const sub = !f.allowed ? 'locked for cursor' : answer > 0.5 ? `${n} matches` : wave > 0.02 ? 'searching…' : `${f.mems.length} memories`;
      if (f.allowed) {
        ctx.font = font(fs, 600, DISP); ctx.fillStyle = wa(0.95);
        ctx.fillText(f.name.toUpperCase(), f.x, f.y - fs * 0.2);
        ctx.font = font(narrow ? 8.5 : 10, 500); ctx.fillStyle = wa(0.5);
        ctx.fillText(sub.toUpperCase(), f.x, f.y + fs * 0.6);
      } else {
        lock(f.x, f.y - fs * 0.75, fs * 0.7, 0.55);
        ctx.font = font(fs * 0.85, 600, DISP); ctx.fillStyle = wa(0.55);
        ctx.fillText(f.name.toUpperCase(), f.x, f.y + fs * 0.35);
        ctx.font = font(narrow ? 8.5 : 10, 500); ctx.fillStyle = wa(0.4);
        ctx.fillText(sub.toUpperCase(), f.x, f.y + fs * 1.05);
      }
      ctx.globalAlpha = 1;
      const hw = fs * 2.6;
      placed.push([f.x - hw, f.y - fs * 1.2, f.x + hw, f.y + fs * 1.3]);
    }

    // the app that asks: a chip at the top
    {
      const g = clamp01(grow * 2.5);
      const fs = narrow ? 10.5 : 12, h = narrow ? 26 : 30;
      ctx.font = font(fs, 600); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const label = 'CURSOR · MCP APP', w = ctx.measureText(label).width + (narrow ? 30 : 36);
      const x0 = app.x - w / 2, y0 = app.y - h / 2;
      if (wave > 0) glow(app.x, app.y, w * 0.7, 0.18 * wave);
      ctx.globalAlpha = g;
      ctx.fillStyle = bg; ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = wa(0.9); ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
      const blink = typeP > 0 && typeP < 1 && !reduced ? (Math.sin(t * 12) > 0 ? 1 : 0.2) : 1;
      ctx.fillStyle = wa(blink); ctx.fillRect(x0 + 10, app.y - 3.5, 7, 7);
      ctx.fillStyle = wa(1); ctx.fillText(label, x0 + (narrow ? 22 : 26), app.y + 0.5);
      ctx.globalAlpha = 1;
      placed.push([x0 - 4, y0 - 4, x0 + w + 4, y0 + h + 4]);
    }

    // labels: answers first, then the rest where they fit
    const order = [...mems].sort((a, b) => (b.lit * 4 + b.hover * 6 + (b.hit ? 1 : 0)) - (a.lit * 4 + a.hover * 6 + (a.hit ? 1 : 0)));
    ctx.textBaseline = 'middle';
    // no label may cover a node
    for (const m of mems) if (m.g) placed.push([m.x - m.r - 5, m.y - m.r - 5, m.x + m.r + 5, m.y + m.r + 5]);
    const clash = (box) => placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    for (const m of order) {
      if (!m.g || m.g < 0.6) continue;
      const locked = !m.f.allowed;
      if (narrow && m.lit < 0.3 && m.hover < 0.5) continue;
      const big = m.lit * answer;
      const px = narrow ? 10 : 11 + big * 1.5;
      ctx.font = font(px, big > 0.5 ? 700 : 500);
      const txt = m.label.toUpperCase();
      const w = ctx.measureText(txt).width * (locked ? 0.5 : 1);
      const c = Math.cos(m.a), s = Math.sin(m.a), gap = m.r + 10;
      const side = c > 0 ? 'right' : 'left', vert = s < 0 ? 'up' : 'down';
      // try the natural side first, then above or below, then the other side
      const modes = Math.abs(c) < 0.3 ? [vert] : [side, vert, side === 'right' ? 'left' : 'right'];
      let x0, yc, box = null;
      for (const mode of modes) {
        yc = m.y;
        if (mode === 'right') x0 = m.x + gap;
        else if (mode === 'left') x0 = m.x - gap - w;
        else { x0 = m.x - w / 2; yc = m.y + (m.r + 8 + px * 0.75) * (mode === 'up' ? -1 : 1); }
        if (x0 < 12 || x0 + w > W - 12) continue;
        const b = [x0 - 3, yc - px * 0.75, x0 + w + 3, yc + px * 0.75];
        if (!clash(b)) { box = b; break; }
      }
      if (!box) continue;
      placed.push(box);
      const show = locked ? 0.5 : m.hit ? 0.7 + 0.3 * m.lit : 0.6 * (1 - 0.55 * wave);
      ctx.globalAlpha = clamp01((m.g - 0.6) / 0.4) * Math.max(show, m.hover);
      if (locked) {
        // a redacted bar: the app can see a memory is there, never what it says
        ctx.fillStyle = ga(0.55); ctx.fillRect(x0, yc - 2.5, w, 5);
      } else {
        ctx.fillStyle = wa(1); ctx.textAlign = 'left';
        ctx.fillText(txt, x0, yc);
        if (big > 0.5) { ctx.fillRect(x0, yc + px * 0.75, w * clamp01((big - 0.5) * 2), 1); }
      }
      ctx.globalAlpha = 1;
    }

    // the question panel
    const chars = Math.round(typeP * QUERY.length);
    if (chars !== typed) { qEl.textContent = QUERY.slice(0, chars); typed = chars; }
    ask.classList.toggle('is-typing', typeP > 0 && typeP < 1);
    ask.style.opacity = String(smoothstep(0.26, 0.32, sp));
    const nh = Math.min(hits.length, Math.floor(answer * (hits.length + 0.999)));
    if (nh !== shownHits) {
      hitsEl.replaceChildren(...hits.slice(0, nh).map((n) => {
        const li = document.createElement('li');
        const a = document.createElement('span'); a.textContent = n.label;
        const b = document.createElement('small'); b.textContent = n.f.name;
        li.append(a, b); return li;
      }));
      footEl.textContent = nh === hits.length ? `${nh} memories · 2 folders searched · 1 locked` : nh ? 'searching…' : ' ';
      shownHits = nh;
    }
  };
  loopInView(sec, frame, () => (coarse ? 1000 / 60 - 2 : 0));
}

// ======================= the hourly seal =======================
const LOG = [
  ['14:03', 'claude', 'search', 'about me'], ['14:11', 'cursor', 'read', 'work'], ['14:17', 'cursor', 'search', 'work'],
  ['14:26', 'claude', 'read', 'about me'], ['14:34', 'windsurf', 'list', 'folders'], ['14:41', 'cursor', 'read', 'about me'],
  ['14:48', 'vs code', 'suggest', 'inbox'], ['14:56', 'claude', 'read', 'work'],
];
const MINE = 5;

async function seal() {
  const sec = $('[data-seal]');
  const svg = $('[data-seal-tree]', sec), logEl = $('[data-seal-log]', sec), verdict = $('[data-seal-verdict]', sec);
  const timeEl = $('[data-seal-time]', sec), phaseEl = $('[data-seal-phase]', sec), clockSvg = $('[data-seal-clock]', sec);

  // the real thing: the same leaf and node hashing the server uses, run here
  const salt = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const entries = LOG.map(([tm, appName, action, target], i) => ({
    id: `r_${i}${salt().slice(0, 6)}`, ts: Date.UTC(2026, 10, 24, 14, +tm.slice(3)), vault_id: 'v_demo', app_id: appName, action, target, salt: salt(),
  }));
  const leaves = await Promise.all(entries.map(leafHash));
  const levels = [leaves];
  // the levels, worked out with the same rule as shared/merkle.js
  const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1), next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const buf = new Uint8Array(65); buf[0] = 1; buf.set(fromHex(cur[i]), 1); buf.set(fromHex(cur[i + 1]), 33);
      next.push(toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))));
    }
    levels.push(next);
  }
  const root = await merkleRoot(leaves);
  const proof = await merkleProof(leaves, MINE);
  const ok = await verifyProof(leaves[MINE], proof, root);
  if (levels.at(-1)[0] !== root) console.warn('seal demo: root mismatch');

  // ---- clock
  svgEl('circle', { class: 'clk-ring', r: 46 }, clockSvg);
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2;
    svgEl('line', { class: k % 5 ? 'clk-tick' : 'clk-tick clk-tick--big', x1: Math.sin(a) * 40, y1: -Math.cos(a) * 40, x2: Math.sin(a) * (k % 5 ? 43 : 45), y2: -Math.cos(a) * (k % 5 ? 43 : 45) }, clockSvg);
  }
  const arc = svgEl('path', { class: 'clk-arc' }, clockSvg);
  const hand = svgEl('line', { class: 'clk-hand', x1: 0, y1: 4, x2: 0, y2: -34 }, clockSvg);
  svgEl('circle', { class: 'clk-hub', r: 3 }, clockSvg);

  // ---- log lines
  const logLis = LOG.map(([tm, a, act, tg], i) => {
    const li = document.createElement('li');
    for (const [cls, txt] of [['lg-t', tm], ['lg-a', a], ['lg-x', `${act} · ${tg}`], ['lg-h', leaves[i].slice(0, 8)]]) {
      const s = document.createElement('span'); s.className = cls; s.textContent = txt; li.append(s);
    }
    if (i === MINE) li.classList.add('is-mine');
    logEl.append(li); return li;
  });

  // ---- tree geometry
  const LY = [460, 350, 240, 130], BW = [78, 98, 118, 150], BH = 30;
  const xs = [leaves.map((_, i) => 50 + i * 94)];
  for (let d = 1; d < levels.length; d++) xs.push(levels[d].map((_, i) => (xs[d - 1][i * 2] + xs[d - 1][i * 2 + 1]) / 2));
  const gLines = svgEl('g', { class: 't2-lines' }, svg), gProof = svgEl('g', { class: 't2-proof' }, svg), gNodes = svgEl('g', {}, svg);
  const lines = [], proofLines = [];
  for (let d = 1; d < levels.length; d++) {
    lines[d] = [];
    levels[d].forEach((_, i) => {
      const px = xs[d][i], py = LY[d] + BH / 2;
      for (const c of [i * 2, i * 2 + 1]) {
        const cx = xs[d - 1][c], cy = LY[d - 1] - BH / 2, mid = (py + cy) / 2;
        const dd = `M${cx} ${cy}V${mid}H${px}V${py}`;
        lines[d].push(svgEl('path', { d: dd, pathLength: 1, class: 't2-line' }, gLines));
      }
    });
  }
  // the verify path, drawn over the top
  let idx = MINE;
  for (let d = 1; d < levels.length; d++) {
    const parent = idx >> 1, px = xs[d][parent], py = LY[d] + BH / 2;
    const cx = xs[d - 1][idx], cy = LY[d - 1] - BH / 2, mid = (py + cy) / 2;
    proofLines.push(svgEl('path', { d: `M${cx} ${cy}V${mid}H${px}V${py}`, pathLength: 1, class: 't2-pline' }, gProof));
    idx = parent;
  }
  const boxes = levels.map((lv, d) => lv.map((h, i) => {
    const g = svgEl('g', { class: `t2-node t2-d${d}`, transform: `translate(${xs[d][i]} ${LY[d]})` }, gNodes);
    svgEl('rect', { x: -BW[d] / 2, y: -BH / 2, width: BW[d], height: BH }, g);
    const t = svgEl('text', { class: 't2-hex', y: 1 }, g);
    return { g, t, h, d, i };
  }));
  boxes[0][MINE].g.classList.add('is-mine');
  // the chain of published seals above the root
  const chain = svgEl('g', { class: 't2-chain' }, svg);
  const CH = [[125, '91c2…7a0e'], [126, 'd04f…13bb'], [127, '5e88…c1d9'], [128, `${root.slice(0, 4)}…${root.slice(-4)}`]];
  const chainNodes = CH.map(([n, h], i) => {
    const x = 70 + i * 176;
    const g = svgEl('g', { class: i === 3 ? 'ch-b ch-b--new' : 'ch-b', transform: `translate(${x} 22)` }, chain);
    svgEl('rect', { x: 0, y: 0, width: 150, height: 40 }, g);
    const a = svgEl('text', { class: 'ch-n', x: 10, y: 16 }, g); a.textContent = `seal #${n}`;
    const b = svgEl('text', { class: 'ch-h', x: 10, y: 31 }, g); b.textContent = i === 3 ? 'pending' : h;
    if (i < 3) svgEl('path', { class: 'ch-link', d: `M${152} 20H${174}` }, g);
    return { g, b, h };
  });
  const drop = svgEl('path', { class: 't2-drop', d: `M${xs[3][0]} ${LY[3] - BH / 2}V90H${70 + 3 * 176 + 75}V64`, pathLength: 1 }, svg);
  // the stamp that presses the root
  const stamp = svgEl('g', { class: 't2-stamp', transform: `translate(${xs[3][0] + 98} ${LY[3]})` }, svg);
  svgEl('path', { d: 'M0-22l19 11v22L0 22l-19-11v-22Z' }, stamp);
  svgEl('path', { class: 'st-tick', d: 'M-8 0.5l5.5 5.5 11-11.5' }, stamp);

  // the root box is wider and shows a longer hash
  const short = (h, d) => (d === 3 ? `${h.slice(0, 6)}…${h.slice(-6)}` : h.slice(0, 8));
  const proofSet = new Set();
  idx = MINE;
  for (let d = 0; d < levels.length - 1; d++) { proofSet.add(`${d}:${idx ^ 1}`); idx >>= 1; }

  let sp = 0, lastVerdict = '';
  const frame = () => {
    const p = pinProgress(sec);
    sp += (p - sp) * 0.3;
    const collect = smoothstep(0.02, 0.32, sp), fold = smoothstep(0.32, 0.6, sp), sealP = smoothstep(0.6, 0.72, sp), ver = smoothstep(0.74, 0.96, sp);
    // clock: an hour passes while the reads arrive
    const mins = Math.min(60, collect * 56 + fold * 4);
    const a = (mins / 60) * Math.PI * 2;
    hand.setAttribute('transform', `rotate(${(mins / 60) * 360})`);
    arc.setAttribute('d', mins <= 0 ? '' : mins >= 60 ? 'M0-36A36 36 0 1 1 0 36A36 36 0 1 1 0-36Z' : `M0 0L0-36A36 36 0 ${a > Math.PI ? 1 : 0} 1 ${Math.sin(a) * 36} ${-Math.cos(a) * 36}Z`);
    timeEl.textContent = mins >= 60 ? '15:00' : `14:${String(Math.floor(mins)).padStart(2, '0')}`;
    phaseEl.textContent = ver > 0.02 ? 'verifying your read' : sealP > 0.02 ? 'seal published' : fold > 0.02 ? 'folding into one root' : 'collecting reads';
    sec.classList.toggle('is-sealed', sealP > 0.5);
    sec.classList.toggle('is-verify', ver > 0.02);

    // leaves arrive with the log
    const nLeaves = collect * LOG.length;
    logLis.forEach((li, i) => {
      const k = clamp01(nLeaves - i);
      li.style.opacity = k.toFixed(3);
      li.style.transform = `translateY(${((1 - k) * 12).toFixed(1)}px)`;
    });
    boxes[0].forEach((b, i) => {
      const k = clamp01(nLeaves - i);
      b.g.style.opacity = k.toFixed(3);
      b.g.style.transform = `translate(${xs[0][i]}px, ${LY[0] - (1 - k) ** 2 * 40}px)`;
      b.t.textContent = k <= 0 ? '' : k < 0.85 ? scramble(8) : short(b.h, 0);
    });
    // folding: each level draws its lines, then its boxes resolve
    for (let d = 1; d < levels.length; d++) {
      const lp = clamp01((fold - (d - 1) / 3) * 3);
      const lineP = clamp01(lp / 0.55), boxP = clamp01((lp - 0.45) / 0.55);
      for (const l of lines[d]) l.style.strokeDashoffset = (1 - lineP).toFixed(3);
      boxes[d].forEach((b) => {
        b.g.style.opacity = boxP.toFixed(3);
        b.g.style.transform = `translate(${xs[d][b.i]}px, ${LY[d]}px) scale(${(0.85 + 0.15 * boxP).toFixed(3)})`;
        b.t.textContent = boxP <= 0 ? '' : boxP < 0.8 ? scramble(d === 3 ? 13 : 8) : short(b.h, d);
      });
    }
    // seal: the stamp presses, the root climbs into the chain
    const press = sealP;
    stamp.style.opacity = press > 0 ? '1' : '0';
    const sc = press < 0.4 ? 2.2 - press / 0.4 * 1.3 : 0.9 + Math.sin(clamp01((press - 0.4) / 0.6) * Math.PI) * 0.15 + clamp01((press - 0.4) / 0.6) * 0.1;
    stamp.style.transform = `translate(${xs[3][0] + 98}px, ${LY[3]}px) scale(${sc.toFixed(3)})`;
    drop.style.strokeDashoffset = (1 - smoothstep(0.35, 0.9, press)).toFixed(3);
    const landed = press > 0.85;
    chainNodes[3].g.classList.toggle('is-on', landed);
    chainNodes[3].b.textContent = landed ? chainNodes[3].h : press > 0.4 ? scramble(4) + '…' + scramble(4) : 'pending';

    // verify: your leaf, its siblings, then the path climbs to the root
    boxes.forEach((lv, d) => lv.forEach((b) => b.g.classList.toggle('is-sib', ver > 0.05 && proofSet.has(`${d}:${b.i}`))));
    proofLines.forEach((l, d) => { l.style.strokeDashoffset = (1 - clamp01((ver - 0.1 - d * 0.25) / 0.25)).toFixed(3); });
    let lit = MINE;
    for (let d = 0; d < levels.length; d++) {
      boxes[d][lit].g.classList.toggle('is-path', ver > 0.05 + d * 0.25);
      lit >>= 1;
    }
    const v = ver >= 0.95 ? (ok ? `✓ your 14:41 read is inside seal #128 · checked with sha-256 in this browser` : '✕ proof failed') : ver > 0.05 ? `checking ${proof.length} sibling hashes against seal #128…` : '';
    if (v !== lastVerdict) { verdict.textContent = v; lastVerdict = v; verdict.classList.toggle('is-ok', ver >= 0.95 && ok); }
  };
  loopInView(sec, frame);
}

// ======================= mcp flow =======================
const CALLS = [
  { app: 0, tool: 'search_memories', arg: '"dinner friday"', back: '"allergic to peanuts"', fetch: 'ciphertext × 12' },
  { app: 1, tool: 'read_memory', arg: '"project atlas"', back: '"ship v2 by march"', fetch: 'ciphertext × 1' },
  { app: 2, tool: 'list_folders', arg: '', back: '["about me", "work"]', fetch: 'sealed names × 2' },
  { app: 3, tool: 'suggest_memory', arg: '"prefers tabs"', back: '"waiting in your inbox"', fetch: 'sealed to your key', up: true },
];
const APPS = ['claude desktop', 'cursor', 'windsurf', 'vs code'];
const APP_ICONS = ['i-claude', 'i-cursor', 'i-windsurf', 'i-vscode'];

function mcp() {
  const sec = $('[data-mcp]');
  const svg = $('[data-mcp-svg]', sec), steps = $$('[data-mcp-steps] > li', sec);
  let L = null, els = null, mode = '';

  const layout = (tall) => {
    if (!tall) {
      const apps = APPS.map((_, i) => ({ x: 40, y: 50 + i * 100, w: 220, h: 64 }));
      const con = { x: 470, y: 150, w: 230, h: 170 }, srv = { x: 930, y: 130, w: 230, h: 210 };
      const box = { x: 16, y: 16, w: 740, h: 440 };
      const wires = apps.map((a) => `M${a.x + a.w} ${a.y + a.h / 2}C${a.x + a.w + 110} ${a.y + a.h / 2} ${con.x - 110} ${con.y + con.h / 2} ${con.x} ${con.y + con.h / 2}`);
      const out = `M${con.x + con.w} ${con.y + con.h / 2 - 22}H${srv.x}`, back = `M${srv.x} ${con.y + con.h / 2 + 22}H${con.x + con.w}`;
      return { vb: '0 0 1200 472', apps, con, srv, box, wires, out, back, cross: { x1: box.x + box.w, y1: box.y, x2: box.x + box.w, y2: box.y + box.h }, boxLabel: [box.x + 14, box.y + 24], srvLabel: [srv.x, srv.y - 14] };
    }
    const apps = APPS.map((_, i) => ({ x: 20 + (i % 2) * 190, y: 30 + Math.floor(i / 2) * 76, w: 170, h: 58 }));
    const con = { x: 70, y: 290, w: 260, h: 140 }, srv = { x: 50, y: 600, w: 300, h: 150 };
    const box = { x: 6, y: 6, w: 388, h: 470 };
    const wires = apps.map((a) => `M${a.x + a.w / 2} ${a.y + a.h}C${a.x + a.w / 2} ${a.y + a.h + 80} ${con.x + con.w / 2} ${con.y - 90} ${con.x + con.w / 2} ${con.y}`);
    const out = `M${con.x + 50} ${con.y + con.h}V${srv.y}`, back = `M${con.x + 110} ${srv.y}V${con.y + con.h}`;
    return { vb: '0 0 400 770', apps, con, srv, box, wires, out, back, cross: { x1: box.x, y1: box.y + box.h, x2: box.x + box.w, y2: box.y + box.h }, boxLabel: [box.x + box.w - 14, box.y + box.h - 14, 'end'], srvLabel: [srv.x, srv.y - 14], tall: true };
  };

  const build = () => {
    const tall = sec.clientWidth < 900;
    if ((tall ? 't' : 'w') === mode) return;
    mode = tall ? 't' : 'w';
    L = layout(tall);
    svg.replaceChildren();
    svg.setAttribute('viewBox', L.vb);
    const { apps, con, srv, box } = L;
    svgEl('rect', { class: 'fl-box', x: box.x, y: box.y, width: box.w, height: box.h }, svg);
    const bl = svgEl('text', { class: 'fl-cap', x: L.boxLabel[0], y: L.boxLabel[1], 'text-anchor': L.boxLabel[2] ?? 'start' }, svg); bl.textContent = 'your machine';
    svgEl('line', { class: 'fl-cross', ...L.cross }, svg);
    const cl = svgEl('text', { class: 'fl-cap fl-cap--acc', x: tall ? box.x + box.w - 14 : box.x + box.w + 12, y: tall ? box.y + box.h + 22 : box.y + box.h - 14, 'text-anchor': tall ? 'end' : 'start' }, svg);
    cl.textContent = 'only ciphertext crosses';
    const wires = L.wires.map((d) => svgEl('path', { class: 'fl-wire', d }, svg));
    const wireFlow = L.wires.map((d) => svgEl('path', { class: 'fl-wire fl-wire--flow', d }, svg));
    const out = svgEl('path', { class: 'fl-lane', d: L.out }, svg), back = svgEl('path', { class: 'fl-lane', d: L.back }, svg);
    const outFlow = svgEl('path', { class: 'fl-lane fl-lane--flow', d: L.out }, svg), backFlow = svgEl('path', { class: 'fl-lane fl-lane--flow', d: L.back }, svg);
    // apps
    const appEls = apps.map((a, i) => {
      const g = svgEl('g', { class: 'fl-app', transform: `translate(${a.x} ${a.y})` }, svg);
      svgEl('path', { d: `M0 0H${a.w}V${a.h - 10}L${a.w - 10} ${a.h}H0Z` }, g);
      // the app's mark: big on the left when wide, small beside the eyebrow when tall
      const ic = tall ? { x: 12, y: 9, s: 14 } : { x: 14, y: (a.h - 30) / 2, s: 30 };
      const tx = tall ? 14 : 58;
      svgEl('use', { class: 'fl-logo', href: `#${APP_ICONS[i]}`, x: ic.x, y: ic.y, width: ic.s, height: ic.s }, g);
      const e = svgEl('text', { class: 'fl-eye', x: tall ? 31 : tx, y: 20 }, g); e.textContent = `client 0${i + 1} · stdio`;
      const n = svgEl('text', { class: 'fl-name', x: tx, y: a.h - 16 }, g); n.textContent = APPS[i];
      svgEl('circle', { class: 'fl-led', cx: a.w - 16, cy: 16, r: 4 }, g);
      return g;
    });
    // connector
    const cg = svgEl('g', { class: 'fl-con', transform: `translate(${con.x} ${con.y})` }, svg);
    svgEl('path', { class: 'fl-con-body', d: `M0 0H${con.w}V${con.h - 14}L${con.w - 14} ${con.h}H0Z` }, cg);
    const ce = svgEl('text', { class: 'fl-eye fl-eye--acc', x: 16, y: 24 }, cg); ce.textContent = 'connector · node';
    const cn = svgEl('text', { class: 'fl-big', x: 16, y: 62 }, cg); cn.textContent = 'synovax';
    const ck = svgEl('text', { class: 'fl-eye', x: 16, y: con.h - 40 }, cg); ck.textContent = 'holds app key · decrypts here';
    const cstat = svgEl('text', { class: 'fl-stat', x: 16, y: con.h - 18 }, cg); cstat.textContent = 'idle';
    // key ring that spins while it works
    const kr = svgEl('g', { transform: `translate(${con.w - 42} 46)` }, cg);
    svgEl('circle', { class: 'fl-kring', r: 24 }, kr);
    const spin = svgEl('circle', { class: 'fl-kspin', r: 24, pathLength: 100 }, kr);
    const keyIcon = svgEl('g', { class: 'fl-key' }, kr);
    svgEl('circle', { cx: -5, cy: 0, r: 6 }, keyIcon);
    svgEl('path', { d: 'M1 0H14M10 0V5M14 0V4' }, keyIcon);
    // server with rows of noise
    const sg = svgEl('g', { class: 'fl-srv', transform: `translate(${srv.x} ${srv.y})` }, svg);
    svgEl('path', { class: 'fl-srv-body', d: `M0 0H${srv.w}V${srv.h - 14}L${srv.w - 14} ${srv.h}H0Z` }, sg);
    const se = svgEl('text', { class: 'fl-eye fl-eye--dim', x: 16, y: 24 }, sg); se.textContent = 'synovax server';
    const rows = [];
    const nRows = Math.floor((srv.h - 72) / 22);
    for (let r = 0; r < nRows; r++) { const t = svgEl('text', { class: 'fl-row', x: 16, y: 52 + r * 22 }, sg); rows.push(t); }
    const sl = svgEl('text', { class: 'fl-eye fl-eye--dim', x: 16, y: srv.h - 12 }, sg); sl.textContent = 'stores ciphertext only';
    // packets
    const packet = (cls) => {
      const g = svgEl('g', { class: `fl-pk ${cls}` }, svg);
      const r = svgEl('rect', { y: -13, height: 26, rx: 0 }, g);
      const t = svgEl('text', { x: 10, y: 4 }, g);
      return { g, r, t, set(txt) { if (t.textContent !== txt) { t.textContent = txt; r.setAttribute('width', String(t.getComputedTextLength() + 20)); } } };
    };
    const pkCall = packet('fl-pk--call'), pkOut = packet('fl-pk--out'), pkBack = packet('fl-pk--back'), pkAns = packet('fl-pk--ans');
    els = { wires, wireFlow, out, back, outFlow, backFlow, appEls, cstat, spin, keyIcon, rows, pkCall, pkOut, pkBack, pkAns, cg };
  };
  new ResizeObserver(build).observe(sec);
  build();

  const at = (path, t) => { const len = path.getTotalLength(); return path.getPointAtLength(clamp01(t) * len); };
  const reverseAt = (path, t) => at(path, 1 - t);
  // align: 0 puts the pill's left edge on the point, 0.5 centres it. Near an app card
  // the pill hangs off the wire side, so it never covers the card's name.
  const place = (pk, pt, show, align = 0.5) => {
    pk.g.style.opacity = show ? '1' : '0';
    if (!show) return;
    const w = Number(pk.r.getAttribute('width')) || 0;
    pk.g.setAttribute('transform', `translate(${(pt.x - w * align).toFixed(1)} ${pt.y.toFixed(1)})`);
  };
  const GLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const noise = (n) => Array.from({ length: n }, () => GLY[(Math.random() * 64) | 0]).join('');
  let lastRows = 0, stepOn = -1;
  const CYCLE = 5600;
  const frame = (now) => {
    if (!els) return;
    const tt = reduced ? 2600 : now;
    const ci = Math.floor(tt / CYCLE) % CALLS.length, c = CALLS[ci];
    const u = (tt % CYCLE) / CYCLE;
    // phases of one call
    const p1 = smoothstep(0.02, 0.24, u), p2 = smoothstep(0.28, 0.44, u), p3 = smoothstep(0.48, 0.62, u), p4 = smoothstep(0.66, 0.84, u);
    const wire = els.wires[c.app];
    els.appEls.forEach((g, i) => g.classList.toggle('is-on', i === c.app && u < 0.92));
    els.wireFlow.forEach((w, i) => w.classList.toggle('is-on', i === c.app && u < 0.9));
    els.pkCall.set(`${c.tool}(${c.arg})`);
    place(els.pkCall, at(wire, p1), u > 0.01 && u < 0.26, 0.5 * smoothstep(0.15, 0.7, p1));
    // out to the server: what goes out is a request for sealed blobs, or a sealed suggestion
    els.pkOut.set(c.up ? `v1.${noise(10)}` : `get · ${c.fetch.startsWith('sealed names') ? 'folders' : 'blobs'}`);
    place(els.pkOut, at(els.out, p2), u > 0.27 && u < 0.46);
    els.outFlow.classList.toggle('is-on', u > 0.26 && u < 0.46);
    // back from the server: ciphertext
    els.pkBack.set(c.up ? 'stored · inbox' : `v1.${noise(12)}`);
    place(els.pkBack, at(els.back, p3), u > 0.47 && u < 0.64);
    els.backFlow.classList.toggle('is-on', u > 0.46 && u < 0.64);
    // decrypt on the machine, then the answer returns
    const dec = smoothstep(0.62, 0.68, u);
    els.pkAns.set(dec < 1 ? noise(c.back.length) : c.back);
    place(els.pkAns, reverseAt(wire, p4), u > 0.64 && u < 0.88, 0.5 * (1 - smoothstep(0.3, 0.85, p4)));
    const working = u > 0.24 && u < 0.7;
    els.cg.classList.toggle('is-on', working);
    els.spin.style.strokeDashoffset = String((-tt / 12) % 100);
    els.cstat.textContent = u < 0.26 ? 'idle' : u < 0.46 ? (c.up ? 'sealing to your key' : `fetching ${c.fetch}`) : u < 0.64 ? 'receiving ciphertext' : u < 0.7 ? 'decrypting · aes-256-gcm' : u < 0.88 ? 'answered' : 'idle';
    // the server's rows churn now and then
    if (now - lastRows > 160) { lastRows = now; els.rows.forEach((r) => { if (!r.textContent || Math.random() < 0.25) r.textContent = `v1.${noise(18)}`; }); }
    const st = u < 0.26 ? 0 : u < 0.64 ? 1 : u < 0.7 ? 2 : u < 0.9 ? 3 : -1;
    if (st !== stepOn) { steps.forEach((s, i) => s.classList.toggle('is-on', i === st)); stepOn = st; }
  };
  loopInView(sec, frame);
}

// headings reveal like the rest of the page
function revealHead(h) {
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

export function showcase() {
  for (const block of [graph, mcp]) {
    try { block(); } catch (err) { console.error(`${block.name} failed`, err); }
  }
  seal().catch((err) => console.error('seal failed', err));
  for (const h of $$('[data-graph] [data-head], [data-seal] [data-head], [data-mcp] [data-head]')) revealHead(h);
}
