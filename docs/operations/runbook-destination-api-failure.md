# Destination API Failure Runbook

Operators use this runbook when a destination instance is failing
delivery at a rate that breaches the v1 default threshold of 1% over
five minutes.

Binding architecture references:

- [Destinations](../architecture/06-destinations.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)
- [Control Plane](../architecture/02-control-plane.md)

The shared destination runtime emitting the failure counter lives at
[`libs/delivery/destinations/`](../../libs/delivery/destinations/).
The CLI surface this runbook uses lives at
[`apps/polaris-cli/src/commands/destinations/`](../../apps/polaris-cli/src/commands/destinations/)
and [`apps/polaris-cli/src/commands/deliveries/`](../../apps/polaris-cli/src/commands/deliveries/).
The Prometheus rule that triggers this runbook lives at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

This runbook is the **alert entry point**. The detailed DLQ triage
workflow once failures cross into DLQ rows lives in
[`destination-dlq-triage.md`](destination-dlq-triage.md); cross-link
out, do not duplicate.

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisDestinationDeliveryFailureRate` | page | per-instance delivery failure share >1% of consumed events over 5 minutes |

Pivot is the immutable instance identity
(`vendor`, `consumer_version`, `destination_id`); the recording rule
`polaris:destination_delivery_failure_ratio:rate5m` pre-aggregates
the ratio.

## Symptoms

- The destination delivery failure alert fires for one
  `(vendor, destination_id)` pair.
- `polaris_destination_events_failed_total` rate climbs while
  `polaris_destination_events_delivered_total` rate drops.
- Producer-side dashboards show analytics-events being emitted
  normally; the lag accumulates downstream of the destination
  consumer.
- Operators see vendor-side 4xx/5xx in the destination's structured
  logs.

## Probable causes, ranked

1. **Vendor incident.** The vendor's API is returning 5xx for some or
   all requests. Symptoms cluster across destinations of the same
   vendor regardless of `destination_id`.
2. **Vendor rate-limiting.** The destination instance is hitting its
   per-key rate cap and the runtime's retry budget can't absorb the
   spike. `polaris_destination_rate_limit_wait_ms_last` climbs.
3. **Stale credential.** `error_class='auth'` (401 / 403) on the
   destination's delivery attempts. The credential in
   `destinations.secret_value` has been rotated, revoked or expired at
   the vendor.
4. **Vendor contract change.** The vendor accepted the payload
   yesterday and rejects it today; a vendor changed their schema or
   tightened validation. `error_class='permanent'` (vendor 4xx with
   stable error code).
5. **Mapper regression.** A recent consumer / mapper version
   produces payloads the vendor rejects. Surfaces as
   `error_class='mapping'` or `error_class='permanent'` with a
   consistent error code from one consumer version onward.
6. **Network egress issue.** The destination consumer pod cannot
   reach the vendor's endpoint (DNS, firewall, mTLS issue). Surfaces
   as TCP-level errors in logs, not vendor responses.

## Investigation

### 1. Identify the affected instance(s)

Prometheus query:

```
topk(10,
  polaris:destination_delivery_failure_ratio:rate5m
)
```

Pivots the worst 10 destination instances. If multiple destinations
of the SAME vendor are simultaneously failing, the cause is
vendor-side; if only one is failing, it's instance-specific.

### 2. Inspect recent deliveries

```bash
polaris deliveries list <destination_id> --status failed_retryable --limit 20
polaris deliveries list <destination_id> --status failed_permanent --limit 20
```

The rows surface `vendor_response_status`, `error_class`, and a
1 KB-truncated `vendor_response_summary`. Cluster by `error_class`:

- `auth` → cause #3 (credential).
- `rate_limit` → cause #2 (rate limit).
- `permanent` → cause #4 or #5 (vendor contract or mapper).
- `retryable` → cause #1 (vendor incident).
- `network` → cause #6 (egress).

### 3. Check the vendor's status page

For first-party vendors (Meta CAPI, GA4, Klaviyo, etc.), open their
public status page. A confirmed incident at the vendor resolves cause
#1 and turns this into a "wait it out" situation; the destination
runtime's retry budget will handle the recovery automatically.

### 4. For `auth` errors, verify the credential

```bash
polaris destinations show <destination_id>
```

The output does NOT render the credential — it cannot, by design. Use
the audit trail instead:

```bash
polaris audit list --action destinations.rotate-secret --target <destination_id>
```

Compare the last rotation timestamp against when the vendor says the
credential changed. A vendor-side rotation with no corresponding Polaris
rotation is the smoking gun.

### 5. Read the destination consumer's logs

```logql
{polaris_service=~"polaris-destination-consumer.*"}
  | json
  | destination_id="${DESTINATION_ID}"
  | level=~"error|warn"
  | environment="${ENVIRONMENT}"
```

The log payload carries `event_id`, `vendor_response_status`, the
attempt count, and the runtime's classification. For network errors,
this is the only place to see them (no DLQ row is written for early
connection failures).

## Mitigations

### Short-term

- **For a vendor incident (cause #1):** wait for the vendor.
  Polaris's runtime retries with exponential backoff and respects
  `Retry-After` headers; the destination DLQ will absorb only the
  permanent failures. Consider extending the retry budget on the
  destination via `polaris destinations update-ops` if the vendor is
  slow to recover.
- **For rate limiting (cause #2):** lower the destination's
  concurrency / batch-rate knob via
  `polaris destinations update-ops`. Audited.
- **For a stale credential (cause #3):** `polaris destinations
  rotate-secret <id> --secret-value <new> --reason <why>`. The runtime
  picks up the new value within the 60s instance-cache window — no
  restart. See the [secret rotation runbook](secret-rotation.md).
- **Disable the destination during triage:**
  ```bash
  polaris destinations disable <destination_id> \
    --reason "Vendor 5xx; pausing during incident"
  ```
  Audited per P6-007. Re-enable with
  `polaris destinations enable <destination_id>`.

### Long-term

- **Bump the consumer / mapper version** when the vendor's contract
  changed (cause #4). Register the new version, point the
  destination at it via `polaris destinations update-ops`, and let
  the destination drain its lag.
- **Roll back the consumer version** when the recent rollout
  introduced a regression (cause #5).
- **Network egress fix** (cause #6) is infrastructure work —
  Polaris's destination consumers should always have direct egress
  to vendor endpoints.

## Escalation

Page the on-call data engineer if:

- failure rate exceeds 5% for more than 15 minutes,
- the failure is destination-specific (single instance) but
  rotating the credential or bumping the consumer version doesn't
  recover it,
- multiple destinations are simultaneously affected and no vendor
  status page confirms an incident (suggests our problem).

Page the security rotation when `error_class='auth'` correlates
across multiple destinations sharing a credential — a shared
credential being rotated without coordination, or a credential
leak, are both security events.

Page the infrastructure rotation when network errors (cause #6)
appear from one Polaris cluster region but not others — points at
egress / DNS / firewall.

## Cross-references

- [Destination DLQ Triage Runbook](destination-dlq-triage.md) — once
  failures cross into DLQ rows, the detailed triage workflow.
- [DLQ Growth Runbook](runbook-dlq-growth.md) — alert entry when
  the failure rate turns into DLQ accumulation.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
- [SLOs](slos.md) — the destination delivery latency SLO posture.
