import { merkleRoot, merkleProof, sealChainHash, GENESIS } from '../shared/merkle.js';
import { tx } from './db.js';

export const sealOut = (s) => ({
  seq: s.seq, periodStart: s.period_start, periodEnd: s.period_end, root: s.root, count: s.count, prev: s.prev, chain: s.chain,
});

// Seals made before the chain existed get their chain hashes, in order.
async function backfillChain(db) {
  const rows = db.prepare('SELECT * FROM seals ORDER BY seq').all();
  let prev = GENESIS;
  for (const r of rows) {
    if (r.chain == null || r.prev == null) {
      const chain = await sealChainHash(sealOut(r), prev);
      db.prepare('UPDATE seals SET prev = ?, chain = ? WHERE seq = ?').run(prev, chain, r.seq);
      prev = chain;
    } else prev = r.chain;
  }
}

// Posts each new seal to SEAL_PUBLISH_URL (a webhook you control: a Discord or
// Slack channel, a log service, a witness server), so a copy of every chain hash
// lives somewhere the vault server cannot edit.
async function publish(url, s) {
  if (!url) return;
  const text = `seal #${s.seq} · ${new Date(s.periodStart).toISOString()} → ${new Date(s.periodEnd).toISOString()} · ${s.count} reads · root ${s.root} · chain ${s.chain}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...s, content: text, text }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`[seals] publishing seal #${s.seq} got HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[seals] could not publish seal #${s.seq}: ${e.message}`);
  }
}

// At the end of each period, every read from that period (across all vaults)
// is folded into one Merkle root. Leaves are salted, so a root says nothing
// about who read what; each vault can still prove its own entries.
export function startSealer(db, periodMs, { publishUrl = '' } = {}) {
  let busy = true;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // A read's timestamp is taken a moment before its row is written. Waiting a
      // short grace after a period ends keeps such a read from arriving after its
      // period was sealed, which would leave it unsealed for good.
      const grace = Math.min(5_000, periodMs / 4);
      const cutoff = Math.floor((Date.now() - grace) / periodMs) * periodMs;
      const rows = db.prepare('SELECT seq, leaf, ts FROM read_log WHERE seal_seq IS NULL AND ts < ? ORDER BY seq').all(cutoff);
      const groups = new Map();
      for (const r of rows) {
        const start = Math.floor(r.ts / periodMs) * periodMs;
        if (!groups.has(start)) groups.set(start, []);
        groups.get(start).push(r);
      }
      for (const [start, entries] of [...groups].sort((a, b) => a[0] - b[0])) {
        const root = await merkleRoot(entries.map((e) => e.leaf));
        // the sealer is the only writer of seals and runs one tick at a time
        const last = db.prepare('SELECT seq, chain FROM seals ORDER BY seq DESC LIMIT 1').get();
        const prev = last?.chain ?? GENESIS;
        const seq = (last?.seq ?? 0) + 1;
        const draft = { seq, periodStart: start, periodEnd: start + periodMs, root, count: entries.length };
        const chain = await sealChainHash(draft, prev);
        const made = tx(db, () => {
          if (db.prepare('SELECT 1 FROM seals WHERE period_start = ?').get(start)) {
            console.warn(`[seals] period ${new Date(start).toISOString()} is already sealed; ${entries.length} late entries left unsealed`);
            return false;
          }
          db.prepare('INSERT INTO seals (seq, period_start, period_end, root, count, created_at, prev, chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(seq, start, start + periodMs, root, entries.length, Date.now(), prev, chain);
          const addLeaf = db.prepare('INSERT INTO seal_leaves (seal_seq, idx, leaf) VALUES (?, ?, ?)');
          const mark = db.prepare('UPDATE read_log SET seal_seq = ?, leaf_idx = ? WHERE seq = ?');
          entries.forEach((e, i) => { addLeaf.run(seq, i, e.leaf); mark.run(seq, i, e.seq); });
          return true;
        });
        if (made) await publish(publishUrl, { ...draft, prev, chain });
      }
    } catch (e) {
      console.error('[seals]', e);
    } finally {
      busy = false;
    }
  };
  backfillChain(db).catch((e) => console.error('[seals] chain backfill failed', e)).finally(() => { busy = false; tick(); });
  const timer = setInterval(tick, Math.max(250, Math.min(periodMs / 4, 30_000)));
  timer.unref();
  return timer;
}

export async function proofFor(db, vaultId, logId) {
  const row = db.prepare('SELECT seal_seq, leaf_idx, leaf FROM read_log WHERE id = ? AND vault_id = ?').get(logId, vaultId);
  if (!row) return null;
  if (row.seal_seq == null) return { sealed: false, leaf: row.leaf };
  const seal = db.prepare('SELECT * FROM seals WHERE seq = ?').get(row.seal_seq);
  const leaves = db.prepare('SELECT leaf FROM seal_leaves WHERE seal_seq = ? ORDER BY idx').all(row.seal_seq).map((r) => r.leaf);
  return {
    sealed: true,
    leaf: row.leaf,
    leafIndex: row.leaf_idx,
    proof: await merkleProof(leaves, row.leaf_idx),
    seal: sealOut(seal),
  };
}
