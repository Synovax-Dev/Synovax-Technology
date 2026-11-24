// Top holders of an ERC-20, from two possible sources:
//
//  rpc         (default) Reads the token's Transfer events straight from the chain's
//              JSON-RPC with eth_getLogs, keeps a running balance per address, then
//              confirms the top N with balanceOf. No third party is involved.
//  blockscout  Asks a Blockscout explorer's API (names and holder counts included).
//              Its Cloudflare front may refuse datacenter addresses, so it is opt-in.
//
// Both return the same shape: { decimals, totalSupply, holdersCount, holders: [...] }.

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BURN = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const isNum = (v) => typeof v === 'string' && /^\d{1,80}$/.test(v);
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 40) : '');

export function pctOf(value, total) {
  if (total <= 0n) return null;
  return Number((value * 1_000_000n) / total) / 10_000;
}

function rows(list, total) {
  return list.map((h, i) => {
    const burn = BURN.has(h.address.toLowerCase());
    return { rank: i + 1, address: h.address, value: h.value.toString(), pct: pctOf(h.value, total), label: burn ? 'burn' : h.contract ? (h.name || 'contract') : (h.name || '') };
  });
}

// ---------- Blockscout
export async function fromBlockscout({ api, contract, shown, fetchImpl = fetch }) {
  const get = async (p) => {
    const res = await fetchImpl(`${api}${p}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`explorer answered ${res.status}`);
    return res.json();
  };
  const [tok, list] = await Promise.all([get(`/api/v2/tokens/${contract}`), get(`/api/v2/tokens/${contract}/holders`)]);
  const total = isNum(tok?.total_supply) ? BigInt(tok.total_supply) : 0n;
  const decimals = Number.isInteger(Number(tok?.decimals)) ? Math.min(Math.max(Number(tok.decimals), 0), 36) : 18;
  const items = (Array.isArray(list?.items) ? list.items : [])
    .filter((h) => ADDR.test(h?.address?.hash ?? '') && isNum(h.value))
    .slice(0, shown)
    .map((h) => ({ address: h.address.hash, value: BigInt(h.value), contract: !!h.address.is_contract, name: cleanName(h.address.name) }));
  const count = Number(tok?.holders_count ?? tok?.holders);
  return { decimals, totalSupply: total.toString(), holdersCount: Number.isFinite(count) ? count : null, holders: rows(items, total) };
}

// ---------- chain RPC
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRpcIndex({ url, fetchImpl = fetch, span = 10_000_000n, lag = 5n, startBlock = 0n, retries = 5, backoffMs = 1000, batchSize = 20 }) {
  const tokens = new Map(); // contract → { next, balances: Map<lower, { address, value }>, decimals, syncing }
  let id = 0;

  // public nodes rate-limit bursts (429): wait and try again, a few times
  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (res.ok) return res.json();
      if ((res.status !== 429 && res.status < 500) || attempt >= retries) throw new Error(`rpc answered ${res.status}`);
      const after = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : backoffMs * 2 ** attempt);
    }
  }
  async function call(method, params) {
    const j = await post({ jsonrpc: '2.0', id: ++id, method, params });
    if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.code = j.error.code; throw e; }
    return j.result;
  }
  // several calls per request (at most batchSize); answers come back in the order asked
  async function batch(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += batchSize) out.push(...await batchOnce(calls.slice(i, i + batchSize)));
    return out;
  }
  async function batchOnce(calls) {
    if (!calls.length) return [];
    const base = id;
    const out = await post(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: base + i + 1, method, params })));
    id += calls.length;
    if (!Array.isArray(out)) throw new Error('rpc batch not supported');
    const byId = new Map(out.map((r) => [r.id, r]));
    return calls.map((_, i) => { const r = byId.get(base + i + 1); if (!r || r.error) throw new Error(r?.error?.message || 'rpc batch answer missing'); return r.result; });
  }

  const hex = (n) => '0x' + n.toString(16);
  const word = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const toBig = (h) => { if (typeof h !== 'string' || !/^0x[0-9a-fA-F]*$/.test(h)) throw new Error('bad number from rpc'); return h === '0x' ? 0n : BigInt(h); };

  // a range the node refuses (too wide, too many results) is split in half
  async function logs(contract, from, to) {
    try {
      return await call('eth_getLogs', [{ address: contract, fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER] }]);
    } catch (e) {
      if (to <= from || !/range|span|results|limit|too many|exceed|narrow/i.test(e.message)) throw e;
      const mid = from + (to - from) / 2n;
      return [...await logs(contract, from, mid), ...await logs(contract, mid + 1n, to)];
    }
  }

  function apply(t, list) {
    const add = (addr, delta) => {
      const k = addr.toLowerCase();
      const cur = t.balances.get(k) ?? { address: addr, value: 0n };
      cur.value += delta;
      t.balances.set(k, cur);
    };
    for (const l of list) {
      // ERC-20 Transfer: 3 topics (an NFT's has 4), amount in data
      if (!Array.isArray(l.topics) || l.topics.length !== 3 || l.removed) continue;
      const from = '0x' + l.topics[1].slice(26), to = '0x' + l.topics[2].slice(26);
      let v; try { v = toBig(l.data); } catch { continue; }
      if (v === 0n) continue;
      add(from, -v);
      add(to, v);
    }
  }

  async function sync(contract) {
    let t = tokens.get(contract);
    if (!t) { t = { next: startBlock, balances: new Map(), syncing: null }; tokens.set(contract, t); }
    if (t.syncing) return t.syncing;
    t.syncing = (async () => {
      const head = toBig(await call('eth_blockNumber', [])) - lag;
      while (t.next <= head) {
        const to = t.next + span - 1n < head ? t.next + span - 1n : head;
        apply(t, await logs(contract, t.next, to));
        t.next = to + 1n;
      }
    })().finally(() => { t.syncing = null; });
    return t.syncing;
  }

  async function top(contract, shown) {
    await sync(contract);
    const t = tokens.get(contract);
    const minted = [...t.balances.values()].filter((b) => b.value > 0n && !/^0x0{40}$/.test(b.address));
    minted.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    // take a few extra, confirm them with balanceOf, then keep the real top N
    const pick = minted.slice(0, shown + 5);
    const answers = await batch([
      ['eth_call', [{ to: contract, data: '0x18160ddd' }, 'latest']], // totalSupply()
      ['eth_call', [{ to: contract, data: '0x313ce567' }, 'latest']], // decimals()
      ...pick.map((h) => ['eth_call', [{ to: contract, data: '0x70a08231' + word(h.address) }, 'latest']]),
      ...pick.map((h) => ['eth_getCode', [h.address, 'latest']]),
    ]);
    const total = toBig(answers[0]);
    const decimals = Math.min(Number(toBig(answers[1])), 36);
    const checked = pick.map((h, i) => ({ address: h.address, value: toBig(answers[2 + i]), contract: (answers[2 + pick.length + i] ?? '0x') !== '0x', name: '' }))
      .filter((h) => h.value > 0n)
      .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
      .slice(0, shown);
    // write the confirmed numbers back, so a token whose balances drift from its
    // events (fees, rebases) still shows what the chain says now
    for (const h of checked) t.balances.get(h.address.toLowerCase()).value = h.value;
    // (addresses from event topics are lowercase; the page compares without case)
    return { decimals, totalSupply: total.toString(), holdersCount: minted.length, holders: rows(checked, total) };
  }

  return { top, sync, call };
}
