# Reference Implementation Analysis: The 'Lossy' Information-Book Ontology

> **What this document is.** A rigorous efficiency, scaling, and maintenance report on the **reference implementation** — the `Lossy` information-book repository — from which the **corpus-graph** scaffold was generalized. Every number below is *measured* on that reference graph, not on the scaffold. The scaffold (`corpus-graph`) is a leaner, config-driven re-expression of the same engine; where the reference accrued technical debt, this report names it and states whether the scaffold fixed it. Read [`METHODOLOGY.md`](./METHODOLOGY.md) for the *why* and [`MAPPING.md`](./MAPPING.md) for the *how-to-port*. This is the case study that grounds both with hard numbers.

---

## 1. Executive summary

A single context bundle centered on one chapter — `chapter:selection-as-other-engine` — carries the curated signal of **roughly 36% of the entire graph** (93 of 256 nodes) plus pointers into **4 full source PDFs**, for **~21,517 estimated tokens**. Dumping just the extracted *text* of those same 4 PDFs would cost **~52,699 tokens**. The bundle therefore delivers a structured, evidence-cited neighborhood at **0.41x the cost of the raw PDF text alone** — and the PDFs on disk are 9.67 MB of binary the assistant never has to open.

The mechanism is not compression. It is **curation**: a typed graph lets the exporter retrieve one center's argument-bearing neighborhood, attach evidence atomically to the claims it justifies, and leave navigation noise and unrelated corpus mass behind. The cost is bounded by a center's local degree, not by corpus size.

One honest qualifier, stated up front and revisited in §5: the "small bundle" story holds cleanly at `hop=1`. The default `hop=2` on high-fan-out hub centers runs **13k–24k tokens** and quietly overflows a 20k soft budget. The budget warns; it never truncates. `--hop=1` is the lever.

---

## 2. System overview & data flow

The reference graph is **derived, never stored**: every run rebuilds it from committed catalogs and prose, so it cannot drift from its inputs. The measured shape:

| Metric | Value |
|---|---|
| Nodes | **256** |
| Edges | **1179** |
| Build warnings | **0** |

### Nodes by type (`byNodeType`)

| Type | Count |
|---|---|
| Concept | 61 |
| Claim | 38 |
| Source | 29 |
| Note | 27 |
| Author | 25 |
| Chapter | 14 |
| CaseStudy | 13 |
| Mechanism | 9 |
| Tradition | 9 |
| Question | 8 |
| PipelineStage | 6 |
| Status | 5 |
| Gate | 5 |
| Part | 4 |
| Tension | 3 |

The long tail is real domain structure: `Concept` (61) and `Claim` (38) dominate, while structural scaffolding (`Part`, `Gate`, `Status`) stays small. In the scaffold's domain-agnostic kernel these collapse onto 8 default types (Document, Concept, Claim, Question, Source, Author, Tension, Status); the reference's richer set is the kind of profile a user grows into.

### Edges by predicate (`byPredicate`, top relations)

| Predicate | Count | Role |
|---|---|---|
| wikiLinks | 272 | **weak** (navigation) |
| covers | 199 | structural |
| argues | 128 | claim |
| evidencedBy | 111 | provenance |
| definedIn | 82 | structural |
| mentions | 61 | **weak** (navigation) |
| cites | 47 | provenance |
| flagsOpenQuestion | 44 | dialectical |
| supports | 40 | **load-bearing** evidence |
| dependsOn | 37 | causal |
| pressureTests | 36 | **load-bearing** evidence |
| partOfTradition | 30 | provenance |
| authoredBy | 29 | provenance |

The distribution is the single most important fact in this report. The two highest-count predicates — `wikiLinks` (272) and `covers` (199) — are *navigation*, not argument. The load-bearing edges that carry an actual case for or against a claim — `supports` (40) and `pressureTests` (36) — are an order of magnitude rarer. A naive "expand everything" retrieval would drown those 76 load-bearing edges in 471 navigation edges. The **validated-vs-weak split** keeps the weak predicates out of the argument graph entirely: they remain traversable for the human reader, but never contaminate what an assistant retrieves as evidence.

### Data flow

