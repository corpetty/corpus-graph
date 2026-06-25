// build-graph — derive a typed semantic-triple graph from a profile's catalogs,
// prose, and interpretive triples. Rebuilt from scratch every run (sub-second),
// so the graph can never drift from its inputs.
//
// Two gatekeepers enforce the ontology.json contract at insertion:
//   addNode  — throws on an unknown node type (hard vocabulary contract)
//   addEdge  — throws on an unknown predicate; drops+warns on a direction/shape
//              violation (soft direction contract; STRICT=1 makes it fatal)
import { join, basename } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { writeJSONL, writeJSON, readJSONL, estTokens, slugify, stripFrontmatter } from './lib/io.js';
import { checkEdge } from './direction-rules.js';

export function buildGraph(ctx) {
  const { ontology, nsToType } = ctx;
  const nodes = new Map();
  const edges = [];
  const edgeKey = new Map(); // "s|p|t" -> edge object (for payload merge)
  const warnings = [];
  const warn = (m) => warnings.push(m);

  function addNode(id, type, props = {}) {
    if (!ontology.nodeTypes[type]) throw new Error(`addNode: unknown node type '${type}' for ${id}`);
    const existing = nodes.get(id);
    if (existing) {
      for (const [k, v] of Object.entries(props)) if (v !== undefined) existing[k] = v;
      return existing;
    }
    const node = { id, type, ...props };
    nodes.set(id, node);
    return node;
  }

  function addEdge(edge) {
    const { source, predicate, target } = edge;
    if (!ontology.predicates[predicate]) throw new Error(`addEdge: unknown predicate '${predicate}'`);
    const verdict = checkEdge(edge, ontology, nsToType);
    if (!verdict.ok) {
      warn(`dropped edge ${source} -${predicate}-> ${target}: ${verdict.reason}`);
      return;
    }
    const key = `${source}|${predicate}|${target}`;
    if (edgeKey.has(key)) {
      // Merge evidence payload onto the existing edge rather than duplicate.
      const ex = edgeKey.get(key);
      for (const k of ['quote', 'pageApprox', 'confidence', 'rationale']) {
        if (edge[k] !== undefined && ex[k] === undefined) ex[k] = edge[k];
      }
      return;
    }
    edgeKey.set(key, edge);
    edges.push(edge);
  }

  // (1) Seed lifecycle status nodes from the ontology so hasStatus edges
  // resolve. The status node TYPE is configurable (default "Status") so a
  // renamed profile (e.g. "Lifecycle") still works.
  const statusType = ontology.statusType || 'Status';
  if ((ontology.statuses || []).length && ontology.nodeTypes[statusType]) {
    const statusNs = ctx.typeToNs[statusType];
    for (const s of ontology.statuses) addNode(`${statusNs}:${slugify(s)}`, statusType, { label: s });
  }

  // (2) Load hand-authored catalogs, data-driven from ontology.catalogLoaders.
  const proseDocs = []; // {id, file}
  for (const loader of ontology.catalogLoaders || []) {
    const path = join(ctx.profileDir, loader.file);
    if (!existsSync(path)) continue; // a profile need not use every type
    const entries = JSON.parse(readFileSync(path, 'utf8'));
    const edgeFields = loader.arrayFieldEdges || {};
    const ns = ctx.typeToNs[loader.nodeType];
    for (const entry of entries) {
      if (!entry.id) {
        warn(`${loader.file}: entry with no id skipped`);
        continue;
      }
      const id = entry.id.includes(':') ? entry.id : `${ns}:${entry.id}`;
      const props = {};
      for (const [k, v] of Object.entries(entry)) {
        if (k === 'id') continue;
        if (edgeFields[k]) continue; // edge field, not a prop
        props[k] = v;
      }
      addNode(id, loader.nodeType, props);
      if (loader.proseField && entry[loader.proseField]) {
        proseDocs.push({ id, file: entry[loader.proseField] });
      }
      for (const [field, spec] of Object.entries(edgeFields)) {
        const vals = entry[field];
        if (!Array.isArray(vals)) continue;
        for (const raw of vals) {
          const tid = String(raw).includes(':')
            ? String(raw)
            : spec.targetNs
              ? `${spec.targetNs}:${slugify(raw)}`
              : null;
          if (!tid) {
            warn(`${loader.file} ${id}.${field}: ambiguous target '${raw}' — use a full 'ns:slug' id`);
            continue;
          }
          if (spec.dir === 'in') addEdge({ source: tid, predicate: spec.predicate, target: id });
          else addEdge({ source: id, predicate: spec.predicate, target: tid });
        }
      }
    }
  }

  // (3) Parse prose for [[wikilinks]] and H2 section anchors.
  function resolveWikilink(rawSlug) {
    if (ctx.slugAliases[rawSlug]) return ctx.slugAliases[rawSlug];
    for (const ns of ontology.namespacePriority || []) {
      const cand = `${ns}:${rawSlug}`;
      if (nodes.has(cand)) return cand;
    }
    return null;
  }
  for (const doc of proseDocs) {
    const path = join(ctx.contentDir, doc.file);
    if (!existsSync(path)) {
      warn(`document ${doc.id}: prose file missing (${doc.file})`);
      continue;
    }
    const md = stripFrontmatter(readFileSync(path, 'utf8'));
    const sections = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    if (sections.length) nodes.get(doc.id).sections = sections;
    for (const m of md.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const rawSlug = slugify(m[1].split('|')[0]);
      const tid = resolveWikilink(rawSlug);
      if (!tid) {
        warn(`document ${doc.id}: unresolved wikilink [[${m[1]}]] (slug '${rawSlug}')`);
        continue;
      }
      // Prose links are the WEAK navigation predicate by design; explicit
      // citation is a deliberate catalog act (the `cites` field), not inferred.
      addEdge({ source: doc.id, predicate: 'wikiLinks', target: tid });
    }
  }

  // (4) Fold in interpretive (LLM-extracted) evidence triples. Prefer a
  // validated aggregate; else read the committed per-source jsonl directly so a
  // bare clone still ships the evidence layer.
  let interpretiveRows = [];
  if (existsSync(ctx.aggregatePath)) {
    interpretiveRows = readJSONL(ctx.aggregatePath);
  } else if (existsSync(ctx.interpretiveDir)) {
    for (const f of readdirSync(ctx.interpretiveDir).filter((f) => f.endsWith('.jsonl'))) {
      interpretiveRows.push(...readJSONL(join(ctx.interpretiveDir, f)));
    }
  }
  for (const r of interpretiveRows) {
    addEdge({
      source: r.subject,
      predicate: r.predicate,
      target: r.object,
      quote: r.quote,
      pageApprox: r.pageApprox,
      confidence: r.confidence,
      rationale: r.rationale,
    });
  }

  // (5) Validate: drop edges whose endpoints don't exist.
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i];
    if (!nodes.has(e.source) || !nodes.has(e.target)) {
      warn(`dangling edge ${e.source} -${e.predicate}-> ${e.target} (missing endpoint)`);
      edges.splice(i, 1);
    }
  }

  // (6) Source-unread: a Source with a declared file but no evidence edges is an
  // un-run extraction task.
  const evidencePreds = new Set(['supports', 'pressureTests']);
  const sourcesWithEvidence = new Set(
    edges.filter((e) => evidencePreds.has(e.predicate)).map((e) => e.source),
  );
  for (const n of nodes.values()) {
    if (n.type === 'Source' && n.file && !sourcesWithEvidence.has(n.id)) {
      warn(`source unread: ${n.id} has a file but no supports/pressureTests evidence yet`);
    }
  }

  // (7) Orphan content: top-level prose files not claimed by any Document.
  if (existsSync(ctx.contentDir)) {
    const claimed = new Set(proseDocs.map((d) => basename(d.file)));
    for (const f of readdirSync(ctx.contentDir).filter((f) => f.endsWith('.md'))) {
      if (!claimed.has(f)) warn(`orphan content: ${f} is not referenced by any Document`);
    }
  }

  // (8) Claim drift: each claim's harvestedFrom anchor must still appear in the
  // freshly-harvested candidate inbox (local-only; no-ops without candidates).
  if (existsSync(ctx.candidatesPath)) {
    const cands = readJSONL(ctx.candidatesPath);
    for (const n of nodes.values()) {
      if (n.type !== 'Claim' || !Array.isArray(n.harvestedFrom)) continue;
      for (const anchor of n.harvestedFrom) {
        const prefix = (anchor.text || '').slice(0, 40);
        if (!prefix) continue;
        const hit = cands.some(
          (c) => (!anchor.document || c.document === anchor.document) && (c.text || '').includes(prefix),
        );
        if (!hit) warn(`claim drift: ${n.id} anchor not found in candidates ("${prefix}...")`);
      }
    }
  }

  const stats = computeStats(nodes, edges, warnings);
  return { nodes, edges, warnings, stats };
}

