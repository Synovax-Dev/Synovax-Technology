// Right-click menu: save a selection, a page or a chat to the vault's inbox.
import { buildSuggestion, grabPage, isChat, send } from './core.js';

const MENUS = [
  { id: 'save-selection', title: 'Save selection to SYNOVAX', contexts: ['selection'] },
  { id: 'save-page', title: 'Save this page or chat to SYNOVAX', contexts: ['page'] },
];

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  for (const m of MENUS) chrome.contextMenus.create(m);
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

const badge = async (tabId, text, color) => {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
};

async function saveFromMenu(info, tab) {
  const { config } = await chrome.storage.local.get('config');
  if (!config?.appKey) { chrome.runtime.openOptionsPage(); return { ok: false, error: 'not set up' }; }
  try {
    let page = { title: tab?.title ?? '', url: info.pageUrl ?? tab?.url ?? '', selection: info.selectionText ?? '', text: '' };
    if (info.menuItemId === 'save-page' || !page.selection) {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPage });
      page = { ...page, ...r.result };
    }
    const kind = info.menuItemId === 'save-selection' ? 'selection' : isChat(page.url) ? 'chat' : 'page';
    await send(config, buildSuggestion({ kind, title: page.title, url: page.url, text: kind === 'selection' ? page.selection : page.text }));
    const last = { ok: true, at: Date.now(), title: page.title };
    await chrome.storage.local.set({ last });
    await badge(tab.id, '✓', '#1f7a3a');
    return last;
  } catch (e) {
    const last = { ok: false, at: Date.now(), error: e.message };
    await chrome.storage.local.set({ last });
    await badge(tab.id, '!', '#b3261e').catch(() => {});
    return last;
  }
}
// the tests call it the same way the menu does
globalThis.saveFromMenu = saveFromMenu;
chrome.contextMenus.onClicked.addListener((info, tab) => { saveFromMenu(info, tab); });
