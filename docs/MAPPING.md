# Mapping Your Domain onto the Kernel

`corpus-graph` ships a domain-agnostic kernel and an *opinionated default contract* you are expected to edit. The kernel knows nothing about books, code, or research notes. It knows about **8 node types**, **~17 predicates** grouped into **6 categories**, and one rule: a predicate's `subjectTypes`/`objectTypes` decide which direction an edge may point. Everything that makes the graph *about your domain* lives in `config/ontology.json` (and the profile that overrides it) — not in code.

This guide walks you from the default skeleton to a typed graph for *your* corpus. The running proof is the shipped `profiles/software-docs/` profile, which renames every node type to a software-documentation domain and builds **28 nodes / 46 edges / 0 warnings** on the *same engine, with no code changes*.

> Two repos in play. **The scaffold tool** is this repo (`corpus-graph`). **The reference implementation** is the *Lossy* book repo it was generalized from — the source of any measured numbers (256 nodes / 1179 edges, etc.). When this doc cites counts for the *software-docs* profile, those are from the scaffold's own worked example.

---

## 1. The minimal skeleton

The default `config/ontology.json` declares 8 node types and ~17 predicates. Evidence is **not** a node type — it is a payload carried *on* edges (see §3).

| # | Node type | Role in the kernel |
|---|-----------|--------------------|
| 1 | `Document` | A unit of prose / content (a note, a page). |
| 2 | `Concept`  | A named idea developed across documents. |
| 3 | `Claim`    | An assertion the corpus advances and argues. |
| 4 | `Question` | An open problem the corpus flags. |
| 5 | `Source`   | An external citable reference. |
| 6 | `Author`   | A person/voice behind a source. |
| 7 | `Tension`  | A contested tradeoff or unresolved opposition. |
| 8 | `Status`   | A lifecycle/state label (a deliberate hub type). |

The ~17 predicates fall into **6 categories**. The categories are the real generalization — they encode *what kind of work* an edge does, independent of domain.

| Category | Example predicates | What it carries |
|----------|--------------------|-----------------|
| `structural` | `partOf`, `covers`, `definedIn` | Skeleton: containment, coverage, where a thing is developed. |
| `causal` | `dependsOn`, `succeedsStage` | Ordering and dependency between things. |
| `provenance` | `authoredBy`, `cites`, `partOfTradition` | Where a claim/source came from. |
| `dialectical` | `pressureTests`, `flagsOpenQuestion` | Opposition, open problems, contestation. |
| `claim` | `argues`, `supports`, `evidencedBy` | The load-bearing argument graph. |
| `weak` | `wikiLinks`, `mentions` | Navigation only — kept **out** of the argument graph. |

The **validated-vs-weak split** is the most important distinction here. In the reference corpus the highest-count edges were `wikiLinks` (272) and `covers` (199), while the load-bearing few were `supports` (40) and `pressureTests` (36). Weak predicates are navigation noise; the split keeps them from contaminating argument retrieval. Prose `[[wikilinks]]` *always* become the weak `wikiLinks` predicate. An explicit citation is a deliberate catalog field, never inferred from a mention.

---

## 2. The mapping process

Five steps take you from "the default contract" to "my domain".

**Step 1 — Rename the node types.** This is your primary surface. Replace the 8 default type *names* with your domain's nouns. The kernel does not care what they are called; it only checks that every node's `type` is one you declared (`addNode` throws on an unknown type — a HARD vocabulary contract).

**Step 2 — Keep the predicate categories; pin each predicate's `subjectTypes`/`objectTypes`.** Do **not** invent new categories — the six are the generalization. Keep the predicate *names* too (they are the stable vocabulary; see Gotchas). What you *must* update is each predicate's `subjectTypes` and `objectTypes` arrays so they reference your renamed types. The single `core/direction-rules.js` module reads these; a backwards relation becomes **unauthorable** — it fails validation at build time and in CI under `STRICT=1`.

**Step 3 — Decide which edges carry an Evidence payload.** Pick the predicates that need a citable justification (in the default, `supports`/`pressureTests`). Those edges carry `quote + pageApprox + confidence + rationale` so a fact and its justification are retrieved atomically. Wire them in `render-spec.json` as evidence predicates.

**Step 4 — Mark high-degree types as hub-transit types.** Category-style super-hubs (a `Status` every node points at) would collapse a 2-hop bundle into one hop. List them in the exporter's hub-transit blocklist so they remain *reachable but not traversed through*.

