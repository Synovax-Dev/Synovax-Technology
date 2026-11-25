// Builds the information pages (web/<slug>/index.html) from site/pages/<slug>.html.
// Each source starts with a comment of `key: value` lines, then the page's sections.
// The shell (header, menu, hero, table of contents, footer) is the same for all of
// them and lives here. Run `npm run pages` after editing; `--check` fails when a
// built page is out of date (the browser test runs it).
//
//   title        the page name, in the tab and the menu
//   description  one sentence for search engines and link cards
//   section      the small label next to the logo
//   eyebrow      the line above the headline
//   h1           the headline, lines split by |
//   lead         one or two sentences under the headline
//   next         up to three slugs for "Read next"
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'site', 'pages');
const REPO = 'https://github.com/Synovax-Dev/Synovax-Technology';

// every page of the site, for the menu, the footer and "Read next"
export const PAGES = {
  product: { title: 'Vault', group: 'Product', blurb: 'Memories, folders, apps and the read log' },
  inbox: { title: 'Inbox', group: 'Product', blurb: 'Memories your apps suggest, kept only if you approve' },
  import: { title: 'Import', group: 'Product', blurb: 'Bring what ChatGPT and Claude remember about you' },
  apps: { title: 'Apps', group: 'Product', blurb: 'Step-by-step setup for every AI app' },
  sharing: { title: 'Sharing', group: 'Product', blurb: 'One folder, read by another vault you trust' },
  legacy: { title: 'Legacy', group: 'Product', blurb: 'Who receives your vault, and only when' },
  devices: { title: 'Phone and devices', group: 'Product', blurb: 'Open and install it anywhere, sign out any device' },
  seals: { title: 'Seals', group: 'Product', blurb: 'The hourly seals of every read, and how to check them' },
  'how-it-works': { title: 'How it works', group: 'Trust', blurb: 'From your first memory to deleting it all' },
  security: { title: 'Security', group: 'Trust', blurb: 'Keys, encryption and where the limits are' },
  'threat-model': { title: 'Threat model', group: 'Trust', blurb: 'What SYNOVAX protects against, and what it does not' },
  immune: { title: 'Immune system', group: 'Trust', blurb: 'Hidden instructions in memories, tested every hour' },
  privacy: { title: 'Privacy', group: 'Trust', blurb: 'Exactly what is stored, and why' },
  status: { title: 'Status', group: 'Trust', blurb: 'Is the server and its seal job working right now' },
  connector: { title: 'Connector', group: 'Developers', blurb: 'The MCP server between your vault and your AI apps' },
  reference: { title: 'API reference', group: 'Developers', blurb: 'Every public, app and vault endpoint' },
  standard: { title: 'Open standard', group: 'Developers', blurb: 'The formats, keys, log and seals, with test vectors' },
  verify: { title: 'Verify', group: 'Developers', blurb: 'Check a read, a seal or the seal chain by hand' },
  'open-source': { title: 'Open source', group: 'Developers', blurb: 'Read the code, run it yourself' },
};
const GO = [['Open the vault', '/vault/'], ['Docs', '/docs/'], ['$SYNOVAX', '/#token'], ['Home', '/']];
const TOP = ['product', 'how-it-works', 'security', 'immune', 'status'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parse(src) {
  const m = /^<!--([\s\S]*?)-->\s*/.exec(src);
  if (!m) throw new Error('a page source must start with a <!-- key: value --> comment');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([a-z][a-z0-9]*):\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

const SPRITE = `<svg width="0" height="0" class="sprite" aria-hidden="true">
    <symbol id="i-mark" viewBox="0 0 24 24"><path d="M21.64 1L4.2 7.77L10.6 12.33C9.72 11.6 9.72 10.34 10.75 9.98L17.59 6.89ZM2.36 23L19.8 16.23L13.4 11.67C14.28 12.4 14.28 13.66 13.25 14.02L6.41 17.11Z" fill="currentColor"/></symbol>
    <symbol id="i-arrow" viewBox="0 0 13.7071 10.7071"><path d="M0 5.35355H13M8 10.3536L13 5.35355L8 0.353553" fill="none" stroke="currentColor"/></symbol>
    <symbol id="i-menu" viewBox="0 0 16 16"><path d="M1.5 4h13M1.5 8h13M1.5 12h13" stroke="currentColor" stroke-width="1.4"/></symbol>
    <symbol id="i-info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4.6M8 4.4v1.4" stroke="currentColor" stroke-width="1.4"/></symbol>
    <symbol id="i-warn" viewBox="0 0 16 16"><path d="M8 1.6L15 14H1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v4M8 11.4v1.4" stroke="currentColor" stroke-width="1.4"/></symbol>
    <symbol id="i-check" viewBox="0 0 16 16"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="1.6"/></symbol>
    <symbol id="i-x" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.6"/></symbol>
    <symbol id="i-github" viewBox="0 0 16 16"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.06-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></symbol>
  </svg>`;

function groups(current) {
  const by = {};
  for (const [slug, p] of Object.entries(PAGES)) (by[p.group] ??= []).push({ t: p.title, href: `/${slug}/`, on: slug === current });
  by.Developers.push({ t: 'GitHub', href: REPO, ext: true });
  by['Go to'] = GO.map(([t, href]) => ({ t, href }));
  return by;
}
const link = (l, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(l.href)}"${l.on ? ' aria-current="page"' : ''}${l.ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(l.t)}${l.ext ? ' ↗' : ''}</a>`;

function shell(slug, meta, body) {
  const toc = [...body.matchAll(/<section class="d-ch[^"]*" id="([a-z0-9-]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/g)]
    .map((m) => `<li><a href="#${m[1]}">${m[2].replace(/<[^>]+>/g, '')}</a></li>`).join('\n          ');
  const g = groups(slug);
  const next = (meta.next ?? '').split(',').map((s) => s.trim()).filter((s) => PAGES[s]).slice(0, 3);
  const h1 = meta.h1.split('|').map((l) => `<span>${l.trim()}</span>`).join('');
  const title = `${meta.title} · SYNOVAX`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(meta.description)}">
  <link rel="canonical" href="https://synovax.tech/${slug}/">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="SYNOVAX">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(meta.description)}">
  <meta property="og:image" content="https://synovax.tech/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/fonts/oswald-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/space-grotesk-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/docs/docs.css">
  <link rel="stylesheet" href="/pages/pages.css">
  <script type="module" src="/pages/pages.js"></script>
</head>
<!-- Built by scripts/build-pages.mjs from site/pages/${slug}.html. Edit that file, then run npm run pages. -->
<body data-page="${slug}">
  ${SPRITE}

  <a class="skip" href="#content">Skip to content</a>

  <header class="d-top p-top">
    <a class="d-logo" href="/" aria-label="SYNOVAX home">
      <svg aria-hidden="true"><use href="#i-mark"/></svg><span>synovax</span><em>${esc(meta.section)}</em>
    </a>
    <nav class="d-topnav p-nav" aria-label="Site">
      ${TOP.map((s) => link({ t: PAGES[s].title, href: `/${s}/`, on: s === slug })).join('\n      ')}
      <a href="/docs/">Docs</a>
    </nav>
    <a class="p-gh" href="${REPO}" target="_blank" rel="noopener noreferrer" aria-label="SYNOVAX on GitHub" title="SYNOVAX on GitHub"><svg aria-hidden="true"><use href="#i-github"/></svg></a>
    <a class="d-cta" href="/vault/">open vault <svg aria-hidden="true"><use href="#i-arrow"/></svg></a>
    <button class="d-burger p-burger" type="button" aria-expanded="false" aria-controls="p-menu" data-menu><svg aria-hidden="true"><use href="#i-menu"/></svg><span>menu</span></button>
  </header>
  <nav class="p-menu" id="p-menu" aria-label="All pages" hidden>
    ${Object.entries(g).map(([name, links]) => `<div><p>${name}</p>${links.map((l) => link(l)).join('')}</div>`).join('\n    ')}
  </nav>

  <section class="d-hero p-hero" aria-labelledby="p-h1">
    <div class="d-hero-in p-hero-in">
      <div>
        <p class="d-eyebrow">${esc(meta.eyebrow)}</p>
        <h1 class="d-h1" id="p-h1">${h1}</h1>
        <p class="p-lead">${meta.lead}</p>
      </div>
    </div>
    <span class="d-corner d-corner--tl" aria-hidden="true"></span>
    <span class="d-corner d-corner--br" aria-hidden="true"></span>
  </section>

  <div class="p-layout">
    <main id="content" class="p-main">
${body.split('\n').map((l) => (l ? `      ${l}` : '')).join('\n')}
${next.length ? `
      <nav class="p-next" aria-label="Read next">
        <p>Read next</p>
        <div>${next.map((s) => `<a href="/${s}/"><span>${esc(PAGES[s].group)}</span><b>${esc(PAGES[s].title)}</b><em>${esc(PAGES[s].blurb)}</em><svg aria-hidden="true"><use href="#i-arrow"/></svg></a>`).join('')}</div>
      </nav>` : ''}
    </main>
    <aside class="d-toc p-toc" aria-label="On this page">
      <p>On this page</p>
      <ol>
          ${toc}
      </ol>
    </aside>
  </div>

  <footer class="p-foot">
    <div class="p-foot-top">
      <a class="d-logo" href="/" aria-label="SYNOVAX home"><svg aria-hidden="true"><use href="#i-mark"/></svg><span>synovax</span></a>
      <p>Your AI memory, encrypted on your device.</p>
    </div>
    <div class="p-foot-cols">
      ${Object.entries(g).map(([name, links]) => `<div><p>${name}</p>${links.map((l) => link(l)).join('')}</div>`).join('\n      ')}
    </div>
    <p class="p-foot-copy">© 2026 SYNOVAX. Free and open source (MIT). Not yet independently audited. Not affiliated with Robinhood.</p>
  </footer>
</body>
</html>
`;
}

const check = process.argv.includes('--check');
let stale = 0;
for (const file of (await readdir(SRC)).filter((f) => f.endsWith('.html')).sort()) {
  const slug = file.slice(0, -5);
  if (!PAGES[slug]) throw new Error(`site/pages/${file}: add "${slug}" to PAGES`);
  const { meta, body } = parse(await readFile(path.join(SRC, file), 'utf8'));
  for (const k of ['title', 'description', 'section', 'eyebrow', 'h1', 'lead']) if (!meta[k]) throw new Error(`site/pages/${file}: missing ${k}`);
  const out = shell(slug, meta, body);
  const dest = path.join(ROOT, 'web', slug, 'index.html');
  if (check) {
    const cur = await readFile(dest, 'utf8').catch(() => '');
    if (cur !== out) { stale++; console.error(`out of date: web/${slug}/index.html (run npm run pages)`); }
  } else {
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, out);
    console.log(`built web/${slug}/index.html`);
  }
}
if (check && stale) process.exit(1);
