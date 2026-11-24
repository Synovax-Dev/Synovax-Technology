// Connect wallet + top holders for the $SYNOVAX section.
//
// The wallet part is read only: it asks for the address (eth_requestAccounts),
// can switch the wallet to Robinhood Chain, and reads the balance with eth_call.
// It never asks for a signature or a transaction.
// The holders table comes from /api/token/holders (the server reads the chain's
// explorer and caches it), so the page itself only ever talks to its own origin.
// Everything is written with textContent, never as HTML.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const CHAIN = {
  chainId: '0x1237', // 4663
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};
const REMEMBER = 'synovax.wallet';
const HOLDERS_EVERY_MS = 60_000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const state = {
  token: null,       // what /api/token published
  holders: null,     // last /api/token/holders answer
  providers: [],     // EIP-6963 announcements: { info, provider }
  provider: null,
  account: '',
  chainId: '',
  balance: null,     // BigInt
  decimals: null,
  supply: null,      // BigInt
};

// ---------- helpers
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const explorer = () => (state.holders?.explorer || CHAIN.blockExplorerUrls[0]).replace(/\/+$/, '');
const store = {
  get() { try { return localStorage.getItem(REMEMBER) || ''; } catch { return ''; } },
  set(v) { try { v ? localStorage.setItem(REMEMBER, v) : localStorage.removeItem(REMEMBER); } catch {} },
};

// 1234567890000000000000n, 18 → "1,234.56"
export function fmtUnits(value, decimals, maxFrac = 2) {
  const neg = value < 0n, v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base, frac = v % base;
  const f = decimals > 0 ? frac.toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '') : '';
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole === 0n && !f && frac > 0n) return '< 0.' + '0'.repeat(maxFrac - 1) + '1';
  return (neg ? '-' : '') + w + (f ? '.' + f : '');
}

// big numbers in a short form: 1.25B, 980.4M, 12.5K
export function fmtCompact(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const units = [[10n ** 12n, 'T'], [10n ** 9n, 'B'], [10n ** 6n, 'M'], [10n ** 3n, 'K']];
  for (const [u, s] of units) {
    if (whole >= u) {
      const tenths = (whole * 10n) / u;
      const t = tenths.toString();
      const out = t.length > 1 ? `${t.slice(0, -1)}.${t.slice(-1)}` : `0.${t}`;
      return out.replace(/\.0$/, '') + s;
    }
  }
  return fmtUnits(value, decimals, 2);
}

const pctText = (p) => (p == null ? '' : p >= 0.01 ? `${p.toFixed(2)}%` : p > 0 ? '< 0.01%' : '0%');

function walletError(e) {
  if (e?.code === 4001) return 'Request cancelled in your wallet.';
  if (e?.code === -32002) return 'Your wallet already has a request open. Check the wallet window.';
  return 'Your wallet did not answer. Unlock it and try again.';
}

// ---------- wallet discovery (EIP-6963, with window.ethereum as the fallback)
function discover() {
  addEventListener('eip6963:announceProvider', (e) => {
    const d = e.detail;
    if (!d?.provider || !d?.info?.uuid) return;
    if (state.providers.some((p) => p.info.uuid === d.info.uuid)) return;
    state.providers.push(d);
    render();
  });
  dispatchEvent(new Event('eip6963:requestProvider'));
}

function available() {
  if (state.providers.length) return state.providers;
  if (window.ethereum) return [{ info: { uuid: 'injected', name: 'Browser wallet', rdns: 'injected', icon: '' }, provider: window.ethereum }];
  return [];
}

// ---------- wallet calls
async function rpc(method, params = []) { return state.provider.request({ method, params }); }

function attach(entry) {
  if (state.provider === entry.provider) return;
  detach();
  state.provider = entry.provider;
  state.rdns = entry.info.rdns;
  const p = state.provider;
  state.onAccounts = (a) => { state.account = Array.isArray(a) && ADDR.test(a[0] ?? '') ? a[0] : ''; if (!state.account) forget(); refresh(); };
  state.onChain = (c) => { state.chainId = String(c).toLowerCase(); refresh(); };
  p.on?.('accountsChanged', state.onAccounts);
  p.on?.('chainChanged', state.onChain);
}

