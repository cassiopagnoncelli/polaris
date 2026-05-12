# P11-004: Production Secret Provider Adapter (Vault)

Status: Backlog

## Goal

Implement the HashiCorp Vault adapter for the production secret provider interface. Local/dev continues to use the `env` provider; the provider interface stays open so a cloud-native adapter can land later if needed.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Destinations](../../architecture/06-destinations.md)

## Dependencies

- P0-008
- P11-003

## Write Scope

Allowed:

```text
packages/shared-secrets/
docs/deployment/
docs/operations/
```

Forbidden:

```text
plaintext secrets
destination mapping semantics
```

## Implementation Notes

- **Production provider: HashiCorp Vault.** Self-hosted Vault is the v1 target. HCP Vault (managed) is operationally compatible — same API surface.
- **Authentication to Vault:** services use Kubernetes auth method (`vault-kubernetes` plugin) in production. Local/dev never connects to Vault.
- **Path convention:** `secret/data/polaris/<environment>/<project_id>/<secret_name>` for KV v2, or equivalent under a different mount when the org has Vault path conventions of its own. Document the chosen layout in `docs/deployment/`.
- **Secret reference shape:** `secret_provider = "vault"`, `secret_ref = "polaris/<environment>/<project_id>/<name>"` (path relative to the mount).
- **Provider interface** stays open: `getSecret(ref) -> Promise<string>` is the only method each adapter implements. Adapters: `env`, `vault`. New adapters (`aws-secrets-manager`, `gcp-secret-manager`, `azure-keyvault`) can land later without touching call sites.
- **Caching:** Vault responses are cached in-memory per service for a TTL (suggested default: 5 minutes) to avoid hammering Vault on every event. Cache invalidation on rotation is operator-driven (restart the service or expose a CLI command).
- **Token/lease lifecycle:** services renew their Vault token automatically. Document lease failure behavior — service health goes degraded, not crashed, when Vault is unreachable; cached secrets continue serving until expiry.
- Env provider remains valid for local/dev.
- Secret values must never be logged or exposed in errors.

## Acceptance Criteria

- [ ] Vault adapter exists in `packages/shared-secrets/`.
- [ ] Vault adapter authenticates via Kubernetes auth in production; local/dev does not require Vault.
- [ ] Secret-ref convention is documented in `docs/deployment/`.
- [ ] Cache TTL is configurable; default 5 minutes.
- [ ] Lease failure degrades health but does not crash the service.
- [ ] Tests prove secrets are not exposed in errors, logs, or audit payloads.
- [ ] Deployment docs explain `secret_provider`, `secret_ref`, Vault path convention, and the K8s auth setup.
- [ ] Provider interface remains open: a stubbed `aws-secrets-manager` adapter exists or is documented as "wire when needed."

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

