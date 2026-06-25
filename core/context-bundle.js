// context-bundle — project a node's neighbourhood into a compact, citeable,
// diff-friendly Markdown packet for an AI session.
//
// Design: gather is cheap and generous (undirected, predicate-agnostic BFS with
// a hub-transit blocklist so category nodes don't collapse the graph); curation
// is type-aware and driven by render-spec.json. Load-bearing evidence lives on
// the EDGES (quote/page/confidence/rationale), so a fact and its justification
// are retrieved atomically and can be cited without opening the source.
import { writeFileSync, existsSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { readJSONL, estTokens } from './lib/io.js';

export function loadGraph(ctx) {
  if (!existsSync(ctx.nodesPath)) {
    throw new Error(`no graph for profile '${ctx.profileName}' — run \`make build PROFILE=${ctx.profileName}\` first`);
  }
  const nodeById = new Map(readJSONL(ctx.nodesPath).map((n) => [n.id, n]));
  const edges = readJSONL(ctx.edgesPath);
  const adj = new Map(); // undirected adjacency
  for (const e of edges) {
    (adj.get(e.source) || adj.set(e.source, []).get(e.source)).push(e.target);
    (adj.get(e.target) || adj.set(e.target, []).get(e.target)).push(e.source);
  }
  return { nodeById, edges, adj };
}

export function resolveCenterId(graph, ontology, raw) {
  const { nodeById } = graph;
  if (nodeById.has(raw)) return raw;
  for (const ns of ontology.namespacePriority || []) {
    if (nodeById.has(`${ns}:${raw}`)) return `${ns}:${raw}`;
  }
  const hits = [...nodeById.values()].filter(
    (n) =>
      String(n.number) === raw ||
      n.id.includes(raw) ||
      String(n.label || n.title || '').toLowerCase().includes(raw.toLowerCase()),
  );
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) {
    throw new Error(`ambiguous center '${raw}': ${hits.slice(0, 8).map((h) => h.id).join(', ')}`);
  }
  throw new Error(`center not found: '${raw}'`);
}

function bfs(graph, ontology, center, hop) {
  const hub = new Set(ontology.hubTransitTypes || []);
  const dist = new Map([[center, 0]]);
  const queue = [[center, 0]];
  while (queue.length) {
    const [id, h] = queue.shift();
    const node = graph.nodeById.get(id);
    if (h > 0 && node && hub.has(node.type)) continue; // reached, not transited
    if (h >= hop) continue;
    for (const nb of graph.adj.get(id) || []) {
      if (!dist.has(nb)) {
        dist.set(nb, h + 1);
        queue.push([nb, h + 1]);
      }
    }
  }
  return dist;
}

const labelOf = (n) => (n ? n.label || n.title || n.id : '?');

