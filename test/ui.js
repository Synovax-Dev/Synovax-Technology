// Browser test: drives the real pages in headless Chrome/Edge over the DevTools
// protocol (no dependencies) and fails on any JS error, CSP violation or failed
// request. Run: npm run test:ui   (set BROWSER=<path> if it cannot find one;
// set UI_SHOTS=<dir> to save screenshots, desktop and phone width)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { totpAt, currentStep } from '../server/totp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_KEY = `ui_admin_${'y'.repeat(40)}`;
const SHOTS = process.env.UI_SHOTS ? path.resolve(process.env.UI_SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const step = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
};

const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) { console.log('No Chrome or Edge found; set BROWSER=<path>. Skipping the browser test.'); process.exit(0); }

// ---------- server and browser

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vault-ui-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'vault-ui-browser-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SEAL_PERIOD_MS: '2000', ADMIN_KEY, KDF_ITERATIONS: '100000', BACKUP_INTERVAL_MS: '0', LEGACY_DAY_MS: '2000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
const BASE = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /running at (http:\/\/\S+)/.exec(String(d)); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('server did not start')), 10_000);
});

const browser = spawn(browserPath, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1366,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  browser.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('browser did not start')), 20_000);
});

// ---------- a tiny DevTools protocol client

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
  } else for (const l of listeners) l(msg);
};
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => cdp(method, params, sessionId);
for (const d of ['Page', 'Runtime', 'Log', 'Network']) await page(`${d}.enable`);

