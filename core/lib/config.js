// Resolves the active profile's configuration, with the top-level config/ as
// the "opinionated default" fallback. A profile overrides only the files it
// ships; anything missing inherits the default skeleton.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { readJSON, readJSONIf } from './io.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveProfile(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith('--profile='));
  if (flag) return flag.slice('--profile='.length);
  return process.env.PROFILE || 'software-docs';
}

export function loadContext(profileName = resolveProfile()) {
  const profileDir = join(REPO_ROOT, 'profiles', profileName);
  if (!existsSync(profileDir)) {
    throw new Error(`profile not found: ${profileName} (looked in ${profileDir})`);
  }
  const defaultDir = join(REPO_ROOT, 'config');

  // A profile overrides only the files it ships; anything missing falls back to
  // the default skeleton. Resolve the actual path so callers (e.g. doctor) can
  // stat the file that was really used.
  const pick = (name) => {
    const p = join(profileDir, name);
    return existsSync(p) ? p : join(defaultDir, name);
  };
  const ontologyPath = pick('ontology.json');
  const renderSpecPath = pick('render-spec.json');
  const harvestSignalsPath = pick('harvest-signals.json');
  const slugAliasesPath = join(profileDir, 'slug-aliases.json');
  const ontology = readJSON(ontologyPath);
  const renderSpec = readJSON(renderSpecPath);
  const harvestSignals = readJSON(harvestSignalsPath);
  const slugAliases = readJSONIf(slugAliasesPath, {});

  // Derived lookups.
  const nsToType = {};
  const typeToNs = {};
  for (const [type, def] of Object.entries(ontology.nodeTypes)) {
    nsToType[def.ns] = type;
    typeToNs[type] = def.ns;
  }

  const outDir = join(REPO_ROOT, 'data', profileName);
  mkdirSync(outDir, { recursive: true });

  return {
    profileName,
    profileDir,
    contentDir: join(profileDir, 'content'),
    interpretiveDir: join(profileDir, 'interpretive'),
    expectedStatsPath: join(profileDir, 'expected-stats.json'),
    outDir,
    nodesPath: join(outDir, 'nodes.jsonl'),
    edgesPath: join(outDir, 'edges.jsonl'),
    statsPath: join(outDir, 'build-stats.json'),
    catalogPath: join(outDir, 'extraction-catalog.json'),
    candidatesPath: join(outDir, 'claim-candidates.jsonl'),
    aggregatePath: join(outDir, 'interpretive-triples.jsonl'),
    aggregateNotesPath: join(outDir, 'interpretive-notes.json'),
    ontologyPath,
    renderSpecPath,
    harvestSignalsPath,
    slugAliasesPath,
    ontology,
    renderSpec,
    harvestSignals,
    slugAliases,
    nsToType,
    typeToNs,
  };
}
