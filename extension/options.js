// Settings: the vault address and the app key, checked against the vault before saving.
import { DEFAULT_URL, cleanVaultUrl, connect } from './core.js';

const form = document.querySelector('[data-config]');
const status = (text, kind = '') => { const s = document.querySelector('[data-status]'); s.textContent = text; s.className = `status ${kind}`; };

const { config } = await chrome.storage.local.get('config');
form.elements.vaultUrl.value = config?.vaultUrl ?? DEFAULT_URL;
if (config?.appKey) status('Connected. Right-click a page, or use the toolbar button, to save.', 'ok');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const vaultUrl = cleanVaultUrl(form.elements.vaultUrl.value);
    // synovax.tech and this computer are allowed by the manifest; any other address is asked for once,
    // first thing, while the click still counts as yours
    const listed = vaultUrl === DEFAULT_URL || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(vaultUrl);
    if (!listed && !(await chrome.permissions.request({ origins: [`${vaultUrl}/*`] }))) throw new Error('The extension needs permission to reach that address.');
    status('Checking the key…');
    const appKey = form.elements.appKey.value.trim();
    await connect({ vaultUrl, appKey });
    await chrome.storage.local.set({ config: { vaultUrl, appKey } });
    form.elements.appKey.value = '';
    status('Connected. Right-click a page, or use the toolbar button, to save.', 'ok');
  } catch (err) {
    status(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

document.querySelector('[data-forget]').addEventListener('click', async () => {
  await chrome.storage.local.remove(['config', 'last']);
  status('The key was removed from this browser. Revoke it in your vault too.');
});

// for the tests: the form is wired up
document.body.dataset.ready = '1';
