// Browser test for the landing page's connect wallet + top holders.
// A fake explorer (Blockscout API shape) and a fake EIP-1193/EIP-6963 wallet
// stand in for Robinhood Chain, so the test needs no network.
// Run: npm run test:wallet   (UI_SHOTS=<dir> saves screenshots)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_KEY = `wallet_admin_${'z'.repeat(40)}`;
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
if (!browserPath) { console.log('No Chrome or Edge found; set BROWSER=<path>. Skipping the wallet test.'); process.exit(0); }

// ---------- fake chain data
const CA = '0x5e1f00000000000000000000000000000000c0de';
const ME = '0x1111111111111111111111111111111111111111';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const MY_BALANCE = 45_000_000n * E18;
const hex = (n) => n.toString(16);
const holderItems = [
  { address: { hash: '0x2222222222222222222222222222222222222222', is_contract: true, name: 'LP Pool <b>x</b>' }, value: String(120_000_000n * E18) },
  { address: { hash: ME, is_contract: false, name: null }, value: String(MY_BALANCE) },
  { address: { hash: DEAD, is_contract: false, name: null }, value: String(30_000_000n * E18) },
  ...Array.from({ length: 22 }, (_, i) => ({ address: { hash: '0x' + (i + 1).toString(16).padStart(40, 'a'), is_contract: false, name: null }, value: String(BigInt(20_000_000 - i * 500_000) * E18) })),
];
let explorerHits = 0;
const explorer = createServer((req, res) => {
  explorerHits++;
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === `/api/v2/tokens/${CA}`) return send(200, { address_hash: CA, decimals: '18', total_supply: String(SUPPLY), holders_count: '1234', symbol: 'SYNOVAX' });
  if (req.url === `/api/v2/tokens/${CA}/holders`) return send(200, { items: holderItems, next_page_params: { value: '1' } });
  send(404, { message: 'Not found' });
});
await new Promise((r) => explorer.listen(0, '127.0.0.1', r));
const EXPLORER = `http://127.0.0.1:${explorer.address().port}`;

// ---------- server and browser
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vault-wallet-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'vault-wallet-browser-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ADMIN_KEY, KDF_ITERATIONS: '100000', BACKUP_INTERVAL_MS: '0', EXPLORER_API: EXPLORER, HOLDERS_TTL_MS: '1500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { if (!/\[holders\]/.test(String(d))) process.stderr.write(`[server] ${d}`); });
const BASE = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /running at (http:\/\/\S+)/.exec(String(d)); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('server did not start')), 10_000);
});
const browser = spawn(browserPath, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  browser.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('browser did not start')), 20_000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map(), listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : resolve(msg.result);
  } else for (const l of listeners) l(msg);
};
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => cdp(method, params, sessionId);
for (const d of ['Page', 'Runtime', 'Log', 'Network']) await page(`${d}.enable`);

const problems = [];
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  const p = m.params;
  if (m.method === 'Runtime.exceptionThrown') problems.push(`JS error: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Log.entryAdded' && p.entry.level === 'error') problems.push(`browser: ${p.entry.text} ${p.entry.url ?? ''}`);
  if (m.method === 'Network.responseReceived' && p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${new URL(p.response.url).pathname}`);
  if (m.method === 'Network.loadingFailed' && !p.canceled && !/ERR_ABORTED/.test(p.errorText)) problems.push(`request failed: ${p.errorText}`);
});
const noProblems = () => { const found = problems.splice(0); assert.deepEqual(found, [], `problems in the page:\n  ${found.join('\n  ')}`); };

