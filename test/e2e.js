// End-to-end test: a real server, a "browser" built from the shared crypto,
// and the real connector spoken to over MCP stdio. Run: npm test
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';
import { totpAt, currentStep } from '../server/totp.js';
import { WORDS } from '../shared/wordlist.js';
import { leafHash, merkleRoot, merkleProof, verifyProof, toHex, verifySealChain, GENESIS } from '../shared/merkle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEAL_MS = 1500;
const ADMIN_KEY = `test_admin_${'x'.repeat(40)}`;
let passed = 0;
const step = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}`); throw e; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- unit checks

await step('wordlist has 256 unique words', () => {
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256);
});

await step('recovery phrase round-trips', async () => {
  const p = C.newRecoveryPhrase();
  assert.equal(p.split(' ').length, 24);
  assert.equal(C.phraseToEntropy(p).length, 24);
  assert.equal((await C.keysFromRecovery(p)).authKey, (await C.keysFromRecovery(`  ${p.toUpperCase()} `)).authKey);
});

await step('AES-GCM rejects the wrong context (AAD) and tampering', async () => {
  const k = C.randomBytes(32);
  const t = await C.encryptJSON(k, { a: 1 }, 'memory:x:body');
  assert.deepEqual(await C.decryptJSON(k, t, 'memory:x:body'), { a: 1 });
  await assert.rejects(C.decryptJSON(k, t, 'memory:y:body'));
  const bad = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
  await assert.rejects(C.decryptJSON(k, bad, 'memory:x:body'));
});

await step('sealed boxes open only with the right private key', async () => {
  const a = await C.newBoxKeyPair();
  const b = await C.newBoxKeyPair();
  const box = await C.boxSeal(a.pub, { hi: 'there' });
  assert.deepEqual(await C.boxOpen(a.priv, a.pub, box), { hi: 'there' });
  await assert.rejects(C.boxOpen(b.priv, b.pub, box));
});

await step('Merkle proofs verify for every leaf, 1 to 9 leaves', async () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, () => toHex(C.randomBytes(32)));
    const root = await merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = await merkleProof(leaves, i);
      assert.ok(await verifyProof(leaves[i], proof, root), `n=${n} i=${i}`);
      assert.ok(!(await verifyProof(leaves[(i + 1) % n === i ? i : (i + 1) % n], proof, root)) || n === 1);
    }
  }
});

// ---------- start the server

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: '0', DATA_DIR: dataDir, SEAL_PERIOD_MS: String(SEAL_MS), ADMIN_KEY, KDF_ITERATIONS: '100000', TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
const BASE = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /running at (http:\/\/\S+)/.exec(String(d)); if (m) resolve(m[1]); });
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  setTimeout(() => reject(new Error('server did not start')), 10_000);
});

let connector, connector2;
const cleanup = async () => {
  connector?.proc.kill();
  connector2?.proc.kill();
  server.kill();
  await sleep(200);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
};

async function api(method, p, body, token, extraHeaders = {}) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer s.${token}` } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status === 200, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

// ---------- MCP client for the connector

function startConnector(appKey) {
  const proc = spawn(process.execPath, ['connector/index.js'], { cwd: ROOT, env: { ...process.env, VAULT_APP_KEY: appKey, VAULT_URL: BASE }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const waiting = new Map();
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15_000);
  });
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(r.result, JSON.stringify(r));
    return { text: r.result.content[0].text, isError: !!r.result.isError };
  };
  return { proc, rpc, tool };
}

