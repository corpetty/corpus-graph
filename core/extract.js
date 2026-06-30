// extract — a programmatic, resumable extraction runner. Per source it sends
// the closed-world catalog + the source text to an LLM backend and writes the
// VALIDATED evidence triples to profiles/<p>/interpretive/<source>.jsonl, which
// the build then folds in. The runner never trusts the model: every returned
// triple is re-validated against the same direction-rules + closed-world catalog
// the aggregator uses, so a hallucinated id or backwards edge is dropped here.
//
// Oversized sources are CHUNKED (heading-aware) under a token ceiling, extracted
// per chunk, and merged with (subject,predicate,object) dedup keeping the
// highest-confidence row. Chunk-level extractions are cached so a re-run resumes.
import { join, basename } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { loadContext, REPO_ROOT } from './lib/config.js';
import { readJSON, readJSONL, writeJSONL, writeJSON, estTokens } from './lib/io.js';
import { checkEdge, evidencePredicates } from './direction-rules.js';
import { getBackend, estimateCostUSD } from './lib/llm.js';
import { chunkText } from './lib/chunk.js';

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

// Re-validate model output against the closed-world catalog + direction rules.
function validateTriples(triples, ctx, blobs, minConfidence) {
  const { ontology, nsToType } = ctx;
  const { knownIds, evPreds } = blobs;
  const kept = [];
  let dropped = 0;
  const seen = new Set();
  for (const t of triples) {
    const edge = { source: t.subject, predicate: t.predicate, target: t.object };
    if (!evPreds.includes(t.predicate)) { dropped++; continue; }
    if (!checkEdge(edge, ontology, nsToType).ok) { dropped++; continue; }
    if (!knownIds.has(t.subject) || !knownIds.has(t.object)) { dropped++; continue; }
    if ((CONF_RANK[t.confidence] || 0) < CONF_RANK[minConfidence]) { dropped++; continue; }
    const key = `${t.subject}|${t.predicate}|${t.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      subject: t.subject, predicate: t.predicate, object: t.object,
      quote: t.quote, pageApprox: t.pageApprox, confidence: t.confidence, rationale: t.rationale,
    });
  }
  return { kept, dropped };
}

// Dedup across chunks by (s,p,o), keeping the highest-confidence row.
function mergeByConfidence(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = `${r.subject}|${r.predicate}|${r.object}`;
    const cur = best.get(key);
    if (!cur || (CONF_RANK[r.confidence] || 0) > (CONF_RANK[cur.confidence] || 0)) best.set(key, r);
  }
  return [...best.values()];
}

function userMessage(source, label, text, evPreds, chunkInfo) {
  return (
    `SOURCE id: \`${source.id}\`\nSOURCE label: ${label}${chunkInfo ? `\n(${chunkInfo})` : ''}\n\n` +
    `Extract evidence triples this source provides about catalog entities, using \`${source.id}\` as the source endpoint of each evidence predicate (${evPreds.join(' / ')}).\n\n` +
    `=== SOURCE TEXT ===\n${text}`
  );
}

async function callBackend(opts, system, user) {
  return opts.backend({ system, user, model: opts.model, maxTokens: opts.maxTokens, effort: opts.effort, schema: TRIPLE_SCHEMA });
}

// Chunk an oversized source, extract each chunk (resumable via a chunk cache),
// then merge with (s,p,o) dedup keeping highest confidence.
async function extractChunked(ctx, source, opts, blobs, slug, srcText, outFile) {
  let chunks = chunkText(srcText, opts.chunkTokens);
  let truncated = 0;
  if (chunks.length > opts.maxChunks) {
    truncated = chunks.length - opts.maxChunks;
    chunks = chunks.slice(0, opts.maxChunks);
  }
  const chunkDir = join(opts.chunkCacheDir, slug);
  mkdirSync(chunkDir, { recursive: true });
  writeJSON(join(chunkDir, 'manifest.json'), {
    source: source.id, sourceTokens: estTokens(srcText), chunkTokens: opts.chunkTokens,
    chunks: chunks.map((c) => ({ index: c.index, tokens: c.tokens })), truncated,
  });

  const label = source.label || source.title || source.id;
  let totalDropped = 0;
  let totalCost = 0;
  const allKept = [];

  // Sequential within a source (the source-level fan-out gives parallelism, and
  // sequential chunks keep cost logging and resume order deterministic).
  for (const c of chunks) {
    const pad = String(c.index + 1).padStart(2, '0');
    const chunkFile = join(chunkDir, `chunk-${pad}.jsonl`);
    if (existsSync(chunkFile) && !opts.force) {
      allKept.push(...readJSONL(chunkFile));
      continue;
    }
    const user = userMessage(source, label, c.text, blobs.evPreds, `chunk ${c.index + 1} of ${chunks.length}`);
    let res;
    try {
      res = await callBackend(opts, blobs.systemPrompt, user);
    } catch (e) {
      return { source: source.id, status: `error on chunk ${c.index + 1}: ${e.message}` };
    }
    const { triples } = parseTriples(res.text);
    const { kept, dropped } = validateTriples(triples, ctx, blobs, opts.minConfidence);
    totalDropped += dropped;
    totalCost += estimateCostUSD(opts.model, res.usage) || 0;
    writeJSONL(chunkFile, kept);
    allKept.push(...kept);
  }

  const merged = mergeByConfidence(allKept);
  mkdirSync(opts.outDir, { recursive: true });
  writeJSONL(outFile, merged);
  return {
    source: source.id,
    status: `extracted (${chunks.length} chunks${truncated ? `, ${truncated} over --max-chunks dropped` : ''})`,
    kept: merged.length, dropped: totalDropped, chunks: chunks.length, truncated, cost: totalCost, file: outFile,
  };
}

