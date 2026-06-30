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
