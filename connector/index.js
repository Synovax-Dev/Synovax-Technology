#!/usr/bin/env node
// The vault connector: a small MCP server (stdio) that an AI app starts on your
// own computer. It decrypts here, with the app key you gave it; the vault server
// only ever sends it ciphertext, and only for the folders you granted this app.
//
//   VAULT_APP_KEY  the key made in the vault under Apps (vlt_app.<id>.<secret>)
//   VAULT_URL      where the vault server runs (default http://127.0.0.1:8787)
//   VAULT_SEMANTIC meaning-based search model: bge-m3 (default), e5-small or off
import readline from 'node:readline';
import * as C from '../shared/crypto.js';
import { APP_NAME } from '../shared/brand.js';
import { createSemantic } from './semantic.js';

const VERSION = '0.1.0';
const BASE = (process.env.VAULT_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const INFO_TTL_MS = 60_000;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const log = (...a) => process.stderr.write(`[${APP_NAME} connector] ${a.join(' ')}\n`);

// ---------- talking to the vault

let me = null; // { appId, auth, wrap, vouchKey }
let info = null; // { at, canSuggest, boxPub, vouchOk, folders: Map(id -> { id, name, key }) }

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer a.${me.appId}.${me.auth}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) info = null;
    throw new Error(data.error || `The vault answered ${res.status}.`);
  }
  return data;
}

let semantic = null;
function semanticSearch() {
  if (semantic) return semantic;
  try {
    const { appId, secret } = C.parseAppKey(process.env.VAULT_APP_KEY ?? '');
    semantic = createSemantic({ log, appId, secret });
  } catch { semantic = { enabled: false, warm() {}, async scores() { return null; } }; } // no valid key: nothing to index
  return semantic;
}

async function ready(force = false) {
  if (!me) {
    if (!process.env.VAULT_APP_KEY) throw new Error('VAULT_APP_KEY is not set. Make an app key in your vault under Apps and put it in this connector\'s env.');
    const { appId, secret } = C.parseAppKey(process.env.VAULT_APP_KEY);
    const m = await C.appKeyMaterial(secret);
    me = { appId, auth: m.auth, wrap: m.wrap, vouchKey: m.vouch };
  }
  if (info && !force && Date.now() - info.at < INFO_TTL_MS) return info;
  const r = await call('/api/app/info');
  const folders = new Map();
  for (const f of r.folders) {
    try {
      const key = await C.unwrapKey(me.wrap, f.wrappedKey, `app:${me.appId}:folder:${f.id}`);
      const meta = await C.decryptJSON(key, f.meta, `folder:${f.id}:meta`);
      folders.set(f.id, { id: f.id, name: meta.name, key });
    } catch {
      log(`could not open folder ${f.id}; skipping it`);
    }
  }
  // The vault vouched for its inbox key with a key only it and this app know.
  const vouchOk = await C.checkVouch(me.vouchKey, me.appId, r.boxPub, r.vouch).catch(() => false);
  if (!vouchOk) log('the vault\'s inbox key failed its check; suggestions are disabled');
  info = { at: Date.now(), canSuggest: r.canSuggest, boxPub: r.boxPub, vouchOk, folders };
  return info;
}

function folderByName(name) {
  const n = String(name).trim().toLowerCase();
  return [...info.folders.values()].find((f) => f.name.toLowerCase() === n || f.id === name);
}

async function heads(folderId, retried = false) {
  const { memories } = await call(`/api/app/memories${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`);
  const out = [];
  let stale = false;
  for (const m of memories) {
    const f = info.folders.get(m.folderId);
    if (!f) { stale = true; continue; }
    try {
      const h = await C.decryptJSON(f.key, m.head, `memory:${m.id}:head`);
      out.push({ id: m.id, folder: f.name, title: h.title, tags: h.tags ?? [], snippet: h.snippet ?? '', updatedAt: m.updatedAt });
    } catch { stale = true; }
  }
  // A folder key may have been rotated since the cached info: fetch the keys again once.
  if (stale && !retried) { await ready(true); return heads(folderId, true); }
  out.fullList = !folderId;
  return out;
}

