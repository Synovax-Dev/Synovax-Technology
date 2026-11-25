// The popup: pick a selection, the page or the chat, add a note, send it to the inbox.
import { buildSuggestion, grabPage, isChat, send } from './core.js';

const $ = (s) => document.querySelector(s);
const form = $('[data-save]');
const status = (text, kind = '') => { const s = $('[data-status]'); s.textContent = text; s.className = `status ${kind}`; };
for (const b of document.querySelectorAll('[data-open-options]')) b.addEventListener('click', () => chrome.runtime.openOptionsPage());

const { config } = await chrome.storage.local.get('config');
if (!config?.appKey) {
  $('[data-setup]').hidden = false;
} else {
  form.hidden = false;
  // ?tab=<id> when the popup is opened as a page (the tests do), else the tab you are on
  const asked = Number(new URLSearchParams(location.search).get('tab'));
  const tab = asked ? await chrome.tabs.get(asked) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  let page = { title: tab?.title ?? '', url: tab?.url ?? '', selection: '', text: '' };
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPage });
    page = r.result;
  } catch {
    status('This page cannot be read by extensions (a browser page or the store). Try another tab.', 'bad');
  }
  const chat = isChat(page.url);
  const buttons = [...document.querySelectorAll('[data-kind]')];
  $('[data-kind=chat]').hidden = !chat;
  $('[data-kind=page]').hidden = chat;
  $('[data-kind=selection]').disabled = !page.selection;
  let kind = page.selection ? 'selection' : chat ? 'chat' : 'page';
  const textFor = (k) => (k === 'selection' ? page.selection : page.text);
  const pick = (k) => {
    kind = k;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.kind === k));
    const t = textFor(k);
    form.elements.title.value = k === 'selection' ? t.split('\n')[0].slice(0, 80) : page.title.slice(0, 200);
    $('[data-preview]').textContent = t ? `${t.length.toLocaleString()} characters: “${t.slice(0, 140).replace(/\s+/g, ' ')}${t.length > 140 ? '…' : ''}”` : 'Nothing to save here.';
  };
  for (const b of buttons) b.addEventListener('click', () => pick(b.dataset.kind));
  pick(kind);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    status('Sealing…');
    try {
      const s = buildSuggestion({ kind, title: form.elements.title.value, url: page.url, text: textFor(kind), note: form.elements.note.value, folder: form.elements.folder.value });
      await send(config, s);
      status('Saved to your inbox. Approve it in your vault.', 'ok');
    } catch (err) {
      status(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });
}