function computeStats(nodes, edges, warnings) {
  const byNodeType = {};
  for (const n of nodes.values()) byNodeType[n.type] = (byNodeType[n.type] || 0) + 1;
  const byPredicate = {};
  for (const e of edges) byPredicate[e.predicate] = (byPredicate[e.predicate] || 0) + 1;
  return { nodes: nodes.size, edges: edges.length, warnings: warnings.length, byNodeType, byPredicate };
}

export function emit(ctx, result) {
  writeJSONL(ctx.nodesPath, [...result.nodes.values()]);
  writeJSONL(ctx.edgesPath, result.edges);
  writeJSON(ctx.statsPath, { ...result.stats, builtAt: new Date().toISOString() });
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = loadContext();
  const result = buildGraph(ctx);
  emit(ctx, result);
  for (const w of result.warnings) console.error(`  warn: ${w}`);
  const sizeTokens = estTokens([...result.nodes.values()].map((n) => JSON.stringify(n)).join(''));
  console.log(
    `[${ctx.profileName}] ${result.stats.nodes} nodes, ${result.stats.edges} edges, ${result.stats.warnings} warnings (~${sizeTokens} tok of node text)`,
  );
  if (process.env.STRICT && result.warnings.length) {
    console.error(`STRICT: ${result.warnings.length} warning(s) — failing build`);
    process.exit(1);
  }
}
