// Verify: the same checks the vault makes, with every step shown.
import { leafData, leafHash, verifyProof, verifySealChain, GENESIS, fromHex } from '/shared/merkle.js';
import { $, el, icon, getJSON, hourSpan, num } from './util.js';

// ---------- tabs
const tabs = [...document.querySelectorAll('[data-tab]')];
for (const t of tabs) {
  t.addEventListener('click', () => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    }
  });
}

function show(box, ok, title, steps) {
  box.hidden = false;
  box.className = `p-result ${ok ? 'is-ok' : 'is-bad'}`;
  box.replaceChildren(el('b', {}, icon(ok ? 'check' : 'x'), title), el('ol', {}, ...steps.map((s) => el('li', { text: s }))));
}

const hex64 = (s) => String(s ?? '').trim().toLowerCase().replace(/^0x/, '');
const isHex64 = (s) => /^[0-9a-f]{64}$/.test(s);

async function againstSeal(seq, leaf, steps) {
  const { data: seal } = await getJSON(`/api/seals/${seq}`);
  steps.push(`Seal #${seal.seq} (${hourSpan(seal.periodStart, seal.periodEnd)}, ${num(seal.count)} reads), published root ${seal.root}.`);
  const { data: p } = await getJSON(`/api/seals/${seq}/proof?leaf=${leaf}`);
  steps.push(`The server sent ${p.proof.length} sibling hash${p.proof.length === 1 ? '' : 'es'} for leaf number ${p.leafIndex}.`);
  let cur = leaf;
  for (const [i, s] of p.proof.entries()) {
    const next = await walkOne(cur, s);
    steps.push(`Step ${i + 1}: ${s.side === 'R' ? `SHA-256(0x01 ‖ ${short(cur)} ‖ ${short(s.hash)})` : `SHA-256(0x01 ‖ ${short(s.hash)} ‖ ${short(cur)})`} = ${short(next)}`);
    cur = next;
  }
  const match = cur === seal.root && await verifyProof(leaf, p.proof, seal.root);
  steps.push(match ? `The walk ends at ${seal.root}, the published root.` : `The walk ends at ${cur}, which is not the published root.`);
  return match;
}

const short = (h) => `${h.slice(0, 10)}…`;
async function walkOne(cur, s) {
  const a = s.side === 'R' ? fromHex(cur) : fromHex(s.hash);
  const b = s.side === 'R' ? fromHex(s.hash) : fromHex(cur);
  const buf = new Uint8Array(1 + a.length + b.length);
  buf[0] = 1; buf.set(a, 1); buf.set(b, 1 + a.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function form(sel, run) {
  const f = $(sel);
  const out = f.querySelector('.p-result');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = f.querySelector('button[type=submit]');
    b.disabled = true;
    const steps = [];
    try {
      const { ok, title } = await run(f, steps);
      show(out, ok, title, steps);
    } catch (err) {
      show(out, false, err.status === 404 ? 'Not found' : 'Could not check', [...steps, err.message]);
    } finally { b.disabled = false; }
  });
}

// A. an entry copied from the vault's read log
form('[data-verify-entry]', async (f, steps) => {
  let e;
  try { e = JSON.parse(f.elements.entry.value); } catch { throw new Error('Paste the entry exactly as "Copy entry" in your read log gives it (JSON).'); }
  for (const k of ['id', 'ts', 'vault_id', 'action', 'salt']) if (e?.[k] == null) throw new Error(`The entry has no "${k}".`);
  if (!Number.isInteger(e.seal)) throw new Error('The entry has no seal number. Only sealed entries can be checked.');
  steps.push(`The entry's bytes: ${leafData(e)}`);
  const leaf = await leafHash(e);
  steps.push(`Its leaf: SHA-256(0x00 ‖ those bytes) = ${leaf}. Only this leaf is sent to the server.`);
  const ok = await againstSeal(e.seal, leaf, steps);
  return { ok, title: ok ? `Verified in seal #${e.seal}` : 'Does not match its seal' };
});

