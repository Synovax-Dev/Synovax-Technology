import { merkleRoot, merkleProof } from '../shared/merkle.js';
import { tx } from './db.js';

export const sealOut = (s) => ({
  seq: s.seq, periodStart: s.period_start, periodEnd: s.period_end, root: s.root, count: s.count,
});

// At the end of each period, every read from that period (across all vaults)
// is folded into one Merkle root. Leaves are salted, so a root says nothing
// about who read what; each vault can still prove its own entries.
export function startSealer(db, periodMs) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const cutoff = Math.floor(Date.now() / periodMs) * periodMs;
      const rows = db.prepare('SELECT seq, leaf, ts FROM read_log WHERE seal_seq IS NULL AND ts < ? ORDER BY seq').all(cutoff);
      const groups = new Map();
      for (const r of rows) {
        const start = Math.floor(r.ts / periodMs) * periodMs;
        if (!groups.has(start)) groups.set(start, []);
        groups.get(start).push(r);
      }
      for (const [start, entries] of [...groups].sort((a, b) => a[0] - b[0])) {
        const root = await merkleRoot(entries.map((e) => e.leaf));
        tx(db, () => {
          if (db.prepare('SELECT 1 FROM seals WHERE period_start = ?').get(start)) {
            console.warn(`[seals] period ${new Date(start).toISOString()} is already sealed; ${entries.length} late entries left unsealed`);
            return;
          }
          const { lastInsertRowid } = db.prepare(
            'INSERT INTO seals (period_start, period_end, root, count, created_at) VALUES (?, ?, ?, ?, ?)',
          ).run(start, start + periodMs, root, entries.length, Date.now());
          const seq = Number(lastInsertRowid);
          const addLeaf = db.prepare('INSERT INTO seal_leaves (seal_seq, idx, leaf) VALUES (?, ?, ?)');
          const mark = db.prepare('UPDATE read_log SET seal_seq = ?, leaf_idx = ? WHERE seq = ?');
          entries.forEach((e, i) => { addLeaf.run(seq, i, e.leaf); mark.run(seq, i, e.seq); });
        });
      }
    } catch (e) {
      console.error('[seals]', e);
    } finally {
      busy = false;
    }
  };
  tick();
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
