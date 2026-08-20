# Polaris monorepo task entrypoints.
#
# Bare-metal-first: targets assume RabbitMQ, PostgreSQL, Redis, and ClickHouse
# are reachable at their default localhost endpoints. `docker-*` targets bring
# those up via docker-compose.yml for developers who don't run native infra.
#
# The pnpm workspace (see package.json) is the source of truth; targets here
# exist so the common workflows show up in `make help` and so per-package
# commands have stable repo-root aliases.

.DEFAULT_GOAL := help

# Pull `.env.local` (if present) into every `make` subprocess as real
# environment variables. shared-config's `.env`-file resolution is cwd-based,
# so a single repo-root `.env.local` wouldn't otherwise be visible when
# services run from `apps/*` / `processors/*/v1` / `consumers/*/v1`. Doing the
# load here in Make is the cheapest way to make `make dev`, `make db-migrate`,
# and `make clickhouse-bootstrap` all see the same local config.
#
# Format: simple `KEY=VALUE` lines, no quotes, no shell expansion. Comments
# (`#`) are supported. See `.env.local.example`.
ifneq (,$(wildcard ./.env.local))
include .env.local
export
endif

.PHONY: help setup destroy seed install lint style format check typecheck \
        dev build build-packages build-cli test tests ci stats \
        docker-up docker-down docker-ps docker-logs docker-nuke \
        cli api_key clean \
        db-bootstrap db-migrate db-rollback db-status \
        clickhouse-bootstrap clickhouse-migrate

# Defaults for `make api_key`, overridable per invocation:
#
#   make api_key KEY_SOURCE=payments-api KEY_TYPE=backend
#
# They match definitions/sources/storefront/* — the sources `make seed`
# materializes — so the no-argument form issues the web key
# `blueprints/01-storefront` expects. That blueprint also produces backend
# events, so it wants both: run the bare form and the KEY_SOURCE form above.
#
# The `KEY_` prefix is not decoration. Make seeds its variables from the
# environment, and `?=` does not override something already set — so a bare
# `ENV` would let a stray `ENV=production` in someone's shell silently
# redirect key issuance at production. `POLARIS_ENV` is worse: `.env.local`
# sets it to `local`, which `keys create` rejects outright. Prefixed names
# collide with neither.
KEY_PROJECT ?= storefront
KEY_ENV     ?= development
KEY_SOURCE  ?= storefront-web
KEY_TYPE    ?= web

POLARIS_CLI = apps/polaris-cli/dist/bin/polaris.js

# Code surfaces tracked by `make stats`. Mirrors the architecture docs:
# apps/ holds the services; packages/ and libs/ hold the shared libraries, both
# at once for the length of programme T (ADR-0007); sync/ and async/
# hold the pipeline units (this said `processors consumers` until 2026-08-19,
# which is where they lived before the R-programme move -- both globs had
# matched nothing since, so the whole pipeline counted as zero lines);
# catalog/ holds the file-backed registries; sql/ + db/migrations hold DDL.
LOC_DIRS = apps packages libs sync async catalog sql db/migrations
LOC_PRUNE = \( -name node_modules -o -name dist -o -name build -o -name .next -o -name out -o -name coverage \) -prune
LOC_FIND_TYPES = \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.sql' -o -name '*.yaml' -o -name '*.yml' \)
LOC_GIT_PATHS = \
	':(glob)apps/**/*.ts' \
	':(glob)apps/**/*.tsx' \
	':(glob)packages/**/*.ts' \
	':(glob)packages/**/*.tsx' \
	':(glob)libs/**/*.ts' \
	':(glob)libs/**/*.tsx' \
	':(glob)sync/**/*.ts' \
	':(glob)async/**/*.ts' \
	':(glob)processors/**/*.ts' \
	':(glob)consumers/**/*.ts' \
	':(glob)definitions/**/*.ts' \
	':(glob)definitions/**/*.yaml' \
	':(glob)definitions/**/*.yml' \
	':(glob)sql/**/*.sql' \
	':(glob)db/migrations/**/*.sql'