// B. a leaf and a seal number
form('[data-verify-leaf]', async (f, steps) => {
  const leaf = hex64(f.elements.leaf.value);
  const seq = Number.parseInt(f.elements.seal.value, 10);
  if (!isHex64(leaf)) throw new Error('A leaf is 64 hex characters (0x in front is fine).');
  if (!Number.isInteger(seq) || seq < 1) throw new Error('Give the seal number, for example 12.');
  const ok = await againstSeal(seq, leaf, steps);
  return { ok, title: ok ? `Part of seal #${seq}` : 'Not part of that seal' };
});

// C. a proof by hand: nothing is sent anywhere
form('[data-verify-hand]', async (f, steps) => {
  const root = hex64(f.elements.root.value), leaf = hex64(f.elements.leaf.value);
  if (!isHex64(root) || !isHex64(leaf)) throw new Error('The root and the leaf are 64 hex characters each.');
  const proof = f.elements.proof.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const m = /^(L|R)\s+(?:0x)?([0-9a-fA-F]{64})$/.exec(l);
    if (!m) throw new Error(`Line ${i + 1}: write each step as "R <hash>" (the sibling is on the right) or "L <hash>".`);
    return { side: m[1], hash: m[2].toLowerCase() };
  });
  let cur = leaf;
  for (const [i, s] of proof.entries()) {
    const next = await walkOne(cur, s);
    steps.push(`Step ${i + 1}: ${s.side === 'R' ? `SHA-256(0x01 ‖ ${short(cur)} ‖ ${short(s.hash)})` : `SHA-256(0x01 ‖ ${short(s.hash)} ‖ ${short(cur)})`} = ${short(next)}`);
    cur = next;
  }
  const ok = cur === root;
  steps.push(ok ? 'The walk ends at the root you gave. Nothing was sent anywhere.' : `The walk ends at ${cur}, not at the root you gave.`);
  return { ok, title: ok ? 'The proof holds' : 'The proof does not hold' };
});

// D. the whole seal chain, from the first seal to the newest
const chainBtn = $('[data-verify-chain]');
const chainOut = $('[data-verify-chain-out]');
chainBtn?.addEventListener('click', async () => {
  chainBtn.disabled = true;
  const steps = [];
  try {
    const all = [];
    for (let from = 1; ;) {
      const { data } = await getJSON(`/api/seals?from=${from}&limit=500`);
      if (!data.seals.length) break;
      all.push(...data.seals);
      from = data.seals.at(-1).seq + 1;
      if (data.seals.length < 500) break;
    }
    if (!all.length) { show(chainOut, true, 'No seals yet', ['There is nothing to check until the first seal is made.']); return; }
    steps.push(`Fetched ${num(all.length)} seals, #${all[0].seq} to #${all.at(-1).seq}.`);
    const gaps = all.filter((s, i) => s.seq !== i + 1).length;
    if (gaps) steps.push('The seal numbers have a gap: a seal is missing.');
    const res = await verifySealChain(all, GENESIS);
    steps.push(res.ok ? `Each seal commits to the one before it, back to the start. Newest chain hash: ${res.head}.` : `The chain breaks at seal #${res.badSeq}.`);
    let cp = null;
    try { cp = JSON.parse(localStorage.getItem('synovax:seal-checkpoint') ?? 'null'); } catch {}
    if (cp?.seq) {
      const seen = all.find((s) => s.seq === cp.seq);
      steps.push(seen && seen.chain === cp.chain ? `Your vault in this browser saw seal #${cp.seq} before, and it is unchanged.` : `Your vault in this browser saw seal #${cp.seq} with another chain hash: the history was changed since.`);
      if (!seen || seen.chain !== cp.chain) res.ok = false;
    } else steps.push('This browser has no earlier record from your vault to compare with. Open your vault\'s read log once to keep one.');
    show(chainOut, res.ok && !gaps, res.ok && !gaps ? 'The seal chain is unbroken' : 'The seal chain is broken', steps);
  } catch (err) {
    show(chainOut, false, 'Could not check', [...steps, err.message]);
  } finally { chainBtn.disabled = false; }
});
