# corpus-graph — turn a corpus into a typed knowledge graph and project it into
# citeable, bounded AI context bundles.
#
# PROFILE selects which profiles/<name>/ to operate on (default: software-docs).
# Pass extra script flags through ARGS="...".

PROFILE ?= software-docs
NODE    ?= node
CG       = $(NODE) bin/corpus-graph.js
export PROFILE

.PHONY: build context harvest extract aggregate catalog extract-build test check accept-stats stats doctor init help

build: ## Rebuild the graph for $(PROFILE)
	@$(CG) build

context: build ## Emit a context bundle: make context CENTER=<id> [ARGS="--hop=1 -o out.md"]
	@$(CG) context --center=$(CENTER) $(ARGS)

harvest: ## Scan prose for candidate claims into the gitignored inbox
	@$(CG) harvest

extract: ## Run extraction: make extract ARGS="--source=<id>|--all [--backend=anthropic|openai|mock --model=...]"
	@$(CG) extract $(ARGS)

catalog: build ## Emit the closed-world extraction catalog for agents
	@$(CG) catalog

aggregate: ## Validate + de-dup interpretive triples into the aggregate
	@$(CG) aggregate

extract-build: ## catalog -> aggregate -> rebuild (after running extraction agents)
	@$(CG) extract-build

test: build ## Run the regression suite (snapshot + structural invariants + extract)
	@$(NODE) --test core/*.test.js

check: ## Strict build (warnings fatal) + tests — the CI gate
	@STRICT=1 $(CG) check
	@$(NODE) --test core/*.test.js

accept-stats: ## Bless the current counts as the new golden snapshot
	@$(CG) accept-stats

stats: ## Print build stats as JSON
	@$(CG) stats

doctor: ## Diagnose $(PROFILE) without rebuilding (staleness, refs, config)
	@$(CG) doctor

init: ## Scaffold a new profile: make init NAME=my-corpus
	@$(CG) init $(NAME)

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := build
