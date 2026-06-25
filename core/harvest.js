// harvest — cheap regex scan of prose proposing candidate claims into a
// gitignored inbox. Machine RECALL only; a human PROMOTES the load-bearing ones
// into catalogs/claims.json with a stable slug + harvestedFrom anchor.
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { loadContext } from './lib/config.js';
import { writeJSONL, stripFrontmatter, slugify } from './lib/io.js';

export function harvest(ctx) {
  const sig = ctx.harvestSignals;
  const candidates = [];
  if (!existsSync(ctx.contentDir)) return candidates;

  const markers = (sig.markerPhrases || []).map((m) => ({ name: m.name, re: new RegExp(m.pattern, 'i') }));
  const bold = sig.boldSentence || {};

  for (const file of readdirSync(ctx.contentDir).filter((f) => f.endsWith('.md'))) {
    const docSlug = slugify(file.replace(/\.md$/, ''));
    const text = stripFrontmatter(readFileSync(join(ctx.contentDir, file), 'utf8'));
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (bold.enabled) {
        for (const m of line.matchAll(/\*\*(.+?)\*\*/g)) {
          const s = m[1].trim();
          const words = s.split(/\s+/).length;
          if (words >= (bold.minWords || 4) && words <= (bold.maxWords || 60) && /[.?!]$/.test(s)) {
            candidates.push({ document: docSlug, line: i + 1, signal: 'bold-sentence', text: s });
          }
        }
      }
      for (const mk of markers) {
        if (mk.re.test(line)) {
          candidates.push({ document: docSlug, line: i + 1, signal: mk.name, text: line.trim() });
        }
      }
    });
  }
  writeJSONL(ctx.candidatesPath, candidates);
  return candidates;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = loadContext();
  const c = harvest(ctx);
  console.log(`[${ctx.profileName}] harvested ${c.length} candidate(s) -> ${ctx.candidatesPath}`);
}
