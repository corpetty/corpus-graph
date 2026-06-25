// THE single source of truth for edge direction/shape invariants.
//
// In the reference implementation these rules were duplicated verbatim across
// three files (the builder, the aggregator, and the test suite) and could
// silently diverge. Here every caller — build-graph, aggregate-interpretive,
// and graph.test — imports this module, so the contract cannot drift.
//
// Direction is enforced by reading the `subjectTypes` / `objectTypes` declared
// for each predicate in ontology.json. A backwards relation is therefore
// unauthorable: it fails validation at build time and in CI.

export function typeOfId(id, nsToType) {
  if (typeof id !== 'string' || !id.includes(':')) return null;
  const ns = id.slice(0, id.indexOf(':'));
  return nsToType[ns] || null;
}

// Validate one edge against the ontology. Returns { ok, reason }.
export function checkEdge(edge, ontology, nsToType) {
  const { source, predicate, target } = edge;
  const pred = ontology.predicates[predicate];
  if (!pred) return { ok: false, reason: `unknown predicate '${predicate}'` };

  const sType = typeOfId(source, nsToType);
  const tType = typeOfId(target, nsToType);
  if (!sType) return { ok: false, reason: `unresolvable subject id '${source}'` };
  if (!tType) return { ok: false, reason: `unresolvable object id '${target}'` };

  const subjOk = !pred.subjectTypes || pred.subjectTypes.includes(sType);
  const objOk = !pred.objectTypes || pred.objectTypes.includes(tType);

  if (pred.directed === false) {
    // Undirected: accept either orientation against the declared endpoint sets.
    const flipped =
      (!pred.subjectTypes || pred.subjectTypes.includes(tType)) &&
      (!pred.objectTypes || pred.objectTypes.includes(sType));
    if ((subjOk && objOk) || flipped) return { ok: true };
    return {
      ok: false,
      reason: `${predicate} endpoints ${sType}/${tType} not in {${(pred.subjectTypes || []).join(',')}} x {${(pred.objectTypes || []).join(',')}}`,
    };
  }

  if (subjOk && objOk) return { ok: true };
  return {
    ok: false,
    reason: `${predicate} expects ${(pred.subjectTypes || ['*']).join('|')} -> ${(pred.objectTypes || ['*']).join('|')}, got ${sType} -> ${tType}`,
  };
}

// Which predicates carry an evidence payload (quote/pageApprox/confidence/rationale)?
export function evidencePredicates(ontology) {
  return Object.entries(ontology.predicates)
    .filter(([, p]) => p.carriesEvidence)
    .map(([name]) => name);
}
