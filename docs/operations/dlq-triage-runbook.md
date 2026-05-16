# DLQ Triage Runbook

This is the operator entry point for triaging Polaris DLQ events end-to-end.
It covers both destination-side DLQs (per consumer instance, mirrored to
PostgreSQL `dlq_records`) and processor-side DLQs (per processor, dual-written
to Kafka + PostgreSQL `processor_dlq_records` as of 3L2HKMND).

Binding architecture references:

- [Redpanda Topics](../architecture/03-redpanda-topics.md) — DLQ topic
  conventions.
- [Destinations](../architecture/06-destinations.md) — destination DLQ
  semantics, `error_class`, vendor response summary.
- [Observability and Operations](../architecture/08-observability-and-operations.md)
  — operations posture, metrics.

The companion destination-only runbook at
[`destination-dlq-triage.md`](destination-dlq-triage.md) covers the
P9-007 surface in depth — this document is the unified entry point and
SLA contract.

## 1. Overview

Polaris produces two classes of DLQ:

### 1a. Destination DLQs

When a destination consumer's deliverer fails permanently (or exhausts
retries), it republishes the offending Kafka message to
`<vendor>.<consumer_version>.dlq` (see
[Retry and DLQ Topics](../architecture/03-redpanda-topics.md#retry-and-dlq-topics))
AND writes a row to the PostgreSQL
[`dlq_records`](../../packages/shared-destinations/src/db/dlq-records.ts)
table.

The PostgreSQL row is the active triage queue. Each row carries the
original Kafka bytes (`payload`), the original Kafka headers (`headers`)
including the Polaris delivery key, the stage-version snapshot
(`consumer_version`, `normalize_version`, `mapper_version`,
`deliverer_version`), and mutable resolution slots (`resolved_at`,
`resolved_by`, `resolution_note`). Operators triage from the PostgreSQL
rows; the Kafka topic is the durable byte-identical buffer.

### 1b. Processor DLQs

When a processor (geoip-enricher, identity-resolver, sessionizer,
analytics-projector, attribution-engine) fails permanently on a message,
the shared runtime calls
[`publishToDlq`](../../packages/shared-processor/src/dlq.ts) which
delegates to
[`republishToDlq`](../../packages/shared-kafka/src/dlq.ts). The message
lands on `<processor_name>.dlq` with the failure metadata as headers
(reason, error class, error message, source topic/partition/offset,
attempt counter, failed-at timestamp). The original Kafka bytes are
preserved byte-identically so replay tooling can rely on `event_id`
equality across topics.

Processor DLQs **dual-write** as of 3L2HKMND: the Kafka publish to
`<processor_name>.dlq` still happens (so existing topic consumers and
runbooks stay unbroken) AND a row lands in the PostgreSQL
[`processor_dlq_records`](../../packages/shared-processor/src/db/processor-dlq-records.ts)
table. Each row carries the original Kafka bytes (`payload`), the
original headers (`headers`), the failing processor identity
(`processor_name`, `processor_version`), classifier output
(`reason`, `error_class`, `error_message`), source-topic coordinates
(`source_topic` / `source_partition` / `source_offset`), and the
mutable resolution slots (`resolved_at`, `resolved_by`,
`resolution_note`). Operators triage from PostgreSQL via the CLI
commands documented in §3b; the Kafka topic remains the durable
byte-identical buffer.

## 2. SLA targets

These are **v1 defaults**, applied per destination/processor DLQ.
They are operational targets, not contractual commitments — they
tighten after observed traffic. The on-call rotation owns
acknowledgement; the responsible processor/consumer owner classifies
and resolves.

```text
acknowledge (operator opens a triage ticket)        within 1 hour during business hours, 4 hours otherwise
classify (retryable vs permanent)                   within 4 hours of acknowledgement
resolve (retry succeeds or marked permanent)        within 24 hours of acknowledgement
escalate (DLQ growth continues during triage)       when DLQ size > acknowledged-batch + 1000
```

The `escalate` trigger fires when the DLQ keeps growing during triage:
if the operator acknowledged 500 rows and the table now holds more
than 1500, the issue is propagating faster than triage can drain and
the responsible team needs a second pair of eyes.

## 3. Inspect DLQ volume

### Destination DLQs

Use `polaris dlq summary` to get a per-(error_class, reason) breakdown
for one destination or one vendor:

```bash
polaris dlq summary --vendor meta-capi --since 2026-05-14T00:00:00Z
polaris dlq summary --destination polaris_dst_checkout_meta
```

Source: [`apps/polaris-cli/src/commands/dlq/summary.ts`](../../apps/polaris-cli/src/commands/dlq/summary.ts).

The summary reports:

- total unresolved DLQ rows in scope,
- oldest / newest unresolved `published_at`,
- per-`error_class` count + oldest/newest,
- per-`reason` count + oldest/newest,
- `truncated: true` when the result hits the 1000-row cap (narrow
  `--since`/`--until`).

To get the same picture across every vendor at once (forensic /
end-of-day check), iterate vendors from the destinations list:

```bash
polaris destinations list --output json \
  | jq -r '.[].vendor' | sort -u \
  | while read vendor; do
      polaris dlq summary --vendor "$vendor" --output json
    done | jq -s 'map({vendor: .scope.vendor, total, by_error_class, by_reason})'
```

The aggregation runs client-side; there is no cross-tenant aggregate
query because every DLQ surface is scoped through a partial index.

To list individual unresolved entries, use:

```bash
polaris dlq list --vendor meta-capi --limit 50
polaris dlq list --destination polaris_dst_checkout_meta --since 2026-05-14T00:00:00Z
```

The `--include-resolved` flag widens the query to the full history
when forensic context is needed.

### Processor DLQs

As of 3L2HKMND, processor DLQs are queryable from PostgreSQL via
`polaris processors dlq`:

```bash
polaris processors dlq list --processor geoip-enricher --limit 50
polaris processors dlq list --processor analytics-projector --since 2026-05-14T00:00:00Z
```

The `--include-resolved` flag widens to the full history. The Kafka
topic (`<processor_name>.dlq`) is still written byte-identically for
backward compatibility with Redpanda-console workflows and existing
streaming consumers:

```bash
rpk topic describe geoip-enricher.dlq
rpk topic consume geoip-enricher.dlq --num 50 --format '%h\t%v\n'
```

The processor DLQ metric `polaris_processor_events_dlq_total` (labeled
by `processor_name`, `processor_version`, `project_id`, `environment`,
`reason`) is the canonical volume signal — read it from Grafana before
diving into individual messages.

## 4. Inspect one DLQ event

### Destination DLQs

```bash
polaris dlq show polaris_dlq_01HZZ...
```

Source: [`apps/polaris-cli/src/commands/dlq/show.ts`](../../apps/polaris-cli/src/commands/dlq/show.ts).

Renders the full row including:

- destination identity (`destination_id`, `vendor`, `project_id`,
  `environment`, stage-version snapshot),
- failure context (`reason`, `error_class`,
  `vendor_response_code`, `vendor_response_summary`, `attempts`),
- Kafka coordinates (`source_topic`, `source_partition`, `source_offset`),
- every header,
- `delivery_key` — the Polaris-owned idempotency key the destination
  runtime dedupes on,
- a payload preview (first 400 chars of the canonical envelope JSON
  in human output; full bytes in `--output json`),
- resolution slots (`resolved_at`, `resolved_by`, `resolution_note`)
  if already triaged.

### Processor DLQs

No CLI surface in v1. Use Redpanda console or `rpk`:

```bash
rpk topic consume geoip-enricher.dlq --offset oldest --num 1 --format '%h\n%v\n'
```

The headers carry the same failure metadata vocabulary as destination
DLQs: `polaris-retry-reason`, `polaris-retry-error-class`,
`polaris-retry-error-message`, `polaris-retry-attempts`,
`polaris-retry-failed-at`, `polaris-retry-source-topic`,
`polaris-retry-source-partition`, `polaris-retry-source-offset`.

## 5. Classify retryable vs permanent

Both destination and processor DLQs carry an `error_class` label that
the responsible owner uses to decide retry vs permanent. The closed
set of destination error classes lives in
[`DELIVERY_RECORD_ERROR_CLASSES`](../../packages/shared-destinations/src/db/delivery-records.ts).

| `error_class`   | Retryability                              | Operator action |
|-----------------|-------------------------------------------|-----------------|
| `auth`          | **Permanent until credential is rotated** | Rotate the credential via the secret-provider runbook; verify with `polaris destinations show <id>` that `secret_ref` points at the rotated material; retry **once** (`polaris dlq retry`); escalate if the retry still fails. |
| `rate_limit`    | Retryable                                 | Safe to retry. If a vendor enforces a long cooldown, batch-retry after the cooldown window. |
| `timeout`       | Retryable                                 | Safe to retry. If the destination's `timeout_ms` is too aggressive, update via `polaris destinations update-ops` before retry. |
| `transient`     | Retryable                                 | Safe to retry. Vendor-side flakes, network blips, 5xx. |
| `permanent`     | **Permanent**                             | Do not retry without a code fix. Either the vendor rejected the canonical envelope (consumer/mapper bug — file a ticket, then `mark-resolved` with the ticket id) or the vendor's contract changed (consumer-version bump). |
| `mapping`       | Permanent until code change               | The mapper rejected the canonical envelope. File a code-fix ticket; `mark-resolved` against the ticket. |
| `consent`       | Permanent (intentional drop)              | The destination's `normalize` stage dropped the event for consent reasons. Usually `mark-resolved` with `--note "consent: dropped"`; no retry. |
| `identity`      | Permanent (intentional drop)              | Missing required identity field for the vendor. Usually `mark-resolved`; if a producer regression is the cause, file the producer fix and reference its ticket. |
| `policy`        | Permanent (intentional drop)              | A defensive second-pass redaction rejected the event. `mark-resolved` with the policy violation referenced. |

Processor DLQs use the same `error_class` vocabulary in headers; see
[`packages/shared-processor/src/classify.ts`](../../packages/shared-processor/src/classify.ts)
for the processor-side classifier.

## 6. Retry safely

### Destination retry

```bash
polaris dlq retry polaris_dlq_01HZZ... --note "vendor cred rotated at 14:32 UTC"
```

Source: [`apps/polaris-cli/src/commands/dlq/retry.ts`](../../apps/polaris-cli/src/commands/dlq/retry.ts).

The CLI:

1. reads the row from `dlq_records`,
2. opens a short-lived Kafka producer against
   `POLARIS_REDPANDA_BROKERS`,
3. publishes the byte-identical envelope back to the row's
   `source_topic` with the original headers,
4. closes the producer,
5. in one PostgreSQL transaction: sets `resolved_at` / `resolved_by` =
   the CLI actor / `resolution_note` = the `--note` text, plus writes
   an `audit_records` row with `action='dlq.retry'`.

#### Idempotency contract

**Yes, retrying a DLQ event is safe — the destination dedupes on
`delivery_key`.** The destination runtime's dedupe layer keys on
`(destination_id, delivery_key)`. Because the retry preserves the
original `polaris-delivery-key` header, a double-publish (e.g. an
operator who lost the terminal mid-command and retried twice) is a
no-op on the destination side — the second arrival is dropped by
dedupe and a `polaris_destination_events_deduped_total` metric
increments.

Vendor-specific dedupe notes (from
[06-destinations.md](../architecture/06-destinations.md#delivery-model)):

- **Meta CAPI / TikTok**: Polaris maps the stable delivery id into the
  vendor's `event_id` field for second-line dedupe. Cross-reference:
  [`consumers/meta-capi/v1/SPEC.md`](../../consumers/meta-capi/v1/SPEC.md),
  [`consumers/tiktok/v1/SPEC.md`](../../consumers/tiktok/v1/SPEC.md).
- **GA4**: stable `transaction_id` is used as the vendor-side dedupe
  key when present in the canonical event.
- **Braze and Braze-style integrations**: assume weak or no vendor
  event dedupe. Polaris's `delivery_key` defense is the **only**
  guarantee against double-delivery. The architecture doc spells this
  out at
  [Delivery Model](../architecture/06-destinations.md#delivery-model):
  "Braze-style integrations should assume weak or no vendor event
  dedupe and rely more heavily on Polaris delivery records." Treat
  any retry against a Braze-class consumer with extra care — the
  delivery-key dedupe is a hard contract, not a best-effort.

Failure modes during retry:

| Failure                                            | Effect                              | Recovery |
|----------------------------------------------------|-------------------------------------|----------|
| Kafka producer connect/send fails                  | Exception; row stays unresolved     | Re-run `polaris dlq retry` after restoring broker access |
| `dlq_records` row missing                          | `UsageError` (exit 2)               | Verify the id |
| Row already resolved                               | exit 0 with `already resolved`      | Idempotent — no action |
| Row has `payload IS NULL` (early-stage failure)    | `UsageError`                        | Use `mark-resolved` instead; the bytes are only in Kafka |

### Processor retry

Processor DLQs don't have a per-message CLI retry in v1. The two
operator paths are:

1. **Bulk replay (preferred for window-scoped failures).** Run
   `polaris replay create` with the window covering the failed
   processor offsets. The replay republishes raw events from the
   archive back through the processor pipeline. See
   [Replay control plane](../architecture/05-processors-and-replay.md).
2. **Manual republish (per-message, escape hatch).** Read the message
   from `<processor>.dlq` with `rpk topic consume`, then republish
   the value bytes to the processor's input topic with `rpk topic
   produce`. This bypasses the DLQ classification metadata; do it
   only when the bulk replay path is overkill.

Both paths respect the same idempotency posture: processors are
expected to be idempotent on (event_id, processor_name,
processor_version). When in doubt, prefer the replay path because it
keeps the audit trail in `audit_records`.

## 7. Mark resolved

When the issue is fixed out-of-band (vendor support reprocessed the
event, a one-off ETL backfilled it, the canonical event is no longer
relevant, the operator decided to drop a `consent`/`identity`/`policy`
class row):

```bash
polaris dlq mark-resolved polaris_dlq_01HZZ... --note "vendor ops backfilled via support ticket #4218"
```

Source: [`apps/polaris-cli/src/commands/dlq/mark-resolved.ts`](../../apps/polaris-cli/src/commands/dlq/mark-resolved.ts).

Same audit posture as `retry`:
`action='dlq.mark-resolved'`, `target_type='dlq_record'`, before+after
snapshots written to `audit_records` in the same Kysely transaction
as the row update. Idempotent — re-running on an already-resolved row
exits 0.

Audit trail review:

```bash
polaris audit list --target-type dlq_record --since 2026-05-14T00:00:00Z
polaris audit show <audit_id>
```

## 8. How replay policy affects destination retries

Destination retries from this runbook republish to the **source topic**
of the DLQ row. That topic is the destination's normal consumer input
(e.g. `analytics.events`). The destination runtime treats the
republished bytes as a fresh delivery and runs the standard pipeline
(normalize → map → deliver) against them.

This is **not** the same as a control-plane replay. A control-plane
replay (`polaris replay create ...`, planned by P7-002, guarded by
P7-004) walks a window of raw events from the archive and dispatches
them through processors and destinations.

The replay-suppression contract (P7-004) only applies to
control-plane replays:

- **Destinations opted out of replay** (the default,
  `replay_opt_in=false` on the `destinations` row) **WILL NOT receive
  replayed events**. The destination runtime drops them at
  `replay-suppression`; a `polaris_destination_replay_suppressed_total`
  metric increments and a structured log line lands. **No vendor
  delivery happens.**
- **Destinations opted in** (`replay_opt_in=true`, set via
  `polaris destinations enable-replay <id> --reason "<text>"`) receive
  replayed events through the normal pipeline.

The DLQ-retry path is **independent** of this opt-in — `polaris dlq
retry` republishes to the source topic, not through the replay
pipeline, and the dedupe layer keys off `delivery_key`. A DLQ retry
will fire vendor delivery whether or not the destination has opted
into replay.

**Before initiating a control-plane replay that touches a destination
with DLQ history**, check the opt-in flag:

```bash
polaris destinations show <destination_id> | grep -E "replay_opt_in"
```

Look for:

```text
replay_opt_in         false
```

If the destination is opted out, decide between:

1. Leaving it opted out — the replay will run through processors and
   ClickHouse but skip vendor delivery to this destination. (Suitable
   when the operator wants the analytics refresh but not a vendor
   double-send.)
2. Enabling the opt-in via `polaris destinations enable-replay <id>
   --reason "<text>"` — the replay will deliver. Audited.
   `delivery_key` dedupe still protects against duplicate vendor sends
   per Polaris-delivery-key, but cross-replay re-sends still hit the
   vendor when a fresh canonical event id arrives.

Disable replay opt-in after the replay window closes with `polaris
destinations disable-replay <id> --reason "<text>"`.

## 9. Secret redaction expectation

DLQ records (and delivery records) must **never** contain raw secrets.
This is enforced at three layers:

1. **Schema.** The `dlq_records` migration
   ([`db/migrations/20260514000001_create_dlq_records.sql`](../../db/migrations/20260514000001_create_dlq_records.sql))
   defines no column resembling a resolved secret value. The
   destination instance's `secret_ref` is the only credential-adjacent
   field surfaced, and that is the `provider:ref` literal, not the
   resolved plaintext.
2. **Application.** The repository's `truncateSummary` helper bounds
   `vendor_response_summary` to 1 KB on insert. Tests in
   `packages/shared-destinations/test/no-secret-shape.test.ts` assert
   the table surface stays secret-free.
3. **Consumer-side defense.** Every consumer's deliverer redacts the
   resolved access token from the vendor response BEFORE writing it
   into `delivery_records.vendor_response_summary` or the matching
   `dlq_records` row. References:
   - [`consumers/tiktok/v1/src/deliverer.ts`](../../consumers/tiktok/v1/src/deliverer.ts)
     — `redactToken` defense.
   - [`consumers/meta-capi/v1/src/deliverer.ts`](../../consumers/meta-capi/v1/src/deliverer.ts)
     — `redactToken` defense.

If a DLQ record's `vendor_response_summary` looks suspicious
(unredacted token, vendor account id, customer PII echoed in the
error response), that is a **P1 bug** in the consumer's deliverer —
file it, then resolve the DLQ row with a note pointing at the bug
ticket.

The operator-side audit trail (`audit_records.before` /
`audit_records.after`) also excludes the bytes payload to keep audit
rows small and side-effect-free; see
[`apps/polaris-cli/src/commands/dlq/snapshot.ts`](../../apps/polaris-cli/src/commands/dlq/snapshot.ts).

## CLI surface summary

| Command | Mutating? | Audited? | Source |
|---|---|---|---|
| `polaris dlq summary (--destination \| --vendor) [...]` | no | n/a | [summary.ts](../../apps/polaris-cli/src/commands/dlq/summary.ts) |
| `polaris dlq list (--destination \| --vendor) [...]` | no | n/a | [list.ts](../../apps/polaris-cli/src/commands/dlq/list.ts) |
| `polaris dlq show <dlq_id>` | no | n/a | [show.ts](../../apps/polaris-cli/src/commands/dlq/show.ts) |
| `polaris dlq retry <dlq_id> [--note "..."]` | **yes** | **yes (`dlq.retry`)** | [retry.ts](../../apps/polaris-cli/src/commands/dlq/retry.ts) |
| `polaris dlq mark-resolved <dlq_id> [--note "..."]` | **yes** | **yes (`dlq.mark-resolved`)** | [mark-resolved.ts](../../apps/polaris-cli/src/commands/dlq/mark-resolved.ts) |
| `polaris audit list [--target-type dlq_record] [...]` | no | n/a | [list.ts](../../apps/polaris-cli/src/commands/audit/list.ts) |
| `polaris audit show <audit_id>` | no | n/a | [show.ts](../../apps/polaris-cli/src/commands/audit/show.ts) |
| `polaris destinations show <destination_id>` | no | n/a | [show.ts](../../apps/polaris-cli/src/commands/destinations/show.ts) |
| `polaris destinations enable-replay <id> --reason "<text>"` | **yes** | **yes (`destinations.enable-replay`)** | [enable-replay.ts](../../apps/polaris-cli/src/commands/destinations/enable-replay.ts) |
| `polaris destinations disable-replay <id> --reason "<text>"` | **yes** | **yes (`destinations.disable-replay`)** | [disable-replay.ts](../../apps/polaris-cli/src/commands/destinations/disable-replay.ts) |

Mutating commands honor the P6-007 production gate: against
`POLARIS_ENV=production` with `actor_source='declared'`, the
dispatcher rejects them and requires an operator token.

## Known gaps

The destination-side surface is complete for v1. The processor-side
surface gained the typed `processor_dlq_records` table and the
`polaris processors dlq {list,show,retry,mark-resolved}` commands in
3L2HKMND. The following are follow-up work:

- **Cross-processor summary.** `polaris processors dlq` requires
  `--processor`. A "everything, grouped by processor" view can be
  achieved via a shell loop over the processor names; a first-class
  `polaris processors dlq summary` is a sibling to the destination
  surface's `summary` and not yet shipped.
- **Cross-vendor / cross-destination aggregate.** `polaris dlq
  summary` requires `--destination` or `--vendor`. A "everything,
  grouped by vendor" view is achievable via a shell loop (see the
  jq snippet in [Inspect DLQ volume](#3-inspect-dlq-volume)); a
  first-class `polaris dlq summary --all` is not in v1 because the
  underlying repository surface intentionally scopes queries through
  partial indexes.
- **Auto-pruning of resolved rows.** `dlq_records` has no automatic
  retention in v1; resolved rows accumulate until an operator runs a
  scheduled cleanup. The backup/retention runbook documents the
  retention story for PostgreSQL more broadly; an operations-owned
  cleanup script is a follow-up.
