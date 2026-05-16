# Vault Secret Provider — Production Deployment Guide

This guide covers wiring Polaris services to HashiCorp Vault as the
production secret provider. Local/dev keeps the `env` provider; nothing
in this document is required to develop on Polaris.

Binding architecture references:

- [Control Plane — Secrets](../architecture/02-control-plane.md)
- [Production Readiness — Secret Management](../architecture/11-production-readiness.md)
- [Destinations](../architecture/06-destinations.md) (heaviest secret consumer)

Implementation:

- [`packages/shared-secrets/src/providers/vault.ts`](../../packages/shared-secrets/src/providers/vault.ts) — adapter
- [`packages/shared-secrets/src/providers/vault-token-manager.ts`](../../packages/shared-secrets/src/providers/vault-token-manager.ts) — K8s auth + token lifecycle
- [`packages/shared-secrets/src/providers/vault-cache.ts`](../../packages/shared-secrets/src/providers/vault-cache.ts) — in-memory TTL cache
- [`packages/shared-config/src/schemas/secret-provider.ts`](../../packages/shared-config/src/schemas/secret-provider.ts) — env schema

## What lives where

Polaris stores `(secret_provider, secret_ref)` pairs in PostgreSQL.
PostgreSQL never holds plaintext secrets; repo files never hold
plaintext secrets. The Vault adapter is the bridge between the
reference and the value.

```text
PostgreSQL                           Vault KV v2
-----------                          -------------------------------
secret_provider = "vault"            secret/data/polaris/<env>/<project>/<name>
secret_ref      = "polaris/prod/      └─ data: { "value": "<plaintext>" }
                   storefront/
                   meta-capi"
```

The adapter expects the secret value at the `value` key of the KV v2
entry. That matches what `vault kv put <path> value=<token>` produces;
any other layout requires changing
[`extractKvValue`](../../packages/shared-secrets/src/providers/vault.ts) in
the adapter, which is a deliberate cliff to keep deployments uniform.

## Provider switch

Each service decides its provider at boot via env vars consumed by the
[`secretProviderEnvSchema`](../../packages/shared-config/src/schemas/secret-provider.ts).

```text
POLARIS_SECRET_PROVIDER=vault                # required to switch from env
POLARIS_VAULT_ADDRESS=https://vault.svc:8200 # required, no trailing slash
POLARIS_VAULT_ROLE=polaris-production        # required
POLARIS_VAULT_KV_MOUNT=secret                # default
POLARIS_VAULT_K8S_AUTH_MOUNT=kubernetes      # default
POLARIS_VAULT_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token  # default
POLARIS_VAULT_CACHE_TTL_MS=300000            # 5 min default
```

When `POLARIS_SECRET_PROVIDER=vault`, the address and role are
**required** — the schema fails fast at startup so a misconfigured
deployment never boots into a half-working state. The kubelet rotates
the JWT at `POLARIS_VAULT_TOKEN_PATH` on its own schedule; the adapter
re-reads it on every Vault auth call, so a stale in-memory copy never
ages.

Local/dev keeps the env provider — `POLARIS_SECRET_PROVIDER=env` (or
omit; `env` is the default). The CLI and developer workflows never
require a running Vault instance.

## Secret reference shape

The canonical Polaris secret-ref is:

```text
polaris/<environment>/<project_id>/<secret_name>
```

- `<environment>` is the deployment environment (`production`,
  `staging`, `development`).
- `<project_id>` is the Polaris project slug (matches the
  `projects.id` column).
- `<secret_name>` is a short, descriptive name. Use ASCII letters,
  digits, hyphens, and underscores. No slashes inside this segment.

The adapter URL-encodes each segment individually, preserving the
inter-segment slashes. References containing whitespace or control
characters are rejected at the
[parser](../../packages/shared-secrets/src/reference.ts) layer before
ever reaching the adapter.

Examples:

```text
polaris/production/storefront/meta-capi
polaris/production/storefront/google-ads
polaris/staging/internal-analytics/ga4
```

These map to Vault paths under the configured KV mount. With the
default `kvMount=secret`:

```text
secret/data/polaris/production/storefront/meta-capi
secret/data/polaris/production/storefront/google-ads
```

To use a non-default mount (org convention, separate Vault namespaces),
set `POLARIS_VAULT_KV_MOUNT` accordingly. The adapter never crosses
mounts: every secret a Polaris service reads must live under the one
configured mount.

## Vault Kubernetes auth setup

Polaris services authenticate to Vault using the Kubernetes auth
method. The pod's service-account JWT is exchanged for a short-lived
Vault client token, which the adapter renews / re-auths
transparently.

Operator setup (one-time, per Vault cluster + environment):