help: ## Show this help
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# The whole local install story is `bin/setup`, and these two aliases are all
# of the Makefile's share of it — the same split `make dev` has with
# `bin/dev`. It used to be a chain of seven prerequisites here, each of them
# additive, which is how `make setup` came to produce a machine that depended
# on its own history: a source deleted from the catalog kept routing, an
# edited migration never applied. The script destroys the four Polaris stores
# and rebuilds them, so what you get is a function of the repo. See its header.
#
# DESTRUCTIVE, and deliberately so. Nothing else may take `setup` as a
# prerequisite — the day something does, that target silently becomes a wipe.
# `make db-migrate` is the verb for picking up new migrations after a pull.
#
# The script holds each step's output and prints the tail of whatever failed.
# `make setup VERBOSE=1` streams all of it instead, for the failure that is not
# in the tail. It is the same install either way — see `--verbose` in the
# script header.
setup: ## Install locally from scratch: drop every Polaris store, then rebuild, seed, and issue keys
	@./bin/setup $(if $(VERBOSE),--verbose)

destroy: ## Drop every Polaris store (postgres, clickhouse, rabbitmq, redis) without rebuilding
	@./bin/setup --destroy $(if $(VERBOSE),--verbose)

# Kept as its own target because re-seeding after a catalog change is a normal
# thing to do on its own — it is the one phase of `setup` that destroys
# nothing, and so the one that is safe against a machine you do not want reset.
seed: build-cli ## Re-run the catalog syncs and the browser origin allow-list (destroys nothing)
	@./bin/setup --seed $(if $(VERBOSE),--verbose)

install: ## Install pnpm workspace dependencies
	pnpm install

lint: ## Run the Biome linter
	pnpm lint

style: ## Auto-fix lint and format issues
	pnpm check:fix

format: ## Format with Biome
	pnpm format

check: ## Run Biome lint + format checks
	pnpm check

typecheck: ## Run tsc --noEmit across the workspace
	pnpm typecheck

# The whole bare-metal dev story is `bin/dev`, and this alias is all of the
# Makefile's share of it. There used to be six targets here — dev, dev-all,
# dev-ingester, dev-control-plane, dev-stop, and a dev-guard that refused to
# start when a stack was already up — differing only in which services they
# left out, none of them able to stop what they started. Signal handling is
# the reason it moved: Make forwards signals to nothing, so a recipe cannot
# promise that Ctrl-C reaches the processes it spawned. `bin/dev` runs the
# stack in its own process group and kills that group. See its header.
dev: ## Run the whole platform bare-metal (Ctrl-C stops everything it started)
	@./bin/dev

build: ## Build all workspace packages
	pnpm build

# Workspace packages export only ./dist/*, so anything importing `@polaris/*`
# needs these built first — `setup`, `build-cli`, and the dev stack alike.
# `bin/dev` runs the same command itself rather than depending on this target,
# so starting the stack is one script and not a prerequisite chain; keep the
# two in step. `tsc --incremental` makes the no-op case ~3-5s, cheap enough to
# pay on every start.
# `libs/*` and `libs/*/*` are the ADR-0007 destinations, listed beside
# `packages/*` because both are live until IJ4NN. A filter that names only the
# old root builds nothing for a moved library, and `make seed` then fails at
# runtime on a `@polaris/*` import with no dist behind it.
build-packages: ## Build shared packages so workspace imports resolve at runtime
	pnpm -r --filter './packages/*' --filter './libs/*' --filter './libs/*/*' run build

# `build-packages` covers the library roots only, and the CLI lives in apps/ — so
# `make seed` and `make api_key`, which shell out to the built CLI, name this
# explicitly rather than assuming a prior `make build`.
build-cli: build-packages ## Build the polaris CLI (apps/polaris-cli) so `make seed` / `make api_key` can run it
	pnpm --filter @polaris/polaris-cli run build

test: ## Run the Vitest suite
	pnpm test