function detach() {
  const p = state.provider;
  if (p?.removeListener) { p.removeListener('accountsChanged', state.onAccounts); p.removeListener('chainChanged', state.onChain); }
  state.provider = null;
}

function forget() {
  detach();
  Object.assign(state, { account: '', chainId: '', balance: null, decimals: null, supply: null });
  store.set('');
}

async function connect(entry) {
  attach(entry);
  say('Waiting for your wallet…');
  try {
    const accounts = await rpc('eth_requestAccounts');
    state.account = ADDR.test(accounts?.[0] ?? '') ? accounts[0] : '';
    if (!state.account) throw new Error('no account');
    state.chainId = String(await rpc('eth_chainId')).toLowerCase();
    store.set(entry.info.rdns);
    say('');
    await refresh();
  } catch (e) {
    forget();
    say(walletError(e));
    render();
  }
}

async function disconnect() {
  const p = state.provider;
  forget();
  render();
  // where the wallet supports it, also drop the site's permission
  try { await p?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch {}
}

async function switchChain() {
  say('Waiting for your wallet…');
  try {
    await rpc('wallet_switchEthereumChain', [{ chainId: CHAIN.chainId }]);
  } catch (e) {
    // 4902: the wallet does not know the chain yet
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902) {
      try { await rpc('wallet_addEthereumChain', [CHAIN]); }
      catch (e2) { say(walletError(e2)); return; }
    } else { say(walletError(e)); return; }
  }
  try { state.chainId = String(await rpc('eth_chainId')).toLowerCase(); } catch {}
  say('');
  refresh();
}

// silent restore: eth_accounts never opens a prompt
async function restore() {
  const rdns = store.get();
  if (!rdns) return;
  const entry = available().find((p) => p.info.rdns === rdns);
  if (!entry) return;
  attach(entry);
  try {
    const accounts = await rpc('eth_accounts');
    if (!ADDR.test(accounts?.[0] ?? '')) { forget(); return; }
    state.account = accounts[0];
    state.chainId = String(await rpc('eth_chainId')).toLowerCase();
    refresh();
  } catch { forget(); }
}

const word = (data) => data.slice(2).padStart(64, '0');
async function readUint(contract, data) {
  const out = await rpc('eth_call', [{ to: contract, data }, 'latest']);
  if (typeof out !== 'string' || !/^0x[0-9a-fA-F]*$/.test(out) || out === '0x') throw new Error('bad answer');
  return BigInt(out);
}

let reading = 0;
async function refresh() {
  render();
  const ca = state.token?.contract;
  if (!state.account || state.chainId !== CHAIN.chainId || !ADDR.test(ca ?? '')) return;
  const ticket = ++reading;
  try {
    const [bal, dec, sup] = await Promise.all([
      readUint(ca, '0x70a08231' + word(state.account)), // balanceOf(address)
      state.decimals == null ? readUint(ca, '0x313ce567') : Promise.resolve(BigInt(state.decimals)), // decimals()
      readUint(ca, '0x18160ddd'), // totalSupply()
    ]);
    if (ticket !== reading) return;
    Object.assign(state, { balance: bal, decimals: Number(dec), supply: sup });
  } catch {
    if (ticket !== reading) return;
    Object.assign(state, { balance: null });
    say('Could not read your balance. Try again in a moment.');
  }
  render();
}

// ---------- holders
async function loadHolders() {
  try {
    const res = await fetch('/api/token/holders', { cache: 'no-store' });
    if (!res.ok) return;
    state.holders = await res.json();
  } catch { return; }
  render();
}

// ---------- drawing
let message = '';
function say(m) { message = m; const el = $('[data-wallet-msg]'); if (el) render(); }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render() {
  renderButtons();
  renderCard();
  renderHolders();
}

