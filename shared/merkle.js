// Merkle tree for the hourly seals. Shared by the server (to build seals and
// proofs) and the vault app (to check a log entry against a seal by itself).
//   leaf = SHA-256(0x00 || entry)      node = SHA-256(0x01 || left || right)
// An odd node at the end of a level moves up unchanged (no duplication).
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

export const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));

async function hash(prefix, ...parts) {
  const buf = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0));
  buf[0] = prefix;
  let o = 1;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return new Uint8Array(await subtle.digest('SHA-256', buf));
}

/** The exact bytes a log entry commits to. The random salt keeps the leaf from revealing anything. */
export function leafData(e) {
  return JSON.stringify([e.id, e.ts, e.vault_id, e.app_id ?? null, e.action, e.target ?? null, e.salt]);
}

export async function leafHash(entry) {
  return toHex(await hash(0, te.encode(leafData(entry))));
}

async function levels(leavesHex) {
  let level = leavesHex.map(fromHex);
  const all = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? await hash(1, level[i], level[i + 1]) : level[i]);
    }
    all.push(next);
    level = next;
  }
  return all;
}

export async function merkleRoot(leavesHex) {
  if (!leavesHex.length) throw new Error('A seal needs at least one entry.');
  const all = await levels(leavesHex);
  return toHex(all[all.length - 1][0]);
}

export async function merkleProof(leavesHex, index) {
  const all = await levels(leavesHex);
  const proof = [];
  let i = index;
  for (let d = 0; d < all.length - 1; d++) {
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < all[d].length) proof.push({ side: i % 2 === 0 ? 'R' : 'L', hash: toHex(all[d][sib]) });
    i = Math.floor(i / 2);
  }
  return proof;
}

export async function verifyProof(leafHex, proof, rootHex) {
  let cur = fromHex(leafHex);
  for (const p of proof) {
    const sib = fromHex(p.hash);
    cur = p.side === 'R' ? await hash(1, cur, sib) : await hash(1, sib, cur);
  }
  return toHex(cur) === rootHex;
}