tests: test ## Alias for test

benchmark: ## Run benchmark suites across the workspace (no-op if no package defines a `benchmark` script)
	@matches=$$(find . -maxdepth 4 -name package.json -not -path "*/node_modules/*" -exec grep -lE '"benchmark"[[:space:]]*:' {} + 2>/dev/null); \
	if [ -n "$$matches" ]; then \
		pnpm -r run benchmark --if-present; \
	else \
		echo "No benchmark scripts defined yet — skipping."; \
	fi

ci: lint typecheck test ## Run the CI flow: lint, typecheck, tests

stats: ## Show project LOC (current tree + historical churn)
	@current_loc=$$(find $(LOC_DIRS) $(LOC_PRUNE) -o -type f $(LOC_FIND_TYPES) -print0 2>/dev/null | xargs -0 cat 2>/dev/null | wc -l | tr -d ' ') && \
	printf "LOC\n  Current: %s\n" "$$current_loc"
	@historical_loc=$$(git log --numstat --format=tformat: -- $(LOC_GIT_PATHS) | \
		awk '($$1 ~ /^[0-9]+$$/ && $$2 ~ /^[0-9]+$$/) { total += $$1 + $$2 } END { print total + 0 }') && \
	printf "  Historical: %s\n" "$$historical_loc"

docker-up: ## Start the local infra stack with docker compose (daemonised, waits for health) and declare the RabbitMQ topology
	docker compose up -d --wait
	$(MAKE) rabbitmq-provision

docker-down: ## Stop the docker compose stack (preserves named volumes)
	docker compose down

docker-ps: ## Show docker compose service status
	docker compose ps

docker-logs: ## Tail docker compose logs (Ctrl-C to exit)
	docker compose logs -f

docker-nuke: ## Stop docker compose and wipe named volumes (destructive)
	docker compose down -v

cli: ## Open the polaris CLI console (apps/polaris-cli)
	pnpm --filter @polaris/polaris-cli run start

# The token prints exactly once — only its argon2id hash is stored, so a lost
# token is reissued, never recovered. Not part of `make setup` for that
# reason: a step that re-runs would leave a trail of live keys behind.
#
#   make api_key                                          # web key for storefront-web
#   make api_key KEY_SOURCE=payments-api KEY_TYPE=backend # backend key
api_key: build-cli ## Issue an API key for local apps (override with KEY_PROJECT/KEY_ENV/KEY_SOURCE/KEY_TYPE)
	@node $(POLARIS_CLI) keys create \
		--project $(KEY_PROJECT) --env $(KEY_ENV) --source $(KEY_SOURCE) --type $(KEY_TYPE)

db-bootstrap: ## Create the polaris role + database on the local PostgreSQL (idempotent; bare-metal only)
	pnpm db:bootstrap-local

db-migrate: ## Apply pending PostgreSQL migrations (dbmate up — creates DB if missing)
	pnpm db:migrate

db-rollback: ## Roll back the most recent PostgreSQL migration
	pnpm db:rollback

db-status: ## Show PostgreSQL migration status
	pnpm db:status

clickhouse-bootstrap: ## Create local ClickHouse DB + apply DDL + local-only users
	pnpm clickhouse:bootstrap-local

clickhouse-migrate: ## Apply ClickHouse SQL migrations only (no local-user init)
	pnpm clickhouse:migrate

rabbitmq-bootstrap: ## Create the local RabbitMQ user/vhost/permissions named by POLARIS_RABBITMQ_URL (bare-metal only; docker compose does this itself)
	pnpm rabbitmq:bootstrap-local

rabbitmq-provision: ## Declare the RabbitMQ topology (super streams + retry/DLQ queues). Idempotent; required before any service starts.
	pnpm rabbitmq:provision

rabbitmq-plan: ## Print the RabbitMQ topology that would be declared, without touching the broker
	pnpm rabbitmq:provision:dry-run

clean: ## Remove built artefacts (per-package "clean" scripts)
	pnpm clean