function renderButtons() {
  for (const b of $$('[data-wallet-mast]')) {
    b.textContent = state.account ? short(state.account) : 'connect wallet';
    b.classList.toggle('is-on', !!state.account);
    b.setAttribute('aria-label', state.account ? `Wallet ${state.account}, show details` : 'Connect wallet');
  }
}

function renderCard() {
  const card = $('[data-wallet]');
  if (!card) return;
  const facts = $('[data-wallet-facts]', card), msg = $('[data-wallet-msg]', card);
  const pick = $('[data-wallet-pick]', card), main = $('[data-wallet-btn]', card);
  const sw = $('[data-wallet-switch]', card), off = $('[data-wallet-off]', card);
  const on = !!state.account, right = state.chainId === CHAIN.chainId;
  const ca = state.token?.contract;

  card.classList.toggle('is-on', on);
  main.hidden = on;
  off.hidden = !on;
  sw.hidden = !on || right;
  facts.hidden = !on;
  pick.replaceChildren();
  pick.hidden = true;

  if (!on) {
    const list = available();
    main.disabled = false;
    if (!list.length) {
      msg.textContent = message || 'No browser wallet found. Install one such as MetaMask, Rabby or Coinbase Wallet, then reload this page.';
      main.disabled = true;
    } else {
      msg.textContent = message || 'Connect to see your $SYNOVAX balance and where you stand among holders.';
    }
    return;
  }

  const set = (k, v, dim = false) => { const d = $(`[data-w="${k}"]`, facts); d.textContent = v; d.classList.toggle('tok-dim', dim); };
  set('address', short(state.account));
  $('[data-w="address"]', facts).title = state.account;
  set('network', right ? 'robinhood chain' : 'wrong network', !right);
  if (!ADDR.test(ca ?? '')) {
    set('balance', 'after launch', true); set('rank', 'after launch', true);
    msg.textContent = message || 'Connected. Your balance shows here once the contract address is posted.';
    return;
  }
  if (!right) {
    set('balance', 'switch network', true); set('rank', 'switch network', true);
    msg.textContent = message || 'Your wallet is on another network. Switch to Robinhood Chain to read your balance.';
    return;
  }
  if (state.balance == null || state.decimals == null) {
    set('balance', 'reading…', true); set('rank', '…', true);
    msg.textContent = message || 'Reading your balance from Robinhood Chain.';
    return;
  }
  const pct = state.supply > 0n ? Number((state.balance * 1_000_000n) / state.supply) / 10_000 : null;
  set('balance', `${fmtUnits(state.balance, state.decimals)}${pct != null && state.balance > 0n ? ` · ${pctText(pct)}` : ''}`, state.balance === 0n);
  const mine = state.holders?.holders?.find((h) => same(h.address, state.account));
  set('rank', mine ? `#${mine.rank}` : state.balance > 0n ? `outside top ${state.holders?.holders?.length || 20}` : 'not a holder yet', !mine);
  msg.textContent = message || (mine ? `You are holder #${mine.rank}. Your row is marked in the list.` : 'Connected to Robinhood Chain.');
}

// shown when the visitor has more than one wallet installed
function showPicker() {
  const card = $('[data-wallet]');
  const pick = $('[data-wallet-pick]', card);
  const list = available();
  pick.replaceChildren(...list.map((entry) => {
    const b = el('button', 'tw-wallet');
    b.type = 'button';
    if (/^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(entry.info.icon || '')) {
      const img = el('img'); img.src = entry.info.icon; img.alt = ''; img.width = 20; img.height = 20; b.append(img);
    }
    b.append(el('span', '', entry.info.name || 'Wallet'));
    b.addEventListener('click', () => { pick.hidden = true; connect(entry); });
    return b;
  }));
  pick.hidden = false;
  $('[data-wallet-msg]', card).textContent = 'Choose a wallet.';
  pick.querySelector('button')?.focus();
}

