# Phase 9 — Support and escalation path

You are onboarded. From here on, you are a project team consuming the
platform. This page is the operational contract: who to call, what to
file, and where the runbooks live.

## Who owns what

| Surface | Owner | When you contact them |
|---|---|---|
| Event schemas (catalog + Zod) | **Your team + schema reviewer** | You want to add or evolve an event. Open a PR; the reviewer signs off. |
| Project / source declarations | **Your team + operator** | Drift between `catalog/` and PostgreSQL, or you want to add a new source. Open a PR, ping the operator to sync. |
| API keys | **Operator** | You need a new key, a rotation, or a revocation. Through your operator channel. |
| Destinations | **Operator** | New destination, tuning, enable/disable, replay opt-in. Through your operator channel. |
| Replays | **Operator** | Backfill an event window after a producer bug or destination outage. Through your operator channel. |
| Vendor-side delivery failures | **Operator on-call** | Delivery has stopped; DLQ is filling; vendor returning 5xx. Page on-call. |
| Ingester / processor outage | **Platform on-call** | The ingester is rejecting valid events; analytics pipeline is stalled. Page on-call. |
| Vendor support (Meta, TikTok, GA4, ...) | **Your team** | The vendor itself rejected a delivered event. Polaris already delivered; the rejection is between you and the vendor. |

> Your organization fills in the exact channel names (Slack channel,
> PagerDuty rotation, ticket queue) for the on-call rows above when this
> guide is published. The boundaries above hold regardless of the
> channel.

## Routine self-service

Before paging anyone:

- **Diagnostics in the SDK.** Wire `onError` and `onDrop` ([Phase 4](./04-install-web-sdk.md)
  / [Phase 5](./05-install-node-sdk.md)). They are the only reliable
  signal that the SDK is not delivering.
- **Per-event reason codes.** The ingester's response includes a closed
  set of codes ([Phase 6](./06-first-event.md)). `unknown_event`,
  `invalid_properties`, and `forbidden_field_rejected` are all
  producer-side bugs — fix them at your call site or in your schema.
- **Read state with `polaris audit list` and `polaris export`.** You can
  inspect what the operator changed in your project's runtime without
  paging anyone. See [Audit and Export](../development/audit-and-export.md).
- **Dashboards.** [Observability](../development/observability.md) lists
  the Grafana stack and the per-vendor delivery dashboards. Check the
  panel for your `destination_id` before paging.

## When to file a DLQ ticket

Destinations that fail delivery enter the **DLQ** (dead-letter queue).
The destination runtime writes one row to `dlq_records` per DLQ
publish. The operator-facing triage CLI surface is:

```bash
# What is in the DLQ for one vendor?
polaris dlq list --vendor meta-capi --limit 20

# What is in the DLQ for one of your destinations?
polaris dlq list --destination polaris_dst_018f1c0b... --since 2026-05-15T00:00:00Z

# Show one entry in full.
polaris dlq show polaris_dlq_018f1c0b...

# Retry the entry (republishes the byte-identical envelope; the runtime
# dedupe protects against double-delivery).
polaris dlq retry polaris_dlq_018f1c0b... --note "vendor cred rotated 14:32 UTC"

# Or, mark resolved without republishing (when fixed out-of-band).
polaris dlq mark-resolved polaris_dlq_018f1c0b... \
  --note "vendor ops backfilled via support ticket #4218"
```

`retry` and `mark-resolved` are mutating and audited. They run through
the production-mutation gate; **only operators with `POLARIS_TOKEN` can
execute them against production**.

When you (the team) notice a destination is failing:

1. Confirm via the dashboards listed in
   [Observability](../development/observability.md).
2. File the ticket with `destination_id`, vendor, approximate window,
   suspected cause, and any vendor-side context you have (e.g. "Meta
   rolled out a new SDK version, we suspect schema drift").
3. The on-call operator triages with the [Destination DLQ Triage
   runbook](../operations/destination-dlq-triage.md), which is the
   authoritative procedure.

## When to file a replay request

If a producer bug or destination outage caused events to be lost (or
rejected for a reason that has since been fixed), you may need a
**replay**. Replays are operator-only and time-bounded:

- bounded to the operational retention window (90 days for `raw.events`
  in v1)
- a dry-run plan is rendered first via `polaris replay plan <id>` before
  the executor runs
- destination opt-in is per-instance and defaults to off (see
  [Phase 8](./08-destinations.md))

Your team's job is to file the request with: project, environment, event
window (`--from` and `--to` in ISO 8601 UTC), the specific event names or
event IDs in scope, and the rationale. The operator handles the rest.

The CLI surface is in `apps/polaris-cli/src/commands/replay/`; the
architectural contract is in [Architecture / Processors and Replay /
Replay Control Plane](../architecture/05-processors-and-replay.md).

## Escalation matrix

| Symptom | First diagnostic | Then |
|---|---|---|
| `track()` resolves but ingester `/metrics` shows zero accepts for your project | Check `onError` / `onDrop`; confirm `endpoint` and `apiKey` resolved at runtime. | Operator: confirm the API key is `status=active` and pointed at the right environment. |
| Ingester returns `unknown_event` | The catalog does not register the name. Phase 3. | Schema reviewer. |
| Ingester returns `invalid_properties` | Your producer schema does not match the registered Zod schema. | Diff your call against `packages/shared-schemas/src/events/<domain>/<event>.v<n>.ts`. |
| Ingester returns `forbidden_field_rejected` | Your producer sent a reject-listed field (e.g. `cvv`, `password`). | **Fix the producer.** This is a hard rule, not a configurable threshold. |
| Events accepted but missing in analytics | Check DLQ; check processor lag dashboards. | DLQ runbook. |
| Destination delivering 4xx | Vendor schema drift or stale cred. Inspect `delivery_records.vendor_response_summary`. | DLQ runbook. |
| Destination delivering nothing | `polaris destinations show` — is `status=active`? Did the operator disable it? | Operator. |
| 401 / 403 from ingester | API key revoked, wrong environment, or origin not in the allow-list (browser). | Operator: rotate or fix the source's allowed origins. |

## Key cross-references

- [SDK / Troubleshooting](../sdk/troubleshooting.md) — long form for the
  Web/Node SDK failure modes.
- [Destination DLQ Triage runbook](../operations/destination-dlq-triage.md) —
  the on-call procedure for delivery failures.
- [Audit and Export](../development/audit-and-export.md) — the read path
  for runtime state.
- [Observability](../development/observability.md) — Grafana / Prometheus /
  Loki entry point.
- [Backup and Retention](../operations/backup-and-retention.md) — how long
  events live; what is replayable.

## Done when

- Your team knows which operator channel to use.
- The on-call alias for delivery failures is bookmarked.
- You have skimmed the [DLQ runbook](../operations/destination-dlq-triage.md)
  so you know what shape of ticket the operator wants.

## Next

[Phase 10 — Troubleshooting](./10-troubleshooting.md) — common failure
modes and the diagnostic move for each.
