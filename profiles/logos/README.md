# logos profile — a schema-axis port of the Logos whitepaper graph

This profile ports the ontology of the **Logos whitepaper graph**
(`logos-co/logos-whitepaper/graph`, 1,045 nodes / 8,705 edges / 17 node types /
26 predicates) onto the corpus-graph engine, as a stress test: *how cleanly does
a maximal, domain-coupled ontology map onto the generalized kernel, and where
does it strain?*

It ships the full **17-type / 26-predicate ontology** plus a **small
representative sample** of catalogs (not the real Logos data, which lives in that
repo and is mostly machine-extracted). The sample builds to **60 nodes / 79
edges / 0 warnings**, exercises all 17 node types and 22 of the 26 predicates,
and passes the full invariant suite (`PROFILE=logos node --test core/graph.test.js`).

```bash
make build   PROFILE=logos
make context PROFILE=logos CENTER=t4-001        # a requirement's neighbourhood
make test    PROFILE=logos
```

## What ported cleanly

- **All 17 node types** map 1:1 onto a profile `ontology.json` with renamed
  namespaces (`requirement:`, `tier:`, `subsystem:`, `law:`, …). No engine change.
- **The 4-level containment spine** (`Requirement -belongsToTier-> Tier`,
  `-belongsToSubTier-> SubTier`, `Family -narrates-> Requirement`) ports as plain
  **directed structural edges**. corpus-graph needs *no special hierarchy
  primitive* to represent containment structure — typed predicates with declared
  `subjectTypes`/`objectTypes` express it directly. (This refines the earlier
  claim that corpus-graph "has no containment notion": the *structure* ports; see
  the gap below for what doesn't.)
- **The hub-transit blocklist generalizes beautifully.** Marking
  `Tier`/`SubTier`/`CyberspaceLayer`/`OutlineSection`/`Status` as
  `hubTransitTypes` keeps these high-degree grouping nodes *reachable but not
  pivoted through*, so a requirement bundle stays local even though `Tier` is a
  579-edge super-hub in the full graph. This is the exact pattern corpus-graph
  generalized from Logos's hardcoded `type === 'Status'` — now driven entirely by
  config, and now carrying Logos's *own* hierarchy.
- **Explicit, enforced direction.** Logos's `graph-meta.json` declares *no*
  `subjectTypes`/`objectTypes` — edge direction lives in parser code. Porting
  required making direction explicit per predicate; the engine now **enforces**
  it (`addEdge` drops/warns on a backwards edge via the shared
  `direction-rules.js`). The discipline corpus-graph adds caught nothing here only
  because the sample was authored against the explicit contract.
- **Two of the three domain-fact tables become catalogs.** `tierMeta`,
  `subsystemKeys`, and `cyberspaceLayers` — baked into the Logos schema file —
  become ordinary catalogs here (`tiers.json`, `subsystems.json`, `layers.json`)
  with the table values as node props. Domain-fact-as-*data* ports cleanly.

## Where it strains (these drive `docs/ROADMAP.md`)

1. **Evidence flows the opposite way from the renderer's default — now handled.**
   Logos's dominant edge — `evidencedBy` (3,844 of 8,705, ~44%) — runs
   `Requirement -evidencedBy-> Document` (the evidenced thing points *out* to its
   source line), whereas corpus-graph's evidence render kinds default to the
   `Source -supports-> Claim` **in-edge** model. **Resolved** by
   [corpus-graph#7](https://github.com/corpetty/corpus-graph/issues/7): the render
   kinds now take an `evidenceDirection: "in" | "out"` option. This profile's
   `render-spec.json` sets `"evidenceDirection": "out"` on its requirements
   section, so `evidencedBy` quotes + line locators surface directly (see a
   `make context PROFILE=logos CENTER=t0-001` bundle). The `contestedClaims` /
   `editorialFlags` kinds remain omitted only because Logos has no
   supports-vs-pressureTests dialectic to flag.
2. **Traversal/render was hierarchy-blind — now partly handled.** The containment
   *structure* ports as edges, but the renderer didn't *exploit* it. **Resolved**
   for breadcrumbs by [corpus-graph#6](https://github.com/corpetty/corpus-graph/issues/6):
   this profile declares `belongsToTier`/`belongsToSubTier`/`subEntryOf` on a
   `breadcrumb` section, so a requirement bundle now opens with
   `Tier 4 ▸ Tier 4.A ▸ **T4-001**` (and `Tier 5 ▸ T5-MS-001 ▸ **T5-BL-001**` for a
   sub-entry). Ancestors render even when they are hub-transit nodes beyond the hop
   radius. A "what this Tier contains" roll-up section is still a possible follow-up.
3. **Domain-fact-as-parsing-logic does not port.** `subsystemKeys` is not just
   data in Logos — the build *uses* it to parse requirement ids like `T5-MS-001`
   (`T5` → Tier 5, `MS` → Waku) during ingestion. corpus-graph's generic prose
   parser has no id-grammar hook, so the table-as-*parser* stays behind. (Custom
   parse hooks are intentionally out of kernel scope.)
4. **The real corpus needs the ops/extraction layer.** These sample catalogs are
   hand-authored; the real Logos graph is overwhelmingly machine-extracted. Hosting
   it for real would need the runner / chunking / triage / diff / doctor layer
   corpus-graph deliberately omits. → That is the whole of `docs/ROADMAP.md`.

## Verdict

The **schema axis ports cleanly** — 17 types, containment-as-edges, hub-transit,
and domain-facts-as-catalogs all work with zero engine changes. The real gaps are
in **projection** (evidence direction, hierarchy-awareness) and in the
**ops/extraction layer**, both tracked in [`docs/ROADMAP.md`](../../docs/ROADMAP.md).
