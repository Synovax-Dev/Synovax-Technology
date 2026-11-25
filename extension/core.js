// The extension's logic, with no browser APIs in it, so the same file runs in
// the extension and in the tests. It acts like any connected app that may only
// suggest: it sends a memory to the vault's inbox, sealed so only the vault can
// open it, and it can never read the vault.
import * as C from './lib/crypto.js';

export const DEFAULT_URL = 'https://synovax.tech';
// The suggestion box may be up to 200,000 characters; leave room for encryption.
const MAX_BODY_BYTES = 100_000;

export function cleanVaultUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim() || DEFAULT_URL); } catch { throw new Error('That is not a web address.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('Use an https:// address (http:// only for this computer).');
  if (u.username || u.password) throw new Error('The address must not contain a name or password.');
  return u.origin;
}

// Cut text to a number of UTF-8 bytes without splitting a character.
export function cutBytes(text, max = MAX_BODY_BYTES) {
  const s = String(text ?? '');
  const bytes = C.te.encode(s);
  if (bytes.length <= max) return { text: s, cut: false };
  let out = C.td.decode(bytes.subarray(0, max));
  if (out.endsWith('�')) out = out.slice(0, -1);
  return { text: out.trimEnd(), cut: true };
}

const CHAT_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'www.perplexity.ai', 'perplexity.ai'];
export const isChat = (url) => { try { return CHAT_HOSTS.includes(new URL(url).hostname); } catch { return false; } };

/** What to save, as a suggestion. kind: "selection", "page" or "chat". */
export function buildSuggestion({ kind, title, url, text, note, folder }) {
  const name = String(title ?? '').replace(/\s+/g, ' ').trim();
  const where = /^https?:\/\//.test(String(url ?? '')) ? String(url) : '';
  const label = { selection: 'Selection', chat: 'Chat', page: 'Page' }[kind];
  if (!label) throw new Error('Unknown kind of save.');
  const content = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!content) throw new Error(kind === 'selection' ? 'Select some text on the page first.' : 'This page has no text to save.');
  const head = [note && String(note).trim(), where && `From: ${where}`].filter(Boolean).join('\n');
  const { text: body, cut } = cutBytes(head ? `${head}\n\n${content}` : content);
  const first = content.split('\n')[0].slice(0, 80);
  return {
    title: (kind === 'selection' ? first : name || first || label).slice(0, 200),
    body: cut ? `${body}\n\n[cut to fit: the rest was not saved]` : body,
    tags: [kind === 'chat' ? 'chat' : kind === 'page' ? 'web page' : 'clipping'],
    folder: String(folder ?? '').trim().slice(0, 60) || null,
    reason: `${label} saved from the browser extension${name ? `: ${name.slice(0, 120)}` : ''}`,
  };
}

// Runs inside the page (chrome.scripting), so it must not use anything from this
// module. On an AI chat, the conversation is in <main>.
export function grabPage() {
  const selection = String(globalThis.getSelection?.() ?? '').trim();
  const root = document.querySelector('main') || document.body;
  return { title: document.title, url: location.href, selection, text: String(root?.innerText ?? '').slice(0, 400_000) };
}

async function call(vaultUrl, path, auth, body, fetchImpl) {
  const res = await fetchImpl(vaultUrl + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer a.${auth.appId}.${auth.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The vault answered ${res.status}.`);
  return data;
}

/** Check a key against the vault: it must be allowed to suggest, and the vault's inbox key must carry the vault's tag. */
export async function connect({ vaultUrl, appKey }, fetchImpl = fetch) {
  const origin = cleanVaultUrl(vaultUrl);
  const { appId, secret } = C.parseAppKey(appKey);
  const m = await C.appKeyMaterial(secret);
  const auth = { appId, token: m.auth };
  const info = await call(origin, '/api/app/info', auth, null, fetchImpl);
  if (!info.canSuggest) throw new Error('This key may not suggest memories. In your vault, open Apps, choose Edit access for it, and allow suggestions.');
  if (!(await C.checkVouch(m.vouch, appId, info.boxPub, info.vouch))) throw new Error('The vault\'s inbox key did not pass its check, so nothing will be sent.');
  return { origin, auth, boxPub: info.boxPub, folders: info.folders.length };
}

/** Seal a suggestion for the vault's inbox and send it. */
export async function send(config, suggestion, fetchImpl = fetch) {
  const c = await connect(config, fetchImpl);
  const s = suggestion;
  const box = await C.boxSeal(c.boxPub, {
    title: s.title, body: s.body, tags: s.tags, folderHint: s.folder, reason: s.reason, at: Date.now(),
  });
  return call(c.origin, '/api/app/suggest', c.auth, { box }, fetchImpl);
}
