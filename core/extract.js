// extract — a programmatic, resumable extraction runner. Per source, it sends
// the closed-world catalog + the source text to an LLM backend and writes the
// VALIDATED evidence triples to profiles/<p>/interpretive/<source>.jsonl, which
// the build then folds in. The runner never trusts the model: every returned
// triple is re-validated against the same direction-rules + closed-world catalog
// the aggregator uses, so a hallucinated id or backwards edge is dropped here.
import { join, basename } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { loadContext, REPO_ROOT } from './lib/config.js';
import { readJSON, readJSONL, writeJSONL, estTokens } from './lib/io.js';
import { checkEdge, evidencePredicates } from './direction-rules.js';
import { getBackend, estimateCostUSD } from './lib/llm.js';

const CONF_RANK = { high: 3, medium: 2, low: 1 };

const TRIPLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    triples: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          quote: { type: 'string' },
          pageApprox: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale: { type: 'string' },
          _note: { type: 'string' },
        },
        required: ['subject', 'predicate', 'object', 'confidence'],
      },
    },
  },
  required: ['triples'],
};

function extractionPromptText(ctx) {
  const profile = join(ctx.profileDir, 'EXTRACTION_PROMPT.md');
  const dflt = join(REPO_ROOT, 'config', 'EXTRACTION_PROMPT.md');
  return readFileSync(existsSync(profile) ? profile : dflt, 'utf8');
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function parseTriples(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { triples: [], notes: [] };
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return { triples: [], notes: [] };
    }
  }
  const rows = Array.isArray(obj) ? obj : obj.triples || [];
  const triples = rows.filter((r) => r && !r._note && r.subject && r.predicate && r.object);
  const notes = rows.filter((r) => r && r._note).map((r) => r._note);
  return { triples, notes };
}

