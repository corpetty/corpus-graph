// triage/cost test — pure logic, no key/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadContext } from './lib/config.js';
import { buildGraph, emit } from './build-graph.js';
import { buildCatalog } from './build-catalog.js';
import { triageProfile } from './triage.js';

const ctx = loadContext('software-docs');
emit(ctx, buildGraph(ctx));
buildCatalog(ctx);

test('triage ranks sources by expected yield with a cumulative cost projection', () => {
  // small sourceTokensPerTriple so the three refs get distinct yields
  const q = triageProfile(ctx, { sourceTokensPerTriple: 30, outFile: join(ctx.outDir, 'triage-test.json') });
  assert.equal(q.sources.length, 3, 'three reference files present');
  for (let i = 1; i < q.sources.length; i++) {
    assert.ok(q.sources[i - 1].estTriples >= q.sources[i].estTriples, 'ranked by expected yield (desc)');
    assert.ok(q.sources[i].cumulativeCostUSD >= q.sources[i - 1].cumulativeCostUSD, 'cumulative cost is monotonic');
  }
  assert.ok(Math.abs(q.sources.at(-1).cumulativeCostUSD - q.totalCostUSD) < 1e-9, 'last cumulative == total');
  q.sources.forEach((r, i) => assert.equal(r.rank, i + 1));
});

test('triage budget marks a cutoff the runner can consume', () => {
  const full = triageProfile(ctx, { sourceTokensPerTriple: 30, outFile: join(ctx.outDir, 'triage-test.json') });
  const budget = full.totalCostUSD * 0.5;
  const q = triageProfile(ctx, { sourceTokensPerTriple: 30, budget, outFile: join(ctx.outDir, 'triage-test.json') });
  assert.ok(q.sources[0].withinBudget, 'the top-ranked source fits');
  assert.ok(q.sources.some((r) => !r.withinBudget), 'a lower-ranked source is over budget');
  // what `extract --budget` would select
  const selected = q.sources.filter((r) => !r.already && r.withinBudget).map((r) => r.source);
  assert.ok(selected.length >= 1 && selected.length < q.sources.length);
});