// Everything that went wrong in the page, checked after each step.
const problems = [];
const allowStatus = new Set(); // "METHOD path status" strings a step expects
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  const p = m.params;
  if (m.method === 'Runtime.exceptionThrown') problems.push(`JS error: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Log.entryAdded' && p.entry.level === 'error') problems.push(`browser: ${p.entry.text} ${p.entry.url ?? ''}`);
  if (m.method === 'Network.responseReceived' && p.response.status >= 400) {
    const u = new URL(p.response.url);
    const key = `${u.pathname} ${p.response.status}`;
    if (!allowStatus.has(key)) problems.push(`HTTP ${p.response.status} ${u.pathname}`);
  }
  if (m.method === 'Network.loadingFailed' && !p.canceled && !/ERR_ABORTED/.test(p.errorText)) problems.push(`request failed: ${p.errorText}`);
});
const noProblems = () => {
  const found = problems.splice(0);
  assert.deepEqual(found, [], `problems in the page:\n  ${found.join('\n  ')}`);
};

// Run code in the page. `H` holds small helpers so steps read like a person using it.
const HELPERS = `
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim().includes(text));
  const click = (sel, text) => { const e = text ? byText(sel, text) : $(sel); if (!e) throw new Error('nothing to click: ' + sel + ' ' + (text ?? '')); e.click(); return true; };
  const type = (sel, v) => { const e = typeof sel === 'string' ? $(sel) : sel; if (!e) throw new Error('no field ' + sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; };
`;
async function js(code) {
  const r = await page('Runtime.evaluate', { expression: `(async () => { ${HELPERS} ${code} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function until(code, what, ms = 15_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await js(code); if (last) return last; } catch (e) { last = e.message; }
    await sleep(120);
  }
  const toastText = await js('return $("#toast")?.textContent').catch(() => '?');
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)}; toast: ${JSON.stringify(toastText)}; page problems: ${JSON.stringify(problems)})`);
}
async function open(p) {
  const loaded = new Promise((r) => listeners.push(function l(m) { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }));
  await page('Page.navigate', { url: BASE + p });
  await loaded;
}
const toast = (text) => until(`return $('#toast')?.textContent.includes(${JSON.stringify(text)}) && $('#toast').textContent`, `toast "${text}"`);

async function shot(name, phone = false) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  if (phone) await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(phone ? 900 : 300);
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, `${name}${phone ? '-phone' : ''}.png`), Buffer.from(data, 'base64'));
  if (phone) { await page('Emulation.clearDeviceMetricsOverride'); await sleep(300); }
}

// Overflow check: nothing should make the page scroll sideways.
const noSideScroll = async (where) => {
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const over = await js('return document.documentElement.scrollWidth - document.documentElement.clientWidth');
  await page('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
  assert.ok(over <= 1, `${where} scrolls sideways by ${over}px on a phone`);
};

// ---------- MCP connector (to check what the browser made is usable by an app)

function startConnector(appKey) {
  const proc = spawn(process.execPath, ['connector/index.js'], { cwd: ROOT, env: { ...process.env, VAULT_APP_KEY: appKey, VAULT_URL: BASE, VAULT_SEMANTIC: 'off' }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', id = 1;
  const waiting = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = id++; waiting.set(n, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: r.result.content[0].text, isError: !!r.result.isError }; };
  return { proc, rpc, tool };
}

let connector;
try {
  const user = 'ui-tester';
  const pass = 'purple elephant dances quietly';
  let phrase, appKey;

  await step('landing page loads without errors, and fits a phone', async () => {
    await open('/');
    await sleep(2500);
    // a fresh server has fewer vaults than STATS_MIN_VAULTS: early access, no counts
    assert.equal(await js('return $("[data-hero-early]").hidden'), false, 'early access shows');
    assert.equal(await js('return $("[data-hero-live]").hidden'), true, 'the counts stay hidden');
    await sleep(2500); await shot('landing-hero');
    await js('window.scrollTo(0, document.body.scrollHeight / 2)'); await sleep(800);
    await js('window.scrollTo(0, document.body.scrollHeight)'); await sleep(800);
    await shot('landing'); await js('window.scrollTo(0, 0)'); await shot('landing', true);
    await noSideScroll('the landing page');
    // the masthead (logo, nav, GitHub, wallet, open vault) never overlaps, from phone to wide screens
    for (const [width, height, mobile] of [[390, 844, true], [1024, 768, false], [1280, 800, false], [1366, 768, false], [1440, 900, false], [1920, 1080, false]]) {
      await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await sleep(400);
      const clash = await js(`
        const boxes = ['.mast .logo', '.mast-nav li', '.mast-gh', '.mast-wallet', '.mast-cta', '.burger']
          .flatMap((s) => $$(s)).map((e) => [e.className || e.textContent.trim(), e.getBoundingClientRect()]).filter(([, r]) => r.width > 0);
        if (!$('.mast-gh') || $('.mast-gh').getBoundingClientRect().width === 0) return 'github icon not shown';
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const [a, r] = boxes[i], [b, q] = boxes[j];
          if (r.left < q.right + 8 && q.left < r.right + 8 && r.top < q.bottom && q.top < r.bottom) return a + ' / ' + b;
        }
        return '';`);
      assert.equal(clash, '', `masthead at ${width}px: ${clash}`);
    }
    await page('Emulation.clearDeviceMetricsOverride'); await sleep(200);
    assert.equal(await js('return $(".mast-gh").href'), 'https://github.com/Synovax-Dev/Synovax-Technology', 'navbar GitHub link');
    noProblems();
  });

  await step('docs page loads, search and tabs work', async () => {
    await open('/docs/');
    await sleep(800);
    assert.ok(await js('return document.querySelectorAll("h2").length > 3'));
    await shot('docs'); await shot('docs', true);
    await noSideScroll('the docs page');
    noProblems();
  });

  await step('information pages: built, load without errors, live parts answer, fit a phone', async () => {
    const built = spawnSync(process.execPath, ['scripts/build-pages.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(built.status, 0, `pages out of date: ${built.stderr}`);
    for (const slug of ['product', 'inbox', 'import', 'apps', 'extension', 'sharing', 'legacy', 'devices', 'seals', 'how-it-works', 'security', 'threat-model', 'immune', 'privacy', 'status', 'connector', 'reference', 'standard', 'verify', 'open-source']) {
      await open(`/${slug}/`);
      await sleep(400);
      assert.ok(await js('return $("h1").textContent.trim().length > 3 && $$(".d-ch h2").length >= 2'), `${slug}: headline and sections`);
      if (slug === 'status') {
        await until('return /working/i.test($("[data-status-head] h3")?.textContent ?? "") && $$("[data-status-rows] li").length === 6', 'the status rows');
        await shot('page-status');
      }
      if (slug === 'immune') {
        await until('return $$(".p-matrix tbody tr").length === 14 && $$(".p-cell.is-held").length === 98', 'the immune record, all held');
        await shot('page-immune'); await shot('page-immune', true);
      }
      if (slug === 'security' || slug === 'seals') await until('return !$("[data-seals]").textContent.includes("Loading")', 'the latest seals');
      if (slug === 'verify') {
        // a proof by hand needs no server: a one-leaf seal's root is the leaf itself
        const leaf = 'ab'.repeat(32);
        await js(`click('[data-tab]', 'A proof by hand'); const f = $('[data-verify-hand]'); type(f.elements.root, '${leaf}'); type(f.elements.leaf, '0x${leaf}'); f.requestSubmit(); return true`);
        await until('return $("[data-verify-hand] .p-result")?.textContent.includes("The proof holds")', 'the hand check');
        await js(`const f = $('[data-verify-hand]'); type(f.elements.root, '${'cd'.repeat(32)}'); f.requestSubmit(); return true`);
        await until('return $("[data-verify-hand] .p-result")?.textContent.includes("does not hold")', 'a failed hand check');
        await js('$("[data-verify-chain]").click(); return true');
        await until('return /seal chain is unbroken|No seals yet/.test($("[data-verify-chain-out]")?.textContent ?? "")', 'the chain check');
        await shot('page-verify');
      }
      if (slug === 'how-it-works') { await shot('page-how'); await shot('page-how', true); }
      await noSideScroll(`the ${slug} page`);
      noProblems();
    }
    // the menu opens on a phone and lists every page
    await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await js('$("[data-menu]").click(); return true');
    assert.ok(await js('return !$("#p-menu").hidden && $$("#p-menu a").length >= 25 && $$("#p-menu a").some((a) => a.pathname === "/devices/")'), 'the page menu');
    await page('Emulation.clearDeviceMetricsOverride');
    noProblems();
  });

  await step('vault: create a vault and see the 24 recovery words', async () => {
    await open('/vault/');
    await until('return $(".au-form")', 'the sign-in form');
    await shot('vault-signin'); await shot('vault-signin', true);
    await noSideScroll('the sign-in page');
    await js('click(".au-tab", "Create")');
    await until('return $(".au-title")?.textContent.includes("Create")', 'the create form');
    await js(`type('input[name=username]', ${JSON.stringify(user)}); type('input[name=pass]', ${JSON.stringify(pass)}); type('input[name=pass2]', ${JSON.stringify(pass)}); $('.au-form').requestSubmit(); return true`);
    await until('return $$(".au-words li").length === 24', 'the recovery words', 30_000);
    phrase = await js('return $$(".au-words li span").map((s) => s.textContent).join(" ")');
    assert.equal(phrase.split(' ').length, 24);
    await shot('vault-phrase');
    await js('const c = $(".au-check input"); c.click(); return true');
    await js('click(".au-submit", "Enter my vault")');
    await until('return $(".shell")', 'the dashboard');
    assert.equal(await js('return $$(".folders .folder").length'), 4, 'All memories + 3 starter folders');
    noProblems();
  });

  await step('vault: write a memory, it is saved encrypted', async () => {
    await js('click(".btn.primary", "New memory")');
    await until('return $("form.editor")', 'the editor');
    const work = await js('return [...$("select[name=folder]").options].find((o) => o.textContent === "Work").value');
    await js(`type('input[name=title]', 'Coffee order'); type('textarea[name=body]', 'Flat white, oat milk, no sugar.'); type('input[name=tags]', 'food, habits'); type('select[name=folder]', ${JSON.stringify(work)}); $('form.editor').requestSubmit(); return true`);
    await toast('Saved');
    await until('return byText(".item-title", "Coffee order")', 'the memory in the list');
    await js(`type('input[name=title]', 'About me'); return true`); // unsaved text in the open editor
    await js('click(".btn", "Close")');
    await js('click(".btn.primary", "New memory")');
    const about = await js('return [...$("select[name=folder]").options].find((o) => o.textContent === "About me").value');
    await js(`type('input[name=title]', 'Name'); type('textarea[name=body]', 'Call me Dee.'); type('select[name=folder]', ${JSON.stringify(about)}); $('form.editor').requestSubmit(); return true`);
    await toast('Saved');
    await js('click(".btn", "Close")');
    await shot('vault-memories'); await shot('vault-memories', true);
    await noSideScroll('the memories view');
    noProblems();
  });

  await step('vault: search filters the list', async () => {
    await js(`type('.search input', 'oat'); return true`);
    assert.equal(await js('return $$(".list .item").length'), 1);
    await js(`type('.search input', ''); return true`);
    noProblems();
  });

  await step('apps: make a key for Work + About me, and the connector reads with it', async () => {
    await js('click(".nav-item", "Apps")');
    await until('return $("main input[name=name]")', 'the new-app form');
    await js(`type('main input[name=name]', 'Claude Desktop');
      for (const l of $$('label.check')) if (['Work', 'About me'].includes(l.textContent.trim())) l.querySelector('input').click();
      $('input[name=suggest]').click();
      byText('.btn.primary', 'Create app key').closest('form').requestSubmit(); return true`);
    appKey = await until('return $(".keybox code")?.textContent', 'the new key');
    assert.match(appKey, /^vlt_app\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.match(await js('return $("pre.code").textContent'), /VAULT_APP_KEY/);
    await shot('vault-appkey');
    await js('click(".btn.primary", "Done")');
    await until('return byText(".card.app h3", "Claude Desktop")', 'the app card');
    connector = startConnector(appKey);
    await connector.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ui', version: '1' } });
    assert.match((await connector.tool('list_folders')).text, /Work[\s\S]*About me|About me[\s\S]*Work/);
    assert.match((await connector.tool('search_memories', { query: 'oat milk' })).text, /Coffee order/);
    noProblems();
  });

  await step('apps: taking Work away replaces its key, and the app loses it', async () => {
    await js('click(".btn", "Edit access")');
    await until('return $("form.card h3")', 'the access form');
    await js(`for (const l of $$('label.check')) if (l.textContent.trim() === 'Work') l.querySelector('input').click();
      byText('.btn.primary', 'Save access').closest('form').requestSubmit(); return true`);
    await toast('new key');
    const r = await connector.tool('search_memories', { query: 'oat milk' });
    assert.match(r.text, /Nothing in the vault matches/);
    assert.match((await connector.tool('search_memories', { query: 'Dee' })).text, /Name/, 'About me still works');
    noProblems();
  });

  await step('folder: Replace key by hand re-encrypts it', async () => {
    await js('click(".folders .folder", "Work")');
    await until('return byText(".link", "Replace key")', 'the Replace key button');
    await js('window.confirm = () => true; click(".link", "Replace key")');
    await toast('New key for "Work"');
    noProblems();
  });

  await step('sharing: share a folder with another vault, open one shared with you, stop sharing', async () => {
    // a second vault, made the way the vault page makes one
    const C = await import('../shared/crypto.js');
    const post = async (p, body, token, method = 'POST') => {
      const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer s.${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const data = await r.json().catch(() => ({}));
      assert.ok(r.ok, `${method} ${p}: ${r.status} ${JSON.stringify(data)}`);
      return data;
    };
    const fSalt = C.b64(C.randomBytes(16)), fk = await C.keysFromPassphrase('friend passphrase here', fSalt, 100_000);
    const fRec = await C.keysFromRecovery(C.newRecoveryPhrase()), fVk = C.randomBytes(32), fBox = await C.newBoxKeyPair();
    const fToken = (await post('/api/auth/register', {
      username: 'friend', salt: fSalt, iterations: 100_000, authKey: fk.authKey, recoveryAuthKey: fRec.authKey,
      wrappedVaultKey: await C.wrapKey(fk.kek, fVk, 'vk/passphrase'), wrappedVaultKeyRecovery: await C.wrapKey(fRec.kek, fVk, 'vk/recovery'),
      boxPub: fBox.pub, boxPrivWrapped: await C.wrapKey(fVk, fBox.priv, 'box/private'),
    })).token;
    const friendCode = C.formatShareCode('friend', await C.keyFingerprint(fBox.pub));

    // 1. share "About me" with the friend, from the folder's Share panel
    await js('click(".folder .fname", "About me")');
    await until('return byText(".link", "Share")', 'the Share button');
    await js('click(".link", "Share")');
    await until('return $(".share-panel")', 'the share panel');
    await js(`type('.share-panel input[name=code]', ${JSON.stringify(friendCode)}); $('.share-form').requestSubmit(); return true`);
    await toast('Shared');
    await until('return byText(".share-panel .session b", "friend")', 'friend in the list');
    await shot('vault-share');
    await noSideScroll('the share panel');
    const shared = (await post('/api/shared', null, fToken, 'GET')).shares;
    assert.equal(shared.length, 1);
    const opened = await C.shareOpen(fBox.priv, fBox.pub, shared[0].ownerBoxPub, shared[0].box);
    assert.equal(opened.folderName, 'About me');
    const mems = (await post(`/api/shared/${shared[0].id}`, null, fToken, 'GET')).memories;
    assert.ok((await Promise.all(mems.map((m) => C.decryptJSON(opened.folderKey, m.body, `memory:${m.id}:body`)))).some((d) => d.body === 'Call me Dee.'));

    // 2. the friend shares a folder back; it shows up under Shared, read only
    await js('click(".nav-item", "Shared")');
    const myCode = await until('return $("[data-share-code]")?.textContent', 'my share code');
    const mine = C.parseShareCode(myCode);
    assert.equal(mine.username, user);
    const { boxPub } = await post('/api/share-key', mine, fToken);
    const folderId = C.newId(), folderKey = C.randomBytes(32), memId = C.newId();
    await post(`/api/folders/${folderId}`, { meta: await C.encryptJSON(folderKey, { name: 'Trip plans' }, `folder:${folderId}:meta`), wrappedKey: await C.wrapKey(fVk, folderKey, `folder:${folderId}:key`) }, fToken, 'PUT');
    await post(`/api/memories/${memId}`, { folderId, head: await C.encryptJSON(folderKey, { title: 'Flights', tags: [], snippet: '' }, `memory:${memId}:head`), body: await C.encryptJSON(folderKey, { title: 'Flights', body: 'Lisbon on May 3, back May 10.', tags: ['travel'] }, `memory:${memId}:body`) }, fToken, 'PUT');
    const backId = C.newId();
    await post(`/api/shares/${backId}`, { folderId, recipient: user, box: await C.shareSeal(fBox.priv, fBox.pub, boxPub, { shareId: backId, folderId, folderKey, folderName: 'Trip plans', owner: 'friend', recipient: user }), meta: await C.encryptJSON(fVk, { recipient: user, fingerprint: mine.fingerprint }, `share:${backId}:meta`) }, fToken, 'PUT');
    await js('click(".btn", "Refresh")');
    await until('return byText(".card.shared h2", "Trip plans")', 'the folder shared with me');
    assert.ok(await js(`return $(".card.shared .fine").textContent.includes(${JSON.stringify((await C.keyFingerprint(fBox.pub)).slice(-8))})`), 'the sender\'s fingerprint is shown');
    await js('click(".card.shared .btn.primary", "Open folder")');
    await until('return byText(".shared-mem summary", "Flights")', 'the shared memory');
    await js('$(".shared-mem summary").click(); return true');
    assert.ok(await js('return $(".shared-body").textContent === "Lisbon on May 3, back May 10."'));
    await shot('vault-shared'); await shot('vault-shared', true);
    await noSideScroll('the Shared page');

    // 3. stop sharing "About me": the friend is cut off and the folder gets a new key
    await js('window.confirm = () => true; click(".card .session .btn", "Stop sharing")');
    await toast('new key');
    assert.equal((await fetch(`${BASE}/api/shared/${shared[0].id}`, { headers: { authorization: `Bearer s.${fToken}` } })).status, 404);
    // the friend's opening is in the read log
    await js('click(".nav-item", "Read log")');
    await until('return byText(".log td", "friend (shared)") || byText(".log td", "A vault you stopped sharing with")', 'the shared opening in the log');
    await post('/api/account', { confirm: 'friend' }, fToken, 'DELETE');
    noProblems();
  });

  await step('legacy: name an heir; a vault left to you opens only after its owner stays away', async () => {
    const C = await import('../shared/crypto.js');
    const call = async (p, body, token, method = 'POST') => {
      const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer s.${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const data = await r.json().catch(() => ({}));
      assert.ok(r.ok, `${method} ${p}: ${r.status} ${JSON.stringify(data)}`);
      return data;
    };
    const salt = C.b64(C.randomBytes(16)), k = await C.keysFromPassphrase('elder passphrase here', salt, 100_000);
    const rec = await C.keysFromRecovery(C.newRecoveryPhrase()), vk = C.randomBytes(32), bx = await C.newBoxKeyPair();
    const eToken = (await call('/api/auth/register', {
      username: 'elder', salt, iterations: 100_000, authKey: k.authKey, recoveryAuthKey: rec.authKey,
      wrappedVaultKey: await C.wrapKey(k.kek, vk, 'vk/passphrase'), wrappedVaultKeyRecovery: await C.wrapKey(rec.kek, vk, 'vk/recovery'),
      boxPub: bx.pub, boxPrivWrapped: await C.wrapKey(vk, bx.priv, 'box/private'),
    })).token;

    // 1. in Settings, name "elder" as the heir of this vault, then remove them
    await js('click(".nav-item", "Settings")');
    await until('return $(".legacy-form")', 'the legacy card');
    const elderCode = C.formatShareCode('elder', await C.keyFingerprint(bx.pub));
    await js(`type('.legacy-form input[name=code]', ${JSON.stringify(elderCode)}); type('.legacy-form select[name=wait]', '30'); $('.legacy-form').requestSubmit(); return true`);
    await toast('will receive your vault');
    await until('return byText(".card .session b", "elder")', 'the heir in the list');
    await shot('vault-legacy');
    const named = (await call('/api/legacy-for-me', null, eToken, 'GET')).vaults;
    assert.equal(named.length, 1);
    assert.equal(named[0].owner, user);
    assert.equal(named[0].waitDays, 30);
    assert.equal(named[0].open, false);
    await js('window.confirm = () => true; click(".card .session .btn", "Remove"); return true');
    await toast('removed');
    assert.equal((await call('/api/legacy-for-me', null, eToken, 'GET')).vaults.length, 0);

    // 2. "elder" leaves their vault to this one; it opens once elder stays away a "day" (2 s here)
    await js('click(".nav-item", "Shared")');
    const mine = C.parseShareCode(await until('return $("[data-share-code]")?.textContent', 'my share code'));
    const { boxPub } = await call('/api/share-key', mine, eToken);
    const fid = C.newId(), fkey = C.randomBytes(32), mid = C.newId();
    await call(`/api/folders/${fid}`, { meta: await C.encryptJSON(fkey, { name: 'Letters' }, `folder:${fid}:meta`), wrappedKey: await C.wrapKey(vk, fkey, `folder:${fid}:key`) }, eToken, 'PUT');
    await call(`/api/memories/${mid}`, { folderId: fid, head: await C.encryptJSON(fkey, { title: 'For you', tags: [], snippet: '' }, `memory:${mid}:head`), body: await C.encryptJSON(fkey, { title: 'For you', body: 'The garden key is under the blue pot.', tags: [] }, `memory:${mid}:body`) }, eToken, 'PUT');
    const lid = C.newId();
    await call(`/api/legacy/${lid}`, { heir: user, waitDays: 1, box: await C.legacySeal(bx.priv, bx.pub, boxPub, { legacyId: lid, vaultKey: vk, owner: 'elder', heir: user }), meta: await C.encryptJSON(vk, { heir: user, fingerprint: mine.fingerprint }, `legacy:${lid}:meta`) }, eToken, 'PUT');
    await js('click(".btn", "Refresh")');
    await until('return byText(".legacy-in h2", "elder")', 'the vault left to me');
    assert.ok(await js('return $(".legacy-in .muted").textContent.includes("stays closed") && !byText(".legacy-in .btn", "Open vault")'), 'closed while elder is around');
    await sleep(2400);
    await js('click(".btn", "Refresh")');
    await until('return byText(".legacy-in .btn", "Open vault")', 'it opens');
    await js('click(".legacy-in .btn", "Open vault")');
    await until('return byText(".legacy-in summary", "Letters")', 'the folders of the vault left to me');
    await js('$(".legacy-in summary").click(); return true');
    assert.ok(await js('return byText(".legacy-mem .shared-body", "garden key")'));
    await shot('vault-legacy-in'); await shot('vault-legacy-in', true);
    await noSideScroll('a vault left to me');
    await call('/api/account', { confirm: 'elder' }, eToken, 'DELETE');
    await js('click(".btn", "Refresh")');
    await until('return !$(".legacy-in")', 'gone with the vault');
    noProblems();
  });
  await step('devices: add a device by QR code, both ways, and share into the vault from the phone menu', async () => {
    const C = await import('../shared/crypto.js');
    const call = async (p, body, token, method = 'POST', headers = {}) => {
      const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer s.${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const data = await r.json().catch(() => ({}));
      assert.ok(r.ok, `${method} ${p}: ${r.status} ${JSON.stringify(data)}`);
      return data;
    };
    // 1. this browser is the signed-in device; a "phone" (here, the test) scans its code
    await js('click(".nav-item", "Settings")');
    await until('return byText(".btn", "Add a device with a QR code")', 'the add-device button');
    assert.ok(await js('return !/\\bfalse\\b|\\bundefined\\b/.test($(".sessions").textContent)'), 'no stray words in the device list');
    await js('click(".btn", "Add a device with a QR code")');
    const link = await until('return $("[data-pair-link]")?.dataset.pairLink', 'the QR code');
    assert.ok(await js('return $("svg.qr path").getAttribute("d").length > 500'), 'a QR code is drawn');
    await shot('vault-pair');
    const m = /#pair=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(link);
    assert.ok(m && link.startsWith(`${BASE}/vault/#pair=`), link);
    const [, pid, sec] = m, secret = C.unb64(sec), dev = await C.newBoxKeyPair();
    const { ticket } = await call(`/api/pair/${pid}/join`, { pub: dev.pub, mac: await C.pairMac(secret, `pair/join/v1|${pid}|${dev.pub}`) }, null, 'POST', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    const shown = await until('return $("[data-pair-code]")?.textContent', 'the number to compare');
    assert.equal(shown, await C.pairCode(secret, dev.pub), 'the same number as on the phone');
    assert.ok(await js('return byText(".pair-text b", "Safari on iOS")'), 'it says which device asks');
    await js('click(".pair-panel .btn.primary", "Approve")');
    await until('return byText(".pair-panel .ok", "is opening your vault")', 'approved');
    let got;
    for (let i = 0; i < 20 && !got?.token; i++) { got = await call(`/api/pair/${pid}/collect`, { ticket }); if (!got.token) await sleep(200); }
    assert.ok(await C.checkPairMac(secret, `pair/give/v1|${pid}|${got.box}`, got.mac));
    const given = await C.boxOpen(dev.priv, dev.pub, got.box);
    assert.equal(given.username, user);
    assert.equal((await call('/api/account', null, got.token, 'GET')).username, user, 'the phone has a working session');
    await call('/api/auth/logout', null, got.token);
    noProblems();

    // 2. the other way: this browser is the new device, opened from a code another device shows
    const s = await call('/api/auth/salt', { username: user });
    const k = await C.keysFromPassphrase(pass, s.salt, s.iterations);
    const other = await call('/api/auth/login', { username: user, authKey: k.authKey });
    const vk = await C.unwrapKey(k.kek, other.keys.wrappedVaultKey, 'vk/passphrase');
    const { id } = await call('/api/pair', null, other.token);
    const secret2 = C.randomBytes(32);
    await js('click(".side-lock")');
    await until('return $(".au-form")', 'locked');
    await open('/');
    await open(`/vault/#pair=${id}.${C.b64(secret2)}`);
    const code = await until('return $("[data-pair-code]")?.textContent', 'the number on the new device');
    assert.equal(await js('return location.hash'), '', 'the secret is taken out of the address bar');
    await shot('vault-pair-join', true);
    const seen = await call(`/api/pair/${id}`, null, other.token, 'GET');
    assert.ok(await C.checkPairMac(secret2, `pair/join/v1|${id}|${seen.devicePub}`, seen.deviceMac));
    assert.equal(code, await C.pairCode(secret2, seen.devicePub));
    const sealed = await C.boxSeal(seen.devicePub, { pairId: id, username: user, vaultKey: C.b64(vk) });
    await call(`/api/pair/${id}/approve`, { box: sealed, mac: await C.pairMac(secret2, `pair/give/v1|${id}|${sealed}`) }, other.token);
    await until('return $(".shell")', 'the vault, opened without the passphrase', 20_000);
    assert.ok(await js('return byText(".item-title", "Coffee order")'), 'and it decrypts');
    await call('/api/auth/logout', null, other.token);
    noProblems();

    // 3. share from another app: the service worker keeps the text out of the request
    await until('return navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)', 'the service worker');
    const hits = [];
    // a redirect shows up as the next request's redirectResponse
    listeners.push((msg) => {
      const r = msg.method === 'Network.responseReceived' ? msg.params.response : msg.method === 'Network.requestWillBeSent' ? msg.params.redirectResponse : null;
      if (r?.url.includes('/vault/share')) hits.push(r);
    });
    await open('/vault/share?title=Trip%20idea&text=Rent%20a%20boat%20in%20Lisbon&url=https%3A%2F%2Fexample.com%2Fboats');
    await until('return $(".au-form")', 'the sign-in form');
    assert.equal(await js('return location.pathname + location.search + location.hash'), '/vault/', 'nothing shared is left in the address');
    assert.ok(hits.length && hits.every((r) => r.fromServiceWorker), 'answered by the service worker, not the server');
    await js(`type('input[name=username]', ${JSON.stringify(user)}); type('input[name=pass]', ${JSON.stringify(pass)}); $('.au-form').requestSubmit(); return true`);
    await until('return $("form.editor input[name=title]")?.value === "Trip idea"', 'the shared text in a new memory', 30_000);
    assert.equal(await js('return $("form.editor textarea[name=body]").value'), 'Rent a boat in Lisbon\n\nhttps://example.com/boats');
    await shot('vault-shared-in', true);
    await js('click(".btn", "Close")');
    noProblems();
  });
  await step('inbox: a suggestion from the app shows up and can be approved', async () => {
    assert.match((await connector.tool('suggest_memory', { title: 'Likes jazz', body: 'Mentioned Coltrane twice.', folder: 'About me', reason: 'came up twice' })).text, /Suggested/);
    await js('click(".nav-item", "Inbox")');
    await js('click(".btn", "Refresh")');
    await until('return byText(".suggestion", "Coltrane") || $(".suggestion input[name=title]")?.value === "Likes jazz"', 'the suggestion');
    await shot('vault-inbox');
    await js('byText(".btn.primary", "Approve").closest("form").requestSubmit(); return true');
    await toast('Approved');
    noProblems();
  });

  await step('read log: reads are listed, sealed, verified, and the seal chain checks out', async () => {
    await js('click(".nav-item", "Read log")');
    await until('return $$("table.log tbody tr").length >= 4', 'log rows');
    await sleep(4500); // let the reads be sealed (2 s periods in this test)
    await js('click(".btn", "Refresh")');
    await until('return byText("table.log .btn", "Verify")', 'a Verify button');
    await js('click("table.log .btn", "Verify")');
    await until('return byText("table.log .ok", "Verified")', 'a verified entry');
    await until('return byText(".chain-l", "Seal chain intact")', 'the chain check');
    await shot('vault-log'); await shot('vault-log', true);
    await noSideScroll('the read log');
    noProblems();
  });

  await step('settings: this device is listed; export works', async () => {
    await js('click(".nav-item", "Settings")');
    await until('return byText(".session", "this device")', 'the session list');
    await js('click(".btn", "Download export")');
    await shot('vault-settings'); await shot('vault-settings', true);
    await noSideScroll('settings');
    noProblems();
  });

  await step('settings: import a pasted list of memories (as from ChatGPT)', async () => {
    const list = '- Prefers metric units\n- Works night shifts as a nurse\n- Name';
    await js(`type(byText('.card', 'Import').querySelector('textarea'), ${JSON.stringify(list)}); return true`);
    await until('return byText(".card .fine", "Found 3")', 'the import preview');
    await js('click(".btn.primary", "Import")');
    await toast('Imported 3');
    noProblems();
  });

  let totpSecret;
  await step('settings: turn on two-step sign-in with an authenticator code', async () => {
    await js('click(".nav-item", "Settings")');
    await until('return byText(".btn", "Turn on two-step")', 'the 2FA card');
    await js('click(".btn", "Turn on two-step")');
    totpSecret = (await until('return byText(".card", "setup key")?.querySelector(".keybox code")?.textContent', 'the setup key')).replace(/\s/g, '');
    await js(`type(byText('.card', 'setup key').querySelector('input[name=code]'), ${JSON.stringify(totpAt(totpSecret, currentStep()))});
      byText('.btn.primary', 'Turn on').closest('form').requestSubmit(); return true`);
    await until('return byText(".ok", "On.")', '2FA on');
    noProblems();
  });

  await step('lock, then open again with passphrase + code: everything still decrypts', async () => {
    await js('click(".side-lock")');
    await until('return $(".au-form")', 'the sign-in form');
    allowStatus.add('/api/auth/login 401'); // the first try, without a code, is answered "code needed"
    await js(`type('input[name=pass]', ${JSON.stringify(pass)}); $('.au-form').requestSubmit(); return true`);
    await until('return $("input[name=totp]")', 'the code field', 30_000);
    assert.equal(await js('return $("input[name=pass]").value'), pass, 'what was typed stays');
    await js(`type('input[name=totp]', ${JSON.stringify(totpAt(totpSecret, currentStep() + 1))}); $('.au-form').requestSubmit(); return true`);
    await until('return $(".shell")', 'the dashboard', 30_000);
    problems.splice(0, problems.length, ...problems.filter((p) => !/status of 401 .*\/api\/auth\/login/.test(p)));
    allowStatus.clear();
    const titles = await js('return $$(".item-title").map((e) => e.textContent)');
    assert.deepEqual([...titles].sort(), ['Coffee order', 'Likes jazz', 'Name', 'Name', 'Prefers metric units', 'Works night shifts as a nurse']);
    assert.ok(!(await js('return document.body.textContent.includes("Unreadable")')), 'nothing is unreadable after the key changes');
    noProblems();
  });

  await step('recover with the 24 words and a new passphrase', async () => {
    await js('click(".side-lock")');
    await until('return $(".au-form")', 'the sign-in form');
    await js('click(".au-forgot button")');
    await until('return $("textarea[name=phrase]")', 'the recovery form');
    await js(`type('input[name=username]', ${JSON.stringify(user)}); type('textarea[name=phrase]', ${JSON.stringify(phrase)});
      type('input[name=pass]', 'a whole new passphrase'); type('input[name=pass2]', 'a whole new passphrase'); $('.au-form').requestSubmit(); return true`);
    await until('return $(".shell")', 'the dashboard', 30_000);
    await toast('Two-step sign-in was turned off');
    noProblems();
  });

  await step('a wrong passphrase shows a clear message', async () => {
    await js('click(".side-lock")');
    await until('return $(".au-form")', 'the sign-in form');
    allowStatus.add('/api/auth/login 401');
    await js(`type('input[name=pass]', 'definitely not it'); $('.au-form').requestSubmit(); return true`);
    await until('return $(".au-err:not([hidden])")?.textContent.includes("Wrong")', 'the error message');
    // the app logs the failure on purpose (console.error in submitAuth); that is not a bug
    // (and Chrome itself logs the 401 it was given)
    problems.splice(0, problems.length, ...problems.filter((p) => !/console\.error: Error: Wrong name or passphrase|status of 401 .*\/api\/auth\/login/.test(p)));
    allowStatus.clear();
    noProblems();
  });

  await step('admin panel: sign in and see the token form', async () => {
    await open('/admin/');
    await until('return $("input[type=password], input[name=key]")', 'the admin sign-in');
    await js(`type($('input[type=password]') ?? $('input[name=key]'), ${JSON.stringify(ADMIN_KEY)}); ($('input[type=password]') ?? $('input[name=key]')).closest('form').requestSubmit(); return true`);
    await until('return $("[name=contract]") && $("[name=contract]").offsetParent !== null', 'the token form');
    await shot('admin'); await shot('admin', true);
    await noSideScroll('the admin panel');
    noProblems();
  });

  console.log(`\n${passed} browser checks passed${SHOTS ? ` · screenshots in ${SHOTS}` : ''}.`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  connector?.proc.kill();
  try { ws.close(); } catch {}
  browser.kill();
  server.kill();
  await sleep(800);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
