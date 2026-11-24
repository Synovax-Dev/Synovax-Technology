// Small helpers for the live parts of the information pages. Everything is put on
// the page with textContent: nothing from the server is read as HTML.
export const $ = (s, el = document) => el.querySelector(s);

export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export async function getJSON(path) {
  const t0 = performance.now();
  const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
  const ms = Math.round(performance.now() - t0);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { status: res.status });
  return { data, ms };
}

const pad = (n) => String(n).padStart(2, '0');
// times in the reader's own zone, written out so no locale guesses are needed
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const day = (ts) => { const d = new Date(ts); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
export const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const when = (ts) => `${day(ts)}, ${clock(ts)}`;
export const hourSpan = (a, b) => `${day(a)}, ${clock(a)} to ${clock(b)}`;

export function since(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

export function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export const short = (hex, n = 12) => (hex && hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex ?? '');
export const num = (n) => Number(n).toLocaleString('en-US');
