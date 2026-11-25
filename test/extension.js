// The browser extension: its logic against a real server, then the real
// extension loaded into headless Chrome or Edge (through the DevTools protocol,
// which branded browsers still allow for unpacked extensions), saving a page, a
// selection and a popup note into the vault's inbox. Run: npm run test:extension
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';
import * as X from '../extension/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const step = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
};

await step('the extension is built from the current code', () => {
  const r = spawnSync(process.execPath, ['scripts/build-extension.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

await step('what gets saved: titles, sources, size limits, chats', () => {
  assert.equal(X.cleanVaultUrl(''), 'https://synovax.tech');
  assert.equal(X.cleanVaultUrl('http://127.0.0.1:8787/vault/'), 'http://127.0.0.1:8787');
  assert.throws(() => X.cleanVaultUrl('http://example.com'), /https/);
  assert.throws(() => X.cleanVaultUrl('https://me:pw@example.com'), /name or password/);
  assert.ok(X.isChat('https://claude.ai/chat/123') && X.isChat('https://chatgpt.com/c/1') && !X.isChat('https://example.com'));
  const sel = X.buildSuggestion({ kind: 'selection', title: 'Some page', url: 'https://example.com/a', text: 'Prefers aisle seats.\nAlways.' });
  assert.equal(sel.title, 'Prefers aisle seats.');
  assert.match(sel.body, /^From: https:\/\/example\.com\/a\n\nPrefers aisle seats\./);
  assert.deepEqual(sel.tags, ['clipping']);
  const page = X.buildSuggestion({ kind: 'chat', title: '  Trip   planning ', url: 'https://claude.ai/chat/1', text: 'a\n\n\n\nb', note: 'Keep this', folder: 'Travel' });
  assert.equal(page.title, 'Trip planning');
  assert.equal(page.body, 'Keep this\nFrom: https://claude.ai/chat/1\n\na\n\nb');
  assert.equal(page.folder, 'Travel');
  assert.deepEqual(page.tags, ['chat']);
  assert.throws(() => X.buildSuggestion({ kind: 'selection', text: '  ' }), /Select some text/);
  const big = X.buildSuggestion({ kind: 'page', title: 'Big', text: 'é'.repeat(80_000) });
  assert.ok(C.te.encode(big.body).length < 100_100 && big.body.endsWith('[cut to fit: the rest was not saved]'));
  assert.ok(!big.body.includes('\uFFFD'), 'never cuts a character in half');
});

// ---------- a server, a vault, and an app key that may only suggest
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vault-ext-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, KDF_ITERATIONS: '100000', BACKUP_INTERVAL_MS: '0', ADMIN_KEY: `test_admin_${'x'.repeat(40)}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
const BASE = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /running at (http:\/\/\S+)/.exec(String(d)); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('server did not start')), 10_000);
});
let browser, profile;
const cleanup = async () => {
  browser?.kill();
  server.kill();
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
};

async function api(method, p, body, token) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer s.${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${p}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

try {
  const salt = C.b64(C.randomBytes(16)), k = await C.keysFromPassphrase('extension test passphrase', salt, 100_000);
  const rec = await C.keysFromRecovery(C.newRecoveryPhrase()), vk = C.randomBytes(32), box = await C.newBoxKeyPair();
  const token = (await api('POST', '/api/auth/register', {
    username: 'clipper', salt, iterations: 100_000, authKey: k.authKey, recoveryAuthKey: rec.authKey,
    wrappedVaultKey: await C.wrapKey(k.kek, vk, 'vk/passphrase'), wrappedVaultKeyRecovery: await C.wrapKey(rec.kek, vk, 'vk/recovery'),
    boxPub: box.pub, boxPrivWrapped: await C.wrapKey(vk, box.priv, 'box/private'),
  })).token;
  const makeApp = async (name, canSuggest) => {
    const id = C.newId(), secret = C.randomBytes(32), m = await C.appKeyMaterial(secret);
    await api('PUT', `/api/apps/${id}`, { meta: await C.encryptJSON(vk, { name, secret: C.b64(secret) }, `app:${id}:meta`), authKey: m.auth, vouch: await C.vouchFor(m.vouch, id, box.pub), canSuggest, folderKeys: [] }, token);
    return { id, key: C.formatAppKey(id, secret) };
  };
  const ext = await makeApp('Browser extension', true);
  const inbox = async () => Promise.all((await api('GET', '/api/inbox', null, token)).suggestions.map((s) => C.boxOpen(box.priv, box.pub, s.box)));

  await step('the extension\'s logic sends a sealed suggestion that only the vault opens', async () => {
    const c = await X.connect({ vaultUrl: BASE, appKey: ext.key });
    assert.equal(c.folders, 0, 'it is given no folders to read');
    await X.send({ vaultUrl: BASE, appKey: ext.key }, X.buildSuggestion({ kind: 'selection', title: 'x', url: 'https://example.com', text: 'Allergic to cats.' }));
    const got = await inbox();
    assert.equal(got.length, 1);
    assert.equal(got[0].body, 'From: https://example.com\n\nAllergic to cats.');
    assert.match(got[0].reason, /browser extension/);
    const readOnly = await makeApp('Reader', false);
    await assert.rejects(X.connect({ vaultUrl: BASE, appKey: readOnly.key }), /may not suggest/);
    await assert.rejects(X.connect({ vaultUrl: BASE, appKey: 'nonsense' }), /app key/);
    // a server that swaps in its own inbox key is caught before anything is sealed
    const fake = await C.newBoxKeyPair();
    const lying = async (url, opts) => {
      const r = await fetch(url, opts);
      if (!url.endsWith('/api/app/info')) return r;
      const j = await r.json();
      return new Response(JSON.stringify({ ...j, boxPub: fake.pub }), { status: 200 });
    };
    await assert.rejects(X.send({ vaultUrl: BASE, appKey: ext.key }, X.buildSuggestion({ kind: 'page', title: 't', text: 'x' }), lying), /did not pass its check/);
    for (const s of (await api('GET', '/api/inbox', null, token)).suggestions) await api('DELETE', `/api/inbox/${s.id}`, null, token);
  });

  // ---------- the real extension in a headless browser
  const BROWSERS = [process.env.BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const browserPath = BROWSERS.find((p) => existsSync(p));
  if (!browserPath) {
    console.log('No Chrome or Edge found; set BROWSER=<path>. Skipping the in-browser part.');
  } else {
    profile = await mkdtemp(path.join(os.tmpdir(), 'vault-ext-browser-'));
    browser = spawn(browserPath, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const toBrowser = browser.stdio[3], fromBrowser = browser.stdio[4];
    let buf = '', nextId = 0;
    const waiting = new Map();
    fromBrowser.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') problems.push(`JS error: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
    });
    const problems = [];
    const noProblems = () => { const found = problems.splice(0); assert.deepEqual(found, [], `problems in the extension:\n  ${found.join('\n  ')}`); };
    const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
      setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
    });
    const attach = async (targetId) => {
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
      await cdp('Runtime.enable', {}, sessionId);
      return sessionId;
    };
    const run = async (sessionId, expression) => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const until = async (sessionId, expression, what, ms = 15_000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await run(sessionId, expression).catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}${problems.length ? `; problems: ${problems.join(' | ')}` : ''}`);
        await sleep(150);
      }
    };
    const targets = async () => (await cdp('Target.getTargets')).targetInfos;
    const shots = process.env.UI_SHOTS ? path.resolve(process.env.UI_SHOTS) : null;
    const shot = async (sessionId, name) => {
      if (!shots) return;
      await mkdir(shots, { recursive: true });
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };

    let extId, sw, tabId;
    await step('the extension loads, and its settings page checks and saves the key', async () => {
      extId = (await cdp('Extensions.loadUnpacked', { path: path.join(ROOT, 'extension') })).id;
      const swTarget = await (async () => { for (let i = 0; i < 50; i++) { const t = (await targets()).find((x) => x.type === 'service_worker' && x.url === `chrome-extension://${extId}/background.js`); if (t) return t; await sleep(100); } throw new Error('no service worker'); })();
      sw = await attach(swTarget.targetId);
      const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
      const s = await attach(targetId);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, s);
      await until(s, 'document.body.dataset.ready === "1"', 'the settings form');
      await run(s, `(() => { const f = document.querySelector('[data-config]'); f.elements.vaultUrl.value = ${JSON.stringify(BASE)}; f.elements.appKey.value = 'vlt_app.bad'; f.requestSubmit(); return true })()`);
      await until(s, 'document.querySelector("[data-status]").className.includes("bad")', 'a bad key refused');
      await run(s, `(() => { const f = document.querySelector('[data-config]'); f.elements.appKey.value = ${JSON.stringify(ext.key)}; f.requestSubmit(); return true })()`);
      await until(s, 'document.querySelector("[data-status]").textContent.includes("Connected")', 'connected');
      await shot(s, 'extension-options');
      assert.equal(await run(s, 'document.querySelector("[data-config]").elements.appKey.value'), '', 'the key is not left on screen');
      const stored = await run(sw, 'chrome.storage.local.get("config").then((r) => r.config)');
      assert.equal(stored.vaultUrl, BASE);
      assert.equal(stored.appKey, ext.key);
      noProblems();
    });

    await step('right-click "Save this page" and "Save selection" put the page and the selection in the inbox', async () => {
      const url = `${BASE}/how-it-works/`;
      const { targetId } = await cdp('Target.createTarget', { url });
      const pageS = await attach(targetId);
      await until(pageS, 'document.readyState === "complete" && !!document.querySelector("h1")', 'the page');
      tabId = await run(sw, `chrome.tabs.query({}).then((t) => t.find((x) => x.url === ${JSON.stringify(url)}).id)`);
      const r1 = await run(sw, `chrome.tabs.get(${tabId}).then((tab) => saveFromMenu({ menuItemId: 'save-page', pageUrl: tab.url }, tab))`);
      assert.equal(r1.ok, true, JSON.stringify(r1));
      const r2 = await run(sw, `chrome.tabs.get(${tabId}).then((tab) => saveFromMenu({ menuItemId: 'save-selection', pageUrl: tab.url, selectionText: 'Your memories are encrypted on your device.' }, tab))`);
      assert.equal(r2.ok, true, JSON.stringify(r2));
      const got = await inbox();
      const page = got.find((s) => s.tags[0] === 'web page');
      assert.ok(page, 'the page arrived');
      assert.match(page.title, /How it works/);
      assert.ok(page.body.startsWith(`From: ${url}\n\n`) && page.body.length > 500, 'with its text');
      const clip = got.find((s) => s.tags[0] === 'clipping');
      assert.equal(clip.body, `From: ${url}\n\nYour memories are encrypted on your device.`);
      noProblems();
    });

    await step('the toolbar popup saves the selection on the page, with a note and a folder', async () => {
      const pages = (await targets()).filter((t) => t.type === 'page' && t.url.endsWith('/how-it-works/'));
      const pageS = await attach(pages[0].targetId);
      await run(pageS, '(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("h1")); getSelection().removeAllRanges(); getSelection().addRange(r); return true })()');
      const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/popup.html?tab=${tabId}` });
      const s = await attach(targetId);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 560, deviceScaleFactor: 2, mobile: false }, s);
      await until(s, '!document.querySelector("[data-save]").hidden && document.querySelector("[data-kind=selection]").getAttribute("aria-pressed") === "true"', 'the popup with the selection chosen');
      assert.equal(await run(s, 'document.querySelector("[data-kind=page]").hidden'), false);
      assert.equal(await run(s, 'document.querySelector("[data-kind=chat]").hidden'), true, 'not a chat site');
      await run(s, `(() => { const f = document.querySelector('[data-save]'); f.elements.note.value = 'Read this again'; f.elements.folder.value = 'Reading'; f.requestSubmit(); return true })()`);
      await until(s, 'document.querySelector("[data-status]").className.includes("ok")', 'saved');
      await shot(s, 'extension-popup');
      const got = await inbox();
      const note = got.find((x) => x.body.startsWith('Read this again\n'));
      assert.ok(note, 'the popup suggestion arrived');
      assert.equal(note.folderHint, 'Reading');
      assert.equal(got.length, 3);
      noProblems();
    });
  }

  console.log(`\n${passed} extension checks passed.`);
} finally {
  await cleanup();
}
