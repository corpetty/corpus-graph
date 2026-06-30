// doctor — diagnose a profile WITHOUT rebuilding or writing anything.
//
// Three classes of check the normal build/test loop doesn't give you:
//   1. Staleness — is the on-disk derived graph (data/<profile>/*.jsonl, what the
//      exporter and MCP server actually read) older than any input, INCLUDING the
//      engine itself? The golden snapshot can't catch this: it rebuilds in memory,
//      so an input edited-but-not-rebuilt still "passes" while bundles serve stale.
//   2. Referential / direction / orphan problems — surfaced by a real in-memory
//      build (no emit), so doctor never diverges from the builder.
//   3. Config validity — render-spec and ontology wiring the build doesn't check
//      (a render section pointing at a renamed-away node type, a bad evidence
//      predicate, an unknown breadcrumb predicate, a dangling targetNs).
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/config.js';
import { buildGraph } from './build-graph.js';
import { readJSON } from './lib/io.js';

const KNOWN_KINDS = new Set([
  'centerSummary', 'breadcrumb', 'claimsWithEvidence', 'contestedClaims',
  'questions', 'sources', 'nodeList', 'editorialFlags',
]);

const rel = (p) => (p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p);

export function doctor(ctx) {
  const problems = [];
  const add = (level, msg) => problems.push({ level, msg });
  const nt = ctx.ontology.nodeTypes || {};
  const preds = ctx.ontology.predicates || {};

  // ---- 1. Staleness: on-disk derived graph vs every input (incl. the engine) ----
  const inputs = [];
  const stat = (p) => existsSync(p) && inputs.push(p);
  stat(ctx.ontologyPath);
  stat(ctx.renderSpecPath);
  stat(ctx.harvestSignalsPath);
  stat(ctx.slugAliasesPath);
  for (const loader of ctx.ontology.catalogLoaders || []) stat(join(ctx.profileDir, loader.file));
  for (const dir of [ctx.interpretiveDir, ctx.contentDir]) {
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (/\.(jsonl|md)$/.test(f)) inputs.push(join(dir, f));
  }
  const coreDir = join(REPO_ROOT, 'core');
  for (const f of readdirSync(coreDir)) if (f.endsWith('.js')) inputs.push(join(coreDir, f));
  const libDir = join(coreDir, 'lib');
  if (existsSync(libDir)) for (const f of readdirSync(libDir)) if (f.endsWith('.js')) inputs.push(join(libDir, f));

  if (!existsSync(ctx.nodesPath)) {
    add('warn', `graph not built — run \`make build PROFILE=${ctx.profileName}\` (the exporter/MCP read data/${ctx.profileName}/)`);
  } else {
    const builtAt = statSync(ctx.nodesPath).mtimeMs;
    const newer = inputs.filter((p) => statSync(p).mtimeMs > builtAt);
    if (newer.length) {
      add('error', `on-disk graph is STALE: ${newer.length} input(s) newer than ${rel(ctx.nodesPath)} — run \`make build PROFILE=${ctx.profileName}\``);
      for (const p of newer.slice(0, 8)) add('info', `newer: ${rel(p)}`);
      if (newer.length > 8) add('info', `…and ${newer.length - 8} more`);
    }
  }

  // ---- 2. Real in-memory build (no emit) for referential/direction/orphan ----
  let result = null;
  try {
    result = buildGraph(ctx);
  } catch (e) {
    add('error', `build would FAIL: ${e.message}`);
  }
  if (result) {
    for (const w of result.warnings) add(/source unread/.test(w) ? 'info' : 'warn', w);
    if (existsSync(ctx.expectedStatsPath)) {
      const exp = readJSON(ctx.expectedStatsPath);
      if (exp.nodes !== result.stats.nodes || exp.edges !== result.stats.edges) {
        add('warn', `golden snapshot drift: built ${result.stats.nodes}/${result.stats.edges}, expected ${exp.nodes}/${exp.edges} — \`make accept-stats\` if intended`);
      }
    } else {
      add('info', `no golden snapshot — \`make accept-stats PROFILE=${ctx.profileName}\` to freeze one`);
    }
  }

  // ---- 3. render-spec validity (the build never reads render-spec) ----
  for (const sec of ctx.renderSpec.sections || []) {
    const id = sec.id || sec.kind;
    if (!KNOWN_KINDS.has(sec.kind)) add('error', `render-spec: section '${id}' has unknown kind '${sec.kind}'`);
    if (sec.nodeType && !nt[sec.nodeType]) add('error', `render-spec: section '${id}' references unknown nodeType '${sec.nodeType}'`);
    for (const p of sec.evidencePredicates || []) if (!preds[p]) add('error', `render-spec: section '${id}' evidencePredicate '${p}' not in ontology`);
    for (const p of sec.predicates || []) if (!preds[p]) add('error', `render-spec: breadcrumb '${id}' predicate '${p}' not in ontology`);
    if (sec.evidenceDirection && !['in', 'out'].includes(sec.evidenceDirection)) add('error', `render-spec: section '${id}' evidenceDirection must be 'in' or 'out'`);
  }
  for (const p of ctx.renderSpec.neverRender || []) if (!preds[p]) add('warn', `render-spec: neverRender lists '${p}', not a predicate`);

  // ---- 4. ontology config sanity ----
  for (const loader of ctx.ontology.catalogLoaders || []) {
    if (!nt[loader.nodeType]) add('error', `ontology: catalogLoader ${loader.file} nodeType '${loader.nodeType}' not declared`);
    for (const [field, spec] of Object.entries(loader.arrayFieldEdges || {})) {
      if (!preds[spec.predicate]) add('error', `ontology: ${loader.file} field '${field}' predicate '${spec.predicate}' not in ontology`);
      if (spec.targetNs && !ctx.nsToType[spec.targetNs]) add('error', `ontology: ${loader.file} field '${field}' targetNs '${spec.targetNs}' is not a node-type namespace`);
      if (spec.dir && !['in', 'out'].includes(spec.dir)) add('error', `ontology: ${loader.file} field '${field}' dir must be 'in' or 'out'`);
    }
  }
  for (const t of ctx.ontology.hubTransitTypes || []) if (!nt[t]) add('warn', `ontology: hubTransitTypes '${t}' is not a node type`);
  for (const ns of ctx.ontology.namespacePriority || []) if (!ctx.nsToType[ns]) add('warn', `ontology: namespacePriority '${ns}' has no node type`);
  if ((ctx.ontology.statuses || []).length) {
    const st = ctx.ontology.statusType || 'Status';
    if (!nt[st]) add('error', `ontology: statusType '${st}' not declared but statuses are listed`);
  }

  // ---- 5. slug-aliases resolve to real nodes ----
  if (result && Object.keys(ctx.slugAliases || {}).length) {
    const ids = new Set(result.nodes.keys());
    for (const [slug, target] of Object.entries(ctx.slugAliases)) {
      if (!ids.has(target)) add('warn', `slug-alias '${slug}' -> '${target}' does not resolve to a node`);
    }
  }

  return problems;
}
