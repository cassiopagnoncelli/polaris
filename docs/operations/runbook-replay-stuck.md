# Replay Stuck / Failure Runbook

Operators use this runbook when an executing replay job stops making
progress for the v1 default 30-minute threshold, or fails outright.

Binding architecture references:

- [Processors and Replay](../architecture/05-processors-and-replay.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)
- [Control Plane](../architecture/02-control-plane.md)

The polaris-cli surface for replay lives at
[`apps/polaris-cli/src/commands/replay/`](../../apps/polaris-cli/src/commands/replay/).
The replay-job state model lives at
[`apps/polaris-cli/src/db/replay-jobs.ts`](../../apps/polaris-cli/src/db/replay-jobs.ts);
statuses are `pending`, `planning`, `dry_run`, `running`, `paused`,
`completed`, `failed`, `cancelled`. The Prometheus rule that triggers
this runbook lives at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisReplayJobStuck` | page | a `running` replay job makes no progress for 30 minutes |

**v1 metric gap.** The replay coordinator does not yet emit a
progress gauge; the alert is wired with the v1 threshold but will
not fire until `polaris_replay_job_progress_offset` lands alongside
`polaris_replay_job_status`. Until then, operators discover stuck
replays from the CLI (`polaris replay list`, `polaris replay show`).
The gap is tracked in [`docs/operations/alerts.md`](alerts.md).

This runbook also covers the related "operator gate denial spike"
warn (also a `_TODO_` v1 metric); the credential-confusion symptom
that fires it overlaps with replay-operator workflows.

## Symptoms

- `polaris replay list --status running` shows a job that has been
  in `running` for an unexpectedly long time.
- `polaris replay show <replay_job_id>` reports a stale
  `progress.last_event_at`.
- Downstream consumers see the expected replay traffic stop arriving
  partway through the configured window.
- The job's progress logs (the replay coordinator's structured logs)
  stop emitting `replay.progress` events.

## Probable causes, ranked

1. **Coordinator pod restart.** The replay coordinator was restarted
   mid-replay. It should resume from the checkpoint; if it doesn't,
   the resume logic is the suspect (cause #5).
2. **Downstream processor unhealthy.** The replay target processor
   is lagging or DLQ-flooding; the coordinator throttles emit to
   match. Cross-reference
   [`runbook-processor-lag.md`](runbook-processor-lag.md).
3. **Kafka publisher errors.** Same root cause as
   [`runbook-redpanda-publish-failures.md`](runbook-redpanda-publish-failures.md);
   the replay coordinator can't push events into the replay topic.
4. **Replay window mis-specified.** The `--window` start is after
   the end (so no events match) or the `--target` resolves to an
   empty source. The job sits in `running` but completes 0 events.
5. **Checkpoint corruption.** The replay coordinator's progress
   checkpoint (stored in PostgreSQL) is inconsistent and the
   coordinator can't decide where to resume.
6. **Operator gate denied a control-plane call.** The coordinator
   tried to call back into the control plane (e.g. to mark a step
   complete) and the P6-007 production gate rejected the call —
   correlates with the operator-gate-denial warn.

## Investigation

### 1. Identify the stuck job

```bash
polaris replay list --status running --limit 20
```

Sort by `created_at` and find rows older than the threshold (30
minutes by default; longer for known long-running replays).

### 2. Inspect job state

```bash
polaris replay show <replay_job_id>
```

Output renders the full row: `mode`, `target`, `window_from`,
`window_to`, `status`, `progress`, `last_event_at`, `created_by`,
`created_at`. Compare `last_event_at` to the current time; if it's
older than 30 minutes the job is stuck. The `mode` field reveals
whether this is a dry-run (low-impact) or a real replay (operator
attention).

### 3. Read coordinator logs

```logql
{polaris_service="polaris-replay-coordinator"}
  | json
  | replay_job_id="${REPLAY_JOB_ID}"
  | environment="${ENVIRONMENT}"
```

Look for the last `event="replay.progress"` and then for whatever
errored after it: a `level=error` row with a stack trace, a
`level=warn` row about back-pressure, or silence (the coordinator
crashed). Silence past a `replay.progress` line points at cause #1
(restart).

### 4. Check downstream health

```bash
polaris processors runs --processor <target_processor> --limit 10
```

Surfaces the target processor's recent run history. If recent runs
are failing or paused, the replay is correctly waiting on a sick
downstream.

Cross-reference the Grafana dashboard UIDs:

- `polaris-per-project-lag` for consumer lag,
- `polaris-per-project-schema` for rejection rates.

### 5. Verify the replay window has events

```bash
polaris replay plan \
  --target <target> \
  --window-from <iso> \
  --window-to <iso> \
  --project <project_id> \
  --env <env>
```

`replay plan` is read-only; it returns the count of source events
matching the window without executing. If it returns 0, cause #4
(empty window) is confirmed.

### 6. Check audit log for control-plane denials

```bash
polaris audit list --action replay.advance --since <iso8601>
```

Or, if the operator-gate denials track separately:

```bash
polaris audit list --target-type replay_job --limit 30
```

A burst of denials points at cause #6 (gate denied a step).

## Mitigations

### Short-term

- **Resume the job:**
  ```bash
  polaris replay resume <replay_job_id>
  ```
  Mutating; audited. If the coordinator was restarted and the
  checkpoint is fine, resume picks up where the job left off.
- **Pause and inspect:**
  ```bash
  polaris replay pause <replay_job_id> --reason "investigating stuck job"
  ```
  Mutating; audited. Pausing prevents the coordinator from making
  any more partial progress while you debug.
- **Cancel and re-plan:**
  ```bash
  polaris replay cancel <replay_job_id> --reason "..."
  ```
  When the cause is #4 (mis-specified window) or #5 (corrupt
  checkpoint), cancel the job and re-plan from scratch with a
  validated window.
- **Fix downstream first.** When the cause is cause #2 (lagging
  processor) or cause #3 (Redpanda publish failures), the replay is
  correctly waiting; resolve the downstream per the corresponding
  runbook, then `polaris replay resume`.

### Long-term

- **Land the replay progress metric** so this runbook stops
  depending on CLI polling; tracked in
  [`docs/operations/alerts.md`](alerts.md). The expected metric is
  `polaris_replay_job_progress_offset{replay_job_id, status}`.
- **Add a replay coordinator dashboard** to
  [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/)
  once the metric ships.

## Escalation

Page the on-call data engineer if:

- the replay is `failed` and the failure message indicates data
  loss (a replay that lost track of its checkpoint),
- the stuck job is blocking a compliance / contractual deadline
  (e.g. a customer requested replay for an attribution window),
- resume + downstream fix does not unblock progress within 60
  minutes.

Page the security rotation when the operator-gate-denial warn
fires repeatedly for replay operations — repeated denials suggest
either a credential issue or an attempted unauthorized replay.

## Cross-references

- [Processor Lag Runbook](runbook-processor-lag.md) — common
  downstream cause of stuck replays.
- [Redpanda Publish Failures Runbook](runbook-redpanda-publish-failures.md) —
  common upstream cause of stuck replays.
- [DLQ Growth Runbook](runbook-dlq-growth.md) — when a stuck
  replay's DLQ traffic exceeds thresholds.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