// Word scores and meaning scores together. Without the model, words only.
async function search(query, all) {
  const terms = [...new Set(words(query))];
  const kw = new Map(rank(terms, all).map((x) => [x.m.id, terms.length ? x.s : 0]));
  const sem = semanticSearch();
  const res = sem.enabled ? await sem.scores(query, all) : null;
  const maxKw = Math.max(0, ...kw.values()) || 1;
  if (!res) {
    const note = sem.enabled && !sem.failed ? 'Meaning-based search is still starting on this computer, so these are word matches only.' : '';
    return { hits: all.filter((m) => kw.get(m.id) > 0).map((m) => ({ m, s: kw.get(m.id), how: 'words' })), note };
  }
  const { floor, strong, words: wordWeight } = sem.spec;
  const hits = [];
  for (const m of all) {
    const cos = res.scores.get(m.id);
    const k = kw.get(m.id) / maxKw;
    if (cos == null) { if (k > 0) hits.push({ m, s: k * wordWeight, how: 'words' }); continue; }
    if (cos < floor && k === 0) continue;
    hits.push({ m, s: cos + wordWeight * k, how: cos >= strong ? 'strong' : k > 0 ? 'words + meaning' : 'possible' });
  }
  const note = res.pending ? `${res.pending} memories are still being indexed for meaning-based search; they may be missing until it finishes.` : '';
  return { hits, note };
}

// ---------- search
// Still keyword search (no model, nothing leaves this computer), but forgiving:
// accents folded, light stemming (English and Indonesian), one typo allowed in
// longer words, a few everyday synonyms, and rarer words count for more (BM25-like).

const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const STOP = new Set((
  'the a an and or but of to in on at by for with from as is am are was were be been being my me mine i you your yours it its this that these those ' +
  'what which who whom whose when where why how do does did done have has had can could should would will shall may might must ' +
  'most more much many very so too also just not no any some all there their they them we our us he she his her him than then ' +
  'about into over under again only own same such get got like ' +
  'yang dan di ke dari ini itu untuk dengan atau saya aku gue gua kamu anda dia ia kami kita mereka ada apa apakah kapan mana dimana ' +
  'bagaimana gimana kenapa mengapa siapa punya sudah udah akan bisa harus paling lebih sangat juga tidak nggak gak bukan ya dong sih kah lah nya pada oleh'
).split(' '));

function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  // Indonesian: drop common prefixes and suffixes (kan, an, i, nya, lah, kah)
  let x = w.replace(/(nya|lah|kah|pun)$/, '');
  x = x.replace(/^(meng|meny|mem|men|me|peng|peny|pem|pen|pe|ber|be|ter|di|ke|se)(?=[a-z]{4,})/, '');
  x = x.replace(/(kan|an|i)$/, (m, _s, off) => (off >= 4 ? '' : m));
  // English
  x = x.replace(/(ies)$/, 'y').replace(/(sses)$/, 'ss').replace(/([^s])s$/, '$1')
    .replace(/(ing|edly|ed|ly)$/, (m, _s, off) => (off >= 4 ? '' : m));
  return x.length >= 3 ? x : w;
}

const SYNONYMS = [
  ['job', 'work', 'career', 'occupation', 'kerja', 'pekerjaan', 'profession'],
  ['like', 'love', 'enjoy', 'prefer', 'favorite', 'favourite', 'suka', 'senang'],
  ['dislike', 'hate', 'avoid', 'benci', 'tidak suka'],
  ['food', 'eat', 'diet', 'meal', 'makan', 'makanan'],
  ['drink', 'coffee', 'tea', 'minum', 'kopi', 'teh'],
  ['family', 'wife', 'husband', 'kid', 'child', 'children', 'son', 'daughter', 'keluarga', 'anak', 'istri', 'suami'],
  ['home', 'live', 'city', 'address', 'rumah', 'tinggal', 'kota'],
  ['health', 'allergy', 'allergic', 'medical', 'medicine', 'sakit', 'alergi', 'kesehatan', 'obat'],
  ['language', 'speak', 'bahasa'],
  ['name', 'call', 'nama', 'panggil'],
  ['birthday', 'born', 'age', 'ulang tahun', 'lahir', 'umur'],
  ['project', 'building', 'proyek'],
  ['style', 'tone', 'format', 'answer', 'reply', 'gaya', 'jawaban'],
].map((g) => g.map((w) => stem(fold(w))));
const synonymsOf = (t) => [...new Set(SYNONYMS.filter((g) => g.includes(t)).flat())].filter((x) => x !== t);

