// build-catalog — emit a closed-world catalog of valid node ids + the controlled
// predicate vocabulary, to GROUND an extraction agent so it can only reference
// entities that already exist. Regenerate after adding nodes, before extraction.
import { existsSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { readJSONL, writeJSON } from './lib/io.js';
import { evidencePredicates } from './direction-rules.js';

export function buildCatalog(ctx) {
  if (!existsSync(ctx.nodesPath)) throw new Error('no graph yet — run build first');
  const nodes = readJSONL(ctx.nodesPath);
  const byType = {};
  for (const n of nodes) {
    (byType[n.type] ||= []).push({
      id: n.id,
      label: n.label || n.title || n.id,
      aliases: n.aliases || [],
      summary: n.summary || '',
    });
  }
  const catalog = {
    profile: ctx.profileName,
    evidencePredicates: evidencePredicates(ctx.ontology),
    predicates: Object.fromEntries(
      Object.entries(ctx.ontology.predicates).map(([k, p]) => [
        k,
        { subjectTypes: p.subjectTypes, objectTypes: p.objectTypes, carriesEvidence: !!p.carriesEvidence },
      ]),
    ),
    nodesByType: byType,
  };
  writeJSON(ctx.catalogPath, catalog);
  return catalog;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = loadContext();
  const c = buildCatalog(ctx);
  const total = Object.values(c.nodesByType).reduce((a, v) => a + v.length, 0);
  console.log(`[${ctx.profileName}] catalog: ${total} ids across ${Object.keys(c.nodesByType).length} types -> ${ctx.catalogPath}`);
}