**Step 5 — Keep domain-specific structure as profile seeds/catalogs, not in the kernel.** Anything richer than the 8-type skeleton (the reference's `PipelineStage`, `Gate`, `Tradition`, `CaseStudy`) belongs in *your profile's* ontology and catalog files — not the shared kernel. The `book` profile is the illustrative example of a richer schema layered this way.

---

## 3. Worked rename: the `software-docs` profile

`profiles/software-docs/` proves domain-agnosticism by shipping its own `ontology.json` that maps 1:1 onto the defaults:

| Default | software-docs | Default | software-docs |
|---------|---------------|---------|---------------|
| Document | **Page** | Source | **Reference** |
| Concept | **Module** | Author | **Maintainer** |
| Claim | **Decision** | Tension | **Tradeoff** |
| Question | **Issue** | Status | **Lifecycle** |

The node-type block becomes:

```json
{
  "nodeTypes": {
    "Page":      { "color": "#1e3a8a", "description": "A documentation page." },
    "Module":    { "color": "#0ea5a3", "description": "A named software module / subsystem." },
    "Decision":  { "color": "#b91c1c", "description": "An architectural decision the docs advance." },
    "Issue":     { "color": "#a16207", "description": "An open question / tracked issue." },
    "Reference": { "color": "#475569", "description": "An external citable reference (RFC, spec, post)." },
    "Maintainer":{ "color": "#7c3aed", "description": "A person who owns/authored a reference." },
    "Tradeoff":  { "color": "#db2777", "description": "A contested tradeoff." },
    "Lifecycle": { "color": "#334155", "description": "A lifecycle state (hub type)." }
  }
}
```

The predicate *names and categories* stay; only `subjectTypes`/`objectTypes` are re-pinned to the renamed types:

```json
{
  "predicates": {
    "covers":      { "category": "structural", "directed": true,
                     "subjectTypes": ["Page"], "objectTypes": ["Module", "Decision", "Issue", "Tradeoff"] },
    "argues":      { "category": "claim", "directed": true,
                     "subjectTypes": ["Page"], "objectTypes": ["Decision"] },
    "supports":    { "category": "claim", "directed": true,
                     "subjectTypes": ["Reference"], "objectTypes": ["Decision", "Module"] },
    "pressureTests":{ "category": "claim", "directed": true,
                     "subjectTypes": ["Reference"], "objectTypes": ["Decision"] },
    "authoredBy":  { "category": "provenance", "directed": true,
                     "subjectTypes": ["Reference"], "objectTypes": ["Maintainer"] },
    "wikiLinks":   { "category": "weak", "directed": false,
                     "subjectTypes": ["Page"], "objectTypes": ["Page"] }
  }
}
```

Catalog loading is **data-driven** from `ontology.catalogLoaders` — a file maps to a `nodeType`, and its array fields become edges. No per-type code:

```json
{
  "catalogLoaders": {
    "decisions.json": {
      "nodeType": "Decision",
      "arrayFieldEdges": {
        "argues":      { "predicate": "argues",     "dir": "in",  "targetNs": "page" },
        "dependsOn":   { "predicate": "dependsOn",  "dir": "out", "targetNs": "decision" }
      }
    }
  }
}
```

A catalog entry's scalar fields become node props; its array fields become edges per the mapping above. The evidence-carrying triples live in their own files, one edge per line, exactly as in the reference:

```json
{"subject":"reference:rfc-9111","predicate":"supports","object":"decision:immutable-cache-keys","quote":"...","pageApprox":"§4.2","confidence":"high","rationale":"..."}
```

A bundle for the `caching-guide` page (hop 2) comes out at **~319 tokens / 9 nodes**, surfacing the contested decision *"Cache keys are content-addressed and immutable"* with a supporting quote (RFC 9111, p.§4.2, high) **and** a pressure-testing quote (Web Almanac 2023, p.Caching ch., medium), plus the resolved cache-invalidation issue and its working answer. The harvest scan proposed 7 candidate claims; `aggregate` kept 5 evidence triples with 0 drops. All 6 invariant tests pass.

---

## 4. A second sketch: research-notes / PKM

A personal-knowledge-management corpus barely deviates from the default:

| Default | PKM | Notes |
|---------|-----|-------|
| Document | **Note** | The atomic markdown note. |
| Concept | **Topic** | A recurring theme. |
| Claim | **Claim** | Keep as-is — claims are claims. |
| Question | **OpenLoop** | Things you haven't resolved. |
| Source | **Source** | Keep as-is. |
| Author | **Author** | Keep as-is. |
| Tension | **Tension** | Keep as-is. |
| Status | **Maturity** | `seedling / budding / evergreen` — a hub. |

```json
{
  "nodeTypes": {
    "Note":     { "description": "An atomic note." },
    "Topic":    { "description": "A recurring theme." },
    "OpenLoop": { "description": "An unresolved question." },
    "Maturity": { "description": "Note maturity state (hub type)." }
  }
}
```

`[[wikilinks]]` between notes flow straight into the weak `wikiLinks` predicate — the navigation layer Zettelkasten users already rely on — while `argues`/`supports` carry the actual argument graph. Mark `Maturity` as a hub-transit type so it doesn't short-circuit traversal.

---

## 5. Opinionated default plus escape hatch

A profile **inherits** `config/ontology.json` and **overrides only what it renames**. The `blank` profile inherits the default ontology wholesale and adds a tiny hello catalog; `software-docs` overrides the whole node-type/predicate block to prove a full rename works. You do not copy the engine — you copy the contract and edit it. Resolution lives in `core/lib/config.js`.

Run a renamed profile by pointing the CLI at it; the build is derive-never-store and rebuilds from scratch sub-second, so the graph can never drift from your catalogs:

```bash
node bin/corpus-graph.js init --profile software-docs
node bin/corpus-graph.js build --profile software-docs
node bin/corpus-graph.js context page:caching-guide --hop 2 --profile software-docs
STRICT=1 make check   # warnings become fatal in CI
```

---

## 6. Gotchas

- **Ambiguous `targetNs` needs full ids.** When an array field could resolve into more than one namespace, the slug-only form is ambiguous. Use a fully namespaced id (`decision:immutable-cache-keys`, not `immutable-cache-keys`) so the loader binds the right node.
- **Predicate *names* are the stable vocabulary; node *types* are the rename surface.** Rename types freely. Renaming a predicate means touching `direction-rules`, `render-spec`, and every catalog `arrayFieldEdges` entry at once — currently not worth it. Re-pin `subjectTypes`/`objectTypes` instead, and keep the name.
- **`render-spec.json` sections reference node types.** Because curation lives in render — sections key off type names — a renamed profile must ship **its own `render-spec.json`**. If sections still say `Claim` while your ontology says `Decision`, those sections will silently never emit. Rename the render-spec alongside the ontology, and your bundles surface the right types.
