# P0-002: TypeScript Tooling Baseline

Status: Backlog

## Goal

Add strict TypeScript, Biome, and Vitest baseline configuration for the monorepo.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-001.

## Write Scope

Allowed:

```text
package.json
tsconfig.json
tsconfig.base.json
biome.json
vitest.config.*
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
infra/
sql/
```

## Implementation Notes

- TypeScript must be strict.
- Prefer ESM-first settings.
- Use Biome for formatting/linting.
- Use Vitest for tests.
- Do not add ESLint.
- Do not introduce Turborepo or Nx.

## Acceptance Criteria

- [ ] Strict TypeScript config exists.
- [ ] Biome config exists.
- [ ] Vitest config exists.
- [ ] Root scripts expose typecheck, lint/format check, test, and build placeholders as appropriate.
- [ ] No application code is added.

## Checks

Run where possible:

```text
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Handoff

```text
Files changed:
- package.json (modified): added strict-TS / Biome / Vitest tooling. Adds devDependencies @biomejs/biome@2.4.15, @types/node@22.19.19, @vitest/coverage-v8@4.1.6, typescript@6.0.3, vitest@4.1.6. Replaces placeholder pnpm-recursive scripts with root tooling that exercises the actual configs while still recursing into packages when they exist:
    - typecheck: `tsc -p tsconfig.json --noEmit && pnpm -r --if-present run typecheck`
    - lint: `biome lint .`  (+ `lint:fix`)
    - format / format:check: `biome format --write .` / `biome format .`
    - check / check:fix: combined biome lint+format
    - test / test:watch / test:coverage: vitest with `--passWithNoTests` so the v1 monorepo passes before any packages exist
    - build, clean: still `pnpm -r --if-present run ...` (P0-001's pattern), to be filled in by per-package builds.
- tsconfig.base.json (new): strict TypeScript baseline for all future packages. ESM-first (`module`/`moduleResolution` = `NodeNext`), `target` ES2023, `verbatimModuleSyntax`, `isolatedModules`, `declaration` + `declarationMap` + `sourceMap` on, `noEmit` deliberately omitted so packages can extend and emit. Every strictness flag turned on, including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `noUnusedLocals`/`noUnusedParameters`. `skipLibCheck` is on so third-party type drift does not block CI.
- tsconfig.json (new): thin root config that extends `tsconfig.base.json`, sets `noEmit: true`, `incremental: false`, and includes only root tooling files (`vitest.config.ts`) so `pnpm typecheck` at the root only validates root configuration. Workspace packages will own their own `tsconfig.json` extending the base. Excludes apps/packages/processors/consumers so this config never claims package code.
- biome.json (new): Biome 2.4.15 schema-locked. VCS integration on (respects .gitignore). Formatter: 2-space, LF, line width 100. JS: double quotes, semicolons, trailing commas everywhere, parens around arrow params. JSON: no trailing commas. Linter: `recommended` rules plus a few project-specific tightenings (`useImportType`, `useExportType`, `useNodejsImportProtocol`, `noUnusedImports`/`noUnusedVariables` as errors; `noNonNullAssertion` and `noExplicitAny` as warnings; `noConsole` off so service bootstrap can log to stdout). Excludes node_modules, dist, build, coverage, .turbo, min.js, pnpm-lock.yaml.
- vitest.config.ts (new): Vitest config for the monorepo. `environment: "node"`, no `globals`, `include` covers `apps`, `packages`, `processors`, `consumers` test/spec files. Coverage uses the v8 provider with text/html/lcov reporters and a `src/`-scoped include list. Excludes node_modules/dist/build/coverage. `passWithNoTests` is set via the CLI flag in `package.json` rather than in this file so it stays explicit at the script level.
- pnpm-lock.yaml (new, side effect of `pnpm install`): records resolved versions for the five new devDependencies (69 packages added).

Commands run:
- pnpm install                  -> exit 0 (devDependencies installed, lockfile generated)
- pnpm typecheck                -> exit 0 (`tsc -p tsconfig.json --noEmit` succeeds; `pnpm -r --if-present` is a no-op because no workspace packages exist yet)
- pnpm lint                     -> exit 0 (Biome lint: "Checked 5 files. No fixes applied.")
- pnpm format:check             -> exit 0 (Biome format: "Checked 5 files. No fixes applied.")
- pnpm check                    -> exit 0 (combined Biome lint + format)
- pnpm test                     -> exit 0 ("No test files found, exiting with code 0" via `--passWithNoTests`)
- pnpm build                    -> exit 0 (still a `pnpm -r --if-present` placeholder; no packages to build)
- pnpm exec biome --version     -> 2.4.15 (config "Loaded successfully" per `biome rage`)
- node --version                -> v22.14.0 (Active LTS, matches `engines.node >= 22`)
- pnpm --version                -> 10.30.0 (matches `packageManager` pin)

Checks passed:
- All four checks listed in the task card (`pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`) plus the implied `pnpm format:check` from the engineering standards. All exit 0.

Known gaps:
- No `apps/`, `packages/`, `processors/`, or `consumers/` content exists yet (intentional; out of scope for P0-002, forbidden by write scope). Per-package `tsconfig.json` files extending `tsconfig.base.json` and per-package `package.json` scripts will be created by P0-003+ as those packages land.
- `pnpm -r --if-present run typecheck` / `build` / `clean` currently no-op with "No projects matched the filters" — this is expected and will start exercising real package scripts once P0-003 onward add packages.
- `pnpm test` uses `--passWithNoTests`; this should be revisited once the first real test suite lands (P0-003 / P0-006). The flag stays in `package.json` rather than `vitest.config.ts` so it remains visible at the script level.
- `.gitignore` was not extended (out of scope). It currently only excludes `resources/maxmind`. `node_modules/`, `pnpm-lock.yaml` resolution noise, `dist/`, `coverage/`, and `*.tsbuildinfo` are not yet ignored at the repo level; the root `tsconfig.json` sets `incremental: false` to avoid producing a `tsconfig.tsbuildinfo` at the root for now. A future workspace-skeleton refinement task (or P11-002 CI) should add a proper `.gitignore`.
- No CI workflow yet — P11-002 owns wiring `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm test` into CI quality gates.
- The task card's `Checks` block lists `pnpm lint` but not `pnpm format:check`. Both are exposed as root scripts; the engineering standards require formatting checks in CI, so both are wired now.
```
