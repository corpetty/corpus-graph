# Roadmap

corpus-graph distilled the conventions of two production graph subsystems — the
[Logos whitepaper graph](https://github.com/logos-co/logos-whitepaper) (the
original, maximal instance: 1,045 nodes / 8,705 edges / 17 node types / 3,338
script LOC) and the *Lossy* book graph (`information-book`) — into a leaner,
config-driven, **domain-agnostic engine** (~1,084 LOC). In doing so it
*deliberately omitted* the entire automated extraction-and-ops layer that makes
the Logos graph a production ingestion factory.

This roadmap is the plan to **absorb that operational depth back in — as
opt-in, config-gated, domain-agnostic capabilities** — without compromising the
kernel. It is grounded in a [direct comparison](./ANALYSIS.md) of the two
implementations and in the [logos profile port](../profiles/logos/README.md),
which stress-tested how cleanly the Logos ontology maps onto the engine.

## Design principles (non-negotiable)

1. **Zero-dep core stays zero-dep.** New capabilities that need a dependency
   (the Anthropic SDK, etc.) ship as opt-in modules, exactly like the MCP server
   — never a hard dependency of `core/`.
2. **Config over code.** Behavior is driven by `ontology.json` / `render-spec.json`
   / new config blocks — not by per-profile forks of the engine.
3. **Domain-agnostic.** Nothing Logos-specific (or book-specific) enters the
   kernel. The `logos` and `book` profiles prove capabilities generalize.
4. **Derive-never-store and the gatekeepers are sacred.** Every new input path
   flows through the same validation (`direction-rules.js`, closed-world catalog,
   dedup) as the existing ones.

---

## Theme A — Automated extraction & ingestion (the biggest gap)

Today corpus-graph's `harvest → promote → extract` loop stops at a prompt a
human pastes into a subagent. The Logos graph is overwhelmingly machine-extracted
(`evidencedBy` alone is 3,844 of its 8,705 edges). To host a corpus of any real
size unattended, the engine needs a runnable ingestion pipeline.

