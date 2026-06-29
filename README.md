# corpus-graph

*Turn any corpus into a typed knowledge graph and project it into citeable,
bounded AI context bundles.*

You have a body of text — a book, a docs set, a research-note vault, a wiki — and
you want an AI to draft, review, or reason over it **grounded in what you've
actually written and the sources behind it**. Dumping files into the prompt is
expensive and noisy; pure embedding-RAG is opaque and uncited. `corpus-graph` is
a third option: a small, typed, hand-curated knowledge graph *derived* from your
corpus, then *projected* into compact, deterministic, **citeable** context
packets the AI consumes one task at a time.

It is a domain-agnostic generalization of the graph-ontology subsystem built for
the *Lossy* book ([the reference implementation](docs/ANALYSIS.md)) — the same
engine with the book-specific parts pulled out into config.

```bash
make build                              # build the example graph (software-docs profile)
make context CENTER=caching-guide       # emit a context bundle to stdout
make test                               # golden snapshot + structural invariants
make help                               # all targets
```

## What you get, in one screen

```
your catalogs (JSON)  ─┐
your prose (Markdown) ─┼─►  build  ─►  nodes.jsonl + edges.jsonl  ─►  context bundle
source evidence (JSONL)┘    (0.06s)     (a typed semantic-triple graph)   (Markdown packet
                                                                            for an AI session)
```

A **bundle** is what you paste into a drafting/review session. It is the BFS
neighbourhood of one node, type-aware-rendered: the claims in scope with their
**verbatim source quotes, page locators, and confidence**, the open questions,
the contested points, related documents, and editorial flags — and nothing else.

Example (the shipped `software-docs` profile, `make context CENTER=caching-guide`,
~319 tokens, 9 nodes):

```markdown
### Cache keys are content-addressed and immutable
`decision:immutable-cache-keys` · _accepted_
- supports · RFC 9111: HTTP Caching (`ref:http-caching-rfc`, p.§4.2, high)
  “a cache MUST use the most recent response ... determined by validators”
- pressureTests · Web Almanac 2023 (`ref:web-almanac`, p.Caching ch., medium)
  “cache hit ratios fall when asset URLs churn on every deploy”
## Contested decisions (present as live trade-offs)
- Cache keys are content-addressed and immutable (`decision:immutable-cache-keys`)
```

The fact and its justification travel together — because evidence lives **on the
edges**, the agent can cite `RFC 9111 §4.2` without ever opening the RFC.

## The four moving parts

1. **A schema contract** — one file, [`config/ontology.json`](config/ontology.json),
   declares the node types and predicates. Two gatekeepers (`addNode`,
   `addEdge`) refuse anything off-contract, so the graph can only contain shapes
   the tools understand. Direction is enforced by a **single shared module**
   ([`core/direction-rules.js`](core/direction-rules.js)) that reads each
   predicate's `subjectTypes`/`objectTypes` — a backwards relation is
   unauthorable.
2. **A derive-never-store build** — the graph is rebuilt from scratch every run
   (sub-second), so it can never drift from its inputs. No staleness tracking.
3. **A graph-guided exporter** — an undirected, predicate-agnostic BFS with a
   *hub-transit blocklist* gathers a node's neighbourhood; a render-spec then
   curates it into Markdown. The AI pays for **a node's neighbourhood, not the
   whole corpus**.
4. **A maintenance discipline** — `harvest → promote → extract`: a cheap scan
   proposes candidate claims into a gitignored inbox; you promote the
   load-bearing ones into catalogs; an LLM extracts evidence against a
   *closed-world* catalog of valid ids; a golden snapshot + strict CI keep it
   honest.

See [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) for the abstract version.

## The kernel (8 node types, 6 predicate categories)

