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

  const ontology =
    readJSONIf(join(profileDir, 'ontology.json')) ?? readJSON(join(defaultDir, 'ontology.json'));
  const renderSpec =
    readJSONIf(join(profileDir, 'render-spec.json')) ?? readJSON(join(defaultDir, 'render-spec.json'));
  const harvestSignals =
    readJSONIf(join(profileDir, 'harvest-signals.json')) ??
    readJSON(join(defaultDir, 'harvest-signals.json'));
  const slugAliases = readJSONIf(join(profileDir, 'slug-aliases.json'), {});

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
    ontology,
    renderSpec,
    harvestSignals,
    slugAliases,
    nsToType,
    typeToNs,
  };
}