const tokens = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
const words = tokens; // kept for the empty-query check

function nearMiss(a, b) { // edit distance <= 1, for words of 5+ letters
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// How well one query term matches a field's tokens: exact 1, prefix 0.8, synonym 0.6, typo 0.5.
function termHit(t, toks) {
  let best = 0;
  const syn = synonymsOf(t);
  for (const w of toks) {
    if (w === t) return 1;
    if (t.length >= 3 && (w.startsWith(t) || t.startsWith(w) && w.length >= 3)) best = Math.max(best, 0.8);
    else if (syn.includes(w)) best = Math.max(best, 0.6);
    else if (nearMiss(t, w)) best = Math.max(best, 0.5);
  }
  return best;
}

// Ranks memories for a query. Field weights: title 3, tags 2, text 1; each
// term weighted by how rare it is across what this app can read.
function rank(terms, mems) {
  if (!terms.length) return mems.map((m) => ({ m, s: 1 }));
  const docs = mems.map((m) => ({ m, title: tokens(m.title), tags: tokens(m.tags.join(' ')), text: tokens(m.snippet) }));
  const N = docs.length;
  return docs.map((d) => {
    let s = 0;
    for (const t of terms) {
      const df = docs.filter((x) => termHit(t, x.title) || termHit(t, x.tags) || termHit(t, x.text)).length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      s += idf * (3 * termHit(t, d.title) + 2 * termHit(t, d.tags) + termHit(t, d.text));
    }
    return { m: d.m, s };
  });
}

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

// ---------- tools

const TOOLS = [
  {
    name: 'list_folders',
    description: `List the folders of the user's ${APP_NAME} memory vault that you are allowed to read. Use this to see what kinds of personal context exist (e.g. "About me", "Work").`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async () => {
      const i = await ready(true);
      if (!i.folders.size) return 'No folders are shared with this app yet. The user can grant folders in their vault under Apps.';
      return [...i.folders.values()].map((f) => `- ${f.name}`).join('\n');
    },
  },
  {
    name: 'search_memories',
    description: `Search the user's personal memory vault for facts, preferences and context about them. Call this before answering anything that depends on who the user is, how they like answers, or their projects. Ask in plain words, in any language ("what should I avoid eating", "when am I most productive"): it matches by meaning as well as by words. Each result says how it matched (strong, possible, words); treat "possible" as a lead to check, not a fact. Returns titles and short snippets; use read_memory for the full text. An empty query lists the most recent memories.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for. Leave empty for the most recent memories.' },
        folder: { type: 'string', description: 'Optional folder name to search in.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    run: async ({ query = '', folder, limit = 10 }) => {
      await ready();
      let folderId;
      if (folder) {
        const f = folderByName(folder);
        if (!f) return `There is no folder called "${folder}" that this app may read. Use list_folders.`;
        folderId = f.id;
      }
      const all = await heads(folderId);
      const n = Math.min(50, Math.max(1, limit));
      const fmtHit = ({ m, how }) =>
        `[${m.id}] ${m.title} (${m.folder}, ${day(m.updatedAt)})${m.tags.length ? ` #${m.tags.join(' #')}` : ''}${how ? ` · match: ${how}` : ''}\n    ${m.snippet.replace(/\s+/g, ' ').slice(0, 200)}`;
      if (!String(query).trim()) {
        if (!all.length) return 'The folders this app may read are empty.';
        return [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, n).map((m) => fmtHit({ m })).join('\n');
      }
      const { hits, note } = await search(query, all);
      const found = hits.sort((a, b) => b.s - a.s || b.m.updatedAt - a.m.updatedAt).slice(0, n);
      if (!found.length) return `Nothing in the vault matches "${query}".${note ? ` (${note})` : ''}`;
      const legend = found.some((x) => x.how === 'possible') ? '\n(“possible” = loosely related by meaning; check it fits before relying on it.)' : '';
      return found.map(fmtHit).join('\n') + legend + (note ? `\n(${note})` : '');
    },
  },
  {
    name: 'read_memory',
    description: 'Read one memory from the vault in full, by the id that search_memories returned (the text in [brackets]). Each read is recorded in the user\'s read log.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Memory id' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async ({ id }) => {
      await ready();
      const m = await call(`/api/app/memories/${encodeURIComponent(String(id).replace(/[[\]]/g, ''))}`);
      const open = (f) => C.decryptJSON(f.key, m.body, `memory:${m.id}:body`);
      let f = info.folders.get(m.folderId);
      let d = f ? await open(f).catch(() => null) : null;
      if (!d) { // unknown folder or a rotated key: fetch the keys again once
        f = (await ready(true)).folders.get(m.folderId);
        if (!f) throw new Error('This app cannot open that folder.');
        d = await open(f);
      }
      return `# ${d.title}\nFolder: ${f.name} · updated ${day(m.updatedAt)}${d.tags?.length ? ` · tags: ${d.tags.join(', ')}` : ''}\n\n${d.body}`;
    },
  },
  {
    name: 'suggest_memory',
    description: 'Suggest a new memory for the user to keep, when you learn something durable about them (a preference, a fact, an ongoing project). It is sealed for the user\'s vault and waits in their inbox until they approve it; it is not saved directly. Only suggest things worth remembering across conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title, e.g. "Prefers metric units"' },
        body: { type: 'string', description: 'The memory itself, written about the user in plain words' },
        tags: { type: 'array', items: { type: 'string' } },
        folder: { type: 'string', description: 'Folder name you think fits' },
        reason: { type: 'string', description: 'One line on why this is worth remembering' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    run: async ({ title, body, tags = [], folder, reason }) => {
      const i = await ready(true);
      if (!i.canSuggest) return 'This app is not allowed to suggest memories. The user can turn it on in their vault under Apps.';
      if (!i.vouchOk) throw new Error('The vault\'s inbox key could not be verified, so nothing was sent.');
      const box = await C.boxSeal(i.boxPub, {
        title: String(title).slice(0, 200), body: String(body).slice(0, 20_000),
        tags: (Array.isArray(tags) ? tags : []).map(String).slice(0, 20), folderHint: folder ? String(folder) : null,
        reason: reason ? String(reason).slice(0, 500) : null, at: Date.now(),
      });
      await call('/api/app/suggest', { method: 'POST', body: JSON.stringify({ box }) });
      return 'Suggested. It is waiting in the user\'s inbox for them to approve.';
    },
  },
];

// ---------- MCP over stdio (newline-delimited JSON-RPC 2.0)

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      semanticSearch().warm(); // load the model in the background, ready for the first search
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${APP_NAME.toLowerCase()}-connector`, version: VERSION },
        instructions: `This server reads the user's personal ${APP_NAME} memory vault: what they chose to let you know about them. Search it before answering questions that depend on the user's preferences, background or projects. Use suggest_memory for durable new facts; the user approves each one.`,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...t }) => t) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
      try {
        return { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.replace(/^﻿/, ''); // some shells prepend a byte-order mark
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (msg.id === undefined || msg.id === null) return; // a notification: nothing to answer
  try {
    send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg.method, msg.params) });
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
  }
});
rl.on('close', () => process.exit(0));
log(`ready, vault at ${BASE}`);