```
prose (.md) + catalogs (.json)
        │
        ▼
   build-graph  ──►  in-memory Map(nodes) + array(edges)   [0 warnings]
        │
        ├──►  graph.test (golden snapshot + invariants)
        │
        ▼
 context-bundle  ──►  hop-bounded BFS  ──►  render-spec projection  ──►  Markdown / JSON
```

Nothing between prose and bundle is persisted as graph state; the artifacts under `data/` are derived and gitignored.

---

## 3. Build performance

| Operation | Wall-clock | Notes |
|---|---|---|
| `make build` | **0.056s** | Graph logic is sub-10ms; the rest is Node startup |
| `make test` | **0.100s** | 6–9 structural/snapshot tests |

Runtime: **node v24**. Because graph construction is sub-10ms and the dominant cost is interpreter startup, "rebuild from scratch every time" is effectively free. This is what makes *derive-never-store* viable: there is no staleness to track because there is no stored state to go stale.

---

## 4. Context-assembly efficiency

The core claim — that a typed graph buys cheaper, better-grounded context than raw retrieval — was measured across **5 diverse centers** at the default `hop=2`.

### The 5-bundle measurement

| Center | Est. tokens | Distinct nodes | Share of graph |
|---|---|---|---|
| `claim:selection-is-the-tunable-mechanism` | 12,959 | 89 | smallest |
| `chapter:selection-as-other-engine` | 21,517 | 93 | 36.3% |
| `question:truth-value-placement` | 21,559 | 107 | — |
| `concept:receiver-budget` | 23,015 | 102 | — |
| `mechanism:selection` | 23,983 | 116 | 45.3% (largest) |

The band is tight: **12,959–23,983 tokens / 89–116 distinct nodes**. Even the smallest bundle reaches ~35% of the graph's nodes; the largest reaches ~45%. A single center, expanded two hops, routinely pulls in a third to a half of all nodes — yet costs under 24k tokens because the projection renders only argument-relevant structure and drops weak/neverRender predicates.

### Token method and verification

Tokens are estimated by the tool's own **bytes/4** heuristic. This was checked against a real tokenizer: for the chapter bundle the tool self-reported **~21,326** vs a measured **21,517** — within ~1%. BPE on English prose typically lands within ~10–15% of bytes/4, so the figures below are conservative-to-accurate, not optimistic.

### Three token-savings baselines

All three compare against the chapter bundle (`chapter:selection-as-other-engine` = **21,517 tokens**).

| Baseline | Raw size | Est. tokens | Bundle vs baseline |
|---|---|---|---|
| (a) Underlying note (`content/selection-as-other-engine.md`) | — | 8,510 | **2.53x** (bundle is larger) |
| (b) 4 cited source PDFs (text-extracted) | 9.67 MB / 210,799 chars | 52,699 | **0.41x** |
| (c) Whole `.md` corpus | 914,078 bytes | 228,519 | **9.4%** |

**(a) The bundle is 2.53x the raw note — and that is the point.** The bundle is *not* a compression of the note; it is the note's prose *plus* the structured neighborhood scattered across catalogs and other chapters that the note alone never contained. You pay 2.53x to get the evidence, the contested claims, the open questions, and the citations assembled in one place.

**(b) The bundle is 0.41x the cost of dumping 4 PDFs' text.** The four cited PDFs are 9,670,860 bytes (9.67 MB) on disk; extracted to text they are 210,799 chars ≈ 52,699 tokens (per-PDF 5,329 / 14,178 / 17,602 / 15,590). The bundle references **all 4 of those PDFs plus 9 more sources** — 13 cited sources total — and still costs only 21,517 tokens. Its evidence rows are **locator-tagged pointers into the PDFs** (quote + `pageApprox` + confidence), so the assistant gets the cited fact and its justification atomically without ever loading the 9.67 MB of binary. The bundle is a rounding error against the PDFs it indexes.

**(c) The bundle is 9.4% of the corpus token mass**, targeted at one chapter. Loading the whole corpus to answer one chapter's question costs ~228,519 tokens; the bundle does it for ~21,517 — and is more useful, because it is curated rather than dumped.

---

## 5. The honest caveat: `hop=2` overflows budget; `hop=1` is the lever

The attractive "~5–6k token" bundle figure **only holds at `hop=1`**. The default is `hop=2`, and on hub centers that default runs **13k–24k tokens** — silently over a 20k soft budget.