// Process one source: returns a per-source result record.
async function extractOne(ctx, source, opts, ctxBlobs) {
  const { ontology, nsToType } = ctx;
  const { knownIds, evPreds, systemPrompt } = ctxBlobs;
  const slug = source.id.includes(':') ? source.id.slice(source.id.indexOf(':') + 1) : source.id;
  const outFile = join(opts.outDir, `${slug}.jsonl`);
  const label = source.label || source.title || source.id;

  if (existsSync(outFile) && !opts.force) {
    return { source: source.id, status: 'skipped (already extracted; --force to redo)' };
  }
  const srcPath = join(ctx.profileDir, source.file);
  if (!existsSync(srcPath)) {
    return { source: source.id, status: `skipped (source file missing: ${source.file})` };
  }
  const srcText = readFileSync(srcPath, 'utf8');
  const tokens = estTokens(srcText);
  if (tokens > opts.maxSourceTokens) {
    return {
      source: source.id,
      status: `skipped (source ~${tokens} tok > ${opts.maxSourceTokens}; needs chunking — corpus-graph#2)`,
    };
  }

  const user =
    `SOURCE id: \`${source.id}\`\nSOURCE label: ${label}\n\n` +
    `Extract evidence triples this source provides about catalog entities, using \`${source.id}\` as the source endpoint of each evidence predicate (${evPreds.join(' / ')}).\n\n` +
    `=== SOURCE TEXT ===\n${srcText}`;

  if (opts.dryRun) {
    return { source: source.id, status: `would extract (~${tokens} tok)`, kept: 0, dropped: 0 };
  }

  let res;
  try {
    res = await opts.backend({
      system: systemPrompt,
      user,
      model: opts.model,
      maxTokens: opts.maxTokens,
      effort: opts.effort,
      schema: TRIPLE_SCHEMA,
    });
  } catch (e) {
    return { source: source.id, status: `error: ${e.message}` };
  }

  const { triples, notes } = parseTriples(res.text);
  const kept = [];
  const drops = [];
  const seen = new Set();
  for (const t of triples) {
    const edge = { source: t.subject, predicate: t.predicate, target: t.object };
    if (!evPreds.includes(t.predicate)) {
      drops.push(`${t.predicate}: not an evidence predicate`);
      continue;
    }
    const v = checkEdge(edge, ontology, nsToType);
    if (!v.ok) {
      drops.push(v.reason);
      continue;
    }
    if (!knownIds.has(t.subject) || !knownIds.has(t.object)) {
      drops.push(`off-catalog id (${t.subject} / ${t.object})`);
      continue;
    }
    if ((CONF_RANK[t.confidence] || 0) < CONF_RANK[opts.minConfidence]) {
      drops.push(`below min confidence (${t.confidence})`);
      continue;
    }
    const key = `${t.subject}|${t.predicate}|${t.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      quote: t.quote,
      pageApprox: t.pageApprox,
      confidence: t.confidence,
      rationale: t.rationale,
    });
  }

  mkdirSync(opts.outDir, { recursive: true });
  writeJSONL(outFile, kept);
  const cost = estimateCostUSD(opts.model, res.usage);
  void nsToType;
  return {
    source: source.id,
    status: 'extracted',
    kept: kept.length,
    dropped: drops.length,
    notes: notes.length,
    cost,
    file: outFile,
    usage: res.usage,
  };
}

export async function extractProfile(ctx, opts = {}) {
  const o = {
    backend: opts.backend || getBackend(opts.backendName || 'anthropic'),
    model: opts.model || 'claude-opus-4-8',
    effort: opts.effort || 'medium',
    maxTokens: opts.maxTokens || 16000,
    concurrency: opts.concurrency || 4,
    minConfidence: opts.minConfidence || 'low',
    maxSourceTokens: opts.maxSourceTokens || 150000,
    force: !!opts.force,
    dryRun: !!opts.dryRun,
    outDir: opts.outDir || ctx.interpretiveDir,
  };

  if (!existsSync(ctx.nodesPath)) throw new Error('no graph — run build first');
  if (!existsSync(ctx.catalogPath)) throw new Error('no extraction catalog — run catalog first');
  const knownIds = new Set(readJSONL(ctx.nodesPath).map((n) => n.id));
  const nodeById = new Map(readJSONL(ctx.nodesPath).map((n) => [n.id, n]));
  const catalog = readJSON(ctx.catalogPath);
  const evPreds = evidencePredicates(ctx.ontology);
  const systemPrompt = `${extractionPromptText(ctx)}\n\n## CATALOG\n\n\`\`\`json\n${JSON.stringify(catalog)}\n\`\`\``;

  // Which node types are text sources to mine? Configurable; defaults to the
  // subject types of the evidence-carrying predicates.
  const defaultFrom = [...new Set(evPreds.flatMap((p) => ctx.ontology.predicates[p].subjectTypes || []))];
  const extractFrom = new Set(ctx.ontology.extractFrom || defaultFrom);

  let targets = [...nodeById.values()].filter((n) => extractFrom.has(n.type) && n.file);
  if (opts.sourceId) {
    const want = opts.sourceId.includes(':') ? opts.sourceId : null;
    targets = targets.filter((n) => n.id === opts.sourceId || (!want && n.id.endsWith(`:${opts.sourceId}`)));
    if (!targets.length) throw new Error(`source not found among extractable types: ${opts.sourceId}`);
  }

  const blobs = { knownIds, evPreds, systemPrompt };
  const results = await mapLimit(targets, o.concurrency, (n) => extractOne(ctx, n, o, blobs));
  const totalCost = results.reduce((a, r) => a + (r.cost || 0), 0);
  const totalKept = results.reduce((a, r) => a + (r.kept || 0), 0);
  return { results, totalCost, totalKept, count: targets.length };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const f = args.find((a) => a.startsWith(`--${k}=`));
    return f ? f.slice(k.length + 3) : undefined;
  };
  const ctx = loadContext();
  const opts = {
    backendName: get('backend') || 'anthropic',
    sourceId: get('source'),
    model: get('model'),
    effort: get('effort'),
    minConfidence: get('min-confidence'),
    concurrency: get('concurrency') ? Number(get('concurrency')) : undefined,
    maxTokens: get('max-tokens') ? Number(get('max-tokens')) : undefined,
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  };
  if (!opts.sourceId && !args.includes('--all')) {
    console.error('usage: extract (--source=<id> | --all) [--backend=anthropic|openai|mock] [--model=] [--effort=] [--min-confidence=] [--concurrency=N] [--force] [--dry-run]');
    process.exit(1);
  }
  const summary = await extractProfile(ctx, opts);
  for (const r of summary.results) {
    const extra = r.kept != null ? ` (kept ${r.kept}, dropped ${r.dropped || 0}${r.cost != null ? `, ~$${r.cost.toFixed(4)}` : ''})` : '';
    console.error(`  ${basename(r.source)} — ${r.status}${extra}`);
  }
  console.log(`[${ctx.profileName}] ${summary.count} source(s), ${summary.totalKept} triples kept, ~$${summary.totalCost.toFixed(4)}. Run \`make build\` to fold them in.`);
}
