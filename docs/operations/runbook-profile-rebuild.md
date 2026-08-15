# Runbook: rebuilding a project's profile plane

`polaris profiles rebuild --project X --env Y --reason "..." --yes`

## When to run this

Polaris merges profiles from evidence, and evidence can be wrong: a shared kiosk, a recycled email address, an identifier that should have been on the denylist and was not. The symptom is an over-merged profile — one `profile_id` that is demonstrably two people.

There is no "split this profile" operation, and deliberately so. Unpicking a merge in place means deciding which of the survivor's identifiers, traits, sessions and attribution chains belonged to which side, and every one of those answers would be a guess dressed as a repair.

So the profile plane is rebuilt from the events instead. Fix the rule first — add the identifier to the denylist, correct the resolver's configuration — then rebuild. What comes out is what the current rules would have concluded all along, which is the only available definition of correct.

## What it does, and why the order is not negotiable

```
pause  ->  truncate  ->  replay  ->  resume
```

- **pause** stops the resolver writing to this project's profile scope, and returns only once in-flight resolutions have drained. Before the truncate, or live traffic writes profiles into the scope being emptied and the rebuild races itself.
- **truncate** empties the project's profile plane.
- **replay** re-runs `raw.events` for the project through the resolver.
- **resume** lifts the pause. After the replay, or the same events arrive twice — once replayed, once live — and the resolver's advisory locks serialise them into a merge nobody asked for.

Three of the four possible orderings are wrong and two of them are wrong quietly. That is why this is one command rather than four.

## Read this before you run it: rebuild depth is bounded

The replay reaches back only as far as `raw.events` is retained. **A profile whose first sighting is older than the retention window is rebuilt from its visible history only.** A customer of five years comes out with a `first_seen_at` of however many days you retain.

The command prints this and records `depth_bounded_by: raw_events_retention` with the retention in days on the job. It is not a warning to click past: an operator who rebuilds to fix one over-merged profile and silently truncates the lineage of every profile in the project has been handed a worse problem than the one they started with.

If the project's history matters more than the over-merge, do not rebuild. R10 adds an archive replay source that lifts the bound; until it lands, the honest options are to accept the lineage loss or to live with the bad merge.

## Required configuration

`POLARIS_RESOLVER_METRICS_URL` — where `sync-identity` publishes
`polaris_processor_in_flight`. **No default, deliberately.** A default would
let a rebuild run against whatever answered on localhost, and the one thing
the drain probe must never do is report "drained" because it asked the wrong
process.

`POLARIS_RABBITMQ_STREAM_RETENTION_DAYS` — how far back `raw.events` reaches.
Defaults to 90 and is reported on the job, not assumed; see the depth
section above.

## Production requires an operator token

`--project` is the entire blast radius. A mistyped project id does not fail — it succeeds, against the wrong project, and the only remedy is another rebuild. In `production` the command refuses any actor source other than `operator_token`.

## If it crashes mid-rebuild

The job row records `steps_completed`, so the state is diagnosable rather than mysterious:

| `steps_completed` | State | What to do |
|---|---|---|
| `[]` | Nothing happened. | Re-run. |
| `["pause"]` | Resolver paused, plane intact. | The command resumes on any exit; confirm the resolver is running, then re-run. |
| `["pause","truncate"]` | **Plane is empty.** | Re-run immediately. The project resolves every event to a new profile until you do. |
| `["pause","truncate","replay"]` | Rebuild finished, resume failed. | Resume the resolver by hand via the activation gate. Nothing is lost. |
| `["pause","truncate","replay","resume"]` | Done. | Nothing. |

The command runs `resume` in a `finally`, so a failure after the pause does not leave the resolver stopped on top of an empty plane — that would turn a failed repair into an outage. If the resume itself fails, the job shows `replay` present and `resume` absent, which is the second-to-last row above.

## After a rebuild

Profile ids change. Anything holding a `profile_id` from before the rebuild is holding a dangling reference:

- ClickHouse history keeps the old ids. `polaris.profile_merge_map` maps merges, **not** rebuilds — a rebuild is not a merge and does not write to it. Person-keyed queries over the rebuilt window resolve correctly; queries spanning the rebuild boundary will see the same person under two ids.
- Destination vendors keep whatever `external_id` they were sent. Polaris does not re-send after a rebuild, by design (see `docs/architecture/06-destinations.md`).

Both are consequences of never rewriting history, and both are why a rebuild is a repair of last resort rather than routine maintenance.
