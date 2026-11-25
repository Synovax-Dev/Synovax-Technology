// Builds the browser extension: copies the shared crypto into extension/lib/ and
// the icon, then writes web/extension/synovax-extension.zip for "Load unpacked".
// The ZIP is made the same way every time (fixed dates, sorted names), so
// `--check` can tell when it is out of date (the end-to-end test runs it).
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const COPIES = [
  ['shared/crypto.js', 'extension/lib/crypto.js'],
  ['shared/wordlist.js', 'extension/lib/wordlist.js'],
  ['shared/brand.js', 'extension/lib/brand.js'],
  ['web/icon-192.png', 'extension/icon.png'],
];
const ZIP = path.join(ROOT, 'web', 'extension', 'synovax-extension.zip');

// ---------- a small ZIP writer (stored, no compression), enough for a dozen files
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(`synovax-extension/${name}`, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += local.length + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function listFiles(dir, base = '') {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

const check = process.argv.includes('--check');
let stale = 0;
for (const [from, to] of COPIES) {
  const src = await readFile(path.join(ROOT, from));
  const dest = path.join(ROOT, to);
  const cur = await readFile(dest).catch(() => null);
  if (cur && cur.equals(src)) continue;
  if (check) { stale++; console.error(`out of date: ${to} (run npm run extension)`); continue; }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, src);
}
if (!stale) {
  const files = await Promise.all((await listFiles(EXT)).map(async (name) => ({ name, data: await readFile(path.join(EXT, name)) })));
  const out = zip(files);
  const cur = await readFile(ZIP).catch(() => null);
  if (!(cur && cur.equals(out))) {
    if (check) { stale++; console.error('out of date: web/extension/synovax-extension.zip (run npm run extension)'); }
    else { await mkdir(path.dirname(ZIP), { recursive: true }); await writeFile(ZIP, out); }
  }
  if (!check) console.log(`built web/extension/synovax-extension.zip (${files.length} files, ${out.length} bytes)`);
}
if (check && stale) process.exit(1);
