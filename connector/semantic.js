// Meaning-based search for the connector. The model runs on this computer; no
// memory text is sent anywhere. The only network use is downloading the model
// once (from Hugging Face) into the cache folder.
//
//   VAULT_SEMANTIC   bge-m3 (default) | e5-small | off
//   VAULT_CACHE_DIR  where the model and the encrypted index live (default <repo>/.cache)
//
// Optional: it needs `npm install` (the @huggingface/transformers package).
// Without it the connector simply keeps its word search.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as C from '../shared/crypto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Thresholds come from a calibration set of everyday memories and questions in
// English and Indonesian (14 questions with a right answer, 5 with none). No
// cut-off separates "relevant" from "unrelated" perfectly for any model tried, so
// results carry a label and the AI reading them makes the final call.
export const MODELS = {
// `words` is how much a word match adds, scaled to how spread out the model's scores are.
  'bge-m3': { id: 'Xenova/bge-m3', pooling: 'cls', query: '', doc: '', floor: 0.40, strong: 0.55, words: 0.1, size: '560 MB' },
  'e5-small': { id: 'Xenova/multilingual-e5-small', pooling: 'mean', query: 'query: ', doc: 'passage: ', floor: 0.80, strong: 0.86, words: 0.02, size: '130 MB' },
};

export function createSemantic({ log, appId, secret }) {
  const choice = (process.env.VAULT_SEMANTIC ?? 'bge-m3').trim().toLowerCase();
  const spec = MODELS[choice];
  if (choice === 'off' || !spec) {
    if (choice !== 'off') log(`VAULT_SEMANTIC="${choice}" is not one of ${Object.keys(MODELS).join(', ')}, off; using word search`);
    return { enabled: false, warm() {}, async scores() { return null; } };
  }
  const cacheRoot = path.resolve(process.env.VAULT_CACHE_DIR || path.join(ROOT, '.cache'));
  const indexFile = path.join(cacheRoot, 'index', `${appId}-${choice}.bin`);

  let extractor = null; // Promise<pipeline | null>
  let failed = false;
  function load() {
    extractor ??= (async () => {
      let lib;
      try { lib = await import('@huggingface/transformers'); }
      catch { failed = true; log('meaning-based search needs `npm install` in the vault folder; using word search'); return null; }
      lib.env.cacheDir = path.join(cacheRoot, 'models');
      log(`loading ${spec.id} (first time: downloads about ${spec.size} once)`);
      const t0 = Date.now();
      const p = await lib.pipeline('feature-extraction', spec.id, { dtype: 'q8' });
      log(`meaning-based search ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return p;
    })().catch((e) => { failed = true; log(`meaning-based search is off: ${e.message}`); return null; });
    return extractor;
  }

  // One model call at a time.
  let queue = Promise.resolve();
  const embed = (texts) => {
    const run = queue.then(async () => {
      const ex = await load();
      const out = await ex(texts, { pooling: spec.pooling, normalize: true });
      return out.tolist().map((v) => Float32Array.from(v));
    });
    queue = run.catch(() => {});
    return run;
  };

  // The index (vectors of what this app may read) is kept encrypted on disk with a
  // key from the app secret, so it is no easier to read than the vault itself.
  let index = null; // Map(id -> { h, v: Float32Array })
  let cacheKey = null;
  let dirty = false, saving = null;
  const textOf = (m) => [m.title, m.tags.join(', '), m.snippet].map((s) => String(s ?? '').trim().replace(/[.!?]+$/, '')).filter(Boolean).join('. ') + '.';
  const hashOf = (s) => createHash('sha256').update(s).digest('base64url').slice(0, 22);
  async function loadIndex() {
    if (index) return index;
    cacheKey ??= await C.hkdf(secret, 'vault/app/embed-index/v1');
    index = new Map();
    try {
      const data = await C.decryptJSON(cacheKey, await readFile(indexFile, 'utf8'), `embed-index:${appId}:${choice}`);
      for (const [id, e] of Object.entries(data.entries ?? {})) index.set(id, { h: e.h, v: new Float32Array(C.unb64(e.v).buffer) });
    } catch { /* no index yet, or from another key: start fresh */ }
    return index;
  }
  async function saveIndex() {
    if (!dirty || saving) return saving;
    dirty = false;
    saving = (async () => {
      const entries = {};
      for (const [id, e] of index) entries[id] = { h: e.h, v: C.b64(new Uint8Array(e.v.buffer.slice(0))) };
      const ct = await C.encryptJSON(cacheKey, { model: spec.id, entries }, `embed-index:${appId}:${choice}`);
      await mkdir(path.dirname(indexFile), { recursive: true });
      await writeFile(`${indexFile}.tmp`, ct, { mode: 0o600 });
      await rename(`${indexFile}.tmp`, indexFile);
    })().catch((e) => log(`could not save the search index: ${e.message}`)).finally(() => { saving = null; if (dirty) saveIndex(); });
    return saving;
  }

  async function indexSome(mems, budgetMs) {
    const t0 = Date.now();
    const todo = mems.filter((m) => index.get(m.id)?.h !== hashOf(textOf(m)));
    // One memory per model call: in a batch, padding nudges the scores, and a
    // memory's score should not depend on which others were indexed with it.
    for (let i = 0; i < todo.length; i++) {
      if (budgetMs != null && Date.now() - t0 > budgetMs) return todo.length - i;
      const m = todo[i];
      const [v] = await embed([spec.doc + textOf(m)]);
      index.set(m.id, { h: hashOf(textOf(m)), v });
      dirty = true;
    }
    return 0;
  }

  let background = null;
  return {
    enabled: true,
    get failed() { return failed; },
    spec,
    /** Start loading the model in the background (does not wait). */
    warm() { load(); },
    /**
     * Cosine similarity of the query to each memory: { scores: Map(id -> number), pending }.
     * null when the model is not available (yet). Waits at most `waitMs` for the
     * model and spends at most `budgetMs` indexing; the rest is indexed afterwards.
     */
    async scores(query, mems, { waitMs = 4000, budgetMs = 8000, complete = false } = {}) {
      const ex = await Promise.race([load(), new Promise((r) => setTimeout(() => r(null), complete ? 600_000 : waitMs))]);
      if (!ex) return null;
      await loadIndex();
      if (complete) await background;
      const pending = await indexSome(mems, complete ? null : budgetMs);
      if (pending && !background) {
        background = indexSome(mems, null).then(saveIndex).finally(() => { background = null; });
      }
      // forget what this app can no longer read, when we saw the full list
      if (mems.fullList) for (const id of index.keys()) if (!mems.some((m) => m.id === id)) { index.delete(id); dirty = true; }
      saveIndex();
      const [q] = await embed([spec.query + query]);
      const scores = new Map();
      for (const m of mems) {
        const e = index.get(m.id);
        if (!e) continue;
        let s = 0;
        for (let i = 0; i < q.length; i++) s += q[i] * e.v[i];
        scores.set(m.id, s);
      }
      return { scores, pending };
    },
  };
}
