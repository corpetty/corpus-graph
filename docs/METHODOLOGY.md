# Graph-Ontology-Assisted AI Authoring/Development

Graph-Ontology-Assisted AI Authoring/Development is a method for grounding a large language model on a specific corpus by routing its context through a typed, hand-curated knowledge graph instead of raw files or an opaque vector index. You define a small schema contract (what kinds of things exist and how they may relate), derive a graph from your source material on every build, and export a tight, type-aware neighbourhood around any one node as the context you hand the model. The graph is the contract between your corpus and the assistant: deterministic to produce, inspectable by a human, and — because justification travels on the edges — citeable. The scaffold tool in this repo, **corpus-graph**, is one concrete, repo-agnostic implementation of the method; the measured numbers quoted in `docs/ANALYSIS.md` come from the reference book implementation it was generalized from.

**TL;DR**

- Ground the model on a *typed graph you can read*, not on a pile of files or a black-box embedding store — context becomes deterministic, inspectable, and citeable.
- Four moving parts: a **schema contract**, a **derive-never-store build**, a **graph-guided context exporter**, and a **maintenance discipline** that keeps the graph honest as the corpus grows.
- The exporter is effectively **O(1) in corpus size**: a bundle is bounded by one center node's local degree, so adding the 500th source does not grow a bundle about unrelated material.
- It is not a silver bullet: it costs upfront curation, it is wrong for fast-churning corpora, and on hub nodes at the default 2-hop radius a bundle can run 13k–24k tokens and overflow a 20k soft budget — `--hop=1` is the tightening lever.

## The problem: grounding a model on *your* corpus

You have a body of material — a book, a documentation set, a research archive — and you want an AI assistant to reason and write over it faithfully. The two common approaches both fail in instructive ways.

**Dumping files** into the context window is simple but blunt. It does not scale (a whole corpus is hundreds of thousands of tokens — the reference corpus is ~228,519 estimated tokens of Markdown alone), it carries no structure, and it gives the model no way to tell a load-bearing claim from a passing mention.

**Pure embedding-RAG** retrieves by surface similarity. It is opaque — you cannot read *why* a chunk was chosen — and non-deterministic, so the same question can yield different context on different runs. Critically, it has no notion of *argument structure*: it cannot tell you that claim A is *supported by* source X but *pressure-tested by* source Y, because that relationship lives nowhere in a vector.

A typed knowledge graph fixes exactly these gaps. It is:

| Property | What it buys you |
| --- | --- |
| **Deterministic** | The same center yields the same bundle, every run. Rebuilt from scratch sub-second, so it cannot drift from inputs. |
| **Inspectable** | A human can read the schema, the nodes, the edges, and the rendered bundle. Nothing is hidden in a similarity score. |
| **Citeable** | Evidence (quote + locator + confidence) rides on the edge, so a fact and its justification are retrieved together and cited without opening the source. |

The cost is real and stated honestly below: you must author and maintain the graph. The method earns that cost when faithfulness and traceability matter more than zero-setup convenience.

## The four moving parts

The method has four parts. Each is described abstractly first, then with corpus-graph as the concrete instance.

### 1. A schema contract

*Abstractly:* declare a closed vocabulary — the node types that exist and the predicates (typed relationships) allowed between them, including which direction each predicate runs. This contract is the spine; everything downstream reads it.

*In corpus-graph:* a single editable `config/ontology.json` declares **8 node types** (Document, Concept, Claim, Question, Source, Author, Tension, Status), **~17 predicates** grouped into **6 categories**, and for each predicate its `subjectTypes`/`objectTypes`/`directed` fields. This is the one file a user edits to adapt the method to their domain. Crucially, those direction fields are *actually read* — see the kernel below.

### 2. A derive-never-store build

*Abstractly:* never hand-edit the graph. Derive it from your sources on every run, fast enough that there is no incentive to cache it. A graph you rebuild cannot go stale.

*In corpus-graph:* `core/build-graph.js` rebuilds the entire graph from frontmatter, prose, and catalogs in sub-second time (`make build` = 0.056s wall-clock in the reference; graph logic is sub-10ms, the rest is Node startup). There is **no staleness tracking** because there is nothing to track — the inputs *are* the source of truth, always.

### 3. A graph-guided context exporter

*Abstractly:* given one node, gather its local neighbourhood by graph traversal, then curate that neighbourhood into a compact, type-aware document. Traversal decides *what is reachable*; curation decides *what is shown*. Keep them separate.

