# Versioning and Build Metadata

Polaris uses a **hybrid versioning model** that separates semantic version
from operational build version. Both are surfaced through every runtime
artifact; operators bisect production behaviour by reading them together.

This is the operator-facing reference. The platform contract lives in
`docs/architecture/09-engineering-standards.md` "Versioning and Releases";
the implementation in P11-001 (Dockerfiles + build args) and P11-007
(shared helper + release label).

## The two axes

### 1. Semantic version (immutable, by directory)

Processor and consumer versions live in the directory name:

```text
processors/
  geoip-enricher/v1/
  identity-resolver/v1/v2/
  ...
consumers/
  meta-capi/v1/
  ...
```

Released semantic versions are **immutable**: any output-changing
behaviour is a new directory (`v2`), not an edit of `v1`. The semantic
version is what `delivery_records.consumer_version`,
`processor_runs.processor_version`, and event-envelope `processor.version`
fields record. It is what an operator pins when configuring a destination
instance or scheduling a replay job.

Internal `packages/` use a separate axis — pnpm-workspace semver on the
package `version` field. Bumping a shared package never forces a
processor/consumer directory bump.

**Bump v1 → v2 when:**

- Mapping logic changes
- Identity rule changes
- Attribution rule changes
- Output schema changes
- Filtering behaviour changes
- Enrichment semantics change

**Do NOT bump v1 → v2 for:**

- Security patches with no behaviour change
- Dependency upgrades
- Observability improvements
- Bug fixes that align actual behaviour with the documented contract

The full list lives in `docs/architecture/05-processors-and-replay.md`
"Processor Versioning".

### 2. Build version (operational, rolls forward on every release)

Every runtime artifact also stamps **four build-time identifiers** that
roll forward on every release of the same semantic version:

| Field           | Source                                | Container ENV          | OCI label                            | `/health` field   |
| --------------- | ------------------------------------- | ---------------------- | ------------------------------------ | ----------------- |
| Package version | `package.json` + git describe         | `POLARIS_BUILD_VERSION` | `org.opencontainers.image.version`   | `version`         |
| Git SHA         | `git rev-parse HEAD`                  | `POLARIS_GIT_SHA`       | `org.opencontainers.image.revision`  | `git_sha`         |
| Build time      | `date -u +%Y-%m-%dT%H:%M:%SZ`         | `POLARIS_BUILD_TIME`    | `org.opencontainers.image.created`   | `build_time`      |
| Release label   | Operator-supplied at deploy time      | `POLARIS_RELEASE_LABEL` | (none — runtime only)                | `release_label`   |

The first three are **build args** baked into the image. The release label
is a **runtime environment variable** set at container start: the same
image can run under different release labels in different rollouts. This
is deliberate — the release label is the operator's free-form tag for a
human rollout that may bundle many services with distinct package
versions (e.g. `2026-q2-r1` covers ingester `1.4.0` + meta-capi `0.7.2` +
identity-resolver `2.1.0`).

The shared helper `getBuildMetadata()` in
`@polaris/shared-service-bootstrap` resolves the four fields from the
above sources and is what every service should use; see
`packages/shared-service-bootstrap/src/bootstrap/build-metadata.ts`.

## Where it shows up

An operator inspecting a running service sees the same four fields in
**three surfaces** that must agree:

1. **OCI layer** — `docker inspect <image>`:
   ```bash
   docker inspect polaris/ingester-api:1.4.0 \
     --format '{{json .Config.Labels}}' \
     | jq '{version: ."org.opencontainers.image.version", revision: ."org.opencontainers.image.revision", created: ."org.opencontainers.image.created"}'
   ```
2. **HTTP layer** — `GET /health`:
   ```bash
   curl -s http://ingester:4000/health | jq '{version, git_sha, build_time, release_label}'
   ```
3. **Log layer** — every JSON log line carries `service`, `version`,
   `env`, and `release_label` (when set) as Pino bindings.

The polaris-cli `polaris version` command emits the same shape:

```text
polaris 1.4.0
node v22.16.0 · sha abc1234 · built 2026-05-12T10:00:00Z · release 2026-q2-r1
```

`polaris version --output json` produces the structured shape.

## Records that pin the semantic version

Runtime records that participate in replay lineage pin the **semantic
version only** — not the operational build version. The replay control
plane targets `consumer_version=v1`, not `consumer_build_version=2026-q2-r1`.
This is intentional: replays must remain reproducible across operational
rebuilds.