```hcl
# 1. Enable the kubernetes auth method (if not already).
vault auth enable -path=kubernetes kubernetes

# 2. Configure it to verify SA JWTs against the cluster's TokenReview API.
#    (`kubernetes_host` reachable from Vault; CA cert + reviewer JWT supplied.)
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc" \
  kubernetes_ca_cert=@/path/to/ca.crt \
  token_reviewer_jwt=@/path/to/reviewer-jwt

# 3. Define a Polaris policy for the environment.
cat <<'EOF' | vault policy write polaris-production -
path "secret/data/polaris/production/*" {
  capabilities = ["read"]
}
path "secret/metadata/polaris/production/*" {
  capabilities = ["read"]
}
EOF

# 4. Bind a Vault role to the Polaris service accounts in the cluster.
vault write auth/kubernetes/role/polaris-production \
  bound_service_account_names="polaris-ingester-api,polaris-control-plane-api,polaris-destination-runtime" \
  bound_service_account_namespaces="polaris-production" \
  policies="polaris-production" \
  token_ttl="1h" \
  token_max_ttl="24h"
```

The role name (`polaris-production` above) is the value supplied via
`POLARIS_VAULT_ROLE`. Match the convention `polaris-<environment>` so
the same wiring rebuilds cleanly for staging and any future
environments. Token TTLs are operator-tunable: shorter means more
Vault traffic, longer means the cached token survives Vault blips
longer. The default in-process cache TTL (5 min) is independent of the
Vault token TTL; the two windows interact only via the degraded-health
path below.

### Vault Agent sidecar variant (DCJXEFE5)

The adapter also supports the Vault Agent sidecar pattern. A
co-located `vault agent` container runs alongside the Polaris
service, exchanges the pod's SA JWT for a Vault client token, renews
the lease on its own schedule, and writes the current token to a file
on a shared `emptyDir` volume. The Polaris service reads the token
from that file. It never sees the SA JWT and never calls
`auth/.../login` itself.

Activate via the `auth: "agent"` option on `createVaultProvider`
(forwarded through the standard service config under
`POLARIS_VAULT_AUTH=agent`). Default token-sink path is
`/vault/secrets/token`; override with `agentTokenPath` /
`POLARIS_VAULT_AGENT_TOKEN_PATH`. The default in-memory re-read
interval is 30 seconds — long enough to avoid filesystem thrash,
short enough that an Agent-driven rotation is picked up well inside
one cache cycle of a typical 1-minute lease window.

Trade-offs:

| Axis | Direct K8s auth (default) | Agent sidecar |
|---|---|---|
| **K8s RBAC surface** | Each Polaris service-account is bound to a Vault auth-role | Only the Agent's service-account is bound; Polaris pods carry no auth-role binding |
| **Container count** | 1 (Polaris only) | 2 (Polaris + Agent) per pod |
| **Lease management** | Polaris adapter renews inline | Agent renews on its own schedule |
| **Failure modes** | Token store collapsed to the in-process VaultTokenManager | Agent process can crash independently; pod-level readiness probe should include the Agent's `/v1/sys/health` mirror or the sink-file mtime |
| **Sample wiring** | See the Kubernetes manifest snippet above | A `vault agent` container with `auto_auth.method.kubernetes` + `sink.file` pointing at the shared volume |

Operators picking direct K8s auth keep moving parts to a minimum;
operators picking the Agent variant get a simpler authz policy at the
cost of a sidecar per pod.

## Bounded transient-retry inside the adapter (DCJXEFE5)

Both auth variants share the same bounded-retry envelope around
the KV read. Connection failures, `429`, and `5xx` responses retry up
to `maxAttempts` (default `3`) with exponential backoff that doubles
from `initialBackoffMs` (default `100 ms`) capped at `maxBackoffMs`
(default `500 ms`). Terminal statuses (`2xx`, `403`, `404`) never
retry — `404` propagates as `SecretNotFoundError`; `403` flips into
the inline re-auth path documented above.

After exhaustion, the adapter falls through to the same stale-cache
fallback that the no-retry path has used since P11-004: if a previous
read of the same ref exists in cache, the adapter returns it and the
readiness probe flips to `degraded`. This preserves end-to-end
delivery across short Vault blips while operators see the condition
on the probe.

The defaults (3 attempts, 100→200ms backoff) keep the worst-case
wait at roughly 300 ms before falling back — bounded enough that the
calling delivery does not look hung. Override via `maxAttempts` /
`initialBackoffMs` / `maxBackoffMs` on `createVaultProvider`.

## In-process cache + degraded health

The Vault adapter caches resolved secrets in-memory per service
instance. Default TTL is 5 minutes (300 000 ms). Override via
`POLARIS_VAULT_CACHE_TTL_MS`.

Behavior:

- **Fresh cache hit** — the adapter returns the cached value with
  zero Vault traffic.
- **Cache miss / expired entry** — the adapter authenticates (or
  reuses a valid Vault token) and reads from KV v2.
- **Vault unreachable while a cached value still exists** — the
  adapter returns the *stale* cached value and marks the readiness
  probe as `degraded`. The service keeps serving destination traffic
  on previously-fetched credentials until they age out of operator
  patience or Vault returns. **This is intentional**: a Vault blip
  does not crash the destination pipeline.
