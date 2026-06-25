// aggregate-interpretive — validate, de-dup, and direction-check LLM-extracted
// evidence triples from interpretive/*.jsonl against a CLOSED-WORLD catalog of
// known node ids. Anything off-catalog or backwards is dropped with a logged
// reason. Mirrors the build's own validation so no entry path is quieter.
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { readJSONL, writeJSONL, writeJSON } from './lib/io.js';
import { checkEdge } from './direction-rules.js';

export function aggregate(ctx) {
  const knownIds = new Set();
  if (existsSync(ctx.nodesPath)) for (const n of readJSONL(ctx.nodesPath)) knownIds.add(n.id);

  const rows = [];
  const drops = [];
  const seen = new Set();
  let perFile = {};

  if (existsSync(ctx.interpretiveDir)) {
    for (const f of readdirSync(ctx.interpretiveDir).filter((f) => f.endsWith('.jsonl'))) {
      const fileRows = readJSONL(join(ctx.interpretiveDir, f));
      perFile[f] = { read: fileRows.length, kept: 0, dropped: 0 };
      for (const r of fileRows) {
        if (r._note) continue; // agent catalog-gap note, not a triple
        const edge = { source: r.subject, predicate: r.predicate, target: r.object };
        const v = checkEdge(edge, ctx.ontology, ctx.nsToType);
        if (!v.ok) {
          drops.push({ file: f, row: r, reason: v.reason });
          perFile[f].dropped++;
          continue;
        }
        if (knownIds.size && (!knownIds.has(r.subject) || !knownIds.has(r.object))) {
          drops.push({ file: f, row: r, reason: 'off-catalog id (subject or object unknown)' });
          perFile[f].dropped++;
          continue;
        }
        const key = `${r.subject}|${r.predicate}|${r.object}`;
        if (seen.has(key)) {
          perFile[f].dropped++;
          continue;
        }
        seen.add(key);
        rows.push(r);
        perFile[f].kept++;
      }
    }
  }

  writeJSONL(ctx.aggregatePath, rows);
  writeJSON(ctx.aggregateNotesPath, { kept: rows.length, drops, perFile });
  return { rows, drops, perFile };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = loadContext();
  const { rows, drops } = aggregate(ctx);
  console.log(`[${ctx.profileName}] aggregated ${rows.length} triple(s), dropped ${drops.length} -> ${ctx.aggregatePath}`);
  for (const d of drops.slice(0, 10)) console.error(`  drop: ${d.reason} (${JSON.stringify(d.row).slice(0, 100)})`);
}