function startConnect() {
  message = '';
  const list = available();
  if (!list.length) { render(); return; }
  if (list.length === 1) connect(list[0]); else showPicker();
}

function renderHolders() {
  const box = $('[data-holders]');
  if (!box) return;
  const body = $('[data-holders-list]', box), table = $('table', box);
  const empty = $('[data-holders-empty]', box), meta = $('[data-holders-meta]', box), all = $('[data-holders-all]', box);
  const h = state.holders;
  const ca = state.token?.contract;

  if (!ADDR.test(ca ?? '') || !h || !h.available || !h.holders?.length) {
    table.hidden = true; all.hidden = true;
    empty.hidden = false;
    if (!ADDR.test(ca ?? '')) { empty.textContent = 'The top 20 holders appear here once the contract address is posted.'; meta.textContent = 'at launch'; }
    else if (h && !h.available && h.reason === 'source-unreachable') { empty.textContent = 'Robinhood Chain is not answering right now. The list will load on its own.'; meta.textContent = 'retrying'; }
    else if (h?.available) { empty.textContent = 'No holders yet.'; meta.textContent = 'live'; }
    else { empty.textContent = 'Loading holders…'; meta.textContent = ''; }
    return;
  }

  const dec = Number.isInteger(h.decimals) ? h.decimals : 18;
  const rows = h.holders.map((x) => {
    const tr = el('tr');
    if (same(x.address, state.account)) tr.className = 'is-you';
    if (x.label === 'burn') tr.classList.add('is-burn');
    tr.append(el('td', 'th-rank', String(x.rank).padStart(2, '0')));
    const cell = el('td'), who = el('div', 'th-who');
    cell.append(who);
    const a = el('a', 'th-addr', short(x.address));
    a.href = `${explorer()}/address/${x.address}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = x.address;
    who.append(a);
    if (same(x.address, state.account)) who.append(el('span', 'th-tag th-tag--you', 'you'));
    else if (x.label === 'burn') who.append(el('span', 'th-tag th-tag--burn', 'burned'));
    else if (x.label) who.append(el('span', 'th-tag', x.label));
    tr.append(cell);
    let v = 0n; try { v = BigInt(x.value); } catch {}
    tr.append(el('td', 'th-amt', fmtCompact(v, dec)));
    const shareCell = el('td'), share = el('div', 'th-share');
    shareCell.append(share);
    const bar = el('span', 'th-bar'); const fill = el('i');
    fill.style.width = `${Math.max(Math.min(x.pct ?? 0, 100), 0)}%`;
    bar.append(fill);
    share.append(bar, el('span', 'th-pct', pctText(x.pct)));
    tr.append(shareCell);
    return tr;
  });
  body.replaceChildren(...rows);
  table.hidden = false; empty.hidden = true;
  all.href = `${explorer()}/token/${ca}?tab=holders`; all.hidden = false;
  const count = Number.isFinite(h.holdersCount) ? `${h.holdersCount.toLocaleString('en-US')} holders` : 'live';
  meta.textContent = h.stale ? `${count} · cached` : count;
}

// ---------- start
export async function wallet(tokenPromise) {
  const card = $('[data-wallet]');
  // the masthead link scrolls to #token (smoothAnchors) and starts connecting
  for (const b of $$('[data-wallet-mast]')) b.addEventListener('click', () => { if (!state.account) startConnect(); });
  if (card) {
    $('[data-wallet-btn]', card).addEventListener('click', startConnect);
    $('[data-wallet-switch]', card).addEventListener('click', switchChain);
    $('[data-wallet-off]', card).addEventListener('click', disconnect);
  }
  discover();
  state.token = await tokenPromise.catch(() => null);
  render();
  // wallets announce right away; give them a moment before restoring
  setTimeout(restore, 300);
  if (ADDR.test(state.token?.contract ?? '')) {
    await loadHolders();
    refresh();
    setInterval(() => { if (document.visibilityState === 'visible') loadHolders(); }, HOLDERS_EVERY_MS);
  }
}
