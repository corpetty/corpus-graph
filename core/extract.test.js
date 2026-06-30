// Extraction-runner regression test. Uses a STUB backend — no API key, no
// network — so it exercises the validate/drop/dedup/write/resume path
// deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { buildGraph, emit } from './build-graph.js';
import { buildCatalog } from './build-catalog.js';
import { extractProfile } from './extract.js';
import { chunkText } from './lib/chunk.js';
import { readJSONL } from './lib/io.js';

const ctx = loadContext('software-docs');
emit(ctx, buildGraph(ctx));
buildCatalog(ctx);
const outDir = join(ctx.outDir, 'extract-test');
rmSync(outDir, { recursive: true, force: true });

// One valid high-confidence triple, one valid low-confidence, one off-catalog
// (dropped), one backwards-direction (dropped), plus a _note (ignored).
const stub = async () => ({
  text: JSON.stringify({
    triples: [
      { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:immutable-cache-keys', quote: 'caches determine reuse from validators', confidence: 'high', rationale: 'validator-based freshness' },
      { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:ssr-by-default', quote: 'x', confidence: 'low', rationale: 'weak' },
      { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:does-not-exist', quote: 'x', confidence: 'high', rationale: 'off-catalog' },
      { subject: 'decision:immutable-cache-keys', predicate: 'supports', object: 'ref:http-caching-rfc', quote: 'x', confidence: 'high', rationale: 'backwards' },
      { _note: 'saw "stale-while-revalidate", not in catalog' },
    ],
  }),
  usage: { input_tokens: 10, output_tokens: 5 },
});

test('extract validates: keeps in-catalog/in-direction, drops off-catalog + backwards', async () => {
  const r = await extractProfile(ctx, { backend: stub, sourceId: 'ref:http-caching-rfc', outDir, minConfidence: 'low' });
  const rec = r.results[0];
  assert.equal(rec.status, 'extracted', JSON.stringify(rec));
  assert.equal(rec.kept, 2, `kept should be the 2 valid triples: ${JSON.stringify(rec)}`);
  assert.equal(rec.dropped, 2, 'off-catalog + backwards should drop');
  const file = join(outDir, 'http-caching-rfc.jsonl');
  assert.ok(existsSync(file), 'per-source jsonl written');
  assert.equal(readJSONL(file).length, 2);
});

test('extract respects min-confidence', async () => {
  rmSync(outDir, { recursive: true, force: true });
  const r = await extractProfile(ctx, { backend: stub, sourceId: 'ref:http-caching-rfc', outDir, minConfidence: 'high' });
  assert.equal(r.results[0].kept, 1, 'only the high-confidence triple survives at min-confidence=high');
});

test('extract is idempotent/resumable (skips an already-extracted source)', async () => {
  const r = await extractProfile(ctx, { backend: stub, sourceId: 'ref:http-caching-rfc', outDir, minConfidence: 'high' });
  assert.match(r.results[0].status, /skipped/);
});

test('chunkText splits deterministically into >1 chunk under the ceiling', () => {
  const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some filler words to add a bit of length here.`).join('\n\n');
  const a = chunkText(text, 50);
  const b = chunkText(text, 50);
  assert.ok(a.length > 1, `expected multiple chunks, got ${a.length}`);
  assert.deepEqual(a.map((c) => c.text), b.map((c) => c.text), 'chunking is deterministic');
});

test('chunking: oversized source is split, extracted per chunk, merged with highest-confidence dedup', async () => {
  rmSync(outDir, { recursive: true, force: true });
  const cdir = join(outDir, 'chunks');
  let call = 0;
  // Same (s,p,o) on every chunk; first chunk low-confidence, the rest high.
  const chunkStub = async () => {
    call++;
    return {
      text: JSON.stringify({
        triples: [{ subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:immutable-cache-keys', quote: `q${call}`, confidence: call === 1 ? 'low' : 'high', rationale: 'r' }],
      }),
      usage: { input_tokens: 5, output_tokens: 2 },
    };
  };
  const r = await extractProfile(ctx, { backend: chunkStub, sourceId: 'ref:http-caching-rfc', outDir, chunkCacheDir: cdir, chunkTokens: 50, minConfidence: 'low' });
  const rec = r.results[0];
  assert.ok(rec.chunks > 1, `should chunk: ${JSON.stringify(rec)}`);
  assert.equal(rec.kept, 1, 'merged to one deduped triple across chunks');
  const rows = readJSONL(join(outDir, 'http-caching-rfc.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confidence, 'high', 'merge keeps the highest-confidence row');
  assert.ok(existsSync(join(cdir, 'http-caching-rfc', 'manifest.json')), 'chunk manifest written');
});
