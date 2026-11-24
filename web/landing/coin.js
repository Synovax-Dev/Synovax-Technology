// The $SYNOVAX coin: a minted coin with a real rim, lettering struck into the
// face and a glint that tracks the turn. It sways, and now and then flips.
// On the landing page it sits inside an instrument dial; elsewhere it stands alone.

import { loopInView, reduced, split, C, fitCanvas } from './engine.js';

const $ = (s, r = document) => r.querySelector(s);
const TAU = Math.PI * 2;

// same shape as the #i-mark symbol in index.html (24x24 box)
const MARK = new Path2D('M21.64 1L4.2 7.77L10.6 12.33C9.72 11.6 9.72 10.34 10.75 9.98L17.59 6.89ZM2.36 23L19.8 16.23L13.4 11.67C14.28 12.4 14.28 13.66 13.25 14.02L6.41 17.11Z');
const RIM_FRONT = '$SYNOVAX · ROBINHOOD CHAIN · ENCRYPTED MEMORY · ';
const RIM_BACK = 'KEEP IT YOURS · YOUR MEMORY · YOUR KEYS · ';
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// Draws the coin on any canvas. Returns kick(), which flips it once.
export function spinCoin(canvas, { loopEl = canvas, dial = false } = {}) {
  const ctx = canvas.getContext('2d');
  const display = (px) => `700 ${px}px Oswald, Impact, sans-serif`;
  const sans = (px, w = 600) => `${w} ${px}px "Space Grotesk", system-ui, sans-serif`;

  let W = 0, H = 0, ratio = 1, R = 1;
  const build = () => {
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    ratio = fitCanvas(canvas, W, H, 2);
    R = Math.min(W, H) * (dial ? 0.28 : 0.4);
  };
  new ResizeObserver(build).observe(canvas);
  build();

  // the rim: a bevelled band with fine reeding, shared by both faces
  const rim = (light) => {
    const lg = ctx.createLinearGradient(-R * light, -R, R * light, R);
    lg.addColorStop(0, '#8a8a8a'); lg.addColorStop(0.35, '#2a2a2a'); lg.addColorStop(0.7, '#141414'); lg.addColorStop(1, '#5c5c5c');
    ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = Math.max(0.6, R * 0.006);
    for (let k = 0; k < 160; k++) {
      const a = (k / 160) * TAU;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * 0.915, Math.sin(a) * R * 0.915); ctx.lineTo(Math.cos(a) * R * 0.99, Math.sin(a) * R * 0.99); ctx.stroke();
    }
    const fg = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.05, 0, 0, R * 0.9);
    fg.addColorStop(0, '#2e2e2e'); fg.addColorStop(0.55, '#171717'); fg.addColorStop(1, '#0b0b0b');
    ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = Math.max(1, R * 0.01);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = Math.max(0.6, R * 0.005);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.64, 0, TAU); ctx.stroke();
  };
  // lettering set around the face, between the two inner rings
  const ringText = (txt) => {
    ctx.font = sans(Math.max(7, Math.round(R * 0.07)), 600);
    ctx.fillStyle = 'rgba(255,255,255,0.78)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const n = txt.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU - Math.PI / 2;
      ctx.save(); ctx.rotate(a + Math.PI / 2); ctx.fillText(txt[i], 0, -R * 0.77); ctx.restore();
    }
  };
  const front = () => {
    rim(1);
    ringText(RIM_FRONT);
    // the mark, struck: a dark offset under a bright fill
    const m = R * 0.04, o = -12 * m;
    ctx.save(); ctx.translate(o + R * 0.012, o + R * 0.016); ctx.scale(m, m);
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fill(MARK); ctx.restore();
    ctx.save(); ctx.translate(o, o); ctx.scale(m, m);
    const mg = ctx.createLinearGradient(0, 0, 24, 24);
    mg.addColorStop(0, '#ffffff'); mg.addColorStop(1, '#a8a8a8');
    ctx.fillStyle = mg; ctx.fill(MARK); ctx.restore();
  };
  const back = () => {
    rim(-1);
    ringText(RIM_BACK);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * TAU, r = R * (0.13 * k) * (1 + 0.05 * Math.sin(a * 3 + k));
        i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#f2f2f2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = display(Math.round(R * 0.3)); ctx.fillText('SNVX', 0, -R * 0.02);
    ctx.font = sans(Math.max(7, Math.round(R * 0.06)), 500); ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('ROBINHOOD CHAIN', 0, R * 0.24);
  };

  // the instrument around it: ticked rings, a crosshair and two satellites
  const drawDial = (cx, cy, t) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(cx - R * 1.45, cy); ctx.moveTo(cx + R * 1.45, cy); ctx.lineTo(W, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cy - R * 1.45); ctx.moveTo(cx, cy + R * 1.45); ctx.lineTo(cx, H); ctx.stroke();
    const r1 = R * 1.32, rot = t * 0.04;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(cx, cy, r1, 0, TAU); ctx.stroke();
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * TAU + rot, long = k % 10 === 0;
      ctx.strokeStyle = `rgba(255,255,255,${long ? 0.45 : 0.14})`;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * (r1 + (long ? 10 : 5)), cy + Math.sin(a) * (r1 + (long ? 10 : 5))); ctx.stroke();
    }
    ctx.font = sans(9, 500); ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + rot - Math.PI / 2;
      ctx.fillText(String(k * 90).padStart(3, '0'), cx + Math.cos(a) * (r1 + 22), cy + Math.sin(a) * (r1 + 22));
    }
    const r2 = R * 1.62;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.setLineDash([2, 6]);
    ctx.beginPath(); ctx.arc(cx, cy, r2, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.95, 0, TAU); ctx.stroke();
    for (const [rr, sp, ph] of [[r2, -0.22, 0.6], [R * 1.95, 0.12, 3.4]]) {
      const a = t * sp + ph, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 12);
      g.addColorStop(0, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(x - 12, y - 12, 24, 24);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill();
    }
  };

  let hoverT = 0, hover = 0, py = 0, px = 0;
  canvas.addEventListener('pointerenter', () => { hoverT = 1; flip(); });
  canvas.addEventListener('pointerleave', () => { hoverT = 0; py = px = 0; });
  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); py = (e.clientY - r.top) / r.height - 0.5; px = (e.clientX - r.left) / r.width - 0.5; });
  canvas.addEventListener('click', () => flip());

  // a flip is a full turn eased over ~1.5s; between flips the coin only sways
  let turns = 0, flipFrom = 0, flipAt = -1e9, nextFlip = 0;
  function flip() {
    if (reduced) return;
    const now = performance.now();
    if (now - flipAt < 1500) return;
    flipFrom = turns; turns += 1; flipAt = now; nextFlip = now + 7000;
  }
  let entered = false;
  new IntersectionObserver(([e]) => { if (e.isIntersecting && !entered) { entered = true; flip(); } }, { rootMargin: '0% 0% -25% 0%' }).observe(canvas);

  const frame = (now) => {
    if (!W) return;
    if (!reduced && nextFlip && now > nextFlip) flip();
    hover += (hoverT - hover) * 0.08;
    const t = reduced ? 0 : now / 1000;
    const fp = clamp((now - flipAt) / 1500);
    const spin = reduced ? 0 : (flipFrom + (turns - flipFrom) * ease(fp)) * TAU;
    const theta = (reduced ? 0.35 : Math.sin(t * 0.5) * 0.42 + px * 0.5) + spin;
    const c = Math.cos(theta), s = Math.sin(theta), aw = Math.abs(c);

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2 + (reduced ? 0 : Math.sin(t * 1.1) * R * 0.03);

    // light behind the coin
    const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 2.1);
    halo.addColorStop(0, `rgba(255,255,255,${0.1 + hover * 0.05})`); halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
    if (dial) drawDial(W / 2, H / 2, t);

    // shadow on the floor, narrower as the coin turns edge-on
    const fy = H / 2 + R * 1.22;
    ctx.save(); ctx.translate(cx, fy); ctx.scale(1, 0.14);
    const sh = ctx.createRadialGradient(0, 0, 0, 0, 0, R * (0.35 + 0.6 * aw));
    sh.addColorStop(0, 'rgba(0,0,0,0.7)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(0, 0, R * (0.35 + 0.6 * aw), 0, TAU); ctx.fill(); ctx.restore();

    // the coin
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(-0.06 + py * 0.15);
    const T = R * 0.13;
    // edge: slices from the hidden face to the visible one, darker toward the back
    const dir = c >= 0 ? 1 : -1, N = 22;
    for (let k = 0; k <= N; k++) {
      const f = k / N, off = -dir * s * T / 2 + dir * s * T * f;
      const v = Math.round(22 + 46 * f * (0.6 + 0.4 * Math.abs(s)));
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.beginPath(); ctx.ellipse(off, 0, Math.max(0.5, R * aw), R, 0, 0, TAU); ctx.fill();
    }
    const fx = dir * s * T / 2;
    ctx.save();
    ctx.translate(fx, 0); ctx.scale(Math.max(0.002, aw), 1);
    if (c >= 0) front(); else back();
    // glint: a band of light that sweeps across as the coin turns
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const gx = Math.sin(theta) * R * 1.5;
    const gl = ctx.createLinearGradient(gx - R * 0.45, -R, gx + R * 0.45, R);
    gl.addColorStop(0, 'rgba(255,255,255,0)'); gl.addColorStop(0.5, `rgba(255,255,255,${0.1 + 0.1 * aw})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl; ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
    ctx.restore();
  };
  const clamp = (x) => Math.max(0, Math.min(1, x));
  document.fonts?.ready.then(() => frame(performance.now()));
  loopInView(loopEl, frame);
  return { kick: flip };
}

export function coin() {
  const sec = $('[data-tok]');
  if (!sec) return;
  spinCoin($('[data-tok-canvas]', sec), { loopEl: sec, dial: true });

  // heading reveal, like the rest of the page
  const h = $('[data-head]', sec);
  const lines = [...h.querySelectorAll('[data-line]')].map((l) => split(l, { unit: 'word' }));
  const stop = document.createElement('span'); stop.className = 'stop stop--accent'; stop.textContent = '.'; stop.setAttribute('aria-hidden', 'true');
  lines.at(-1).units.at(-1).append(stop);
  const hio = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    hio.disconnect();
    lines.forEach((sp, i) => sp.play(i * 130, { stagger: 110, config: C.REVEAL }));
    stop.style.opacity = '1';
  }, { rootMargin: '0% 0% -30% 0%' });
  hio.observe(h);
}
