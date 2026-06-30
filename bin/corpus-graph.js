#!/usr/bin/env node
// corpus-graph CLI — thin dispatch over the core engine.
//   corpus-graph build|context|harvest|aggregate|catalog|extract-build|check|accept-stats|stats|init
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContext, REPO_ROOT } from '../core/index.js';
import { buildGraph, emit } from '../core/build-graph.js';
import { buildBundle } from '../core/context-bundle.js';
import { harvest } from '../core/harvest.js';
import { aggregate } from '../core/aggregate-interpretive.js';
import { buildCatalog } from '../core/build-catalog.js';
import { doctor } from '../core/doctor.js';
import { writeJSON } from '../core/lib/io.js';

const [cmd, ...rest] = process.argv.slice(2);

function build(ctx, { strict = false } = {}) {
  const r = buildGraph(ctx);
  emit(ctx, r);
  for (const w of r.warnings) console.error(`  warn: ${w}`);
  console.log(`[${ctx.profileName}] ${r.stats.nodes} nodes, ${r.stats.edges} edges, ${r.stats.warnings} warnings`);
  if (strict && r.warnings.length) {
    console.error(`STRICT: ${r.warnings.length} warning(s) — failing`);
    process.exit(1);
  }
  return r;
}

function main() {
  switch (cmd) {
    case 'build':
      build(loadContext());
      break;
    case 'context': {
      const ctx = loadContext();
      const get = (k) => {
        const f = rest.find((a) => a.startsWith(`--${k}=`));
        return f ? f.slice(k.length + 3) : undefined;
      };
      const center = get('center') || rest.find((a) => !a.startsWith('--') && a !== '-o');
      if (!center) throw new Error('context: pass --center=<id>');
      const opts = {};
      if (get('hop')) opts.hop = Number(get('hop'));
      if (get('token-budget')) opts.tokenBudget = Number(get('token-budget'));
      const res = buildBundle(ctx, center, opts);
      const oi = rest.indexOf('-o');
      if (oi !== -1 && rest[oi + 1]) {
        writeFileSync(rest[oi + 1], res.text);
        console.error(`[ok] wrote ${rest[oi + 1]} (~${res.tokens} tokens, ${res.nodesInScope} nodes)`);
      } else {
        process.stdout.write(res.text);
        console.error(`\n[${res.overBudget ? 'over budget' : 'ok'}] ~${res.tokens} tokens, ${res.nodesInScope} nodes`);
      }
      break;
    }
    case 'harvest':
      harvest(loadContext());
      console.log('harvested -> claim-candidates.jsonl (gitignored inbox)');
      break;
    case 'aggregate': {
      const { rows, drops } = aggregate(loadContext());
      console.log(`aggregated ${rows.length}, dropped ${drops.length}`);
      break;
    }
    case 'catalog':
      buildCatalog(loadContext());
      console.log('catalog -> extraction-catalog.json');
      break;
    case 'extract-build': {
      const ctx = loadContext();
      build(ctx); // need nodes for the closed-world catalog
      buildCatalog(ctx);
      aggregate(ctx);
      build(ctx); // rebuild folding the validated aggregate
      break;
    }
    case 'check':
      build(loadContext(), { strict: true });
      console.log('(now run `node --test core/graph.test.js`)');
      break;
    case 'accept-stats': {
      const ctx = loadContext();
      const r = buildGraph(ctx);
      writeJSON(ctx.expectedStatsPath, {
        nodes: r.stats.nodes,
        edges: r.stats.edges,
        warnings: r.stats.warnings,
        byNodeType: r.stats.byNodeType,
        byPredicate: r.stats.byPredicate,
      });
      console.log(`blessed ${ctx.expectedStatsPath} (${r.stats.nodes} nodes / ${r.stats.edges} edges)`);
      break;
    }
    case 'stats': {
      const r = buildGraph(loadContext());
      console.log(JSON.stringify(r.stats, null, 2));
      break;
    }
    case 'doctor': {
      const ctx = loadContext();
      const probs = doctor(ctx);
      const sym = { error: '✗', warn: '⚠', info: 'ℹ' };
      for (const p of probs) console.log(`  ${sym[p.level] || '·'} ${p.level === 'info' ? '' : p.level + ': '}${p.msg}`);
      const errors = probs.filter((p) => p.level === 'error').length;
      const warns = probs.filter((p) => p.level === 'warn').length;
      console.log(`[${ctx.profileName}] ${errors} error(s), ${warns} warning(s)`);
      if (errors) process.exit(1);
      break;
    }
    case 'init': {
      const name = rest[0] || 'my-corpus';
      const dest = join(REPO_ROOT, 'profiles', name);
      if (existsSync(dest)) throw new Error(`profile ${name} already exists`);
      mkdirSync(dest, { recursive: true });
      cpSync(join(REPO_ROOT, 'profiles', 'blank'), dest, { recursive: true });
      console.log(`scaffolded profiles/${name} — edit its ontology.json (or inherit the default), add catalogs/ + content/, then \`make build PROFILE=${name}\``);
      break;
    }
    default:
      console.log('usage: corpus-graph <build|context|harvest|aggregate|catalog|extract-build|check|accept-stats|stats|doctor|init> [--profile=NAME] [...]');
      process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