async function extractOne(ctx, source, opts, blobs) {
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

  if (opts.dryRun) {
    const nChunks = tokens > opts.chunkTokens ? chunkText(srcText, opts.chunkTokens).length : 1;
    return { source: source.id, status: `would extract (~${tokens} tok${nChunks > 1 ? `, ${nChunks} chunks` : ''})` };
  }

  if (tokens > opts.chunkTokens) {
    return extractChunked(ctx, source, opts, blobs, slug, srcText, outFile);
  }

  // Single-call path.
  let res;
  try {
    res = await callBackend(opts, blobs.systemPrompt, userMessage(source, label, srcText, blobs.evPreds));
  } catch (e) {
    return { source: source.id, status: `error: ${e.message}` };
  }
  const { triples, notes } = parseTriples(res.text);
  const { kept, dropped } = validateTriples(triples, ctx, blobs, opts.minConfidence);
  mkdirSync(opts.outDir, { recursive: true });
  writeJSONL(outFile, kept);
  return {
    source: source.id, status: 'extracted', kept: kept.length, dropped, notes: notes.length,
    cost: estimateCostUSD(opts.model, res.usage), file: outFile,
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
    chunkTokens: opts.chunkTokens || 100000,
    maxChunks: opts.maxChunks || 50,
    force: !!opts.force,
    dryRun: !!opts.dryRun,
    outDir: opts.outDir || ctx.interpretiveDir,
    chunkCacheDir: opts.chunkCacheDir || join(ctx.outDir, 'chunks'),
  };

  if (!existsSync(ctx.nodesPath)) throw new Error('no graph — run build first');
  if (!existsSync(ctx.catalogPath)) throw new Error('no extraction catalog — run catalog first');
  const nodeById = new Map(readJSONL(ctx.nodesPath).map((n) => [n.id, n]));
  const knownIds = new Set(nodeById.keys());
  const catalog = readJSON(ctx.catalogPath);
  const evPreds = evidencePredicates(ctx.ontology);
  const systemPrompt = `${extractionPromptText(ctx)}\n\n## CATALOG\n\n\`\`\`json\n${JSON.stringify(catalog)}\n\`\`\``;

  const defaultFrom = [...new Set(evPreds.flatMap((p) => ctx.ontology.predicates[p].subjectTypes || []))];
  const extractFrom = new Set(ctx.ontology.extractFrom || defaultFrom);

  let targets = [...nodeById.values()].filter((n) => extractFrom.has(n.type) && n.file);
  if (opts.onlySources) {
    // A triage-ordered subset (from `extract --queue` / `--budget`).
    const order = new Map(opts.onlySources.map((id, i) => [id, i]));
    targets = targets.filter((n) => order.has(n.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  } else if (opts.sourceId) {
    const full = opts.sourceId.includes(':');
    targets = targets.filter((n) => n.id === opts.sourceId || (!full && n.id.endsWith(`:${opts.sourceId}`)));
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
  const num = (k) => (get(k) ? Number(get(k)) : undefined);
  const opts = {
    backendName: get('backend') || 'anthropic',
    sourceId: get('source'),
    model: get('model'),
    effort: get('effort'),
    minConfidence: get('min-confidence'),
    concurrency: num('concurrency'),
    maxTokens: num('max-tokens'),
    chunkTokens: num('chunk-tokens'),
    maxChunks: num('max-chunks'),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  };
  if (!opts.sourceId && !args.includes('--all')) {
    console.error('usage: extract (--source=<id> | --all) [--backend=anthropic|openai|mock] [--model=] [--effort=] [--min-confidence=] [--chunk-tokens=N] [--max-chunks=N] [--concurrency=N] [--force] [--dry-run]');
    process.exit(1);
  }
  const summary = await extractProfile(ctx, opts);
  for (const r of summary.results) {
    const extra = r.kept != null ? ` (kept ${r.kept}, dropped ${r.dropped || 0}${r.cost != null ? `, ~$${r.cost.toFixed(4)}` : ''})` : '';
    console.error(`  ${r.source} — ${r.status}${extra}`);
  }
  console.log(`[${ctx.profileName}] ${summary.count} source(s), ${summary.totalKept} triples kept, ~$${summary.totalCost.toFixed(4)}. Run \`make build\` to fold them in.`);
}