| Node type  | Is…                                              |
|------------|--------------------------------------------------|
| `Document` | a unit you author (chapter, page, note, article) |
| `Concept`  | a named idea/term the corpus defines and reuses  |
| `Claim`    | a load-bearing assertion you must defend         |
| `Question` | an open problem; can gate a Document             |
| `Source`   | an external work you cite                         |
| `Author`   | who produced a Source                            |
| `Tension`  | a contradiction/trade-off held open, not hidden  |
| `Status`   | lifecycle status (a hub-transit type)            |

Predicates are grouped into six categories — **structural / causal / provenance
/ dialectical / claim / weak** — and the *weak* split (navigation links like
`wikiLinks` / `mentions`) is kept **out** of the argument graph so navigation
noise never contaminates retrieval. Rename the types to your domain; keep the
categories. See [`docs/MAPPING.md`](docs/MAPPING.md).

## Profiles

A **profile** is one corpus + its ontology. The active profile is `PROFILE=`
(default `software-docs`). A profile inherits the default `config/` and overrides
only the files it ships.

- **`software-docs`** — the worked example. Renames every node type to a
  software-documentation domain (`Page`/`Module`/`Decision`/`Issue`/…) via its
  own `ontology.json` — same engine, no code changes — and builds **28 nodes / 46
  edges / 0 warnings** with all invariants green. This is the proof the kernel is
  domain-agnostic.
- **`blank`** — what `make init NAME=…` copies. Inherits the default ontology;
  one `hello` document.
- **`book`** — illustrative richer schema (the *Lossy* book). Schema-only; the
  copyrighted prose lives in the reference repo.
- **`logos`** — a schema-axis port of the [Logos whitepaper graph](https://github.com/logos-co/logos-whitepaper)
  (17 node types, a 4-level Tier→SubTier→Family→Requirement containment spine). A
  stress test of how a maximal domain ontology maps onto the kernel — builds 60
  nodes / 79 edges / 0 warnings from a representative sample. What ported cleanly
  and what strained is written up in [`profiles/logos/README.md`](profiles/logos/README.md)
  and drives the [roadmap](docs/ROADMAP.md).

```bash
make init NAME=my-corpus                # scaffold profiles/my-corpus from blank
make build   PROFILE=my-corpus
make context PROFILE=my-corpus CENTER=document:<id> ARGS="--hop=1"
make accept-stats PROFILE=my-corpus     # freeze the golden snapshot
```

## Integrate with an AI loop

Three surfaces, increasing in coupling (see [`docs/INTEGRATION.md`](docs/INTEGRATION.md)):

- **CLI / paste** — `make context CENTER=<id>` → paste the Markdown into a chat
  or PR comment.
- **Agent tool hook** — a wrapper an agent calls with a center id; pairs with
  `make catalog` so an extraction/authoring agent is grounded to valid ids only.
- **MCP server** (opt-in: `npm i @modelcontextprotocol/sdk`, then
  `node mcp/server.js`) — exposes `list_centers` and `get_bundle` to an IDE or
  agent; rebuilds sub-second per call so the graph is always fresh.

## Honest about cost

Token estimates are bytes/4. A bundle is bounded by a node's local degree, not
corpus size — **O(1) for the consumer**. On the reference book, bundles ran
**13k–24k tokens** at the default `hop=2` and **~4–7k at `--hop=1`**. The budget
**warns but never truncates**; `--hop=1` is the tightening lever for hub nodes.
Full measurements and scaling cliffs are in [`docs/ANALYSIS.md`](docs/ANALYSIS.md).

## Requirements

Node ≥ 20 (ESM; zero runtime dependencies in the core) and GNU Make. The MCP
server is the only optional dependency.

## Docs

- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — the abstract, repo-agnostic methodology
- [`docs/MAPPING.md`](docs/MAPPING.md) — mapping your domain onto the kernel
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — wiring it into an AI dev/authoring loop
- [`docs/ANALYSIS.md`](docs/ANALYSIS.md) — efficiency/scaling/maintenance analysis of the reference implementation
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — planned capabilities (automated extraction, chunking, triage, diff, doctor, hierarchy-aware projection), drawn from comparing against the Logos graph

## Licence

MIT.
