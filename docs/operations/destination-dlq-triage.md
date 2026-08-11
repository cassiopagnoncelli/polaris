# Destination Delivery Records and DLQ Triage Runbook

Operators use this runbook when a destination pipeline produces failures
and the on-call engineer needs to find, classify, and resolve them.

Binding architecture references:

- [Destinations](../architecture/06-destinations.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)
- [Control Plane](../architecture/02-control-plane.md)

The CLI surface this runbook depends on lives at
[`apps/polaris-cli/src/commands/deliveries/`](../../apps/polaris-cli/src/commands/deliveries/)
and [`apps/polaris-cli/src/commands/dlq/`](../../apps/polaris-cli/src/commands/dlq/).
The matching shared types live in
[`packages/shared-destinations/src/db/`](../../packages/shared-destinations/src/db/).
The migration creating `dlq_records` is
[`db/migrations/20260514000001_create_dlq_records.sql`](../../db/migrations/20260514000001_create_dlq_records.sql).

## What the tables mean

**`delivery_records`** is the per-attempt log line. One row is written
for every delivery attempt the destination runtime executes against an
envelope — whether the attempt succeeded (`status='accepted'`), dropped
in normalize (`dropped_consent` / `dropped_no_identity` /
`dropped_invalid`), failed in the mapper (`mapped_failed`), or failed
in the deliverer (`failed_retryable` / `failed_permanent`). The row is
**immutable**. Operators do NOT mutate `delivery_records`; everything
mutable lives on `dlq_records`.

**`dlq_records`** is the active triage queue. The destination runtime
writes one row per DLQ publish, alongside the canonical broker
republish to the `<vendor>.<consumer_version>.dlq` topic family. Each
row carries:

- the original message bytes (`payload`) so a retry can republish the
  byte-identical envelope back onto `analytics.events`;
- the original message headers (`headers`) so a retry preserves the
  `polaris-delivery-key` + retry-attempt counter the runtime needs to
  short-circuit duplicate delivery;
- the stage-version snapshot (`consumer_version`, `normalize_version`,
  `mapper_version`, `deliverer_version`) so a "all DLQ entries produced
  with mapper/v1 against deliverer/v2" query is one filter away;
- mutable resolution slots (`resolved_at`, `resolved_by`,
  `resolution_note`) set when an operator marks the row done.

Both tables have schema CHECKs forbidding secret-shaped columns; the
destination instance's `secret_ref` is the only "credential-adjacent"
field surfaced, and that is the `provider:ref` literal, not the
resolved plaintext.

## CLI surface

| Command | Mutating? | Audited? | Description |
|---|---|---|---|
| `polaris deliveries list <destination_id>` | no | n/a | List delivery attempts for one destination, newest-first, with optional `--status`, `--error-class`, `--since`, `--until`, `--limit`. |
| `polaris deliveries show <delivery_id>` | no | n/a | Render one delivery record's full state. |
| `polaris dlq list (--destination \| --vendor) ...` | no | n/a | List DLQ records by destination OR vendor (exactly one). Filter knobs: `--error-class`, `--reason`, `--since`, `--until`, `--include-resolved`, `--limit`. Defaults to unresolved-only. |
| `polaris dlq show <dlq_id>` | no | n/a | Render one DLQ record with headers + payload preview. |
| `polaris dlq retry <dlq_id> [--note "..."]` | **yes** | **yes (`dlq.retry`)** | Republish the row's bytes to its source topic, then mark resolved. Runtime dedupe protects against double-delivery. |
| `polaris dlq mark-resolved <dlq_id> [--note "..."]` | **yes** | **yes (`dlq.mark-resolved`)** | Mark resolved without republishing. Use when the operator fixed the issue out-of-band. |

Mutating commands honor the P6-007 production gate: against
`POLARIS_ENV=production` with `actor_source='declared'`, the dispatcher
rejects them and requires an operator token.

## Triage workflow

### 1. Spot the failure mode

Start from the metrics dashboards (Grafana — see
`docs/architecture/08-observability-and-operations.md`). The
`polaris_destination_events_failed_total` and
`polaris_destination_events_dlq_total` counters break down by
`vendor`, `consumer_version`, `destination_id`, `project_id`,
`environment`, `reason`. Most outages cluster around one vendor or one
error class.

### 2. List unresolved DLQ entries

```bash
polaris dlq list --vendor meta-capi --limit 20
```

or, scoped to one destination:

```bash
polaris dlq list --destination polaris_dst_checkout_meta --since 2026-05-14T00:00:00Z
```

The output table shows `published_at`, `dlq_id`, `attempts`,
`reason`, `error_class`, and the originating event id. The
`--include-resolved` flag widens the query to the full history when
forensic context is needed.

### 3. Inspect a specific entry

```bash
polaris dlq show polaris_dlq_01HZZ...
```

Renders the full row including transport coordinates (`source_topic`,
`source_partition`, `source_offset`), every header, and a
payload-preview (first 400 chars of the canonical envelope JSON). Use
this view to determine the root cause:

- **`error_class='auth'`** — credentials expired or revoked. Fix the
  destination's `secret_ref` (via the secret-provider runbook); then
  decide retry vs. mark-resolved.
- **`error_class='mapping'`** — mapper version mismatch or a producer
  emitted an envelope the mapper rejects. Capture the envelope, fix the
  mapper version on the destination, then `retry`.
- **`error_class='permanent'` (vendor 4xx)** — the vendor rejected the
  event. Either the canonical envelope violates the vendor's contract
  (then this is a code bug; create a follow-up) or the vendor changed
  their schema (then the consumer version needs to bump). Usually
  `mark-resolved` with a note pointing to the follow-up ticket.
- **`reason='decode_failed'` / `'missing_destination_id'`** — early-
  stage failures that pre-date instance resolution. These are
  broker-only (no `dlq_records` row); triage them from the DLQ queue
  directly in the RabbitMQ management console. (They are loud
  but rare — usually a producer-side regression.)

### 4. Retry the entry

```bash
polaris dlq retry polaris_dlq_01HZZ... --note "vendor cred rotated 14:32 UTC"
```

The CLI:

1. reads the row from `dlq_records`,
2. opens a short-lived producer against
   `POLARIS_RABBITMQ_URL`,
3. publishes the byte-identical envelope back to the row's
   `source_topic` with the original headers,
4. closes the producer,
5. in one PostgreSQL transaction: sets `resolved_at` / `resolved_by` =
   the CLI actor / `resolution_note` = the `--note` text, plus writes
   an `audit_records` row with `action='dlq.retry'`.

The destination runtime's dedupe layer keys on
`(destination_id, delivery_key)`. Because the retry preserves the
original `polaris-delivery-key` header, a double-publish (e.g. an
operator who lost the terminal mid-command) is a no-op on the
destination side — the second arrival is dropped by dedupe and a
`polaris_destination_events_deduped_total` metric increments.

Failure modes during retry:

| Failure | Effect | Recovery |
|---|---|---|
| Producer connect/publish fails | Exception; row stays unresolved | Re-run `polaris dlq retry` after restoring broker access |
| `dlq_records` row missing | `UsageError` (exit 2) | Verify the id |
| Row already resolved | exit 0 with `already resolved` | Idempotent — no action |
| Row has `payload IS NULL` (early-stage failure) | `UsageError` | Use `mark-resolved` instead; the bytes are only on the broker |

### 5. Or mark the entry resolved without retrying

When the issue is fixed out-of-band (vendor support reprocessed the
event, a one-off ETL backfilled it, the canonical event is no longer
relevant):

```bash
polaris dlq mark-resolved polaris_dlq_01HZZ... --note "vendor ops backfilled via support ticket #4218"
```

Same audit posture as `retry` (`action='dlq.mark-resolved'`,
`target_type='dlq_record'`, snapshots before+after).

### 6. Confirm

`polaris deliveries list <destination_id>` after a retry shows a fresh
`accepted` row appended to the destination's delivery history with the
incremented attempt number. The original `failed_permanent` row stays
where it was — `delivery_records` is append-only.

`polaris audit list --target-type dlq_record` shows every operator
action against the DLQ for forensic review.

## Secrets and PII safety

Both tables are designed to never carry secrets:

- `dlq_records.payload` is the canonical Polaris envelope as bytes;
  the canonical schema forbids credentials at intake (see
  [`docs/architecture/01-event-contract.md`](../architecture/01-event-contract.md)).
- `dlq_records.headers` carry Polaris `polaris-*` headers and
  vendor-side dedupe keys; never resolved secrets.
- `dlq_records.vendor_response_summary` is truncated to 1 KB and
  contains the receiver's reason string. Tests assert no resolved
  secret leak.
- Mutating commands' audit snapshots exclude the bytes payload to
  keep `audit_records` rows small.

## Operational tips

- **Batch triage.** When a single vendor returns 401 for an hour,
  `polaris dlq list --vendor meta-capi --error-class auth | head -50`
  produces the work queue. Fix the secret, then loop:

  ```bash
  polaris dlq list --vendor meta-capi --error-class auth --limit 100 \
    --output json \
    | jq -r '.dlq[].dlq_id' \
    | while read id; do polaris dlq retry "$id" --note "auth rotated"; done
  ```

  Each retry runs through the production gate independently; the gate
  enforces operator-token presence per-invocation.

- **Cold replays.** If the DLQ topic still has the original bytes but
  the `dlq_records` row aged out (the table has no auto-pruning in v1
  — operators run their own scheduled cleanup), use `polaris replay
  create` to re-process the original analytics.events window. The
  replay-suppression logic on the destination runtime requires the
  matching `allowReplay=true` opt-in on the consumer host config.

- **Audit trail.** Every retry and mark-resolved produces an
  `audit_records` row with full before/after snapshots. The before
  snapshot pins the `dlq_records.attempts` and the prior resolution
  state (always null at the moment of mutation); the after snapshot
  pins the resolved-at/by/note triple.
