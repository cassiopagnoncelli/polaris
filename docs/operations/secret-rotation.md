# Secret Rotation Runbook

Operators use this runbook to rotate a credential stored in HashiCorp
Vault for a Polaris destination, source, or other Vault-backed
reference. The v1 procedure is intentionally low-magic: change the
value in Vault, restart the consuming service(s), verify.

Binding architecture references:

- [Control Plane — Secrets](../architecture/02-control-plane.md)
- [Production Readiness — Secret Management](../architecture/11-production-readiness.md)
- [Vault Deployment Guide](../deployment/secret-provider-vault.md)

Implementation:

- [`packages/shared-secrets/src/providers/vault.ts`](../../packages/shared-secrets/src/providers/vault.ts)
- [`packages/shared-secrets/src/providers/vault-cache.ts`](../../packages/shared-secrets/src/providers/vault-cache.ts)

## When to use this runbook

- Routine rotation (scheduled credential refresh).
- Emergency rotation (suspected leak; vendor revocation).
- Vendor-side credential expiry that forces a re-provision.
- Compromised pod / node where caching window must be cut short.

This runbook does NOT cover:

- Issuing new Polaris API keys / operator tokens (see the lifecycle
  CLI; those are hashed in PostgreSQL, not stored in Vault).
- Vault root-token rotation (Vault operations procedure, not
  Polaris-specific).
- Migrating a project between two Vault paths (use the destination
  update CLI to rewrite `secret_ref` *after* this runbook lands the
  new value at the new path).

## What you'll need

- `vault` CLI configured against the production Vault cluster, with a
  policy that allows `update` on
  `secret/data/polaris/<environment>/<project>/<name>`.
- `kubectl` access to the cluster running the consuming service
  (typically `polaris-production` or `polaris-staging` namespace).
- The Polaris CLI (`polaris`) configured with an operator token if
  you intend to use `polaris destinations show` to verify wiring.
- The Polaris `secret_ref` for the credential being rotated. Find it
  with `polaris destinations show <destination_id>` (look at
  `secret_ref`; it will be in the form
  `vault:polaris/<env>/<project>/<name>`).

## Procedure

### 1. Update the value in Vault

The Polaris convention stores the secret under the `value` key of the
KV v2 entry. Use `vault kv put` for that exact key — do not change
the layout (no extra fields, no rename) or the adapter will throw
`SecretNotFoundError` even though the path exists.

```bash
vault kv put \
  secret/polaris/production/storefront/meta-capi \
  value="<new-credential-value>"
```

Vault automatically versions the new value. The previous version is
retained per the KV v2 retention policy on the mount; check it with
`vault kv metadata get secret/polaris/production/storefront/meta-capi`.

### 2. Identify which services cache this secret

The adapter caches resolved secrets in-process per service replica.
The cache TTL defaults to 5 minutes
(`POLARIS_VAULT_CACHE_TTL_MS=300000`). The list of services that may
hold a cached copy depends on the credential:

| Credential class | Caching services |
| --- | --- |
| Destination credentials (Meta CAPI, GA4, ...) | the destination runtime consumer(s) for that vendor |
| Identity-vendor API keys | the identity resolver service |
| Internal service-to-service auth | every service that consumes the credential |

When in doubt, treat *all* destination-runtime replicas as caching
candidates. The control-plane API and ingester do not currently
resolve Vault secrets per request — they read them only at startup —
so a restart of the destination runtime is usually enough.

### 3. Flush the cache (rolling restart)

Polaris does not expose a CLI command to flush the in-process cache
remotely. The v1 answer is a **rolling restart** of the consuming
replicas:

```bash
kubectl -n polaris-production rollout restart \
  deployment/polaris-destination-runtime

# Wait for the rollout to complete.
kubectl -n polaris-production rollout status \
  deployment/polaris-destination-runtime --timeout=5m
```

A rolling restart guarantees every replica re-authenticates to Vault
and fetches the new value on its first secret resolution. The cache
is process-local and not shared across replicas, so no replica can
hold a stale value past its restart.

If you prefer to wait instead of restarting (e.g. routine rotation
with no urgency), the adapter will pick up the new value on its next
cache miss — within `POLARIS_VAULT_CACHE_TTL_MS` of the rotation
(default 5 minutes). This is acceptable for non-emergency rotations
where the previous value also remains valid at the vendor.

**Do not** reach for a clever flush API: there isn't one. The
operator-trust contract here is "rolling restart drops every cached
secret"; we deliberately did not ship a remote flush endpoint because
the rotation use case maps cleanly onto a routine deployment
primitive and an extra API surface invites accidental denial of
service.

### 4. Verify rotation took effect

There are three independent ways to confirm the new value is live.
Run at least one; production-impact rotations should run all three.

**(a) Re-read from Vault via the CLI**

Confirms the new value is the one Vault returns. Does **not** prove
the consuming service has picked it up, but rules out "I edited the
wrong path":

```bash
vault kv get secret/polaris/production/storefront/meta-capi
# data should show the new value under key `value`
```

**(b) Re-send through the destination**

The strongest signal: trigger a small delivery and verify it
succeeds with the new credential. For destinations:

```bash
# Replay one recent envelope to the destination.
polaris dlq retry <some-dlq-id-or-recent-envelope> --note "post-rotation verify"
# Then check the delivery_records entry for the new attempt:
polaris deliveries list <destination_id> --limit 1
```

The new attempt should land as `status='accepted'`. If it lands
`failed_*`, check the error class:

- `auth` failure → the new value did not propagate; check that the
  rolling restart completed.
- `mapped_failed` / `permanent` → unrelated; the rotation took
  effect but the vendor rejected the payload for other reasons.

**(c) Check the Vault audit log**

Run a tail of the Vault audit log scoped to the secret path. After
the rolling restart, you should see one `read` entry per replica
(typically 2-3 per service), all using the new role token:

```bash
vault audit log | grep '/secret/data/polaris/production/storefront/meta-capi' | tail -5
```

The audit log redacts the response payload by default; you'll see
the access pattern, not the value.

### 5. Update Polaris audit context

Mutating CLI commands that touch destinations / sources are audited
automatically. Rotation itself happens in Vault, not in the Polaris
control plane, so it does **not** land an `audit_records` row. If
your operations policy requires a Polaris-side record:

```bash
polaris audit log-event \
  --action="secret.rotated" \
  --target-type=destination \
  --target-id=<destination_id> \
  --note="rotated meta-capi token; vault version $(vault kv metadata get \
    -format=json secret/polaris/production/storefront/meta-capi | jq .data.current_version)"
```

(That command shape lands when the audit CLI is fully wired; today,
the closest equivalent is a `polaris destinations show` snapshot
followed by a manual incident-log entry.)

### 6. Emergency rotation: shorter cache TTL

For credentials that **must** propagate within seconds (compromised
key, vendor-issued revocation), the rolling restart in step 3 is the
authoritative procedure. The cache TTL is a knob, not a sync
primitive — do not rely on it for emergency timing.

If you anticipate frequent emergency rotations for a specific
service, set `POLARIS_VAULT_CACHE_TTL_MS` to a lower value (e.g.
30 000 ms) for that service. The tradeoff is more Vault traffic on
the hot path; see the [Vault deployment
guide](../deployment/secret-provider-vault.md) for the read-rate
implications.

## How long a rotation takes to land

One cache stands between a rotated Vault value and a running replica: the
Vault adapter's own in-memory cache, `POLARIS_VAULT_CACHE_TTL_MS`, default
5 minutes. The procedure above accounts for it.

A failure to reach Vault mid-rotation is **not** a data-loss event. A provider
that cannot be reached now classifies transient, so the delivery retries and
only dead-letters if the outage outlasts the destination's
`dead_letter_threshold`. Before that split, a brief Vault blip permanently
dead-lettered deliveries and each one needed a manual replay — if you are
working from memory of that behaviour, it no longer applies.

> **Coming with the per-service configuration cutovers.** When a service moves
> onto `@polaris/shared-project-config`, resolved secrets are additionally
> cached in that service's config snapshot, on its own 5-minute deadline —
> version-based invalidation cannot see a rotation, because the stored
> reference does not change. At that point this runbook gains a second wait,
> and `polaris config invalidate --project <id> --env <env> --reason <text>`
> becomes the way to force the drop immediately. No destination consumer
> reads configuration that way yet, so today the Vault TTL above is the whole
> story.

## Failure modes

| Symptom | Likely cause | Remedy |
| --- | --- | --- |
| `SecretNotFoundError` after rotation | Wrote to wrong Vault path, or stored under a key other than `value` | Re-check the `secret_ref` and the KV layout; `vault kv get` the path |
| `SecretProviderError: vault authentication failed` after rotation | Vault role binding rejected the SA JWT; or the SA was rotated/renamed | Re-run `vault write auth/kubernetes/role/...` with the current SA name; the [deployment guide](../deployment/secret-provider-vault.md) has the canonical HCL |
| Deliveries retrying with `error_class = transient` during a Vault outage | Expected. A provider that cannot be reached is a transient failure, so the delivery retries rather than dead-lettering | Restore Vault. Nothing to replay — these reach the DLQ only if the outage outlasts the destination's `dead_letter_threshold` |
| Delivery fails with vendor-side `auth` error after step 3 | The new value is wrong at the vendor; or the rotation crossed the vendor's grace window | Re-issue the credential at the vendor; rotate again |
| Replicas show `degraded` health for > 2 cache TTLs | Vault unreachable from the cluster | Check Vault availability; the adapter is serving stale cache, so traffic is unaffected until cache entries expire |
| One replica keeps using the old value after restart | The rolling restart did not actually replace the pod (stuck terminating, sidecar holding it) | `kubectl delete pod <name>` on the holdout; never `kubectl exec` to "reload" — there is no reload |

## See also

- [Vault Deployment Guide](../deployment/secret-provider-vault.md) —
  full wiring, role HCL, token lifecycle.
- [Destination DLQ Triage Runbook](destination-dlq-triage.md) — what
  to do when a failed delivery suggests a credential issue.
- [`packages/shared-secrets/test/vault-provider.test.ts`](../../packages/shared-secrets/test/vault-provider.test.ts)
  — the no-secret-in-errors test asserts the operator-trust contract
  this runbook depends on.