try {
  // ---------- the "browser": create a vault
  const username = 'tester';
  const pass = 'correct horse battery staple';
  const salt = C.b64(C.randomBytes(16));
  const iterations = 100_000; // lower in tests to keep them fast; the app uses 600k
  const k = await C.keysFromPassphrase(pass, salt, iterations);
  const phrase = C.newRecoveryPhrase();
  const rec = await C.keysFromRecovery(phrase);
  const vk = C.randomBytes(32);
  const box = await C.newBoxKeyPair();
  let token;

  await step('register a vault', async () => {
    const r = await ok('POST', '/api/auth/register', {
      username, salt, iterations, authKey: k.authKey, recoveryAuthKey: rec.authKey,
      wrappedVaultKey: await C.wrapKey(k.kek, vk, 'vk/passphrase'),
      wrappedVaultKeyRecovery: await C.wrapKey(rec.kek, vk, 'vk/recovery'),
      boxPub: box.pub, boxPrivWrapped: await C.wrapKey(vk, box.priv, 'box/private'),
    });
    token = r.token;
    assert.equal((await api('POST', '/api/auth/register', { username })).status, 400);
  });

  await step('wrong passphrase is refused; right one unwraps the vault key', async () => {
    const s = await ok('POST', '/api/auth/salt', { username });
    assert.equal(s.salt, salt);
    const wrong = await C.keysFromPassphrase('not my passphrase', s.salt, s.iterations);
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: wrong.authKey })).status, 401);
    const right = await C.keysFromPassphrase(pass, s.salt, s.iterations);
    const r = await ok('POST', '/api/auth/login', { username, authKey: right.authKey });
    assert.deepEqual(await C.unwrapKey(right.kek, r.keys.wrappedVaultKey, 'vk/passphrase'), vk);
    const ghost = await ok('POST', '/api/auth/salt', { username: 'nobody-here' });
    assert.equal(ghost.salt, (await ok('POST', '/api/auth/salt', { username: 'nobody-here' })).salt, 'fake salt is stable');
  });

  await step('the salt answer does not tell which names exist; other round counts are refused', async () => {
    const real = await ok('POST', '/api/auth/salt', { username });
    const ghost = await ok('POST', '/api/auth/salt', { username: 'nobody-here' });
    assert.equal(ghost.iterations, real.iterations);
    assert.equal((await ok('GET', '/api/config')).iterations, iterations);
    const other = await C.keysFromPassphrase('x', salt, 100_000);
    const r = await api('POST', '/api/auth/register', {
      username: 'odd-rounds', salt, iterations: 600_000, authKey: other.authKey, recoveryAuthKey: other.authKey,
      wrappedVaultKey: await C.wrapKey(other.kek, vk, 'x'), wrappedVaultKeyRecovery: await C.wrapKey(other.kek, vk, 'x'),
      boxPub: box.pub, boxPrivWrapped: await C.wrapKey(vk, box.priv, 'x'),
    });
    assert.equal(r.status, 400);
  });

  await step('a stranger guessing wrong cannot lock the owner out', async () => {
    const s = await ok('POST', '/api/auth/salt', { username });
    const wrong = await C.keysFromPassphrase('a stranger guessing', s.salt, s.iterations);
    const stranger = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 10; i++) assert.equal((await api('POST', '/api/auth/login', { username, authKey: wrong.authKey }, null, stranger)).status, 401);
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: wrong.authKey }, null, stranger)).status, 429, 'the guesser is slowed down');
    const right = await C.keysFromPassphrase(pass, s.salt, s.iterations);
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: right.authKey })).status, 200, 'the owner still gets in');
    // the IP the server trusts is the one the (single) proxy appended, not what the client wrote before it
    const spoof = { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' };
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: wrong.authKey }, null, spoof)).status, 429, 'a faked left-hand IP does not reset the limit');
  });

  // folders and memories
  const folders = {};
  const addFolder = async (name) => {
    const id = C.newId();
    const key = C.randomBytes(32);
    await ok('PUT', `/api/folders/${id}`, { meta: await C.encryptJSON(key, { name }, `folder:${id}:meta`), wrappedKey: await C.wrapKey(vk, key, `folder:${id}:key`) }, token);
    folders[name] = { id, key };
  };
  const addMemory = async (folder, title, body, tags = []) => {
    const id = C.newId();
    const { key, id: folderId } = folders[folder];
    await ok('PUT', `/api/memories/${id}`, {
      folderId,
      head: await C.encryptJSON(key, { title, tags, snippet: body.slice(0, 240) }, `memory:${id}:head`),
      body: await C.encryptJSON(key, { title, body, tags }, `memory:${id}:body`),
    }, token);
    return id;
  };
  let workMem, healthMem;
  await step('add folders and memories', async () => {
    await addFolder('Work');
    await addFolder('Health');
    workMem = await addMemory('Work', 'Morning person', 'I do my best work before nine in the morning.', ['habits']);
    await addMemory('Work', 'Answer style', 'Short answers first, details after. Metric units.', ['preferences']);
    healthMem = await addMemory('Health', 'Allergy', 'I am allergic to penicillin.', ['medical']);
    const v = await ok('GET', '/api/vault', null, token);
    assert.equal(v.folders.length, 2);
    assert.equal(v.memories.length, 3);
  });

  // connect an app with access to Work only
  const appId = C.newId();
  const secret = C.randomBytes(32);
  const appKey = C.formatAppKey(appId, secret);
  await step('create an app key with access to Work only', async () => {
    const m = await C.appKeyMaterial(secret);
    await ok('PUT', `/api/apps/${appId}`, {
      meta: await C.encryptJSON(vk, { name: 'Claude Desktop', secret: C.b64(secret) }, `app:${appId}:meta`),
      authKey: m.auth, vouch: await C.vouchFor(m.vouch, appId, box.pub), canSuggest: true,
      folderKeys: [{ folderId: folders.Work.id, wrappedKey: await C.wrapKey(m.wrap, folders.Work.key, `app:${appId}:folder:${folders.Work.id}`) }],
    }, token);
  });

  connector = startConnector(appKey);
  await step('connector speaks MCP', async () => {
    const init = await connector.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    connector.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await connector.rpc('tools/list', {});
    assert.deepEqual(tools.result.tools.map((t) => t.name), ['list_folders', 'search_memories', 'read_memory', 'suggest_memory']);
  });

  await step('the app sees only Work', async () => {
    const r = await connector.tool('list_folders');
    assert.match(r.text, /Work/);
    assert.doesNotMatch(r.text, /Health/);
  });

  await step('search finds Work memories and never Health ones', async () => {
    const r = await connector.tool('search_memories', { query: 'nine morning' });
    assert.match(r.text, /Morning person/);
    const r2 = await connector.tool('search_memories', { query: 'penicillin allergy' });
    assert.match(r2.text, /^Nothing in the vault matches/);
    assert.doesNotMatch(r2.text, /Allergy|allergic/);
  });

  await step('search forgives plurals, typos and everyday synonyms', async () => {
    assert.match((await connector.tool('search_memories', { query: 'mornings' })).text, /Morning person/, 'plural');
    assert.match((await connector.tool('search_memories', { query: 'metrik units' })).text, /Answer style/, 'one typo');
    assert.match((await connector.tool('search_memories', { query: 'my job' })).text, /Morning person/, 'job ~ work');
    assert.match((await connector.tool('search_memories', { query: 'answers' })).text.split('\n')[0], /Answer style/, 'title match ranks first');
    assert.match((await connector.tool('search_memories', { query: 'zebra quantum' })).text, /^Nothing in the vault matches/);
  });

  await step('read_memory returns the full text; Health is refused', async () => {
    const r = await connector.tool('read_memory', { id: workMem });
    assert.match(r.text, /before nine in the morning/);
    const r2 = await connector.tool('read_memory', { id: healthMem });
    assert.ok(r2.isError);
  });

  await step('a suggestion arrives sealed and only the vault can open it', async () => {
    const r = await connector.tool('suggest_memory', { title: 'Prefers metric units', body: 'Asked twice for kilometres and Celsius.', folder: 'Work', reason: 'Came up twice' });
    assert.match(r.text, /Suggested/);
    const { suggestions } = await ok('GET', '/api/inbox', null, token);
    assert.equal(suggestions.length, 1);
    const d = await C.boxOpen(box.priv, box.pub, suggestions[0].box);
    assert.equal(d.title, 'Prefers metric units');
    assert.equal(d.folderHint, 'Work');
  });

  await step('a swapped inbox key is caught by the vouch check', async () => {
    const evil = await C.newBoxKeyPair();
    const { vouch } = await C.appKeyMaterial(secret);
    assert.equal(await C.checkVouch(vouch, appId, box.pub, await C.vouchFor(vouch, appId, box.pub)), true);
    assert.equal(await C.checkVouch(vouch, appId, evil.pub, await C.vouchFor(vouch, appId, box.pub)), false);
  });

  await step('every read is in the log, and is sealed with a proof that checks out', async () => {
    await sleep(SEAL_MS * 2 + 500);
    const { entries } = await ok('GET', '/api/log', null, token);
    const actions = entries.map((e) => e.action);
    for (const a of ['folders', 'list', 'read', 'suggest']) assert.ok(actions.includes(a), `log has ${a}`);
    assert.ok(entries.some((e) => e.action === 'read' && e.target === workMem));
    const sealed = entries.filter((e) => e.sealSeq != null);
    assert.ok(sealed.length >= 1, 'some entries are sealed');
    for (const e of sealed) {
      const leaf = await leafHash({ id: e.id, ts: e.ts, vault_id: (await ok('GET', '/api/vault', null, token)).keys.vaultId, app_id: e.appId, action: e.action, target: e.target, salt: e.salt });
      assert.equal(leaf, e.leaf);
      const p = await ok('GET', `/api/log/${e.id}/proof`, null, token);
      const pub = await ok('GET', `/api/seals/${p.seal.seq}`);
      assert.ok(await verifyProof(leaf, p.proof, pub.root));
      // a changed entry no longer matches its seal
      const forged = await leafHash({ id: e.id, ts: e.ts, vault_id: 'x', app_id: e.appId, action: 'read', target: healthMem, salt: e.salt });
      assert.ok(!(await verifyProof(forged, p.proof, pub.root)));
    }
  });

  await step('the database holds no plaintext', async () => {
    const files = (await readdir(dataDir)).filter((f) => f.startsWith('vault.db'));
    const raw = Buffer.concat(await Promise.all(files.map((f) => readFile(path.join(dataDir, f))))).toString('latin1');
    for (const secretText of ['penicillin', 'before nine', 'Morning person', 'Health', 'Claude Desktop', 'metric', pass, phrase.split(' ').slice(0, 3).join(' ')]) {
      assert.ok(!raw.includes(secretText), `found "${secretText}" in the database`);
    }
  });

  await step('changing permissions: removing Work cuts the app off', async () => {
    await ok('PATCH', `/api/apps/${appId}`, { folderKeys: [] }, token);
    const r = await connector.tool('read_memory', { id: workMem });
    assert.ok(r.isError);
  });

  await step('replacing a folder key: the old key opens nothing new, apps that keep access still read', async () => {
    // a second app that keeps access to Work, with the old key already cached in its connector
    const appB = C.newId(), secretB = C.randomBytes(32), mB = await C.appKeyMaterial(secretB);
    await ok('PUT', `/api/apps/${appB}`, {
      meta: await C.encryptJSON(vk, { name: 'Cursor', secret: C.b64(secretB) }, `app:${appB}:meta`), authKey: mB.auth,
      vouch: await C.vouchFor(mB.vouch, appB, box.pub), canSuggest: false,
      folderKeys: [{ folderId: folders.Work.id, wrappedKey: await C.wrapKey(mB.wrap, folders.Work.key, `app:${appB}:folder:${folders.Work.id}`) }],
    }, token);
    connector2 = startConnector(C.formatAppKey(appB, secretB));
    await connector2.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.match((await connector2.tool('read_memory', { id: workMem })).text, /before nine/);

    const oldKey = folders.Work.key;
    const newKey = C.randomBytes(32);
    const fid = folders.Work.id;
    const inWork = (await ok('GET', '/api/vault', null, token)).memories.filter((m) => m.folderId === fid);
    const memories = await Promise.all(inWork.map(async (m) => {
      const d = await C.decryptJSON(oldKey, m.body, `memory:${m.id}:body`);
      return { id: m.id, head: await C.encryptJSON(newKey, { title: d.title, tags: d.tags, snippet: d.body.slice(0, 240) }, `memory:${m.id}:head`), body: await C.encryptJSON(newKey, d, `memory:${m.id}:body`) };
    }));
    const rotation = {
      meta: await C.encryptJSON(newKey, { name: 'Work' }, `folder:${fid}:meta`), wrappedKey: await C.wrapKey(vk, newKey, `folder:${fid}:key`),
      memories, grants: [{ appId: appB, wrappedKey: await C.wrapKey(mB.wrap, newKey, `app:${appB}:folder:${fid}`) }],
    };
    assert.equal((await api('POST', `/api/folders/${fid}/rotate`, { ...rotation, memories: memories.slice(1) }, token)).status, 409, 'a missing memory is refused');
    assert.equal((await api('POST', `/api/folders/${fid}/rotate`, { ...rotation, grants: [{ appId: C.newId(), wrappedKey: rotation.wrappedKey }] }, token)).status, 400, 'an unknown app is refused');
    const r = await ok('POST', `/api/folders/${fid}/rotate`, rotation, token);
    assert.equal(r.rotated, inWork.length);
    folders.Work.key = newKey;

    const after = (await ok('GET', '/api/vault', null, token)).memories.find((m) => m.id === workMem);
    await assert.rejects(C.decryptJSON(oldKey, after.body, `memory:${workMem}:body`), 'the old key no longer opens it');
    assert.match((await C.decryptJSON(newKey, after.body, `memory:${workMem}:body`)).body, /before nine/);
    assert.match((await connector2.tool('read_memory', { id: workMem })).text, /before nine/, 'the connector picks up the new key');
    assert.match((await connector2.tool('search_memories', { query: 'nine' })).text, /Morning person/);
    assert.ok((await connector.tool('read_memory', { id: workMem })).isError, 'the app without access still gets nothing');
  });

  await step('signed-in devices can be listed and signed out', async () => {
    const other = (await ok('POST', '/api/auth/login', { username, authKey: k.authKey }, null, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' })).token;
    const { sessions } = await ok('GET', '/api/sessions', null, token);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    assert.ok(sessions.some((s) => s.agent === 'Chrome on Windows'));
    assert.ok(sessions.every((s) => !('token_hash' in s) && !('tokenHash' in s)), 'token hashes stay private');
    const one = sessions.find((s) => s.agent === 'Chrome on Windows');
    await ok('DELETE', `/api/sessions/${one.id}`, null, token);
    assert.equal((await api('GET', '/api/vault', null, other)).status, 401, 'that device is signed out');
    const third = (await ok('POST', '/api/auth/login', { username, authKey: k.authKey })).token;
    const r = await ok('POST', '/api/sessions/sign-out-others', null, token);
    assert.ok(r.signedOut >= 1);
    assert.equal((await api('GET', '/api/vault', null, third)).status, 401);
    assert.equal((await api('GET', '/api/vault', null, token)).status, 200, 'this device stays signed in');
  });

  await step('the seals form an unbroken hash chain', async () => {
    const { seals } = await ok('GET', '/api/seals?from=1');
    assert.ok(seals.length >= 1);
    assert.equal(seals[0].seq, 1);
    assert.equal(seals[0].prev, GENESIS);
    assert.ok((await verifySealChain(seals, GENESIS)).ok);
    const tampered = seals.map((s, i) => (i === 0 ? { ...s, root: 'f'.repeat(64) } : s));
    assert.ok(!(await verifySealChain(tampered, GENESIS)).ok, 'a changed seal breaks the chain');
  });

  await step('a backup of the database is written on start', async () => {
    const files = await readdir(path.join(dataDir, 'backups'));
    assert.ok(files.some((f) => /^vault-\d{8}-\d{6}\.db$/.test(f)), files.join(','));
  });

  await step('revoking the app stops its key on the next request', async () => {
    await ok('DELETE', `/api/apps/${appId}`, null, token);
    const r = await connector.tool('list_folders');
    assert.ok(r.isError);
    assert.match(r.text, /revoked/);
  });

  await step('two-step sign-in: a code is needed, and a code works only once', async () => {
    assert.equal((await ok('GET', '/api/account', null, token)).twoFactor, false);
    const { secret, uri } = await ok('POST', '/api/account/2fa/setup', null, token);
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.equal((await api('POST', '/api/account/2fa/enable', { code: '000000' }, token)).status, 400, 'a wrong code does not turn it on');
    const step0 = currentStep();
    await ok('POST', '/api/account/2fa/enable', { code: totpAt(secret, step0) }, token);
    assert.equal((await ok('GET', '/api/account', null, token)).twoFactor, true);
    assert.ok(!JSON.stringify(await ok('GET', '/api/account', null, token)).includes(secret), 'the secret is never sent back');

    const noCode = await api('POST', '/api/auth/login', { username, authKey: k.authKey });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.data.needTotp, true);
    const wrongPass = await api('POST', '/api/auth/login', { username, authKey: (await C.keysFromPassphrase('nope', salt, iterations)).authKey });
    assert.ok(!wrongPass.data.needTotp, 'a wrong passphrase does not reveal that 2FA is on');
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: k.authKey, totp: totpAt(secret, step0) })).status, 401, 'the code used to turn it on cannot be used again');
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: k.authKey, totp: totpAt(secret, step0 + 1) })).status, 200, 'a fresh code works');
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: k.authKey, totp: totpAt(secret, step0 + 1) })).status, 401, 'and only once');
    assert.equal((await api('POST', '/api/account/2fa/disable', { code: '123456' }, token)).status, 400, 'turning it off needs a real code');
    const raw = (await readdir(dataDir)).filter((f) => f.startsWith('vault.db'));
    const bytes = Buffer.concat(await Promise.all(raw.map((f) => readFile(path.join(dataDir, f))))).toString('latin1');
    assert.ok(!bytes.includes(secret), 'the 2FA secret is not stored in the clear');
  });

  await step('recovery phrase opens the vault and sets a new passphrase', async () => {
    const rk = await C.keysFromRecovery(phrase);
    const r = await ok('POST', '/api/auth/recover', { username, recoveryAuthKey: rk.authKey });
    assert.equal(r.twoFactorReset, true, 'the 24 words also turn two-step sign-in off');
    assert.deepEqual(await C.unwrapKey(rk.kek, r.keys.wrappedVaultKeyRecovery, 'vk/recovery'), vk);
    const newSalt = C.b64(C.randomBytes(16));
    const nk = await C.keysFromPassphrase('a brand new passphrase', newSalt, iterations);
    await ok('PUT', '/api/account/passphrase', { salt: newSalt, iterations, authKey: nk.authKey, wrappedVaultKey: await C.wrapKey(nk.kek, vk, 'vk/passphrase') }, r.token);
    assert.equal((await api('GET', '/api/vault', null, token)).status, 401, 'old sessions are signed out');
    assert.equal((await api('POST', '/api/auth/login', { username, authKey: k.authKey })).status, 401, 'old passphrase no longer works');
    token = (await ok('POST', '/api/auth/login', { username, authKey: nk.authKey })).token;
  });

  await step('deleting the account removes it, and public seals still stand', async () => {
    const sealsBefore = (await ok('GET', '/api/seals')).seals.length;
    assert.equal((await api('DELETE', '/api/account', { confirm: 'wrong' }, token)).status, 400);
    await ok('DELETE', '/api/account', { confirm: username }, token);
    assert.equal((await api('GET', '/api/vault', null, token)).status, 401);
    assert.equal((await ok('GET', '/api/stats')).vaults, 0);
    assert.equal((await ok('GET', '/api/seals')).seals.length, sealsBefore);
  });

  await step('admin panel: only the admin key can publish the token details', async () => {
    const adm = async (method, p, body, t) => {
      const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer adm.${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const pub0 = (await ok('GET', '/api/token'));
    assert.equal(pub0.status, 'pre-launch');
    assert.equal(pub0.contract, '');
    assert.equal((await adm('GET', '/api/admin/token')).status, 401, 'no session');
    assert.equal((await adm('GET', '/api/admin/token', null, 'made-up')).status, 401, 'bad session');
    assert.equal((await adm('GET', '/api/admin/token', null, token)).status, 401, 'a vault session is not an admin session');
    assert.equal((await adm('POST', '/api/admin/login', { key: 'wrong' })).status, 401, 'wrong key');
    const { token: at } = (await adm('POST', '/api/admin/login', { key: ADMIN_KEY })).data;
    assert.ok(at, 'logged in');
    const { token: cur } = (await adm('GET', '/api/admin/token', null, at)).data;
    const CA = '0x00000000000000000000000000000000000000aB';
    const base = { status: 'pre-launch', contract: '', explorerUrl: '', twitter: '', supply: '', launchDate: '', rev: cur.rev };
    assert.equal((await adm('PUT', '/api/admin/token', { ...base, contract: '0x123' }, at)).status, 400, 'bad address');
    assert.equal((await adm('PUT', '/api/admin/token', { ...base, status: 'live' }, at)).status, 400, 'live needs an address');
    assert.equal((await adm('PUT', '/api/admin/token', { ...base, explorerUrl: 'http://x.test/a' }, at)).status, 400, 'explorer must be https');
    assert.equal((await adm('PUT', '/api/admin/token', { ...base, twitter: '<script>' }, at)).status, 400, 'bad handle');
    const next = { ...base, status: 'live', contract: CA, twitter: 'https://x.com/test_handle', supply: '1,000' };
    assert.equal((await adm('PUT', '/api/admin/token', next, at)).status, 400, 'a new address must be confirmed');
    assert.equal((await adm('PUT', '/api/admin/token', { ...next, confirmContract: '0000aa' }, at)).status, 400, 'wrong confirmation');
    const saved = await adm('PUT', '/api/admin/token', { ...next, confirmContract: CA.slice(-6) }, at);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const pub = await ok('GET', '/api/token');
    assert.equal(pub.status, 'live');
    assert.equal(pub.contract, CA);
    assert.equal(pub.twitter, 'test_handle', 'the X url becomes a handle');
    assert.equal(pub.rev, undefined, 'rev stays private');
    assert.equal((await adm('PUT', '/api/admin/token', { ...next, supply: '2,000' }, at)).status, 409, 'a stale rev is refused');
    const { history } = (await adm('GET', '/api/admin/token', null, at)).data;
    for (const f of ['status', 'contract', 'twitter', 'supply']) assert.ok(history.some((h) => h.field === f), `history has ${f}`);
    assert.equal((await adm('POST', '/api/admin/logout', null, at)).status, 200);
    assert.equal((await adm('GET', '/api/admin/token', null, at)).status, 401, 'signed out');
  });

  await step('static pages are served with a strict CSP', async () => {
    const res = await fetch(`${BASE}/vault/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${BASE}/shared/crypto.js`)).status, 200);
    const mf = await fetch(`${BASE}/vault/manifest.webmanifest`);
    assert.equal(mf.headers.get('content-type'), 'application/manifest+json');
    for (const icon of (await mf.json()).icons) assert.equal((await fetch(BASE + icon.src)).status, 200, icon.src);
    assert.equal((await fetch(`${BASE}/../server/index.js`)).status, 404);
    assert.equal((await fetch(`${BASE}/%2e%2e/server/index.js`)).status, 404);
  });

  console.log(`\n${passed} checks passed.`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
