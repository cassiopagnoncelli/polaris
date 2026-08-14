# Secret Rotation Runbook

Operators use this runbook to replace a credential Polaris holds for a
project: a destination's vendor credential, or a sensitive per-project
configuration value.

Binding architecture references:

- [Control Plane — Secrets](../architecture/02-control-plane.md)
- [Production Readiness — Secret Management](../architecture/11-production-readiness.md)

Implementation:

- [`db/migrations/20260813000004_plaintext_project_secrets.sql`](../../db/migrations/20260813000004_plaintext_project_secrets.sql)
- [`packages/shared-control-plane/src/secret-masking.ts`](../../packages/shared-control-plane/src/secret-masking.ts)
- [`packages/shared-project-config/src/secret-box.ts`](../../packages/shared-project-config/src/secret-box.ts)

## What changed, and why this runbook is now short

This procedure used to be: write the new value into HashiCorp Vault, work
out which services had cached the old one, roll them, then wait out a
five-minute adapter TTL. Polaris stored a `<provider>:<ref>` pointer and
resolved it at the point of use, so a rotation happened somewhere Polaris
could not see and every step existed to make the fleet notice.

Per-project secrets now live in the control-plane database as plaintext.
Rotation is a write to that database, and the write announces itself:
`pg_notify` fires in the same transaction, every replica drops the affected
cache entry within milliseconds, and a jittered sweep catches any replica
that missed the notification. There is no external store to reconcile with,
no adapter cache to wait out, and no restart.

The trade this made is worth restating here, because it is this runbook's
standing context: the database holds live credentials. Access to it — and to
its backups and replicas — is access to every project's vendor accounts.

## When to use this runbook

- Routine rotation (scheduled credential refresh).
- Emergency rotation (suspected leak; vendor revocation).
- Vendor-side credential expiry that forces a re-provision.

This runbook does NOT cover:

- Issuing new Polaris API keys or operator tokens. Those are argon2id
  hashes in PostgreSQL, not recoverable values, and the lifecycle CLI
  (`polaris keys rotate`, `polaris operators create`) owns them.
- App or deployment credentials — the Postgres password, the broker
  password, ClickHouse. Those are read from the process environment at
  bootstrap, before a service can reach any store, and rotating them is a
  deployment change.

## What you'll need

- The Polaris CLI configured with an operator token. Production mutations
  require one; the P6-007 gate refuses `--env production` otherwise.
- The new credential, from the vendor's console.
- The destination id (`polaris destinations list --project <p> --env <e>`)
  or the config key being rotated.

You do NOT need the current value, and cannot get it for a destination:
`secret_value` is write-only through every Polaris surface. That is
deliberate — nothing about this procedure requires reading the credential
you are replacing.

## Procedure — a destination's vendor credential

### 1. Write the new value

```bash
polaris destinations rotate-secret polaris_dst_XXXX --secret-value '{"pixel_id":"123","access_token":"NEW"}' --reason "quarterly rotation"
```

The shape is the vendor's, and each consumer asserts its own:
meta-capi and tiktok want a JSON document, ga4 wants
`{measurement_id, api_secret}`, webhook-sink wants a URL or
`{url, signing_key}`. Polaris only requires it to be non-empty.

`--reason` is required and is the whole audit story. The `audit_records`
row names who rotated what and when, with matching `before`/`after`
snapshots — the one field that changed is the one field an audit log may
not hold.

Note the credential passes through argv and lands in shell history. For a
rotation prompted by a leak, clear that entry afterwards.

### 2. Verify it took effect

The destination instance cache holds rows for 60s, so the new credential
is live within one TTL window without any restart. Confirm with traffic
rather than by reading the value back:

```bash
polaris deliveries list --destination polaris_dst_XXXX --limit 5
```

A successful rotation shows `accepted` rows after the rotation timestamp.
A wrong credential shows `failed_permanent` with `error_class=auth` — the
vendor's 401, reported by the deliverer.

### 3. Revoke the old credential at the vendor

Polaris no longer holds it, but the vendor still honours it. Revoke it in
the vendor console. For an emergency rotation this step is the one that
actually closes the exposure.

## Procedure — a per-project configuration secret

```bash
polaris config set --project storefront --env production --namespace meta-capi --key access_token --value 'NEW' --secret --reason "rotating leaked value"
```

`--secret` marks the value sensitive: masked in `config list`/`config get`,
`[redacted]` in the audit row, and boxed in `Secret<T>` when a consumer
reads it. A key the component's schema already declares secret gets the flag
whether or not you pass it — the schema decides, and the flag can only add
sensitivity for free-form keys no schema knows about.

Verify:

```bash
polaris config get --project storefront --env production --namespace meta-capi --key access_token --reveal
```

`--reveal` is the only disclosure path, and exists so an operator can
confirm what they stored. Without it the value prints as `[redacted]`.

## How long a rotation takes to land

| Path | Propagation |
| --- | --- |
| `project_config` value | milliseconds — `pg_notify` commits with the write; a lost notification self-heals on the next 10s sweep |
| `destinations.secret_value` | up to 60s — the destination instance cache TTL |

Neither needs a restart. If a replica appears stuck on an old
`project_config` value — a wedged listener, or a value edited with direct
SQL that bypassed the version bump — `polaris config invalidate` forces the
drop.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `failed_permanent`, `error_class=auth` after rotating | Credential wrong, or malformed for the vendor's shape | Re-run `rotate-secret` with the correct value; check the consumer's `parseResolvedSecret` for the expected shape |
| `MaskedSecretWriteError` on a config set | A masked read was submitted back as a write — a pre-filled form, or a script piping `config list` into `config set` | Pass the real value |
| Rotation applied but old value still delivering | Within the 60s destination-cache TTL | Wait one window; if it persists past that, the write did not land — check `polaris audit list --action destinations.rotate-secret` |
| `config set` refused with a mapping-semantics error | The key name resembles a field map | Mapping semantics live in consumer code, never in configuration |

## See also

- [Destination DLQ triage](destination-dlq-triage.md)
- [Runbook — destination API failure](runbook-destination-api-failure.md)
- [Backup and retention](backup-and-retention.md) — the database now holds
  credentials, so its backups are credential material