*In corpus-graph:* `core/context-bundle.js` takes a center id, runs an undirected BFS to a hop radius (default 2), and projects the result through `config/render-spec.json` into deterministic, diff-friendly Markdown (or JSON). Curation lives in render, not traversal — sections emit only when non-empty, and claims the center directly `argues` sort ahead of BFS-incidental ones.

### 4. A maintenance discipline

*Abstractly:* a graph is only as trustworthy as its upkeep. You need a cheap way for machines to *propose* additions, a deliberate human step to *promote* the load-bearing ones, and validation that an LLM extracting facts can only reference things that already exist.

*In corpus-graph:* the **harvest → promote → extract** loop. A regex scan (`core/harvest.js`) proposes candidates into a gitignored inbox (machine recall); a human promotes the load-bearing ones into committed catalogs with a stable slug (judgment); LLM extraction runs against a **closed-world catalog** (`core/build-catalog.js`) so an agent can only cite ids that already exist; and `core/aggregate-interpretive.js` validates, dedups, and direction-checks, dropping off-catalog or backwards triples with logged reasons.

## The kernel: what makes the graph trustworthy

The four parts rest on a small, domain-agnostic core. These are the design decisions that make the method robust rather than merely tidy.

**Namespaced ids.** Every node id is `ns:slug` — `document:hello`, `decision:immutable-cache-keys`. Slugs are stable across reordering and renaming, so references survive editing.

**Two gatekeepers.** All graph mutation flows through two functions over a `Map(nodes)` + `array(edges)`:

- `addNode` **throws** on an unknown node type — a HARD vocabulary contract. You cannot invent a type by accident.
- `addEdge` **throws** on an unknown predicate, and **drops + warns** on a direction/shape violation — a SOFT direction contract. `STRICT=1` makes those warnings fatal in CI.

**One shared direction module.** `core/direction-rules.js` (56 LOC) reads each predicate's `subjectTypes`/`objectTypes` from the ontology and is imported by the builder, the aggregator, *and* the test suite — defense in depth from a single source of truth. A backwards relation is therefore **unauthorable**: it fails at build time and again in CI. (This deliberately fixes a debt in the reference implementation, where the rules were duplicated verbatim across three files and the schema declared a `directed` field the builder never read.)

**Six predicate categories.** Every predicate falls into one of: **structural / causal / provenance / dialectical / claim / weak**. These categories — not any one domain's type names — are the real generalization the method offers.

**The validated-vs-weak split.** Weak predicates (`wikiLinks`, `mentions`) are *navigation only* and are kept out of the argument graph. This matters because navigation edges dominate by count while argument edges carry the weight: in the reference graph, `wikiLinks` (272) and `covers` (199) were the highest-count predicates, while the load-bearing `supports` (40) and `pressureTests` (36) were comparatively rare. Letting navigation noise into argument retrieval would drown the signal. Prose `[[wikilinks]]` always become the weak `wikiLinks` predicate; an explicit citation is a deliberate catalog field, not an accident of prose.

**Evidence on edges.** `supports` / `pressureTests` edges carry `quote` + `pageApprox` + `confidence` + `rationale`. A fact and its justification are retrieved atomically and cited — e.g. *"p.§4.2, high"* — without opening the source. This is what makes the output citeable rather than merely plausible.

**Hub-transit blocklist.** The BFS is predicate-agnostic, but hub-type nodes (e.g. Status / Lifecycle) are reachable yet *not traversed through*. Without this, a category super-hub that touches every node would collapse the whole graph into one hop of any center. The blocklist keeps neighbourhoods local and meaningful.

**Token budget is advisory.** The exporter estimates tokens as bytes/4, warns on stderr, and suggests a lower `--hop` when a bundle is large. It **never truncates** — truncation would silently drop the very evidence that makes a bundle trustworthy.

## Why it works as an AI aid

The payoff for the model is a context that is *small, structured, and self-justifying*.

- **Atomic fact + justification.** Because evidence is on the edge, the assistant receives the claim and its supporting (and contesting) quotes together. In the software-docs worked example, a hop-2 bundle for the caching-guide page is ~319 tokens / 9 nodes and surfaces the contested decision *"Cache keys are content-addressed and immutable"* with both a supporting quote (RFC 9111, p.§4.2, high) and a pressure-testing quote (Web Almanac 2023, p.Caching ch., medium) — the model sees the tension, not just one side.

- **Targeted, not bulk.** A bundle is a slice, not the corpus. In the reference, the chapter bundle is 21,517 tokens — **9.4%** of the whole 228,519-token corpus, aimed at one chapter. It references 4 cited PDFs (9.67 MB on disk; ~52,699 tokens of extracted text) for **0.41x** the cost of dumping just those four PDFs' text, because its evidence rows are locator-tagged pointers *into* the PDFs rather than the PDFs themselves.

