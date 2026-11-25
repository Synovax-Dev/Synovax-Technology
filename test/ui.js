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
  cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SEAL_PERIOD_MS: '2000', ADMIN_KEY, KDF_ITERATIONS: '100000', BACKUP_INTERVAL_MS: '0' },
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
    for (const slug of ['product', 'inbox', 'import', 'apps', 'devices', 'seals', 'how-it-works', 'security', 'threat-model', 'immune', 'privacy', 'status', 'connector', 'reference', 'standard', 'verify', 'open-source']) {
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
    assert.ok(await js('return !$("#p-menu").hidden && $$("#p-menu a").length >= 22 && $$("#p-menu a").some((a) => a.pathname === "/devices/")'), 'the page menu');
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
