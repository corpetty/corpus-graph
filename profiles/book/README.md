# book profile (illustrative)

This profile ships the **schema only** — it shows how the corpus-graph kernel
scales from the 8-type default skeleton to the richer ontology of a nonfiction
book working out a contested argument (Chapter, Note, Mechanism, Concept,
Question, Claim, Source, Author, Tradition, CaseStudy, Tension).

The **full, living instantiation** is the reference implementation this whole
project was generalized from — the *Lossy* book repo (`information-book`), which
carries the real catalogs, prose, per-source interpretive extractions, and the
Cytoscape viewer. Its prose is copyrighted, so it is not vendored here.

`make build PROFILE=book` is valid but produces only the seeded status nodes,
because no catalogs ship in this profile. To see the methodology on a real,
working corpus, use the `software-docs` profile; to see it at book scale, read
the reference repo and `docs/ANALYSIS.md`.

Notable differences from the default skeleton, called out as a mapping example:

- `Concept` splits into **Concept** + **Mechanism** (a named structural force).
- Adds **CaseStudy** (worked examples) and **Tradition** (intellectual lineage).
- Adds `evidencedBy` (Claim/Concept/Mechanism → Source) alongside the
  `supports`/`pressureTests` (Source → Claim) evidence edges.
- The reference also seeds a domain-specific `PipelineStage`/`Gate` skeleton
  that encodes the book's actual thesis — the kind of thing that belongs in a
  profile's `seeds`, never in the kernel.