| Center | hop=1 | hop=2 (default) |
|---|---|---|
| `chapter:selection-as-other-engine` | ~7,300 | 21,517 |
| `claim:selection-is-the-tunable-mechanism` | ~3,900 | 12,959 |

The token budget is **advisory**: it estimates bytes/4, warns on stderr, and suggests a lower `--hop`. It **never truncates** — a truncated argument graph is worse than an honestly large one, because silent truncation drops exactly the load-bearing evidence the bundle exists to carry. The correct response to an over-budget bundle is `--hop=1`, which roughly thirds the token cost while keeping the center's directly-`argued` claims (those sort ahead of BFS-incidental ones). The scaffold inherits this exactly, and additionally proposes *defaulting hubs to hop=1* as a scaling mitigation (§6).

---

## 6. Scaling analysis

The two sides of the system scale very differently.

### Consumer side: effectively O(1) in corpus size

A bundle is bounded by **one center's local degree**, not by total node count. Adding the 50th or the 500th source does not enlarge a bundle on unrelated material at all. This is the load-bearing scaling property: **context cost does not grow with corpus size**, only with a center's connectivity. A 256-node graph and a hypothetical 25,600-node graph produce the same-sized bundle for the same center — provided that center's degree is unchanged.

### Author side: O(n) with a tiny constant

Build, test, and bundle are all sub-second; the constant is small enough that a 10x graph still builds in well under a second. The author pays linearly to rebuild, but the linear term is so cheap (graph logic sub-10ms) that derive-never-store stays free in practice.

### Scaling cliffs (comfortable at 256 nodes; degrade at 10x–100x)

| Cliff | Symptom at scale | Mitigation |
|---|---|---|
| Golden-snapshot churn | Every change touches frozen counts | Move to per-namespace counts or invariant-only checks |
| Zero-warnings-in-CI global gate | One pending warning blocks all of CI | Allowlist known-pending warnings |
| Whole-corpus rescans (harvest/build) | Linear rescan dominates at 100x | Incremental builds keyed on mtime/hash |
| Hub bundles overflow budget | hop=2 hubs blow past 20k (see §5) | Default hubs to hop=1; predicate-weighted traversal; per-type node caps |
| In-memory graph | RAM ceiling at hundreds of thousands of nodes | A real store (SQLite/DuckDB) behind the same two-gatekeeper API |

None of these bite at 256 nodes. Each is a known, bounded refactor — the API surface (two gatekeepers, one direction module) is designed so the in-memory `Map`+array can be swapped for a real store without changing the contract callers depend on.

---

## 7. Maintenance & freshness model

The reference's discipline is **derive-never-store + a human-in-the-loop promotion pipeline**.

**Freshness.** Because the graph is rebuilt from scratch in 0.056s on every run, there is no cache to invalidate and no staleness to track. The graph is, by construction, never older than its inputs.

**harvest → promote → extract.** A cheap regex scan proposes candidate claims into a **gitignored inbox** (machine recall). A human **promotes** the load-bearing ones into committed catalogs with a stable slug and a `harvestedFrom` anchor (judgment). LLM extraction then runs against a **closed-world catalog**, so an agent can only reference ids that already exist; `aggregate-interpretive` validates, dedups, and direction-checks, dropping off-catalog or backwards triples with logged reasons.

**Defense in depth.** Direction/shape invariants are enforced in three places — the builder (`addEdge`), the aggregator, and the test suite — all importing the *same* direction-rules logic, so a rule can never be enforced inconsistently across stages.

**Golden snapshot + lenient-local/strict-CI.** `expected-stats.json` freezes counts; an intentional change is blessed (`make accept-stats`) and committed alongside the change that caused it. Warnings are a worklist locally and fatal under `STRICT=1` in CI. The **freshness-as-test** pattern (`git diff --exit-code`) forces any regenerated artifact to be committed, so generated output can never silently diverge from source.

---

## 8. Limitations & technical debt of the reference — and what the scaffold fixed

This is the section the methodology exists to address. The reference works, but it accumulated real debt; the scaffold (`corpus-graph`) was the opportunity to pay it down.

