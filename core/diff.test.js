// diff/eval harness test — pure logic, no key/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContext } from './lib/config.js';
import { buildGraph, emit } from './build-graph.js';
import { diffExtractions } from './diff.js';
import { readJSONL } from './lib/io.js';

const ctx = loadContext('software-docs');
emit(ctx, buildGraph(ctx));
const knownIds = new Set(readJSONL(ctx.nodesPath).map((n) => n.id));

const sourceText = 'Caches determine reusability from the response own content and validators rather than out of band state.';
const reference = [
  { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:immutable-cache-keys', confidence: 'high' },
  { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:no-global-state', confidence: 'high' },
];
const candidate = [
  { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:immutable-cache-keys', confidence: 'high', quote: 'Caches determine reusability from the response own content and validators' },
  { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'decision:does-not-exist', confidence: 'high', quote: 'a totally invented phrase not in the source' },
  { subject: 'ref:http-caching-rfc', predicate: 'supports', object: 'module:caching-layer', confidence: 'medium' },
  { subject: 'ref:http-caching-rfc', predicate: 'supports', confidence: 'high' }, // schema-invalid (no object)
];

test('diff: precision/recall/F1 over (s,p,o)', () => {
  const m = diffExtractions(candidate, reference, { ctx, knownIds, sourceText });
  assert.equal(m.matched, 1);
  assert.ok(Math.abs(m.precision - 1 / 3) < 1e-9, `precision ${m.precision}`);
  assert.equal(m.recall, 0.5);
  assert.equal(m.candidate.invalid, 1, 'the row missing an object is schema-invalid');
});

test('diff: catalog check flags hallucinated ids', () => {
  const m = diffExtractions(candidate, reference, { ctx, knownIds });
  assert.equal(m.catalog.hallucinated, 1, 'decision:does-not-exist is off-catalog');
});

test('diff: quote fidelity greps the source text', () => {
  const m = diffExtractions(candidate, reference, { sourceText });
  assert.equal(m.quote.withQuote, 2);
  assert.equal(m.quote.verbatim, 1, 'only the first quote appears verbatim in source');
});
