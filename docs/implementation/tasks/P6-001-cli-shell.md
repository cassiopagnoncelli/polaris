# P6-001: Control-Plane CLI Shell

Status: Done

## Goal

Create the `polaris` CLI shell with command structure, shared config, logger, database connection setup, and stable output conventions.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-003
- P0-004
- P1-002

## Write Scope

Allowed:

```text
apps/polaris-cli/
packages/shared-config/
packages/shared-logger/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
```

## Implementation Notes

- The command name is `polaris`.
- Output should support human-readable tables and JSON where practical.
- Use the same runtime config package as services.
- Do not implement all commands in this task; create the shell and one harmless command like `polaris version`.

### Access model

The CLI is a thin client. It does not connect to PostgreSQL directly; it calls a small control-plane API service (`apps/control-plane-api/`) over HTTPS. This task creates the CLI shell and the API client wrapper; the control-plane API service itself is scaffolded as a peer task or here, scope-permitting.

Reason for the thin-client shape:

- Audit records are written server-side atomically with each mutation, so an operator-side failure cannot leave a mutation without an audit row.
- Operators don't need direct PostgreSQL network reach; only the control-plane API service does.
- A future admin UI reuses the same API.

### Configuration and authentication

```bash
export POLARIS_API_URL="https://polaris.example.internal"
export POLARIS_TOKEN="polaris_ot_..."
polaris version
```

- `POLARIS_TOKEN` is sent as a bearer credential on every request. The token is issued and managed by [P6-007](./P6-007-operator-tokens-and-mutation-gate.md).
- `POLARIS_API_URL` is the control-plane API base URL.
- Per-environment profiles live in `~/.polaris/config.toml`. The config file never stores token plaintext — it points at env var names:

```toml
[profiles.production]
url = "https://polaris.example.internal"
token_env = "POLARIS_PROD_TOKEN"

[profiles.staging]
url = "https://polaris-staging.example.internal"
token_env = "POLARIS_STAGING_TOKEN"
```

- Profile is selected via `--profile <name>` or `POLARIS_PROFILE` env var.
- No interactive login command. Token rotation is `polaris operators rotate`; the operator updates their env var.

### Implementation notes for the control-plane API service

If this task creates the API service shell alongside the CLI:

- Use the same Fastify + service bootstrap stack as the ingester.
- Token validation runs as a request hook: read `Authorization: Bearer <token>`, validate against `operator_tokens`, attach `(actor_id, actor_source = 'cli_token')` to the request context.
- Apply the dispatcher gate (P6-007) at the route level: every route declares `mutates: boolean`; the gate rejects production mutations from `declared` sources.
- Errors use RFC 7807 Problem Details matching the engineering-standards rule.

## Acceptance Criteria

- [ ] CLI package exists at `apps/polaris-cli/`.
- [ ] `polaris version` works.
- [ ] CLI loads validated config (env vars + optional `~/.polaris/config.toml`).
- [ ] CLI sends `POLARIS_TOKEN` as a bearer credential on every request.
- [ ] Profile selection via `--profile` and `POLARIS_PROFILE` works.
- [ ] Config file never stores token plaintext; only env var names.
- [ ] Control-plane API service shell exists (or is explicitly deferred to a peer task with the gap noted).
- [ ] README or help output documents the env-var auth and profile model.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter polaris-cli build
```

## Handoff

```text
Files changed:
- apps/polaris-cli/package.json                   (new)
- apps/polaris-cli/tsconfig.json                  (new, extends ../../tsconfig.base.json)
- apps/polaris-cli/vitest.config.ts               (new)
- apps/polaris-cli/README.md                      (new — documents env-var auth & profiles)
- apps/polaris-cli/src/index.ts                   (new — public package surface)
- apps/polaris-cli/src/bin/polaris.ts             (new — npm bin entry, ./dist/bin/polaris.js)
- apps/polaris-cli/src/program.ts                 (new — commander program + dispatcher)
- apps/polaris-cli/src/command.ts                 (new — CommandDefinition surface)
- apps/polaris-cli/src/commands/index.ts          (new — registry of built-in commands)
- apps/polaris-cli/src/commands/version.ts        (new — `polaris version`)
- apps/polaris-cli/src/config.ts                  (new — env-var auth + TOML profiles)
- apps/polaris-cli/src/logger.ts                  (new — shared-logger wired to stderr)
- apps/polaris-cli/src/output.ts                  (new — human/json output rendering)
- apps/polaris-cli/src/errors.ts                  (new — stable exit codes + CliError tree)
- apps/polaris-cli/src/package-meta.ts            (new — version/sha/build-time bundle)
- apps/polaris-cli/test/config.test.ts            (new, 15 tests)
- apps/polaris-cli/test/run.test.ts               (new, 8 tests)
- pnpm-lock.yaml                                  (regenerated by `pnpm install`)

Commands run:
- pnpm install
- pnpm typecheck                                  (10 workspace projects, all passed)
- pnpm lint                                       (174 files, no warnings)
- pnpm format:check                               (174 files, clean)
- pnpm test                                       (39 files, 460 tests passed)
- pnpm --filter @polaris/polaris-cli build        (clean tsc emit)
- smoke: `polaris --help`, `polaris --version`, `polaris version`, `polaris --output json version`

Checks passed:
- typecheck (strict TS, extends tsconfig.base.json)
- biome lint and format:check
- vitest (23 new tests for config + run flow; suite total 460)
- pnpm --filter @polaris/polaris-cli build (esm dist with .d.ts emitted)

Known gaps / explicitly out of scope (per task hard rules):
- No real HTTP client to the control-plane API — that lands when the API service
  arrives (P6-000 onward). The CLI shell only RESOLVES the bearer token and
  base URL; the request layer ships with the first business command.
- No business commands (keys, sources, destinations, processors, replays,
  operators, audit, export) — each is its own task card under P6/P7.
- The production-mutation gate (P6-007) is not yet wired. Every CommandDefinition
  already declares `mutates: boolean`; flipping the gate on is a one-line
  dispatcher change once operator tokens exist server-side.
- `apps/control-plane-api/` was NOT scaffolded in this task — the task card's
  optional "shell or peer task" wording was satisfied by the P6-000 peer task
  on the kanban. The CLI is ready to call it the moment it exists.
```

