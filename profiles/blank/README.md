# blank profile

The starting point `corpus-graph init` copies. It **inherits the default
ontology** (`config/ontology.json`) — no `ontology.json` of its own — so you get
the domain-agnostic skeleton (Document / Concept / Claim / Question / Source /
Author / Tension / Status) out of the box.

To make it yours:

1. (Optional) Drop an `ontology.json` here to rename node types to your domain.
   Anything you omit inherits the default.
2. Edit `catalogs/*.json` — start with `documents.json`, `concepts.json`,
   `claims.json`.
3. Put prose under `content/` and reference each file from a Document's `file`.
4. `make build PROFILE=<name>` → `make context CENTER=document:<id>`.
5. `make accept-stats PROFILE=<name>` to freeze the golden snapshot.
