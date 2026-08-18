# Processor Version Cutover Runbook

Operators use this runbook to move a project from one processor version
to the next — or to roll the move back — using the worked example of
attribution-engine v1 → v2.

Binding architecture references:

- [Processors and Replay / Processor Versioning](../architecture/05-processors-and-replay.md)
- [Processors and Replay / State Stores](../architecture/05-processors-and-replay.md)
- [Control Plane / Processors](../architecture/02-control-plane.md)

The CLI surface lives at
[`apps/polaris-cli/src/commands/processors/`](../../apps/polaris-cli/src/commands/processors/).
Activation state lives in `processor_activations`, keyed by
`(processor_name, processor_version, project_id, environment)`.

## Why a cutover is not a deploy

Processor versions are immutable in semantic behaviour. A new version is
a new directory with its own manifest, its own consumer group, and — for
any processor holding state — its own state. Rolling one out is
therefore not "ship the new build" but "start the new version, confirm
it, stop the old one", with a window in the middle where both run.

Two properties make that window safe, and both must hold before you
start. Confirm them for whatever processor you are cutting over:

| Property | attribution-engine | How to confirm |
|---|---|---|
| Separate consumer group | `polaris-attribution-engine-v1` / `-v2` | `processor.manifest.yaml` → `defaults.consumer_group` |
| Separate state | `attribution_touchpoint_chains` is keyed by `processor_version` | the table's primary key |

If a processor has neither, both versions consuming at once will fight
over offsets or corrupt shared state, and the procedure below does not
apply — that processor needs a stop-then-start cutover with the
downtime that implies.

## Activation is per version

`processor_activations` keys on the version, so enabling v2 does **not**
disable v1. That is deliberate — it is what makes a dual-run possible —
but it means the "disable the old one" step is a step you must actually
take. Forgetting it leaves both versions emitting to
`attribution.events` forever, which double-counts every touchpoint
downstream.

**Absence means enabled.** A version with no activation row is running,
not stopped. `polaris processors list` prints

```text
attribution-engine v1 ...
    (no activation rows in processor_activations)
```

for a version that is live for every project — the gate only closes on
an explicit `disabled` row. So a cutover does not *move* a row from v1 to
v2; it creates one row enabling v2 and a second row disabling v1. The
audit trail shows this as `(no row) -> disabled`, which is the signature
of the first time anyone has ever stopped that version.

## Standard cutover procedure

Throughout: `--env` is one of `development | staging | production`, and
production mutations require an operator token (P6-007).

### 1. Confirm the target version exists and reads as expected

```bash
polaris processors show attribution-engine --version v2
```

Check the window, the consumer group, and `release_status: released`.
A version whose manifest is missing on disk is a deployment that has not
shipped the code yet; enabling it would activate nothing.

### 2. Check what is currently running

```bash
polaris processors list
polaris processors runs list --processor attribution-engine
```

`list` shows activations — what *should* run. `runs list` shows
`processor_runs` — what *did*. If the two disagree, resolve that before
cutting over: enabling v2 while v1's activation and runs already
disagree makes the result unattributable.

### 3. Deploy v2 alongside v1

Deploy the v2 service with `POLARIS_ATTRIBUTION_ENGINE_CONSUMER_GROUP`
left at its default (`polaris-attribution-engine-v2`). Do not reuse v1's
group: the group is the offset namespace, and inheriting v1's position
would make v2 skip everything v1 already read rather than build its own
chains.

At this point v2 is running but gated off — its activation row does not
exist, so the gate refuses every message. That is the intended state.

### 4. Enable v2 for one project

Start with a low-volume project in a non-production environment.

```bash
polaris processors enable attribution-engine --version v2 \
  --project <project_id> --env staging
```

Both versions now consume the same input. Expect **more**
`attribution.events` traffic during the dual-run — roughly double, since
each version emits its own events with its own `touchpoint_id`s.

### 5. Verify v2 before stopping v1

```bash
polaris processors runs list --processor attribution-engine --version v2
```

Then in ClickHouse, compare the two versions over the same slice.
Derived events land in `analytics_processed`, so:

```sql
SELECT processor_version, event, count() AS n
FROM polaris.analytics_processed
WHERE project_id = {project:String}
  AND occurred_at >= now() - INTERVAL 1 HOUR
  AND event LIKE 'attribution.%'
GROUP BY processor_version, event
ORDER BY processor_version, event
SETTINGS final = 1;
```

What to expect, and what each divergence means:

- **v2 emits more `first_touch_assigned` than v1.** Correct. That is the
  window doing its job — identifiers returning after a >90-day gap start
  a new chain. If the counts are identical, the window is not taking
  effect and something is wrong.
- **v2 emits no `touchpoint_captured` at all.** v2 is not consuming.
  Check its activation row and its consumer group.
- **`touchpoint_id`s differ between versions.** Expected — the hash
  material is version-scoped. Join on the source `event_id` in
  `properties_json` to compare like for like.

