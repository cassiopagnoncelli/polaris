# P6-001: Control-Plane CLI Shell

Status: Backlog

## Goal

Create the `polaris` CLI shell with command structure, shared config, logger, database connection setup, and stable output conventions.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Codex Instructions](../../instructions/codex.md)

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
Commands run:
Checks passed:
Known gaps:
```