- **Vault unreachable and no cached value** — `SecretProviderError`
  bubbles up; the dependent code path (e.g. a destination delivery
  attempt) fails closed.

The readiness probe surface lives on the provider:

```ts
const provider = createVaultProvider({ ... });
const result = provider.probe();
// { status: "up" | "degraded" | "down", lastSuccessAt?, lastFailureAt? }
```

Wire it into the service's
[`registerHealthRoutes`](../../packages/shared-service-bootstrap/src/bootstrap/health.ts)
probe list. Example:

```ts
const vaultProbe: ReadinessProbe = async () => {
  const r = provider.probe();
  return { name: "vault", status: r.status, ...(r.detail ? { detail: r.detail } : {}) };
};
```

When the probe reports `degraded` for sustained periods (operator
alert threshold: > 2 cache TTLs), on-call investigates the Vault
outage. When the probe reports `down` and the service is in the hot
delivery path, the request will fail; load-balancer readiness routes
traffic away until Vault returns.

## Token / lease lifecycle

`VaultTokenManager` (internal) owns the token state:

1. On first `getSecret`, the manager reads the SA JWT and POSTs to
   `auth/<kubernetesAuthMount>/login`. Vault returns a client token
   and a lease window (`token_ttl` from the role above).
2. The token is reused for every subsequent KV read while the
   remaining lease is more than 25% of the original window.
3. When the remaining lease drops below the 25% threshold, the
   manager POSTs to `auth/token/renew-self` to extend the lease in
   place. Renewal uses the existing token; it does **not** re-read
   the SA JWT.
4. If renewal returns `403` (Vault revoked the lease, the
   max-ttl was reached, etc.) the manager falls back to a full
   re-auth: read the SA JWT, exchange it for a fresh token.
5. If a KV read itself returns `403` (token invalidated
   out-of-band), the adapter invalidates the cached token and
   retries the read once with a fresh one. A persistent `403` after
   re-auth surfaces as `SecretProviderError`.

The manager never logs or echoes the SA JWT or the Vault token. The
no-leak property is unit-tested in
[`vault-token-manager.test.ts`](../../packages/shared-secrets/test/vault-token-manager.test.ts)
and [`vault-provider.test.ts`](../../packages/shared-secrets/test/vault-provider.test.ts).

## Logging and error redaction

Resolved secret values must never appear in:

- logs (any level)
- audit records
- DLQ payloads
- delivery records
- exports / dumps
- thrown error messages or stacks

The adapter enforces this from its end:

- `SecretProviderError` messages name the provider and ref but never
  embed the resolved value.
- The `cause` chain is preserved for diagnostics, but the adapter
  discards HTTP response bodies that could echo the value when
  wrapping (Vault doesn't typically echo, but defence in depth).
- A "Vault returned malformed JSON" failure surfaces as a generic
  `"vault response was not valid JSON"` message — the raw response
  text is not propagated through the error chain.

Callers (destination runtime, control-plane API, etc.) must follow
the same rule: hand the resolved value to the consuming subsystem
and discard the reference. Do not log it, do not surface it in error
output, do not stash it in audit context.

## Rotation

See [`docs/operations/secret-rotation.md`](../operations/secret-rotation.md)
for the operator runbook (rotating a secret value in Vault, flushing
the in-process cache across services, verifying rotation took effect).

## Extending the provider interface

The provider interface in
[`@polaris/shared-secrets`](../../packages/shared-secrets/) is open by
design. Reserved slots in the `SecretProvider` enum (currently
`aws-secrets-manager`, `gcp-secret-manager`, `azure-keyvault`) accept
references in PostgreSQL on day one. Until an adapter is registered
with the `SecretResolver`, references to those slots throw
`SecretProviderNotConfiguredError` rather than silently failing.

To add a new adapter:

1. Implement `class XxxSecretProvider implements SecretProviderAdapter`
   following the structure of
   [`vault.ts`](../../packages/shared-secrets/src/providers/vault.ts):
   cache + TTL, health probe, no-secret-in-errors guarantee,
   stale-cache degraded path.
2. Extend
   [`secretProviderEnvSchema`](../../packages/shared-config/src/schemas/secret-provider.ts)
   with the adapter's runtime knobs.
3. Add unit tests, including the no-leak assertion.
4. Land a sibling deployment guide here
   (e.g. `secret-provider-aws-secrets-manager.md`).

A reserved placeholder for AWS Secrets Manager sits at
[`packages/shared-secrets/src/providers/aws-secrets-manager.ts`](../../packages/shared-secrets/src/providers/aws-secrets-manager.ts)
with no implementation; it documents the extension contract inline.

## Known limits

- **No CLI flush command.** Operators rotate by changing the value in
  Vault and rolling the service replicas; the in-process cache is
  per-replica, so a rolling restart drops every cached entry.
  See the rotation runbook for the exact procedure.
- **Single KV mount per service.** A service cannot read from
  multiple KV mounts simultaneously without re-instantiating the
  provider, which is intentional: cross-mount reads conflate
  audit trails and complicate the role binding.
