// Programmatic entry point.
export { loadContext, resolveProfile, REPO_ROOT } from './lib/config.js';
export { buildGraph, emit } from './build-graph.js';
export { buildBundle, loadGraph, resolveCenterId } from './context-bundle.js';
export { harvest } from './harvest.js';
export { aggregate } from './aggregate-interpretive.js';
export { buildCatalog } from './build-catalog.js';
export { doctor } from './doctor.js';
export { extractProfile } from './extract.js';
export { diffExtractions, formatDiffReport } from './diff.js';
export { triageProfile, formatTriageReport } from './triage.js';
export { getBackend, estimateCostUSD } from './lib/llm.js';
export { checkEdge, typeOfId, evidencePredicates } from './direction-rules.js';
