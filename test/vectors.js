// The open standard's test vectors (shared/vectors.json): the code must still
// produce every deterministic value, and open every sealed one.
// Run: npm run test:vectors
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as C from '../shared/crypto.js';
import { fromHex } from '../shared/merkle.js';
import { FILE, deterministic } from '../scripts/vectors.mjs';

const v = JSON.parse(await readFile(FILE, 'utf8'));
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

await step('deterministic values are produced byte for byte', async () => {
  assert.deepEqual(await deterministic(v.input), v.deterministic);
});
await step('the sealed envelope opens with its key and its record name only', async () => {
  const e = v.sealed.envelope;
  assert.deepEqual(await C.decryptJSON(fromHex(e.key), e.token, e.aad), e.plaintext);
  await assert.rejects(C.decryptJSON(fromHex(e.key), e.token, 'memory:other:body'));
});
await step('the sealed box opens with its private key', async () => {
  const b = v.sealed.sealedBox;
  assert.deepEqual(await C.boxOpen(C.unb64(b.privateKeyPkcs8), b.publicKey, b.token), b.plaintext);
});

console.log(failed ? `\n${failed} vector checks failed.` : '\n3 vector checks passed.');
process.exitCode = failed ? 1 : 0;
