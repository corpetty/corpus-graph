# Integrating corpus-graph into an AI loop

corpus-graph turns a corpus into a typed, validated knowledge graph and ships an **exporter** that projects any node's local neighbourhood into a deterministic Markdown bundle. That bundle is the integration surface: it is what you hand to an AI assistant so its work is *grounded* in your argument graph — real ids, real evidence, real cited quotes — instead of free-associating over raw prose.

This document covers three ways to wire the exporter into a development or authoring loop, in increasing order of coupling:

| Surface | Coupling | When to reach for it |
|---|---|---|
| **A. CLI / paste** | none | Ad-hoc grounding into a chat or PR comment |
| **B. Agent tool hook** | thin wrapper | An autonomous agent that drafts or extracts |
| **C. MCP server** | opt-in dependency | A standing tool an MCP-aware client discovers |

All three call the *same* engine. The graph is **derive-never-store**: it is rebuilt from scratch on every run (sub-second), so whatever surface you use, the served graph can never drift from its inputs.

---

## Surface A — CLI / paste

The lowest-friction surface prints a bundle to stdout. Pick a center node id and ask for its neighbourhood:

```bash
make context CENTER=decision:immutable-cache-keys
make context CENTER=decision:immutable-cache-keys ARGS="--hop=1 -o out.md"
```

Or call the binary directly:

```bash
corpus-graph context --center=decision:immutable-cache-keys
corpus-graph context --center=decision:immutable-cache-keys --hop=1 -o out.md
```

The output is deterministic, diff-friendly Markdown (or JSON). Paste it into a chat, drop it into a PR comment, or `-o` it to a file. Because the build runs first and is sub-second, the bundle always reflects the current catalogs — there is no cache to invalidate.

### A shown bundle (software-docs profile, caching-guide)

The `software-docs` worked example builds **28 nodes / 46 edges / 0 warnings**. A bundle for the caching-guide page at hop 2 is **~319 tokens / 9 nodes** and surfaces the *contested* decision with its evidence attached on the edges — a fact and its justification retrieved atomically, each citation locator-tagged so you never open the source:

```markdown
## Decision: Cache keys are content-addressed and immutable  [decision:immutable-cache-keys]
Contested.

### Supporting evidence
- supports — "A cache key consists of the request method and target URI..."
  — RFC 9111 (p.§4.2, high)

### Pressure-testing evidence
- pressureTests — "A large share of responses ship without validators,
  so key reuse is riskier than it looks." — Web Almanac 2023 (p.Caching ch., medium)

### Open question (resolved)
- cache-invalidation — working answer: purge by content hash, never by URL.
```

That is the whole proposition: the assistant sees *both sides* of the contested decision and can cite `RFC 9111, p.§4.2, high` without ever reading RFC 9111.

---

## Surface B — Agent tool hook

For an autonomous agent, wrap the exporter as a single tool. The contract is intentionally tiny.

| | |
|---|---|
| **Input** | `center` id (required), optional `hop`, optional `token-budget` |
| **Output** | the bundle string (Markdown or JSON) |

A minimal Node wrapper shells the same entrypoint the CLI uses:

```js
import { execFileSync } from "node:child_process";

export function getBundle({ center, hop = 2, tokenBudget }) {
  const args = ["context", `--center=${center}`, `--hop=${hop}`];
  if (tokenBudget) args.push(`--token-budget=${tokenBudget}`);
  return execFileSync("corpus-graph", args, { encoding: "utf8" });
}
```

Pair this with **`build-catalog.js`** (`make catalog` → `core/build-catalog.js`). It emits a **closed-world id catalog**: the full set of valid node ids. Hand that catalog to an extraction or authoring agent and it can only reference ids that already exist. The agent becomes a grounded participant — it draws context through `getBundle`, and when it proposes new triples it must address nodes from the catalog. Off-catalog and backwards relations are dropped at aggregation time with logged reasons, so a hallucinated reference cannot enter the committed graph.

This is the cheapest way to make an agent's output *checkable*: every claim it emits is either a valid catalog id or a logged drop.

---

## Surface C — The opt-in MCP server

For MCP-aware clients (editors, desktop chat apps, agent frameworks), `mcp/server.js` exposes the exporter as discoverable tools. It is **opt-in** — the core has zero runtime dependencies, and the server is the one place that needs the SDK:

```bash
npm i @modelcontextprotocol/sdk
node mcp/server.js
```

It exposes two tools:

