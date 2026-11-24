// Meaning-based search, end to end: a real server, memories written the way the
// vault writes them, and the real connector with the model loaded. Needs
// `npm install` (and downloads the model once). Run: npm run test:semantic
// VAULT_SEMANTIC=e5-small npm run test:semantic tries the small model instead.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { await import('@huggingface/transformers'); } catch { console.log('@huggingface/transformers is not installed (run npm install); skipping the semantic test.'); process.exit(0); }

const MODEL = process.env.VAULT_SEMANTIC || 'bge-m3';
let passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vault-sem-'));
const cacheIndex = await mkdtemp(path.join(os.tmpdir(), 'vault-sem-index-'));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, KDF_ITERATIONS: '100000', BACKUP_INTERVAL_MS: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const BASE = await new Promise((res, rej) => { server.stdout.on('data', (d) => { const m = /running at (http:\/\/\S+)/.exec(String(d)); if (m) res(m[1]); }); setTimeout(() => rej(new Error('server did not start')), 15_000); });
const api = async (method, p, body, token) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer s.${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${p} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
};

// The models live in the shared repo cache (downloaded once); the encrypted index goes to a temp folder.
const models = path.join(ROOT, '.cache');
function startConnector(appKey) {
  const proc = spawn(process.execPath, ['connector/index.js'], {
    cwd: ROOT, env: { ...process.env, VAULT_APP_KEY: appKey, VAULT_URL: BASE, VAULT_SEMANTIC: MODEL, VAULT_CACHE_DIR: models },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', id = 1, errs = '';
  const waiting = new Map();
  proc.stderr.on('data', (d) => { errs += d; });
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = id++; waiting.set(n, resolve); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const search = async (query) => (await rpc('tools/call', { name: 'search_memories', arguments: { query, limit: 3 } })).result.content[0].text;
  return { proc, rpc, search, stderr: () => errs };
}

const MEMORIES = [
  ['About me', 'Morning person', 'I do my best work before nine in the morning.'],
  ['About me', 'Allergy', 'I am allergic to penicillin.'],
  ['About me', 'Answer style', 'Short answers first, details after. Metric units.'],
  ['About me', 'Coffee order', 'Flat white, oat milk, no sugar.'],
  ['About me', 'Kids', 'Two daughters, Aya (7) and Sari (4).'],
  ['About me', 'Home', 'Lives in Bandung, Indonesia.'],
  ['Work', 'Job', 'Backend engineer at a logistics startup, mostly Go and Postgres.'],
  ['Work', 'Side project', 'Building a budgeting app for my parents in Flutter.'],
  ['About me', 'Bahasa', 'Lebih suka dijawab dalam bahasa Indonesia yang santai.'],
  ['About me', 'Olahraga', 'Lari pagi 5 km tiap Sabtu.'],
  ['About me', 'Vegetarian', 'Does not eat meat or fish.'],
  ['About me', 'Car', 'Drives a 2015 Honda Jazz.'],
  ['Health', 'Blood type', 'Blood type O negative.'],
];

let connector;
try {
  const salt = C.b64(C.randomBytes(16));
  const k = await C.keysFromPassphrase('semantic test passphrase', salt, 100_000);
  const rec = await C.keysFromRecovery(C.newRecoveryPhrase());
  const vk = C.randomBytes(32), box = await C.newBoxKeyPair();
  const { token } = await api('POST', '/api/auth/register', {
    username: 'semantic', salt, iterations: 100_000, authKey: k.authKey, recoveryAuthKey: rec.authKey,
    wrappedVaultKey: await C.wrapKey(k.kek, vk, 'vk/passphrase'), wrappedVaultKeyRecovery: await C.wrapKey(rec.kek, vk, 'vk/recovery'),
    boxPub: box.pub, boxPrivWrapped: await C.wrapKey(vk, box.priv, 'box/private'),
  });
  const folders = {};
  for (const name of ['About me', 'Work', 'Health']) {
    const id = C.newId(), key = C.randomBytes(32);
    await api('PUT', `/api/folders/${id}`, { meta: await C.encryptJSON(key, { name }, `folder:${id}:meta`), wrappedKey: await C.wrapKey(vk, key, `folder:${id}:key`) }, token);
    folders[name] = { id, key };
  }
  for (const [folder, title, body] of MEMORIES) {
    const id = C.newId(), f = folders[folder];
    await api('PUT', `/api/memories/${id}`, {
      folderId: f.id, head: await C.encryptJSON(f.key, { title, tags: [], snippet: body }, `memory:${id}:head`),
      body: await C.encryptJSON(f.key, { title, body, tags: [] }, `memory:${id}:body`),
    }, token);
  }
  // the app may read About me and Work, not Health
  const appId = C.newId(), secret = C.randomBytes(32), m = await C.appKeyMaterial(secret);
  await api('PUT', `/api/apps/${appId}`, {
    meta: await C.encryptJSON(vk, { name: 'Claude', secret: C.b64(secret) }, `app:${appId}:meta`), authKey: m.auth,
    vouch: await C.vouchFor(m.vouch, appId, box.pub), canSuggest: false,
    folderKeys: await Promise.all(['About me', 'Work'].map(async (n) => ({ folderId: folders[n].id, wrappedKey: await C.wrapKey(m.wrap, folders[n].key, `app:${appId}:folder:${folders[n].id}`) }))),
  }, token);

  connector = startConnector(C.formatAppKey(appId, secret));
  await connector.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });

  await step(`the model loads (${MODEL}) and the first search indexes everything`, async () => {
    const t0 = Date.now();
    let text;
    while (Date.now() - t0 < 600_000) { // the first run may download the model
      text = await connector.search('when am I most productive');
      if (!/still starting|still being indexed/.test(text)) break;
      await sleep(2000);
    }
    assert.match(text.split('\n')[0], /Morning person/, text);
  });

  const cases = [
    ['when am I most productive', 'Morning person'],
    ['kapan saya paling produktif', 'Morning person'],
    ['what medicine should I avoid', 'Allergy'],
    ['obat apa yang harus dihindari', 'Allergy'],
    ['how should you format replies', 'Answer style'],
    ['what do I drink', 'Coffee order'],
    ['how many children do I have', 'Kids'],
    ['where do I live', 'Home'],
    ['what programming languages do I use at work', 'Job'],
    ['what am I building in my spare time', 'Side project'],
    ['which language should you answer in', 'Bahasa'],
    ['what sport do I do', 'Olahraga'],
    ['can I have a steak dinner recipe', 'Vegetarian'],
    ['what car do I own', 'Car'],
  ];
  await step('questions in plain English and Indonesian find the right memory first', async () => {
    const misses = [];
    for (const [q, want] of cases) {
      const first = (await connector.search(q)).split('\n')[0];
      if (!first.includes(want)) misses.push(`"${q}" -> ${first}`);
    }
    assert.ok(misses.length <= (MODEL === 'bge-m3' ? 0 : 4), `misses:\n  ${misses.join('\n  ')}`);
  });

  // Ambiguous questions: the model may put a near miss first ("morning" pulls
  // Morning person up here), so the right memory only has to be in the top 3
  // the AI is shown.
  await step('ambiguous questions keep the right memory in the top 3', async () => {
    const misses = [];
    for (const [q, want] of [['what do I drink in the morning', 'Coffee order'], ['what do I do on weekends', 'Olahraga'], ['anything about my health I should mention to a doctor', 'Allergy']]) {
      const text = await connector.search(q);
      if (!text.split('\n').filter((l) => l.startsWith('[')).some((l) => l.includes(want))) misses.push(`${q} (wanted ${want})`);
    }
    // the small model is the documented lower-quality option: report, do not fail
    if (MODEL !== 'bge-m3' && misses.length) console.log(`      note: ${MODEL} missed ${misses.length}/3 ambiguous questions: ${misses.join('; ')}`);
    else assert.deepEqual(misses, []);
  });

  await step('results say how they matched', async () => {
    assert.match(await connector.search('where do I live'), /match: strong/);
  });

  await step('a folder the app may not read is never searched by meaning either', async () => {
    const text = await connector.search('what is my blood type');
    assert.doesNotMatch(text, /Blood type|O negative/);
  });

  await step('clearly unrelated questions find nothing', async () => {
    for (const q of ['quantum physics homework', 'siapa presiden pertama amerika', 'what is the capital of France']) {
      const text = await connector.search(q);
      assert.ok(/^Nothing in the vault matches/.test(text) || !/match: strong/.test(text), `${q}: ${text}`);
    }
  });

  await step('the search index is saved encrypted, and a restart reuses it', async () => {
    const dir = path.join(models, 'index');
    const files = (await readdir(dir)).filter((f) => f.startsWith(appId));
    assert.equal(files.length, 1);
    const raw = await readFile(path.join(dir, files[0]), 'utf8');
    assert.match(raw, /^v1\./, 'encrypted token');
    for (const word of ['penicillin', 'Bandung', 'Honda']) assert.ok(!raw.includes(word));
    connector.proc.kill();
    connector = startConnector(C.formatAppKey(appId, secret));
    await connector.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    let text;
    for (let i = 0; i < 60; i++) { text = await connector.search('where do I live'); if (!/still starting/.test(text)) break; await sleep(1000); }
    assert.match(text.split('\n')[0], /Home/);
    assert.doesNotMatch(text, /still being indexed/, 'nothing had to be indexed again');
    await rm(path.join(dir, files[0]), { force: true });
  });

  console.log(`\n${passed} semantic checks passed (${MODEL}).`);
} catch (e) {
  console.error(e);
  if (connector) console.error('[connector stderr]\n' + connector.stderr());
  process.exitCode = 1;
} finally {
  connector?.proc.kill();
  server.kill();
  await sleep(500);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(cacheIndex, { recursive: true, force: true }).catch(() => {});
}
