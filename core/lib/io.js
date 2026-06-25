// Small zero-dependency IO + text helpers shared across the engine.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readJSONIf(path, fallback = null) {
  return existsSync(path) ? readJSON(path) : fallback;
}

export function writeJSON(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

export function readJSONL(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`${path}: bad JSON on line ${i + 1}: ${e.message}`);
      }
    });
}

export function writeJSONL(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

// Token estimate: bytes/4. The same heuristic the bundle budget uses. A BPE
// tokenizer on English prose typically lands within ~10-15% of this.
export function estTokens(str) {
  return Math.round(Buffer.byteLength(str, 'utf8') / 4);
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Strip a leading YAML frontmatter fence from markdown.
export function stripFrontmatter(md) {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3);
    if (end !== -1) return md.slice(md.indexOf('\n', end + 1) + 1);
  }
  return md;
}