const HELPERS = `
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const txt = (s) => $(s)?.textContent.trim() ?? null;
  const visible = (s) => { const e = $(s); return !!e && !e.hidden && e.getClientRects().length > 0; };
`;
async function js(code) {
  const r = await page('Runtime.evaluate', { expression: `(async () => { ${HELPERS} ${code} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function until(code, what, ms = 10_000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) {
    try { last = await js(code); if (last) return last; } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)}; page problems: ${JSON.stringify(problems)})`);
}
async function open(p) {
  const loaded = new Promise((r) => listeners.push(function l(m) { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }));
  await page('Page.navigate', { url: BASE + p });
  await loaded;
}
async function shot(name, phone = false) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  if (phone) await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await until(`return !document.documentElement.classList.contains('is-locked') && !$('[data-veil]')`, 'intro to finish', 20_000);
  await js(`document.querySelector('.tok-board').scrollIntoView({ block: 'start' }); return true`);
  await sleep(phone ? 900 : 400);
  const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(SHOTS, `${name}${phone ? '-phone' : ''}.png`), Buffer.from(data, 'base64'));
  if (phone) { await page('Emulation.clearDeviceMetricsOverride'); await sleep(300); }
}
const api = async (method, p, body, t) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer adm.${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// The fake wallet: EIP-1193 provider, announced over EIP-6963 and as window.ethereum.
// Its "connected" flag and chain survive reloads (sessionStorage), like a real wallet.
const WALLET = `(() => {
  const ACC = ${JSON.stringify(ME)};
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
  const st = { chain: ss.get('mock.chain') || '0x1', connected: ss.get('mock.on') === '1', known: ss.get('mock.known') === '1' };
  const save = () => { ss.set('mock.chain', st.chain); ss.set('mock.on', st.connected ? '1' : '0'); ss.set('mock.known', st.known ? '1' : '0'); };
  const ls = {};
  const emit = (ev, v) => (ls[ev] || []).forEach((f) => f(v));
  const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  window.__calls = [];
  const provider = {
    async request({ method, params }) {
      window.__calls.push(method);
      const fail = (code, m) => { const e = new Error(m); e.code = code; throw e; };
      switch (method) {
        case 'eth_requestAccounts': st.connected = true; save(); return [ACC];
        case 'eth_accounts': return st.connected ? [ACC] : [];
        case 'eth_chainId': return st.chain;
        case 'wallet_switchEthereumChain': if (!st.known) fail(4902, 'Unrecognized chain'); st.chain = params[0].chainId; save(); emit('chainChanged', st.chain); return null;
        case 'wallet_addEthereumChain': window.__added = params[0]; st.known = true; st.chain = params[0].chainId; save(); emit('chainChanged', st.chain); return null;
        case 'wallet_revokePermissions': st.connected = false; save(); return null;
        case 'eth_call': {
          const { to, data } = params[0];
          if (to.toLowerCase() !== ${JSON.stringify(CA.toLowerCase())}) fail(-32000, 'wrong contract');
          if (data === '0x70a08231' + ACC.slice(2).padStart(64, '0')) return word('${MY_BALANCE}');
          if (data === '0x313ce567') return word(18);
          if (data === '0x18160ddd') return word('${SUPPLY}');
          fail(-32000, 'unknown call ' + data);
        }
        case 'personal_sign': case 'eth_sign': case 'eth_signTypedData_v4': case 'eth_sendTransaction': window.__dangerous = method; fail(4001, 'no');
        default: fail(4200, 'unsupported ' + method);
      }
    },
    on(ev, f) { (ls[ev] ||= []).push(f); },
    removeListener(ev, f) { ls[ev] = (ls[ev] || []).filter((x) => x !== f); },
  };
  const info = Object.freeze({ uuid: 'mock-0001', name: 'Test Wallet', rdns: 'test.wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22%3E%3Crect width=%2220%22 height=%2220%22 fill=%22%23fff%22/%3E%3C/svg%3E' });
  const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  addEventListener('eip6963:requestProvider', announce);
  announce();
  window.ethereum = provider;
})();`;

try {
  await step('no wallet installed: says so, holders wait for the contract', async () => {
    const h = await api('GET', '/api/token/holders');
    assert.deepEqual(h.data, { available: false, reason: 'no-contract' });
    assert.equal(explorerHits, 0, 'no contract, no explorer calls');
    await open('/');
    await until(`return txt('[data-wallet-msg]').includes('No browser wallet found')`, 'no-wallet message');
    assert.equal(await js(`return $('[data-wallet-btn]').disabled`), true);
    assert.match(await js(`return txt('[data-holders-empty]')`), /once the contract address is posted/);
    assert.equal(await js(`return $('.th-table').hidden`), true);
    noProblems();
  });

  await page('Page.addScriptToEvaluateOnNewDocument', { source: WALLET });

  await step('pre-launch: connect works and says the balance comes after launch', async () => {
    await open('/');
    await until(`return txt('[data-wallet-msg]').includes('Connect to see')`, 'connect prompt');
    await js(`$('[data-wallet-btn]').click(); return true`);
    await until(`return visible('[data-wallet-facts]')`, 'wallet facts');
    assert.equal(await js(`return txt('[data-w="address"]')`), '0x1111…1111');
    assert.equal(await js(`return txt('[data-w="balance"]')`), 'after launch');
    assert.equal(await js(`return txt('[data-wallet-mast]')`), '0x1111…1111', 'masthead shows the address');
    assert.equal(await js(`return localStorage.getItem('synovax.wallet')`), 'test.wallet');
    noProblems();
  });

  let adminToken;
  await step('admin publishes the contract: the server reads holders from the explorer', async () => {
    const login = await api('POST', '/api/admin/login', { password: ADMIN_KEY });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    adminToken = login.data.token;
    const { token: cur } = (await api('GET', '/api/admin/token', null, adminToken)).data;
    const saved = await api('PUT', '/api/admin/token', { status: 'live', contract: CA, explorerUrl: '', twitter: '', supply: '1,000,000,000', launchDate: '', rev: cur.rev, confirmContract: CA.slice(-6) }, adminToken);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const h = (await api('GET', '/api/token/holders')).data;
    assert.equal(h.available, true);
    assert.equal(h.holders.length, 20, 'top 20 only');
    assert.equal(h.holdersCount, 1234);
    assert.equal(h.decimals, 18);
    assert.equal(h.holders[0].pct, 12, '120M of 1B is 12%');
    assert.equal(h.holders[1].pct, 4.5);
    assert.equal(h.holders[0].label, 'LP Pool bx/b', 'names are stripped of < and >');
    assert.equal(h.holders[2].label, 'burn', 'the dead address is marked');
    assert.equal(h.holders[3].label, '', 'plain wallets have no label');
    const hits = explorerHits;
    await api('GET', '/api/token/holders');
    assert.equal(explorerHits, hits, 'second call within the TTL comes from the cache');
  });

  await step('reload: wallet restores without a prompt; wrong network offers a switch', async () => {
    await open('/');
    await until(`return visible('[data-wallet-facts]')`, 'restored wallet');
    assert.ok(!(await js('return window.__calls')).includes('eth_requestAccounts'), 'restore must not prompt');
    assert.equal(await js(`return txt('[data-w="network"]')`), 'wrong network');
    assert.equal(await js(`return visible('[data-wallet-switch]')`), true);
    assert.equal(await js(`return txt('[data-w="balance"]')`), 'switch network');
    await until(`return $$('[data-holders-list] tr').length === 20`, '20 holder rows');
    noProblems();
  });

  await step('switch adds Robinhood Chain (4663) and the balance and rank appear', async () => {
    await js(`$('[data-wallet-switch]').click(); return true`);
    await until(`return txt('[data-w="network"]') === 'robinhood chain'`, 'right network');
    const added = await js('return window.__added');
    assert.equal(added.chainId, '0x1237');
    assert.equal(added.chainName, 'Robinhood Chain');
    assert.deepEqual(added.rpcUrls, ['https://rpc.mainnet.chain.robinhood.com']);
    assert.deepEqual(added.blockExplorerUrls, ['https://robinhoodchain.blockscout.com']);
    await until(`return txt('[data-w="balance"]') === '45,000,000 · 4.50%'`, 'balance');
    assert.equal(await js(`return txt('[data-w="rank"]')`), '#2');
    assert.match(await js(`return txt('[data-wallet-msg]')`), /holder #2/);
    assert.equal(await js(`return visible('[data-wallet-switch]')`), false);
    noProblems();
  });

  await step('holders table: ranks, amounts, shares, you, burned, explorer links', async () => {
    const rows = await js(`return $$('[data-holders-list] tr').map((tr) => ({ cls: tr.className, cells: [...tr.cells].map((c) => c.textContent.trim()), href: tr.querySelector('a').getAttribute('href') }))`);
    assert.deepEqual(rows[0].cells, ['01', '0x2222…2222LP Pool bx/b', '120M', '12.00%']);
    assert.equal(rows[1].cls, 'is-you');
    assert.deepEqual(rows[1].cells, ['02', '0x1111…1111you', '45M', '4.50%']);
    assert.match(rows[2].cls, /is-burn/);
    assert.deepEqual(rows[2].cells, ['03', '0x0000…dEaDburned', '30M', '3.00%']);
    assert.equal(rows[0].href, `${EXPLORER}/address/0x2222222222222222222222222222222222222222`);
    assert.equal(rows[19].cells[0], '20');
    assert.equal(await js(`return $('[data-holders-all]').getAttribute('href')`), `${EXPLORER}/token/${CA}?tab=holders`);
    assert.equal(await js(`return txt('[data-holders-meta]')`), '1,234 holders');
    assert.equal(await js('return window.__dangerous ?? null'), null, 'never asked to sign or send');
    await shot('wallet-connected');
    await shot('wallet-connected', true);
    noProblems();
  });

  await step('phone width: nothing scrolls sideways', async () => {
    await page('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    const over = await js('return document.documentElement.scrollWidth - document.documentElement.clientWidth');
    const boardOver = await js(`const b = $('.tok-board').getBoundingClientRect(); return Math.max(0, b.right - document.documentElement.clientWidth)`);
    await page('Emulation.clearDeviceMetricsOverride'); await sleep(200);
    assert.ok(over <= 1, `page scrolls sideways by ${over}px`);
    assert.ok(boardOver <= 1, `wallet/holders board sticks out by ${boardOver}px`);
  });

  await step('explorer down: the last good list is served, marked cached', async () => {
    await new Promise((r) => explorer.close(r));
    explorer.closeAllConnections?.();
    await sleep(1700);
    const h = (await api('GET', '/api/token/holders')).data;
    assert.equal(h.available, true);
    assert.equal(h.stale, true);
    assert.equal(h.holders.length, 20);
  });

  await step('disconnect: forgets the wallet, also after a reload', async () => {
    await js(`$('[data-wallet-off]').click(); return true`);
    await until(`return !visible('[data-wallet-facts]') && visible('[data-wallet-btn]')`, 'disconnected card');
    assert.equal(await js(`return txt('[data-wallet-mast]')`), 'connect wallet');
    assert.equal(await js(`return $$('[data-holders-list] tr.is-you').length`), 0);
    assert.equal(await js(`return localStorage.getItem('synovax.wallet')`), null);
    await open('/');
    await sleep(800);
    assert.equal(await js(`return visible('[data-wallet-facts]')`), false, 'stays disconnected');
    await until(`return txt('[data-holders-meta]').includes('cached')`, 'cached holders on the page');
    noProblems();
  });

  console.log(`\nwallet test: ${passed} checks passed`);
} finally {
  ws.close(); browser.kill(); server.kill(); explorer.close();
}
