// Docs page behaviour: reading progress, chapter scroll-spy, "on this page",
// search across chapters, client tabs, copy buttons and the mobile chapter drawer.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.add('js');

const chapters = $$('.d-ch');
const sideLinks = new Map($$('.d-side a').map((a) => [a.getAttribute('href').slice(1), a]));

// ---------- chapters fade in as they arrive
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); seen.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });
for (const c of chapters) seen.observe(c);
// a chapter reached by a link should never sit invisible
const showHash = () => { const t = location.hash ? document.getElementById(location.hash.slice(1)) : null; t?.closest('.d-ch')?.classList.add('is-in'); };
addEventListener('hashchange', showHash); showHash();

// ---------- reading progress
const bar = $('[data-progress]');
const progress = () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
};

// ---------- which chapter is current
const toc = $('[data-toc]');
let current = null;
function setCurrent(id) {
  if (id === current) return;
  current = id;
  for (const [k, a] of sideLinks) a.classList.toggle('is-on', k === id);
  const ch = document.getElementById(id);
  if (!ch || !toc) return;
  const items = [[id, $('h2', ch).textContent, false], ...$$('h3[id]', ch).map((h) => [h.id, h.textContent, true])];
  toc.replaceChildren(...items.map(([hid, label, sub]) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${hid}`; a.textContent = label;
    if (sub) a.className = 'sub';
    li.append(a);
    return li;
  }));
}
function spy() {
  const line = innerHeight * 0.3;
  let id = null;
  for (const c of chapters) {
    if (c.hidden) continue;
    if (c.getBoundingClientRect().top - line <= 0) id = c.id; else break;
  }
  setCurrent(id ?? chapters.find((c) => !c.hidden)?.id);
  // keep the active sidebar link in view
  const a = sideLinks.get(current), side = $('.d-side');
  if (a && side && side.scrollHeight > side.clientHeight) {
    const r = a.getBoundingClientRect(), s = side.getBoundingClientRect();
    if (r.top < s.top + 40 || r.bottom > s.bottom - 40) side.scrollTop += r.top - s.top - s.height / 2;
  }
}
let ticking = false;
addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; progress(); spy(); });
}, { passive: true });
addEventListener('resize', () => { progress(); spy(); });
progress(); spy();

// ---------- search: every word must appear somewhere in the chapter
const search = $('[data-search]'), empty = $('[data-empty]');
const textOf = new Map(chapters.map((c) => [c, c.textContent.toLowerCase().replace(/\s+/g, ' ')]));
function filter() {
  const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const c of chapters) {
    const hit = words.every((w) => textOf.get(c).includes(w));
    c.hidden = !hit;
    if (hit) { shown++; if (words.length) c.classList.add('is-in'); }
    const a = sideLinks.get(c.id);
    if (a) a.parentElement.hidden = !hit;
  }
  for (const lv of $$('.d-lv')) lv.hidden = !$$('li', lv).some((li) => !li.hidden);
  empty.hidden = shown > 0;
  current = null; spy(); progress();
}
search.addEventListener('input', () => {
  filter();
  if (search.value.trim()) $('#content').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { search.value = ''; filter(); search.blur(); }
  if (e.key === 'Enter') { const first = chapters.find((c) => !c.hidden); if (first) location.hash = first.id; }
});
addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== search && !/input|textarea/i.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); search.focus(); }
});

// ---------- tabs (arrow keys move between them)
for (const box of $$('[data-tabs]')) {
  const tabs = $$('[role=tab]', box);
  const pick = (t, focus) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) t.focus();
  };
  for (const t of tabs) {
    t.addEventListener('click', () => pick(t));
    t.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(t);
      if (e.key === 'ArrowRight') pick(tabs[(i + 1) % tabs.length], true);
      if (e.key === 'ArrowLeft') pick(tabs[(i - 1 + tabs.length) % tabs.length], true);
    });
  }
}

// ---------- copy buttons
for (const b of $$('[data-copy]')) {
  b.addEventListener('click', async () => {
    const code = b.closest('.code').querySelector('code').textContent;
    try { await navigator.clipboard.writeText(code); b.textContent = 'copied'; }
    catch {
      const r = document.createRange(); r.selectNodeContents(b.closest('.code').querySelector('code'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      b.textContent = 'selected';
    }
    b.classList.add('is-ok');
    setTimeout(() => { b.textContent = 'copy'; b.classList.remove('is-ok'); }, 1500);
  });
}

// ---------- chapter drawer on small screens
const side = $('[data-side]'), burger = $('[data-menu]');
const setOpen = (open) => {
  side.classList.toggle('is-open', open);
  burger.setAttribute('aria-expanded', String(open));
};
burger.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!side.classList.contains('is-open')); });
side.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
document.addEventListener('click', (e) => { if (side.classList.contains('is-open') && !side.contains(e.target)) setOpen(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && side.classList.contains('is-open')) { setOpen(false); burger.focus(); } });
