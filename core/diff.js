// diff — score one extraction set (candidate) against another (reference, "gold")
// so you can measure extraction quality and compare models. Metrics:
//   - schema validity (per row has subject/predicate/object + a valid confidence)
//   - triple precision / recall / F1 over the (subject,predicate,object) key set
//   - quote fidelity: does each quote appear VERBATIM in the source text (--source)
//   - hallucinated ids / bad direction vs a profile's closed-world catalog (--profile)
import { existsSync, readFileSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { buildGraph, emit } from './build-graph.js';
import { readJSONL } from './lib/io.js';
import { checkEdge } from './direction-rules.js';

const VALID_CONF = new Set(['high', 'medium', 'low']);
const isValid = (t) =>
  t && typeof t.subject === 'string' && typeof t.predicate === 'string' &&
  typeof t.object === 'string' && VALID_CONF.has(t.confidence);
const tkey = (t) => `${t.subject}|${t.predicate}|${t.object}`;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

export function diffExtractions(candidate, reference, opts = {}) {
  const candValid = candidate.filter(isValid);
  const refValid = reference.filter(isValid);
  const candKeys = new Set(candValid.map(tkey));
  const refKeys = new Set(refValid.map(tkey));
  let matched = 0;
  for (const k of candKeys) if (refKeys.has(k)) matched++;
  const precision = candKeys.size ? matched / candKeys.size : 0;
  const recall = refKeys.size ? matched / refKeys.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  let withQuote = 0;
  let verbatim = 0;
  if (opts.sourceText != null) {
    const src = norm(opts.sourceText);
    for (const t of candValid) {
      if (t.quote) {
        withQuote++;
        if (src.includes(norm(t.quote))) verbatim++;
      }
    }
  }

  let hallucinated = 0;
  let catalogChecked = false;
  if (opts.ctx && opts.knownIds) {
    catalogChecked = true;
    for (const t of candValid) {
      const ok =
        opts.knownIds.has(t.subject) && opts.knownIds.has(t.object) &&
        checkEdge({ source: t.subject, predicate: t.predicate, target: t.object }, opts.ctx.ontology, opts.ctx.nsToType).ok;
      if (!ok) hallucinated++;
    }
  }

  return {
    candidate: { total: candidate.length, valid: candValid.length, invalid: candidate.length - candValid.length },
    reference: { total: reference.length, valid: refValid.length },
    precision, recall, f1, matched,
    quote: { checked: opts.sourceText != null, withQuote, verbatim, fidelity: withQuote ? verbatim / withQuote : null },
    catalog: { checked: catalogChecked, hallucinated },
  };
}

export function formatDiffReport(m) {
  const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const out = [
    `candidate: ${m.candidate.total} rows (${m.candidate.valid} valid, ${m.candidate.invalid} schema-invalid)`,
    `reference: ${m.reference.total} rows (${m.reference.valid} valid)`,
    `matched (s,p,o): ${m.matched}  ·  precision ${pct(m.precision)}  recall ${pct(m.recall)}  F1 ${pct(m.f1)}`,
    m.quote.checked
      ? `quote fidelity: ${m.quote.verbatim}/${m.quote.withQuote} verbatim in source (${pct(m.quote.fidelity)})`
      : 'quote fidelity: (pass --source=<file> to check)',
    m.catalog.checked
      ? `hallucinated ids / bad direction: ${m.catalog.hallucinated}`
      : 'catalog check: (pass --profile=<name> to check)',
  ];
  return out.join('\n');
}

// Shared CLI used by both `corpus-graph diff` and direct invocation.
export function runDiffCLI(args) {
  const get = (k) => {
    const f = args.find((a) => a.startsWith(`--${k}=`));
    return f ? f.slice(k.length + 3) : undefined;
  };
  const [aPath, bPath] = args.filter((a) => !a.startsWith('--'));
  if (!aPath || !bPath) {
    console.error('usage: diff <candidate.jsonl> <reference.jsonl> [--source=<file>] [--profile=<name>] [--format=json]');
    return 1;
  }
  const candidate = readJSONL(aPath);
  const reference = readJSONL(bPath);
  const opts = {};
  const sf = get('source');
  if (sf && existsSync(sf)) opts.sourceText = readFileSync(sf, 'utf8');
  const profile = get('profile');
  if (profile) {
    const ctx = loadContext(profile);
    emit(ctx, buildGraph(ctx)); // ensure a fresh closed-world catalog
    opts.ctx = ctx;
    opts.knownIds = new Set(readJSONL(ctx.nodesPath).map((n) => n.id));
  }
  const m = diffExtractions(candidate, reference, opts);
  if (get('format') === 'json') console.log(JSON.stringify(m, null, 2));
  else console.log(formatDiffReport(m));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runDiffCLI(process.argv.slice(2)));
}
