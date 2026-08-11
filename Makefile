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

.PHONY: help setup install lint style format check typecheck \
        dev dev-all dev-ingester dev-control-plane \
        build build-packages test tests ci stats \
        docker-up docker-down docker-ps docker-logs docker-nuke \
        cli clean \
        db-bootstrap db-migrate db-rollback db-status \
        clickhouse-bootstrap clickhouse-migrate

# Code surfaces tracked by `make stats`. Mirrors the architecture docs:
# apps/, packages/, processors/, consumers/ hold runtime code; catalog/ holds
# the file-backed event catalog and policy; sql/ + db/migrations hold DDL.
LOC_DIRS = apps packages processors consumers catalog sql db/migrations
LOC_PRUNE = \( -name node_modules -o -name dist -o -name build -o -name .next -o -name out -o -name coverage \) -prune
LOC_FIND_TYPES = \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.sql' -o -name '*.yaml' -o -name '*.yml' \)
LOC_GIT_PATHS = \
	':(glob)apps/**/*.ts' \
	':(glob)apps/**/*.tsx' \
	':(glob)packages/**/*.ts' \
	':(glob)packages/**/*.tsx' \
	':(glob)processors/**/*.ts' \
	':(glob)consumers/**/*.ts' \
	':(glob)catalog/**/*.ts' \
	':(glob)catalog/**/*.yaml' \
	':(glob)catalog/**/*.yml' \
	':(glob)sql/**/*.sql' \
	':(glob)db/migrations/**/*.sql'

help: ## Show this help
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: install build-packages db-bootstrap db-migrate clickhouse-bootstrap rabbitmq-provision ## Bare-metal bootstrap (install + build shared packages + postgres role/db + postgres migrations + clickhouse bootstrap + rabbitmq topology). Assumes infra is running at default endpoints.

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

dev: build-packages ## Run the two HTTP APIs bare-metal with tsx watch (ingester + control-plane)
	pnpm --parallel --filter @polaris/ingester-api --filter @polaris/control-plane-api run dev

dev-all: build-packages ## Run every service bare-metal in parallel (apps + processors + consumers)
	pnpm -r --parallel --if-present run dev

dev-ingester: build-packages ## Run only the ingester API bare-metal
	pnpm --filter @polaris/ingester-api run dev

dev-control-plane: build-packages ## Run only the control-plane API bare-metal
	pnpm --filter @polaris/control-plane-api run dev

build: ## Build all workspace packages
	pnpm build

# Workspace packages export only ./dist/* — tsx watch in the apps imports
# from those dists, so they must exist before `make dev`. `tsc --incremental`
# makes the no-op case fast (~3-5s) so this is cheap to keep as a dev dep.
build-packages: ## Build shared packages so workspace imports resolve at runtime
	pnpm -r --filter './packages/*' run build

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

rabbitmq-provision: ## Declare the RabbitMQ topology (super streams + retry/DLQ queues). Idempotent; required before any service starts.
	pnpm rabbitmq:provision

rabbitmq-plan: ## Print the RabbitMQ topology that would be declared, without touching the broker
	pnpm rabbitmq:provision:dry-run

clean: ## Remove built artefacts (per-package "clean" scripts)
	pnpm clean