- **[#1 Extraction runner](https://github.com/corpetty/corpus-graph/issues/1)** ✅ **done** —
  `corpus-graph extract` (`make extract`): a programmatic, **resumable** runner.
  Per source it sends the closed-world catalog + source text to a pluggable
  backend and writes **re-validated** triples to `interpretive/<source>.jsonl`.
  The Anthropic backend (opt-in `@anthropic-ai/sdk`) uses **structured outputs**
  to force valid JSON, **prompt-caches** the system+catalog block (identical
  across every source in a run), and inherits the SDK's 429/529/5xx backoff;
  an OpenAI-compatible backend covers local/vLLM, and a stub backend makes it
  testable with no key. Concurrency-limited, idempotent (skips already-extracted
  unless `--force`), oversized-guarded (defers to #2), with honest per-source
  token + cost logging. Every returned triple is re-checked against the same
  direction-rules + closed-world catalog the aggregator uses, so a hallucinated
  id or backwards edge is dropped at the runner.
- **[#2 Source chunking + merge](https://github.com/corpetty/corpus-graph/issues/2)** ✅ **done** —
  built into the runner: a source larger than `--chunk-tokens` is split
  heading-aware (`core/lib/chunk.js`, deterministic), extracted per chunk against
  the same cached system+catalog block, and merged with `(subject,predicate,object)`
  dedup keeping the highest-confidence row. Chunk-level extractions are cached
  (`data/<profile>/chunks/<source>/chunk-NN.jsonl` + a manifest) so a re-run
  resumes; a `--max-chunks` guard caps runaway sources and logs what it drops.
- **[#3 Triage scoring/queue + cost model](https://github.com/corpetty/corpus-graph/issues/3)** —
  a ranked extraction queue with a projected token/cost estimate at score cutoffs,
  so a corpus owner can extract a budgeted subset deliberately.
- **[#4 Extraction diff/eval harness](https://github.com/corpetty/corpus-graph/issues/4)** —
  scoring an extraction against a reference on schema validity, verbatim-quote
  fidelity, triple recall/precision, and hallucinated-id detection — the basis for
  multi-model comparison and a regression guard on extraction changes.

---

## Theme B — Projection & ontology expressiveness (surfaced by the logos port)

The [logos profile port](../profiles/logos/README.md) showed the *schema axis*
maps cleanly (17 types, containment-as-edges, hub-transit, domain-facts-as-catalogs)
— but exposed two places the *projection* is too coupled to the book/argument model.

- **[#6 Hierarchy-aware traversal & projection](https://github.com/corpetty/corpus-graph/issues/6)** ✅ **done** —
  containment *structure* ports fine as directed edges, but the exporter was
  hierarchy-blind. Added a `breadcrumb` render kind: a profile lists its
  containment predicates (broad→narrow, e.g. `belongsToTier`, `belongsToSubTier`,
  `subEntryOf`) and the exporter climbs them over the full edge set to render
  `Tier 4 ▸ Tier 4.A ▸ **T4-001**` — ancestors show even when they are hub-transit
  nodes beyond the hop radius. Opt-in; profiles without containment predicates are
  unaffected. (A "what this contains" roll-up section remains a possible follow-up.)
- **[#7 Configurable evidence direction](https://github.com/corpetty/corpus-graph/issues/7)** ✅ **done** —
  the evidence render kinds assumed `Source -supports-> Claim` (an in-edge to the
  claim). Logos's `evidencedBy` runs the other way (`Requirement -evidencedBy->
  Document`). Added a per-section `evidenceDirection: "in" | "out"` (default `"in"`,
  so book/software-docs are unchanged); the `logos` profile now surfaces
  `evidencedBy` quotes + line locators.

---

## Theme C — Ops & diagnostics

- **[#5 doctor / health-check](https://github.com/corpetty/corpus-graph/issues/5)** ✅ **done** —
  `corpus-graph doctor` (or `make doctor`) diagnoses a profile without writing
  anything: (1) **staleness** — on-disk derived graph mtime vs every input
  *including the engine itself* (the class the golden snapshot can't catch, since
  it rebuilds in memory); (2) **referential/direction/orphan** problems via a real
  in-memory build (no emit, so it never diverges from the builder); (3)
  **config validity** — render-spec sections and ontology wiring the build never
  checks. Exits non-zero on a real problem.
- **Future (not yet issued):**
  - *Reference manifest* — a corpus-wide source-path manifest (walk a references
    tree, slugify, log collisions) so `Source`/`Document` nodes get deep-link paths
    in a domain-agnostic way (Logos's `build-reference-manifest.js`).
  - *Confidence-ranked evidence selection* in the bundle (high/med/low → weighted,
    top-N with an elision count) as a config-gated alternative to a flat quote list.
  - *Document/outline versioning* (Logos's v2→v9 crosswalk) — likely too
    domain-specific to generalize; tracked here only as a known Logos capability.

---

## What corpus-graph keeps that Logos should adopt back

The flow is bidirectional. The [comparison](./ANALYSIS.md) lists what the Logos
graph would gain by adopting corpus-graph's discipline: an **enforced** schema
contract (its `graph-meta.json` is descriptive-only), real **addNode/addEdge
gatekeepers** (it validates only late endpoint existence), a **single shared
direction module** that actually reads the `directed` field (Logos's is dead),
**data-driven catalog loaders** (its are hand-coded per type), and **tests +
STRICT/CI** (it has none). The end goal is one engine that is both operationally
deep *and* disciplined.

## Status

| # | Capability | Theme | Status |
|---|---|---|---|
| [1](https://github.com/corpetty/corpus-graph/issues/1) | Extraction runner (Anthropic + optional local) | A | ✅ done |
| [2](https://github.com/corpetty/corpus-graph/issues/2) | Source chunking + merge | A | ✅ done |
| [3](https://github.com/corpetty/corpus-graph/issues/3) | Triage scoring/queue + cost model | A | open |
| [4](https://github.com/corpetty/corpus-graph/issues/4) | Extraction diff/eval harness | A | open |
| [6](https://github.com/corpetty/corpus-graph/issues/6) | Hierarchy-aware traversal & projection | B | ✅ done |
| [7](https://github.com/corpetty/corpus-graph/issues/7) | Configurable evidence direction | B | ✅ done |
| [5](https://github.com/corpetty/corpus-graph/issues/5) | doctor / health-check | C | ✅ done |
