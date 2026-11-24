import { stack, seam, contours, reduced, requestTriggers, smoothScroll, smoothAnchors } from './engine.js';
import { hero } from './hero.js';
import { sections } from './sections.js';
import { effects } from './effects.js';
import { showcase } from './showcase.js';
import { coin } from './coin.js';
import { tokenInfo } from './tokeninfo.js';
import { security } from './security.js';

if (reduced) document.documentElement.classList.add('no-motion');

const html = document.documentElement;
html.classList.add('is-locked');

stack(document.querySelector('[data-stack]'));
for (const c of document.querySelectorAll('[data-seam]')) seam(c);
for (const c of document.querySelectorAll('[data-contours]')) contours(c, c.dataset.contours);

tokenInfo();

hero()
  .catch((err) => {
    console.error(err);
    document.querySelector('[data-veil]')?.remove();
    for (const el of document.querySelectorAll('[data-enter], [data-hero-meta], [data-hero-panels], [data-hero-actions], [data-hero-id]')) el.style.opacity = '1';
  })
  .finally(() => {
    html.classList.remove('is-locked');
    smoothScroll();
    smoothAnchors();
    try { sections(); } catch (err) { console.error(err); }
    try { effects(); } catch (err) { console.error(err); }
    try { showcase(); } catch (err) { console.error(err); }
    try { coin(); } catch (err) { console.error(err); }
    try { security(); } catch (err) { console.error(err); }
    requestTriggers();
  });