export function buildBundle(ctx, rawCenter, opts = {}) {
  const { ontology, renderSpec } = ctx;
  const graph = loadGraph(ctx);
  const center = resolveCenterId(graph, ontology, rawCenter);
  const hop = opts.hop ?? renderSpec.defaultHop ?? 2;
  const budget = opts.tokenBudget ?? renderSpec.tokenBudget ?? 20000;
  const dist = bfs(graph, ontology, center, hop);
  const { nodeById, edges } = graph;

  const inScope = (id) => dist.has(id);
  const reached = [...dist.keys()];
  const byType = (type) =>
    reached
      .map((id) => nodeById.get(id))
      .filter((n) => n && n.type === type)
      .sort((a, b) => dist.get(a.id) - dist.get(b.id) || labelOf(a).localeCompare(labelOf(b)));

  const inEdges = (id, pred) => edges.filter((e) => e.target === id && e.predicate === pred);
  const outEdges = (id, pred) => edges.filter((e) => e.source === id && e.predicate === pred);
  const never = new Set(renderSpec.neverRender || []);

  const out = [];
  const centerNode = nodeById.get(center);
  out.push(`# Context bundle — ${labelOf(centerNode)}`);
  out.push(`> \`${center}\` · type **${centerNode.type}** · hop ${hop} · ${reached.length} nodes in scope\n`);

  for (const sec of renderSpec.sections) {
    const block = renderSection(sec);
    if (block && block.trim()) out.push(block);
  }

  const text = out.join('\n') + '\n';
  const tokens = estTokens(text);
  return { center, text, tokens, nodesInScope: reached.length, hop, overBudget: tokens > budget, budget };

  function renderSection(sec) {
    switch (sec.kind) {
      case 'centerSummary': {
        const lines = [];
        if (centerNode.summary) lines.push(centerNode.summary);
        if (centerNode.aliases?.length) lines.push(`\n_Also known as: ${centerNode.aliases.join(', ')}._`);
        if (centerNode.sections?.length) lines.push(`\n**Sections:** ${centerNode.sections.join(' · ')}`);
        return lines.join('\n');
      }
      case 'claimsWithEvidence': {
        const claims = byType(sec.nodeType || 'Claim');
        if (!claims.length) return '';
        // Claims the center directly argues sort ahead of BFS-incidental ones.
        const direct = new Set(outEdges(center, sec.directPredicate || 'argues').map((e) => e.target));
        claims.sort((a, b) => (direct.has(b.id) ? 1 : 0) - (direct.has(a.id) ? 1 : 0));
        const ev = sec.evidencePredicates || ['supports', 'pressureTests'];
        const lines = [`## ${sec.title}`];
        for (const c of claims) lines.push(renderClaim(c, ev));
        return lines.join('\n');
      }
      case 'contestedClaims': {
        const [pos, neg] = sec.evidencePredicates || ['supports', 'pressureTests'];
        const claims = byType(sec.nodeType || 'Claim').filter(
          (c) => inEdges(c.id, pos).length && inEdges(c.id, neg).length,
        );
        if (!claims.length) return '';
        return [`## ${sec.title}`, ...claims.map((c) => `- **${labelOf(c)}** (\`${c.id}\`)`)].join('\n');
      }
      case 'questions': {
        const qs = byType(sec.nodeType || 'Question');
        if (!qs.length) return '';
        const resolved = new Set(sec.resolvedStatuses || []);
        const open = qs.filter((q) => !resolved.has(q.status));
        const done = qs.filter((q) => resolved.has(q.status));
        const lines = [];
        if (open.length) {
          lines.push(`## ${sec.title}`);
          for (const q of open) lines.push(`- **${labelOf(q)}** (\`${q.id}\`)${q.summary ? ` — ${q.summary}` : ''}`);
        }
        if (done.length) {
          lines.push(`\n## ${sec.resolvedTitle || 'Resolved questions'}`);
          for (const q of done)
            lines.push(`- **${labelOf(q)}** — ${q.workingAnswer || q.summary || 'resolved'}`);
        }
        return lines.join('\n');
      }
      case 'sources': {
        const ss = byType('Source');
        if (!ss.length) return '';
        const lines = [`## ${sec.title}`];
        for (const s of ss) {
          const authors = outEdges(s.id, 'authoredBy').map((e) => labelOf(nodeById.get(e.target)));
          lines.push(`- **${labelOf(s)}**${authors.length ? ` — ${authors.join(', ')}` : ''} (\`${s.id}\`)`);
        }
        return lines.join('\n');
      }
      case 'nodeList': {
        const ns = byType(sec.nodeType).filter((n) => n.id !== center);
        if (!ns.length) return '';
        const lines = [`## ${sec.title}`];
        for (const n of ns) lines.push(`- **${labelOf(n)}** (\`${n.id}\`)${n.summary ? ` — ${n.summary}` : ''}`);
        return lines.join('\n');
      }
      case 'editorialFlags': {
        const flags = [];
        const [pos, neg] = sec.evidencePredicates || ['supports', 'pressureTests'];
        const claims = byType(sec.nodeType || 'Claim');
        for (const c of claims) {
          const sup = inEdges(c.id, pos).length;
          const pt = inEdges(c.id, neg).length;
          if (!sup && !pt) flags.push(`⚠ unbacked claim: **${labelOf(c)}** has no evidence edge`);
          else if (sup && pt) flags.push(`⚖ contested: **${labelOf(c)}** (${sup} support / ${pt} pressure)`);
        }
        if (['skeleton', 'not-started'].includes(centerNode.status))
          flags.push(`◻ center status is "${centerNode.status}" — bundle is thin by design`);
        if (!flags.length) return '';
        return [`## ${sec.title}`, ...flags.map((f) => `- ${f}`)].join('\n');
      }
      default:
        return '';
    }
  }

  function renderClaim(c, evPreds) {
    const lines = [`\n### ${labelOf(c)}`];
    lines.push(`\`${c.id}\`${c.status ? ` · _${c.status}_` : ''}`);
    if (c.summary) lines.push(c.summary);
    const deps = outEdges(c.id, 'dependsOn').map((e) => labelOf(nodeById.get(e.target)));
    if (deps.length) lines.push(`_Depends on: ${deps.join(', ')}._`);
    let any = false;
    for (const pred of evPreds) {
      for (const e of inEdges(c.id, pred)) {
        any = true;
        const src = nodeById.get(e.source);
        const loc = [e.pageApprox && `p.${e.pageApprox}`, e.confidence].filter(Boolean).join(', ');
        const q = e.quote ? ` “${e.quote}”` : '';
        const r = e.rationale ? ` — ${e.rationale}` : '';
        lines.push(`- **${pred}** · ${labelOf(src)} (\`${e.source}\`${loc ? `, ${loc}` : ''})${q}${r}`);
      }
    }
    if (!any) lines.push(`- _No source backing yet._`);
    void never; // weak/never-render predicates are simply never surfaced here
    return lines.join('\n');
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const f = args.find((a) => a.startsWith(`--${k}=`));
    return f ? f.slice(k.length + 3) : undefined;
  };
  const center = get('center') || args.find((a) => !a.startsWith('--'));
  if (!center) {
    console.error('usage: context-bundle --center=<id> [--hop=N] [--token-budget=N] [-o file] [--format=md|json]');
    process.exit(1);
  }
  const ctx = loadContext();
  const opts = {};
  if (get('hop')) opts.hop = Number(get('hop'));
  if (get('token-budget')) opts.tokenBudget = Number(get('token-budget'));
  const res = buildBundle(ctx, center, opts);
  const outFlag = args.includes('-o') ? args[args.indexOf('-o') + 1] : get('o');
  const body = get('format') === 'json'
    ? JSON.stringify({ center: res.center, tokens: res.tokens, nodesInScope: res.nodesInScope, hop: res.hop }, null, 2)
    : res.text;
  if (outFlag) writeFileSync(outFlag, body);
  else process.stdout.write(body);
  if (res.overBudget) {
    console.error(`\n[note] ~${res.tokens} tokens > budget ${res.budget}; try --hop=${Math.max(1, res.hop - 1)} for a tighter packet.`);
  } else {
    console.error(`\n[ok] ~${res.tokens} tokens, ${res.nodesInScope} nodes in scope.`);
  }
}
