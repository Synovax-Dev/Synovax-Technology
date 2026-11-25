// The vault's QR encoder (web/vault/qr.js), checked by decoding what it draws
// with an independent decoder (jsQR, a test-only dependency). Run: npm run test:qr
import assert from 'node:assert/strict';
import { qrMatrix } from '../web/vault/qr.js';

let jsQR;
try { jsQR = (await import('jsqr')).default; } catch { console.log('jsqr is not installed (run npm install); skipping the QR test.'); process.exit(0); }

// draw the matrix as pixels: 4 pixels a module, 4 modules of quiet zone
function pixels(m, scale = 4) {
  const n = (m.size + 8) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) {
    if (!m.dark(x, y)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + 4) * scale + dy) * n + (x + 4) * scale + dx) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return { data, n };
}

const texts = [
  'A',
  'https://synovax.tech/vault/',
  `https://synovax.tech/vault/#pair=${'A'.repeat(22)}.${'b'.repeat(43)}`,
  `http://127.0.0.1:8787/vault/#pair=${'x_-'.repeat(7)}Q.${'Z9'.repeat(21)}a`,
  'Ünïcödé · 日本語 · emoji 🙂',
];
// every length from 1 to the largest a version 10 code holds at level M (213 bytes)
for (let n = 1; n <= 213; n += 7) texts.push('k'.repeat(n));
texts.push('m'.repeat(213));

let versions = new Set();
for (const t of texts) {
  const m = qrMatrix(t);
  versions.add(m.version);
  assert.equal(m.size, m.version * 4 + 17);
  const { data, n } = pixels(m);
  const got = jsQR(data, n, n);
  assert.ok(got, `could not decode a version ${m.version} code of ${t.length} characters`);
  assert.equal(got.data, t, `version ${m.version}`);
  assert.equal(got.version, m.version);
}
assert.throws(() => qrMatrix('z'.repeat(214)), /Too much text/);
assert.deepEqual([...versions].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every version was drawn and read back');
console.log(`  ok  ${texts.length} QR codes, versions 1 to 10, decode back to their text`);
console.log('\n1 QR check passed.');
