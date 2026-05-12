# Polaris monorepo task entrypoints.
#
# Thin wrapper around pnpm and docker compose. The pnpm workspace
# (see package.json) is the source of truth; targets here exist so the common
# workflows show up in `make help` and so per-package commands have stable
# repo-root aliases.

.DEFAULT_GOAL := help

.PHONY: help setup install lint style format check typecheck dev build \
        test tests ci stats up down ps logs cli clean nuke \
        db-migrate db-rollback db-status

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
	@awk 'BEGIN {FS = ":.*## "}; /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: install up db-migrate ## Bootstrap a local environment (install + containers up + migrations)

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

dev: ## Run per-package "dev" scripts bare metal
	pnpm -r --if-present run dev

build: ## Build all workspace packages
	pnpm build

test: ## Run the Vitest suite
	pnpm test

tests: test ## Alias for test

ci: lint typecheck test ## Run the CI flow: lint, typecheck, tests

stats: ## Show project LOC (current tree + historical churn)
	@current_loc=$$(find $(LOC_DIRS) $(LOC_PRUNE) -o -type f $(LOC_FIND_TYPES) -print0 2>/dev/null | xargs -0 cat 2>/dev/null | wc -l | tr -d ' ') && \
	printf "LOC\n  Current: %s\n" "$$current_loc"
	@historical_loc=$$(git log --numstat --format=tformat: -- $(LOC_GIT_PATHS) | \
		awk '($$1 ~ /^[0-9]+$$/ && $$2 ~ /^[0-9]+$$/) { total += $$1 + $$2 } END { print total + 0 }') && \
	printf "  Historical: %s\n" "$$historical_loc"

up: ## Start the local stack with docker compose (daemonised, waits for health)
	docker compose up -d --wait

down: ## Stop the docker compose stack (preserves named volumes)
	docker compose down

ps: ## Show docker compose service status
	docker compose ps

logs: ## Tail docker compose logs (Ctrl-C to exit)
	docker compose logs -f

nuke: ## Stop docker compose and wipe named volumes (destructive)
	docker compose down -v

cli: ## Open the polaris CLI console (apps/polaris-cli)
	pnpm --filter @polaris/polaris-cli run start

db-migrate: ## Apply pending PostgreSQL migrations (dbmate up)
	pnpm db:migrate

db-rollback: ## Roll back the most recent PostgreSQL migration
	pnpm db:rollback

db-status: ## Show PostgreSQL migration status
	pnpm db:status

clean: ## Remove built artefacts (per-package "clean" scripts)
	pnpm clean
