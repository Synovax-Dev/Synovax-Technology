// Security section: a console that runs through the threat model one attack at a
// time, plus counters and card reveals. Every line states what the code actually does.

import { reduced, split, rise, Spring, C } from './engine.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THREATS = [
  { cmd: 'steal the database', res: 'ciphertext only · no keys inside', tag: 'encrypted' },
  { cmd: 'read it as the server owner', res: 'no titles, text, tags or searches', tag: 'blind' },
  { cmd: 'brute-force a passphrase', res: '600k pbkdf2 rounds per guess · rate-limited', tag: 'slowed' },
  { cmd: 'use a stolen app key', res: "only that app's folders · revoke kills it", tag: 'scoped' },
  { cmd: 'swap the inbox key', res: 'vouch check fails · suggestion refused', tag: 'caught' },
  { cmd: 'edit the read log', res: 'merkle root mismatch · proof fails', tag: 'caught' },
  { cmd: 'inject a script', res: "csp allows script-src 'self' only", tag: 'blocked' },
];
const KEEP = 5;

function row({ cmd, res, tag }) {
  const li = document.createElement('li');
  const c = document.createElement('span'); c.className = 'scn-cmd';
  const r = document.createElement('span'); r.className = 'scn-res'; r.textContent = res;
  const t = document.createElement('span'); t.className = 'scn-tag'; t.textContent = tag;
  li.append(c, r, t);
  return { li, c, cmd };
}

function console_(sec) {
  const log = $('[data-sec-log]', sec), held = $('[data-sec-held]', sec), box = $('[data-sec-console]', sec);
  if (reduced) {
    for (const th of THREATS.slice(-KEEP)) { const r = row(th); r.c.textContent = th.cmd; r.li.classList.add('is-done'); log.append(r.li); }
    held.textContent = String(THREATS.length);
    return;
  }
  let visible = false, wake = null;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake?.(); }, { rootMargin: '0% 0% -15% 0%' }).observe(box);
  const whenVisible = () => (visible ? null : new Promise((r) => { wake = () => { wake = null; r(); }; }));

  (async () => {
    for (;;) {
      log.replaceChildren(); held.textContent = '0';
      for (let i = 0; i < THREATS.length; i++) {
        await whenVisible();
        const r = row(THREATS[i]);
        log.append(r.li);
        const rows = $$('li', log);
        rows.forEach((li, k) => li.classList.toggle('is-old', k < rows.length - 2));
        if (rows.length > KEEP) rows[0].remove();
        r.c.classList.add('is-typing');
        for (let k = 1; k <= r.cmd.length; k++) { r.c.textContent = r.cmd.slice(0, k); await sleep(32 + Math.random() * 30); }
        await sleep(380);
        r.c.classList.remove('is-typing');
        r.li.classList.add('is-done', 'is-flash');
        held.textContent = String(i + 1);
        await sleep(160);
        r.li.classList.remove('is-flash');
        await sleep(1300);
      }
      await sleep(2600);
    }
  })();
}

// numbers count up once, the first time the section is on screen
function counters(sec) {
  for (const el of $$('[data-count]', sec)) {
    const to = Number(el.dataset.count);
    if (reduced || !to) continue;
    el.textContent = '0';
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      new Spring(0, { config: { tension: 40, friction: 18 }, onChange: (v) => { el.textContent = String(Math.round(v)); } }).to(to);
    }, { rootMargin: '0% 0% -20% 0%' });
    io.observe(el);
  }
}

function cards(sec) {
  const list = $$('[data-sec-card]', sec);
  if (reduced) return;
  for (const c of list) c.style.opacity = '0';
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const col = list.indexOf(e.target) % 3;
      rise(e.target, { delay: col * 110, config: C.ITEM, y: '1.5rem' });
    }
  }, { rootMargin: '0% 0% -12% 0%' });
  for (const c of list) io.observe(c);
}

function head(sec) {
  const h = $('[data-head]', sec);
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

export function security() {
  const sec = $('[data-sec]');
  if (!sec) return;
  head(sec);
  counters(sec);
  cards(sec);
  console_(sec);
}
