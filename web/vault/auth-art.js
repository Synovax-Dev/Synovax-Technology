// The sign-in panel's picture: a wall of ciphertext, and a lens (your key) that
// drifts across it. Only under the lens does the text read as memories.
// One canvas, reused across re-renders; it sleeps when off screen or detached.

const PLAIN = [
  'prefers metric units', 'ships on thursdays', 'vegan on fridays', 'lives in lisbon',
  'typescript strict mode', 'allergic to peanuts', 'speaks portuguese', 'team of six',
  'standup at 9:30', 'project atlas v2', 'office near rossio', 'answers short and direct',
];
const CIPHER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let art = null;

export function authArt() {
  if (art) { art.wake(); return art.el; }
  const el = document.createElement('div');
  el.className = 'aa';
  el.setAttribute('aria-hidden', 'true');
  const cv = document.createElement('canvas');
  el.append(cv);
  const ctx = cv.getContext('2d');

  let W = 0, H = 0, dpr = 1, cols = 0, rows = 0, cell = 15, cipher = [], plain = [];
  let raf = 0, last = 0, t0 = performance.now(), pointer = null, lens = { x: 0, y: 0 };

  const build = () => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cell = W < 520 ? 13 : 15;
    cols = Math.ceil(W / (cell * 0.62)); rows = Math.ceil(H / (cell * 1.35));
    cipher = Array.from({ length: cols * rows }, () => CIPHER[(Math.random() * CIPHER.length) | 0]);
    // the plaintext tiles across the whole wall, one phrase after another
    const stream = [];
    for (let i = 0; stream.length < cols * rows; i++) stream.push(...`${PLAIN[i % PLAIN.length]} · `);
    plain = stream.slice(0, cols * rows);
    lens.x = W * 0.55; lens.y = H * 0.42;
    return true;
  };

  const draw = (now) => {
    const t = (now - t0) / 1000;
    const R = Math.min(W, H) * (W < 520 ? 0.34 : 0.22);
    // drift on a slow figure-eight, or follow the pointer when it is over the panel
    const tx = pointer ? pointer.x : W * (0.5 + 0.26 * Math.sin(t * 0.21));
    const ty = pointer ? pointer.y : H * (0.42 + 0.2 * Math.sin(t * 0.34 + 1));
    lens.x += (tx - lens.x) * (pointer ? 0.12 : 0.06); lens.y += (ty - lens.y) * (pointer ? 0.12 : 0.06);
    // a few cipher cells reshuffle every frame, so the wall feels alive
    for (let k = 0; k < 18; k++) cipher[(Math.random() * cipher.length) | 0] = CIPHER[(Math.random() * CIPHER.length) | 0];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `500 ${cell * 0.86}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
    ctx.textBaseline = 'middle';
    const cw = cell * 0.62, ch = cell * 1.35;
    for (let r = 0; r < rows; r++) {
      const y = r * ch + ch / 2;
      for (let c = 0; c < cols; c++) {
        const x = c * cw;
        const d = Math.hypot(x + cw / 2 - lens.x, y - lens.y);
        const i = r * cols + c;
        if (d < R) {
          const edge = Math.min(1, (R - d) / (R * 0.18));
          ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * edge})`;
          ctx.fillText(plain[i], x, y);
        } else {
          const fade = Math.max(0, 1 - (d - R) / (R * 2.2));
          ctx.fillStyle = `rgba(255,255,255,${0.07 + 0.1 * fade})`;
          ctx.fillText(cipher[i], x, y);
        }
      }
    }
    // the lens itself
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(lens.x, lens.y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([2, 6]);
    ctx.beginPath(); ctx.arc(lens.x, lens.y, R + 10, t * 0.4, t * 0.4 + Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // tick marks around the rim
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + t * 0.15;
      ctx.beginPath(); ctx.moveTo(lens.x + Math.cos(a) * (R - 6), lens.y + Math.sin(a) * (R - 6)); ctx.lineTo(lens.x + Math.cos(a) * (R + 6), lens.y + Math.sin(a) * (R + 6)); ctx.stroke();
    }
    ctx.font = `600 10px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('YOUR KEY', lens.x + R * 0.72 + 8, lens.y - R * 0.72 - 6);
  };

  const loop = (now) => {
    raf = 0;
    if (!el.isConnected) return;
    if (now - last > 33) { last = now; draw(now); }
    if (!reduced && visible) raf = requestAnimationFrame(loop);
  };
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); }).observe(el);
  new ResizeObserver(() => { if (build()) draw(performance.now()); }).observe(el);
  el.addEventListener('pointermove', (e) => { const r = el.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  el.addEventListener('pointerleave', () => { pointer = null; });

  function wake() {
    if (!W && !build()) { requestAnimationFrame(wake); return; }
    if (!raf) raf = requestAnimationFrame(loop);
  }
  art = { el, wake };
  requestAnimationFrame(wake);
  return el;
}
