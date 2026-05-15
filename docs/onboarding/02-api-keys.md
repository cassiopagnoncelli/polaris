# Phase 2 — Create frontend and backend API keys

API keys authenticate producers against the Polaris ingester. Every key is
bound to exactly one `(project_id, environment, source_id, source_type)`
tuple. The ingester stamps `project_id` and `environment` on every event
from the key — producers cannot override them.

The architectural rules and shape live in [Control Plane /
API Keys](../architecture/02-control-plane.md#api-keys). The CLI surface is
in `apps/polaris-cli/src/commands/keys/`.

## Frontend vs backend keys

Polaris models keys by `source_type`. The shape of trust is different:

| Property | **Frontend key (`--type web`)** | **Backend key (`--type backend`)** |
|---|---|---|
| Audience | The browser. Distributed in your shipped JS. | The server. Never leaves your infrastructure. |
| Secrecy | **Publishable.** Not a secret. | **Secret.** Treat like a database password. |
| Defenses | Per-source origin checks, rate limits, schema validation, max batch size, forbidden-field policy, revocation. | All of the above plus secrecy in transit/at rest. |
| Storage | Inline in the page or in a public env var (`PUBLIC_POLARIS_KEY`). | Server env var / secret manager. |
| Use case | `@polaris/web-sdk` from the browser. | `@polaris/node-sdk` from your API, workers, jobs. |

Frontend keys are not secrets in the "if it leaks we revoke" sense — they
are publishable identifiers protected by per-source origin checks and rate
limits at the ingester. Backend keys *are* secrets.

## Who does this

**Operators only.** `polaris keys create` is `mutates: true`, so the
production gate from
[Control Plane](../architecture/02-control-plane.md#operator-identity-and-audit-actor)
requires `POLARIS_TOKEN`. Your team requests the key via your established
operator channel; the operator runs the command and hands you the resulting
token through your secret-sharing channel.

## Step 2.1 — Operator issues the frontend key

```bash
polaris keys create \
  --project your_project \
  --env production \
  --source your-project-web \
  --type web
```

The CLI prints the token **once**:

```text
polaris key issued
  api_key_id  polaris_ak_018f1b9e-7b50-7b12-9a2e-0e2f88d8f551
  project_id  your_project
  environment production
  source_id   your-project-web
  source_type web

Raw token (shown ONCE — store it now; the platform keeps only the hash):
  polaris_ak_018f1b9e-7b50-7b12-9a2e-0e2f88d8f551.<32-byte-base64url-secret>
```

Polaris stores only the **argon2id hash** of the secret (see
`apps/polaris-cli/src/commands/keys/create.ts` and
`@polaris/shared-secrets`). If your team loses the token, the operator must
revoke and reissue — there is no recovery.

## Step 2.2 — Operator issues the backend key

```bash
polaris keys create \
  --project your_project \
  --env production \
  --source your-project-api \
  --type backend
```

Same flow, different `--source` and `--type`. The token shape on the wire is
identical (`<api_key_id>.<secret>`); only the `source_type` differs in the
ingester's metadata.

## Step 2.3 — Team stores the keys

- **Frontend.** Inline into your build config or a public env var
  (`PUBLIC_POLARIS_API_KEY`). It will end up in the bundle. That is fine.
- **Backend.** Read it from your secret manager at process start. Do not
  commit it. Do not log it.

The token plaintext appears in **exactly one** place: the `keys create`
stdout. It never appears in logs, audit records, or any subsequent CLI
output.

## Step 2.4 — Confirm the row landed

```bash
polaris keys list --project your_project --env production
```

Output:

```text
project=your_project env=production count=2
  polaris_ak_018f1b9e... source=your-project-web type=web status=active created=2026-05-15... last_used=(unused)
  polaris_ak_018f2c0a... source=your-project-api type=backend status=active created=2026-05-15... last_used=(unused)
```

`polaris keys list` deliberately omits the `hash` column — there is nothing
sensitive in the output. `last_used_at` updates after the first ingestion
request authenticated by that key.

## Lifecycle: rotate and revoke

### Rotate

`rotate` issues a fresh key bound to the same
`(project, environment, source_id, source_type)` tuple **and revokes the
original in the same transaction**. There is no grace period — the old key
is unusable the moment the rotation commits.

```bash
polaris keys rotate polaris_ak_018f1b9e-7b50-7b12-9a2e-0e2f88d8f551
```

If you need overlap (zero-downtime rotation):

1. Run `polaris keys create ...` to issue a second key.
2. Deploy the new key everywhere.
3. Run `polaris keys revoke <old_key_id> --reason "rotation 2026-05-15"`.

See `apps/polaris-cli/src/commands/keys/rotate.ts` for the architectural
note on the no-grace-period decision.

### Revoke

```bash
polaris keys revoke polaris_ak_018f1b9e-7b50-7b12-9a2e-0e2f88d8f551 \
  --reason "compromised in incident #4218"
```

Revocation is idempotent: re-running on an already-revoked key prints
`already revoked` and exits 0. The ingester treats any non-`active` row as
not-usable; revocation takes effect on the next request that misses the
auth cache (default TTL 60s).

`--reason` is optional but **strongly encouraged** — the value lands on the
audit record so post-incident reviews carry the rationale verbatim.

## Done when

- Both keys exist in `polaris keys list --project your_project --env <env>`
  with `status=active`.
- Your frontend bundle / backend secret store has the tokens.
- *(Optional but recommended)* You have wired `polaris keys rotate` into
  your runbook for the next scheduled rotation.

## Next

[Phase 3 — Pick event names and add a schema](./03-event-names-and-schemas.md).
