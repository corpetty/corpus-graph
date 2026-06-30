// Regression suite: a golden-count snapshot + content-independent structural
// invariants. The snapshot is per-profile (committed at profiles/<p>/expected-
// stats.json); the invariants hold for any profile. Bless intentional change
// with `make accept-stats`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { buildGraph, emit } from './build-graph.js';
import { doctor } from './doctor.js';
import { checkEdge } from './direction-rules.js';
import { readJSON } from './lib/io.js';
import { join } from 'node:path';

const ctx = loadContext();
const { nodes, edges, warnings, stats } = buildGraph(ctx);

test('golden snapshot matches expected-stats.json', () => {
  if (!existsSync(ctx.expectedStatsPath)) {
    console.warn(`  (no expected-stats.json for ${ctx.profileName} — run \`make accept-stats\` to create it)`);
    return;
  }
  const expected = readJSON(ctx.expectedStatsPath);
  assert.deepEqual(stats.byNodeType, expected.byNodeType, 'byNodeType drifted');
  assert.deepEqual(stats.byPredicate, expected.byPredicate, 'byPredicate drifted');
  assert.equal(stats.nodes, expected.nodes);
  assert.equal(stats.edges, expected.edges);
});

test('zero warnings', () => {
  assert.equal(warnings.length, 0, `warnings:\n  ${warnings.join('\n  ')}`);
});

test('no duplicate (subject,predicate,object) triples', () => {
  const seen = new Set();
  for (const e of edges) {
    const k = `${e.source}|${e.predicate}|${e.target}`;
    assert.ok(!seen.has(k), `duplicate edge ${k}`);
    seen.add(k);
  }
});

test('no dangling endpoints', () => {
  for (const e of edges) {
    assert.ok(nodes.has(e.source), `dangling source ${e.source}`);
    assert.ok(nodes.has(e.target), `dangling target ${e.target}`);
  }
});

test('every edge satisfies direction/shape conventions', () => {
  for (const e of edges) {
    const v = checkEdge(e, ctx.ontology, ctx.nsToType);
    assert.ok(v.ok, `bad edge ${e.source} -${e.predicate}-> ${e.target}: ${v.reason}`);
  }
});

test('every Document prose file exists on disk', () => {
  for (const n of nodes.values()) {
    if (n.type === 'Document' && n.file) {
      assert.ok(existsSync(join(ctx.contentDir, n.file)), `missing prose: ${n.file}`);
    }
  }
});

test('doctor reports no errors for a freshly built profile', () => {
  emit(ctx, { nodes, edges, stats }); // write fresh artifacts so the staleness check is clean
  const errors = doctor(ctx).filter((p) => p.level === 'error');
  assert.equal(errors.length, 0, errors.map((e) => e.msg).join('\n'));
});
