// The information pages: the menu, "on this page", copy buttons, and the live
// parts of some pages (status, seals, the immune record, verify), loaded only there.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- menu
const btn = $('[data-menu]'), menu = $('#p-menu');
if (btn && menu) {
  const set = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); set(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) set(false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { set(false); btn.focus(); } });
}

// ---------- on this page
const tocLinks = $$('.p-toc a');
if (tocLinks.length && 'IntersectionObserver' in window) {
  const byId = new Map(tocLinks.map((a) => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      tocLinks.forEach((a) => a.classList.remove('is-on'));
      byId.get(en.target.id)?.classList.add('is-on');
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  for (const id of byId.keys()) { const s = document.getElementById(id); if (s) io.observe(s); }
}

// ---------- copy buttons
for (const b of $$('.code-bar button[data-copy]')) {
  b.addEventListener('click', async () => {
    const text = b.closest('.code').querySelector('pre').innerText.replace(/\n$/, '');
    try { await navigator.clipboard.writeText(text); b.textContent = 'copied'; b.classList.add('is-ok'); }
    catch { b.textContent = 'select it'; }
    setTimeout(() => { b.textContent = 'copy'; b.classList.remove('is-ok'); }, 1600);
  });
}

// ---------- live parts
const page = document.body.dataset.page;
const LIVE = { status: './status.js', immune: './immune.js', security: './seals.js', seals: './seals.js', verify: './verify.js' };
if (LIVE[page]) import(LIVE[page]).catch((e) => console.error(e));