- **O(1) on the consumer side.** A bundle is bounded by one center's local degree, not total node count. Add the 50th or 500th source and a bundle on unrelated material does not grow at all. The author side is O(n) with a tiny constant — a 10x graph still builds in well under a second.

- **Deterministic and diff-friendly.** Because output is sorted and stable, two runs produce identical bundles, and a bundle can be committed and reviewed like code.

## Where it fits — and where it does not

The method shines when the corpus is **argument-bearing and relatively stable**, when **faithfulness and citation matter**, and when you have a human willing to do **curation as a first-class activity**. Books, standards-grounded documentation, research syntheses, and decision records are natural fits. The software-docs profile proves the engine is domain-agnostic: it renames every node type to a documentation domain (Page/Module/Decision/Issue/Reference/Maintainer/Tradeoff/Lifecycle) via its own ontology, runs with **no code changes**, and builds 28 nodes / 46 edges / 0 warnings with all 6 invariant tests passing.

It fits poorly, or not at all, in the following cases.

### Limits & when NOT to use this

- **Fast-churning corpora.** Drift detection is deliberately weak: each claim stores only a ~40-char prefix of its source prose, and re-derived candidates that no longer contain that anchor merely *warn*. It is local-only (candidates are gitignored), brittle to small edits, and a nudge rather than a gate. If your text changes hourly, the anchors will thrash and the curation cost will dominate.

- **You won't pay the curation cost.** The harvest → promote → extract loop *requires* a human in the promote step. Skip it and the graph is either empty or full of noise. Pure-embedding RAG is the better tool when zero-setup retrieval beats faithfulness.

- **Hub centers at default radius.** The clean "~5–6k token" bundle figure only holds at hop=1. At the default hop=2, hub centers run **13k–24k tokens** (the reference band across 5 diverse centers was 12,959–23,983 tokens / 89–116 nodes) and silently overflow a 20k soft budget — the tool warns but never truncates. `--hop=1` is the explicit tightening lever (chapter ~7,300 tok, claim ~3,900 tok at hop=1).

- **Very large graphs, today.** The method is comfortable at the reference's 256 nodes / 1,179 edges and degrades at 10x–100x in known, addressable ways:

| Scaling cliff | Mitigation |
| --- | --- |
| Golden-snapshot churn | Move to per-namespace counts or invariant-only checks |
| Zero-warnings-in-CI as a global gate | Allowlist known-pending warnings |
| Whole-corpus rescans by harvest/build | Incremental builds keyed on mtime/hash |
| Hub bundles overflowing budget | Default hubs to hop=1, predicate-weighted traversal, per-type node caps |
| In-memory graph | A real store (SQLite/DuckDB) behind the same two-gatekeeper API |

The in-memory `Map` + `array` is the right call at hundreds of nodes and the wrong call at hundreds of thousands — but the two-gatekeeper API is exactly the seam that lets you swap the store without touching the method.

## The discipline that holds it together

Three habits keep the graph trustworthy over time, and they generalize to any generated artifact:

1. **Defense in depth.** Direction and shape invariants are enforced at the builder (`addEdge`), at the aggregator, and in the test suite — all importing the same `direction-rules` module. A bad edge has three chances to be caught.
2. **Lenient-local / strict-CI.** The same build treats warnings as a worklist locally and as fatal failures under `STRICT=1` in CI (`make check`). You iterate freely; the gate is firm.
3. **Freshness-as-test.** A golden snapshot (`profiles/<p>/expected-stats.json`) freezes counts; an intentional change is blessed with `make accept-stats` and committed alongside the change. For any generated file, `git diff --exit-code` forces regeneration to be committed — staleness becomes a failing test.

```bash
# the everyday loop
corpus-graph build                 # derive the graph from scratch (sub-second)
corpus-graph context <center-id>   # export a graph-guided bundle to stdout
corpus-graph context <center-id> --hop=1 -o bundle.md   # tighten a hub center
make check                         # strict build: warnings are fatal (CI gate)
```

The whole engine is small on purpose — ~533 LOC across the three core files (`build-graph.js` 241, `context-bundle.js` 236, `direction-rules.js` 56), ~1,084 LOC total including lib/bin/mcp, with **zero runtime dependencies** in the core. The generalized, config-driven engine is *leaner* than the 2,739-LOC reference scripts it was distilled from. That smallness is the point: a method you can read end-to-end in an afternoon is a method you can trust to ground an assistant on work that matters.