| Tool | Input | Output |
|---|---|---|
| `list_centers` | — | valid center ids (the closed-world catalog) |
| `get_bundle` | `center` (+ optional `hop`, `token-budget`) | the bundle string |

A typical client config stanza:

```json
{
  "mcpServers": {
    "corpus-graph": {
      "command": "node",
      "args": ["mcp/server.js"],
      "cwd": "/path/to/your/corpus-graph"
    }
  }
}
```

The server **rebuilds the graph sub-second per call**, so the served graph is always fresh — there is no daemon state to go stale. `list_centers` is what keeps the model honest: it discovers the legal ids first, then pulls only the neighbourhoods it needs. The flow is identical to Surface B, but the client manages discovery and invocation for you.

---

## The end-to-end drafting / review loop

The exporter is one stage in a maintenance discipline. The full loop, from corpus to committed graph:

```
build → pick a center → get bundle → draft/review against it → edit prose → harvest → promote → extract → rebuild
```

1. **build** — `make build` derives the graph from catalogs and prose (sub-second).
2. **pick a center** — choose the node you are working on (use `list_centers` / the catalog if you need valid ids).
3. **get bundle** — pull that center's neighbourhood via any surface above.
4. **draft / review against it** — the assistant drafts new prose or reviews a change *grounded* in the bundle's claims, tensions, and cited evidence.
5. **edit prose** — you write the actual `.md`.
6. **harvest** — `make harvest` runs a cheap regex scan that proposes candidate claims into a **gitignored inbox** (machine recall, no judgment).
7. **promote** — a human lifts the load-bearing candidates into committed catalogs with a stable slug and a `harvestedFrom` anchor (this is the judgment step).
8. **extract** — LLM extraction runs against the **closed-world catalog**, so it can only reference ids that exist; `aggregate-interpretive` validates, dedups, and direction-checks, dropping off-catalog or backwards triples with logged reasons.
9. **rebuild** — back to step 1; the next bundle reflects everything just promoted.

Harvest is recall, promote is judgment, extract is constrained generation. The exporter feeds steps 3–4; the catalog gates step 8. In the reference implementation this pipeline kept the navigation noise out of the argument graph: a harvest scan found **7 candidate claims** in the software-docs profile, of which **5 evidence triples** were kept with **0 drops**.

---

## Budgeting reality

The token budget is **advisory**. The exporter estimates cost as bytes/4, warns on stderr when a bundle exceeds the soft budget, and suggests a lower `--hop`. **It never truncates.** A bundle is always complete; the budget is a worklist signal, not a gate.

The honest numbers, measured on the reference implementation (a 256-node graph), set expectations:

| Setting | Typical bundle | Notes |
|---|---|---|
| **hop=2 (default), hub center** | **13k–24k tokens** | silently overflows a 20k soft budget — warns, does not truncate |
| **hop=1** | **~4k–7k tokens** | tight packets; the tightening lever |

Concretely, across five diverse hop-2 centers the band ran **12,959 to 23,983 estimated tokens** (89 to 116 distinct nodes). The same `chapter` center that cost ~21,500 tokens at hop 2 dropped to **~7,300 tokens at hop 1**; a `claim` center fell from ~12,959 to **~3,900**. The "~4–7k tight packet" figure holds **only at hop=1**. Default hop=2 on a hub center will overflow — and that is fine for a paste into a long-context model, but `--hop=1` is the lever when you need a tight, focused packet.

Two structural properties make this predictable:

- **Hub-transit blocklist.** BFS reaches hub-type nodes (Status / Lifecycle) but does not traverse *through* them, so a category super-hub cannot collapse the graph to a single hop and blow up the bundle.
- **O(1) in corpus size.** A bundle is bounded by *one center's local degree*, not total node count. Add the 50th or 500th source and a bundle on unrelated material does not grow at all. Budgeting stays a per-center concern, not a corpus-wide one.

### Picking a hop

- **Reviewing one claim or decision?** `--hop=1` — you want the immediate evidence and nothing else.
- **Drafting a section that threads several concepts?** `--hop=2` default, accept the larger packet, watch the stderr warning.
- **Feeding a small or rate-limited model?** `--hop=1` and, if needed, `--token-budget` to get an earlier warning — then trust that the bundle is still complete even when the warning fires.

The rule of thumb: start at hop=1, widen to hop=2 only when the assistant asks for context it cannot see. Because every surface rebuilds sub-second, iterating on hop is free.