| Table                  | Column                       | Axis                |
| ---------------------- | ---------------------------- | ------------------- |
| `processor_runs`       | `processor_version`          | semantic            |
| `replay_jobs`          | `target_processor_version`   | semantic            |
| `delivery_records`     | `consumer_version`           | semantic            |
| `delivery_records`     | `consumer_build_version`     | **operational** (M0DROHV3) |
| `delivery_records`     | `normalize_version`          | semantic (sub-axis) |
| `delivery_records`     | `mapper_version`             | semantic (sub-axis) |
| `delivery_records`     | `deliverer_version`          | semantic (sub-axis) |
| `dlq_records`          | `consumer_version`           | semantic            |
| `audit_records`        | (none — captures actor)      | —                   |

`delivery_records.consumer_build_version` (added by M0DROHV3) is the
one operational-axis column on the runtime-record surface. It carries
whatever `getBuildMetadata()` resolves at consumer startup
(`releaseLabel || gitSha || serviceVersion`); existing rows written
before the migration stay NULL.

For the remaining runtime tables, operational build metadata (package
version, git SHA, build time, release label) is still **not** stamped
on the rows. When an operator needs to reconstruct exactly which build
produced a non-delivery row, the join points are:

- the row's `created_at` timestamp,
- the rollout timeline (release labels + their start/end windows tracked
  separately by the deploy system),
- the image registry's per-tag history.

Adding `processor_build_version` to `processor_runs` is **deferred** —
it duplicates information the rollout timeline already carries, would
invalidate every existing index, and would force a write-coordination
change on every record-writing path. See
`agents/pm/kanban/done/P11-007-release-versioning-and-build-metadata.md`
"Known gaps".

## When does each axis bump?

| Change                                                          | Semantic? | Build?     |
| --------------------------------------------------------------- | --------- | ---------- |
| Bug fix in `processors/identity-resolver/v1/src/runtime.ts`     | no        | yes        |
| Tightening a typo log message                                   | no        | yes        |
| Patch upgrade of `kafkajs`                                      | no        | yes        |
| Adding a new vendor field to `consumers/meta-capi/v1/mappers/`  | YES (v2)  | yes        |
| Changing identity-graph merge rules                             | YES (v2)  | yes        |
| Changing default dedupe window                                  | no        | yes        |
| Changing the consumer-group name in operational settings        | no        | yes        |
| Shipping a coordinated release of every service                 | no        | yes (all)  |

If the change can alter emitted event meaning, identity links,
attribution outcomes, filtering behaviour, or output schema, it is
semantic and requires a new directory.

If the change is operational (build, observability, dependency, runtime
knob), the build version rolls forward but the directory does not move.

## Reading a production incident

When a behavioural change shows up in production:

1. Check `/health.release_label` on the affected service to identify the
   rollout. If the label is unset, the deployment did not opt in to label
   tagging — fall back to `/health.version` + `git_sha`.
2. Diff `git_sha` against the previous known-good rollout to find the
   exact commit range.
3. If `consumer_version` / `processor_version` is the same across the
   change boundary, the regression is operational — look at the build's
   dependency changes, runtime knobs, or rollout config.
4. If `consumer_version` / `processor_version` differs, the regression
   is semantic — the operator chose to flip a destination or processor
   activation onto a new directory. Diff the two version directories.

## Conventions

- Release labels are free-form but should follow a stable scheme so they
  sort meaningfully: `YYYY-qN-rN` (e.g. `2026-q2-r3`) is the
  recommended pattern. Calendar dates (`2026.05`) also work.
- A single release label SHOULD span every service in a coordinated
  rollout. Mixing labels within one rollout defeats the purpose of the
  field.
- The label is operational metadata — it does not participate in replay
  lineage and is not stamped on `delivery_records`.
- An empty / unset `POLARIS_RELEASE_LABEL` is acceptable for ad-hoc
  rollouts; the field surfaces as `null` on `/health` and is omitted
  from log lines.

## See also

- `docs/architecture/05-processors-and-replay.md` — processor immutability rule
- `docs/architecture/06-destinations.md` — consumer immutability rule
- `docs/architecture/09-engineering-standards.md` — "Versioning and Releases"
- `infra/docker/build-args.md` — the three Dockerfile build args
- `infra/docker/README.md` — image inventory and inspection commands
- `packages/shared-service-bootstrap/src/bootstrap/build-metadata.ts` — helper source
