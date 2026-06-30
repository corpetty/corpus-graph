// triage — rank the extractable sources by expected yield and project the
// token + dollar cost of extracting them, so a corpus owner can extract a
// BUDGETED subset deliberately instead of running everything. The runner can
// consume the queue (`extract --queue` / `extract --budget=N`).
//
// The scoring is a transparent, tunable heuristic — no model is hard-coded:
//   estTriples  = sourceTokens / sourceTokensPerTriple   (a yield proxy; the
//                 default 2000 mirrors the reference's ~607-triple/1.2M-token run)
//   inputTokens = sourceTokens + catalogTokens           (the per-call prompt)
//   outputTokens= estTriples * outputTokensPerTriple
//   estCost     = price(inputTokens, outputTokens)
// Prompt caching of the catalog block makes real cost lower; this is a ceiling.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readJSON, readJSONL, writeJSON, estTokens } from './lib/io.js';
import { evidencePredicates } from './direction-rules.js';
import { estimateCostUSD } from './lib/llm.js';

const idSlug = (id) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);

export function triageProfile(ctx, opts = {}) {
  const o = {
    model: opts.model || 'claude-opus-4-8',
    sourceTokensPerTriple: opts.sourceTokensPerTriple || 2000,
    outputTokensPerTriple: opts.outputTokensPerTriple || 200,
    budget: opts.budget != null ? Number(opts.budget) : null,
    outFile: opts.outFile || join(ctx.outDir, 'triage-queue.json'),
  };
  if (!existsSync(ctx.nodesPath)) throw new Error('no graph — run build first');
  if (!existsSync(ctx.catalogPath)) throw new Error('no extraction catalog — run catalog first');

  const nodes = readJSONL(ctx.nodesPath);
  const catalogTokens = estTokens(JSON.stringify(readJSON(ctx.catalogPath)));
  const evPreds = evidencePredicates(ctx.ontology);
  const defaultFrom = [...new Set(evPreds.flatMap((p) => ctx.ontology.predicates[p].subjectTypes || []))];
  const extractFrom = new Set(ctx.ontology.extractFrom || defaultFrom);

  const rows = [];
  for (const n of nodes) {
    if (!extractFrom.has(n.type) || !n.file) continue;
    const path = join(ctx.profileDir, n.file);
    if (!existsSync(path)) continue; // can't extract a source whose file is missing
    const sourceTokens = estTokens(readFileSync(path, 'utf8'));
    const estTriples = Math.max(1, Math.round(sourceTokens / o.sourceTokensPerTriple));
    const inputTokens = sourceTokens + catalogTokens;
    const outputTokens = estTriples * o.outputTokensPerTriple;
    const estCostUSD = estimateCostUSD(o.model, { input_tokens: inputTokens, output_tokens: outputTokens }) || 0;
    const already = existsSync(join(ctx.interpretiveDir, `${idSlug(n.id)}.jsonl`));
    rows.push({ source: n.id, label: n.label || n.title || n.id, sourceTokens, estTriples, estCostUSD, already });
  }

  // Rank: not-yet-extracted first, then by expected yield, then stable by id.
  rows.sort(
    (a, b) => (a.already ? 1 : 0) - (b.already ? 1 : 0) || b.estTriples - a.estTriples || a.source.localeCompare(b.source),
  );
  let cum = 0;
  rows.forEach((r, i) => {
    r.rank = i + 1;
    cum += r.estCostUSD;
    r.cumulativeCostUSD = cum;
    r.withinBudget = o.budget == null ? true : !r.already && r.cumulativeCostUSD <= o.budget;
  });

  const queue = { profile: ctx.profileName, model: o.model, budget: o.budget, totalCostUSD: cum, sources: rows };
  writeJSON(o.outFile, queue);
  return queue;
}

export function formatTriageReport(queue) {
  const lines = [`rank  source                                    ~src-tok  ~triples   ~$cost   cum$    `];
  for (const r of queue.sources) {
    const mark = r.already ? ' (done)' : queue.budget != null && !r.withinBudget ? ' (over budget)' : '';
    lines.push(
      `${String(r.rank).padStart(4)}  ${r.source.padEnd(40).slice(0, 40)}  ${String(r.sourceTokens).padStart(8)}  ${String(r.estTriples).padStart(8)}  ${('$' + r.estCostUSD.toFixed(4)).padStart(8)}  ${('$' + r.cumulativeCostUSD.toFixed(4)).padStart(8)}${mark}`,
    );
  }
  lines.push(`total projected: $${queue.totalCostUSD.toFixed(4)}${queue.budget != null ? ` (budget $${queue.budget})` : ''}`);
  return lines.join('\n');
}