### 6. Disable v1 for that project

```bash
polaris processors disable attribution-engine --version v1 \
  --project <project_id> --env staging
```

Traffic should return to its pre-cutover volume within one batch
interval. Confirm with the same query.

### 6b. Confirm the audit trail

Both mutations write an `audit_records` row in the same transaction as
the activation change, so the cutover is reconstructable afterwards:

```sql
SELECT to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at,
       action,
       target_id,
       coalesce(before->>'enabled_state', '(no row)') AS before,
       after->>'enabled_state'                       AS after
FROM audit_records
WHERE action IN ('processors.enable', 'processors.disable')
ORDER BY created_at;
```

`target_id` is the composite
`<name>:<version>:<project>:<environment>`, so one query covers every
scope you touched. A cutover reads as an `enable` of the new version
followed by a `disable` of the old one; a half-finished cutover is
visible as an enable with no matching disable.

### 7. Repeat per project, then per environment

Cut over the remaining projects, then promote to production. Production
mutations are audited and require a token; every enable/disable writes
an `audit_records` row in the same transaction as the activation change.

### 8. Prune v1's chains once nothing can roll back

v1's chain rows survive the cutover and stay readable — deliberately, so
a rollback works. Once you are certain there is no rollback:

```sql
-- Operator SQL, not a CLI command. `polaris processors chains-prune`
-- deliberately REFUSES v1: v1 has no attribution window, so deleting
-- its chains would change its output if it ever ran again.
DELETE FROM attribution_touchpoint_chains WHERE processor_version = 'v1';
```

That refusal is the point — the command will not let you do this by
accident. Running it by hand is the explicit acknowledgement that v1 is
never coming back for this data.

## What this procedure has been exercised against

All of it, including the data path.

Steps 1, 2, 4, 6, 6b and the rollback were run against a live control
plane (`storefront` / `development`) with the audit assertions. Two
runbook errors surfaced that way: `processors show` did not print
`release_status`, and this document did not say that a version with no
activation row is running rather than stopped.

Steps 3 and 5 were then run as a real dual-run: both versions consuming
`resolved.events` from the same broker, each on its own consumer group,
against one PostgreSQL. Two touchpoints for one identifier 120 days
apart produced exactly the divergence step 5 predicts — v1 continued the
chain (`touchpoint_count` 2, first touch still January), v2 reset it
(count back to 1, first touch moved to May) and emitted three events to
v1's one for the second touchpoint.

That dual-run found a bug no unit test had: v2's reset wrote through the
same upsert as a continuation, whose UPDATE branch deliberately never
rewrites the `first_*` columns. The reset chain came out anchored to the
touchpoint that had just expired while its count said it had restarted.
Fixed in v2 (`startChain` vs `set`), with a regression test on which
method the runtime reaches for. If you are cutting over a different
processor that keeps state, that is the class of bug worth looking for:
a write path that was only ever exercised on an empty row.

## Rollback procedure

Rollback is the cutover in reverse, and it works precisely because
nothing was deleted:

```bash
polaris processors enable  attribution-engine --version v1 --project <p> --env <e>
polaris processors disable attribution-engine --version v2 --project <p> --env <e>
```

v1's chains are exactly as it left them, so it resumes with the same
first-touch anchors it had before. Its consumer group still holds its
own offsets, so it resumes where it stopped — expect it to work through
whatever backlog accrued while it was disabled.

What rollback does **not** undo: the `attribution.events` v2 emitted
during the dual-run are already downstream. Consumers that treat
`first_touch_assigned` as authoritative will have seen v2's extra
resets. If that matters, roll back and then replay v1 over the affected
window rather than assuming the stream is clean.

## Troubleshooting

**Both versions still emitting after the cutover.** The disable did not
land, or landed for a different scope. Activation is per
`(name, version, project, environment)` — a disable for `staging` leaves
`production` running. `polaris processors list` shows every row.

**v2 enabled but nothing is emitted.** Three causes in likelihood order:
the service is not deployed; its consumer group is wrong so it is
reading a position with nothing after it; or the activation row names an
environment the service is not running in.

**Attribution results changed more than expected.** Compare the window
against the gap distribution in your data — if most identifiers return
inside 90 days, v2's output should be close to v1's. A large divergence
means either a long-idle population (legitimate) or a `last_observed_at`
that is not what you think (check for a replay that rewrote chains).

**A dual-run doubled downstream destination deliveries.** Destinations
consume `resolved.events`, and both versions' output reaches them.
Keep dual-runs short, and prefer a low-volume project for the first one.

## Cross-references

- [`async/computation/attribution-engine/v3/CHANGELOG.md`](../../async/computation/attribution-engine/v3/CHANGELOG.md)
  — what changed and what to expect
- [Backup and Retention / Attribution chain retention](./backup-and-retention.md)
  — pruning v2's chains on an ongoing basis
- [Topic Isolation Cutover](./topic-isolation-cutover.md) — the same
  shape of procedure for a different axis