| # | Reference debt | Severity | Fixed in scaffold? |
|---|---|---|---|
| 1 | **Direction rules duplicated 3x** — the same subject/object direction logic was copy-pasted verbatim across 3 files | High (drift risk) | **Fixed.** One shared `core/direction-rules.js` reads each predicate's `subjectTypes`/`objectTypes` from `ontology.json`; builder, aggregator, and tests all import it. |
| 2 | **Schema declared a `directed` field the builder never read** — the contract claimed to enforce direction it did not | High (silent gap) | **Fixed.** `directed`/`subjectTypes`/`objectTypes` are now actually *read*; a backwards relation is unauthorable — it fails validation at build time and in CI. |
| 3 | **Count-only golden snapshot misses same-count swaps** — replacing one edge with a different edge of equal count passes | Medium | **Partially open.** Still count-based; mitigation is per-namespace/invariant-only checks (§6). |
| 4 | **Lexical wikilink resolution hides collisions** — two distinct targets with the same surface text resolve identically | Medium | **Mitigated by design.** Prose `[[wikilinks]]` are always the *weak* `wikiLinks` predicate and kept out of the argument graph; explicit citation is a deliberate catalog field, not lexical inference. |
| 5 | **Brittle 40-char drift anchor** — a claim stores a ~40-char prose prefix; small edits silently break the anchor | Low (by design) | **Carried forward, honestly scoped** as a nudge not a gate: local-only, candidates gitignored, brittle to small edits. |
| 6 | **LLM extraction unaudited for verbatim fidelity** — extracted quotes are not mechanically checked against source text | Medium | **Open.** Closed-world catalogs constrain *which ids* an agent may cite, but verbatim quote fidelity is still trust-based. |

The headline fixes are #1 and #2: the reference's most dangerous debt was a direction contract that was both duplicated and partly unenforced. The scaffold collapses it to a single module that is genuinely read at every stage — a backwards edge is now a build-time error, not a latent inconsistency.

---

## 9. Generalization verdict

The test of the methodology is whether the engine survives being torn off the book domain. It does. The scaffold's kernel is **domain-agnostic and config-driven**, and the reference's 2,739 script LOC generalized *down* to a leaner engine (~533 LOC across the three main files) precisely because the domain knowledge moved out of code and into `ontology.json`.

What transferred to the kernel:

- **Namespaced stable ids** (`ns:slug`), stable across reordering and renaming.
- **Two gatekeepers** — `addNode` (hard vocabulary contract) and `addEdge` (hard predicate contract, soft direction contract that drops+warns, fatal under `STRICT=1`).
- **One shared direction module** reading the ontology — the fix for debt #1/#2.
- **The 6 predicate categories** (structural / causal / provenance / dialectical / claim / weak) — *the categories are the real generalization*, not the specific predicate names.
- **The validated-vs-weak split** — weak predicates navigate, never argue.
- **Data-driven catalog loaders** from `ontology.catalogLoaders`, so adding a node type needs no new code.

The proof is the **software-docs profile**, which renames every node type to a software-documentation domain (Page/Module/Decision/Issue/Reference/Maintainer/Tradeoff/Lifecycle, mapping 1:1 onto the 8 default types) using only its own `ontology.json` — **same engine, no code changes**. It builds:

| Metric | software-docs profile |
|---|---|
| Nodes | **28** |
| Edges | **46** |
| Warnings | **0** |
| Invariant tests | **6/6 pass** |
| Harvest candidates found | 7 |
| Evidence triples kept (0 drops) | 5 |

A bundle for the `caching-guide` page (hop 2) is **~319 tokens / 9 nodes** and surfaces the *contested* decision "Cache keys are content-addressed and immutable" with **both** a supporting quote (RFC 9111, p.§4.2, high) and a pressure-testing quote (Web Almanac 2023, p.Caching ch., medium), plus the resolved cache-invalidation issue and its working answer. That is the same atomic "claim + evidence + counter-evidence + open question" projection that made the book bundle valuable — reproduced in an unrelated domain with renamed types and zero engine changes.

**Verdict:** the efficiency and grounding results measured on the `Lossy` reference are properties of the *method* (typed graph + curated projection + evidence-on-edges + validated/weak split), not of the book domain. The scaffold is that method, made config-driven, with the reference's two most dangerous debts paid off.
