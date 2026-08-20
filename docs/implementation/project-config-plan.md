# Project Configuration Plan

Status: **in progress** — foundation landed (C0–C3, C4 write path, C6);
see the workstream table in §13 for per-item state and commits.
Decision: per-`(project_id, environment)` configuration becomes the single
source of runtime key-values for every Polaris service. Services stop reading
environment variables for anything except bootstrap.
Date: 2026-08-12
Owner: Cassio

This is a control-plane redesign, not a refactor. It reverses two documented
architectural rules, changes destination routing behaviour, and touches all 16
services. The plan is sequenced so the platform stays green (tests +
acceptance) at every gate.

It does **not** collapse every per-project mechanism into one, and claiming so
would oversell it. Of the six in §1 it eliminates two outright, gives a
principled home to the values that currently have none, and deliberately
leaves three alone with reasons stated in §14. The win is that the ad-hoc
mechanisms disappear and the remaining ones have a defensible boundary — not
that one table swallows everything.

## Fidelity to the original requirement

> In Projects (eg. `/admin/projects/storefront`) one should be able to declare
> per-environment variables, hydrating them down to consumers. Consumers
> should only see these variables rather than global or .env variables.

| Requirement | Where satisfied | Deviation, if any |
|---|---|---|
| Declare variables on the project page, per environment | §3.1 free-form keys + typed schema keys; §3.6 editor (C5) | None — an earlier draft allowed only schema-declared keys; this version restores declaration to the project page |
| Hydrated down to consumers | Snapshot pull + `NOTIFY` push (§4); assembled JSON per `(project, environment)` | Pull-through-cache with push invalidation rather than literal push — same observable behaviour, survives restarts |
| Consumers see only these variables | §7 bootstrap split, lint-enforced | **Deliberate:** infra coordinates (Postgres/broker DSNs) must stay in env — a consumer cannot fetch config from a database it has no address for. Everything behavioural moves. |
| Consumers receive the `(project, environment)` JSON | §3.5 snapshot | **Deliberate:** each component receives its namespace slice, not the whole bag — the whole bag would put every vendor's resolved credentials in every consumer's heap, defeating the isolation this exists to build |
| Multiple projects; path to tenant isolation | Whole design; free-form keys are the hook for client-owned consumers | Config isolation lands now; authz-level tenancy explicitly out of scope (§14) |

Every decision in this document is made. §16 is the register of what was
decided and why; there is no open-questions section.

---

## 1. Why

"A setting that varies by project" currently has six answers:

| Mechanism | Location | Scope |
|---|---|---|
| YAML catalog | `definitions/projects/`, `definitions/sources/` | project, project+source |
| `destinations` rows | Postgres + `secret_value` | project + env + vendor |
| `processor_activations` rows | Postgres, absence = allowed, fails open | project + env + processor |
| `topic_isolations` rows | Postgres, producer hot path | project |
| Env override strings | `POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS`, `POLARIS_RATE_LIMIT_PROJECT_OVERRIDES` | project |
| Non-secret config inside secrets | GA4's `{measurement_id, api_secret, firebase_app_id}` | project + env + vendor |

The last two are the tell. `apps/ingester-api/src/config.ts:88,176` hand-parses
`"project=value,project=value"` strings, so adding a project means editing a
global env var and redeploying, with no validation, no audit, and no per-key
history. And `sync/destinations/ga4/v1/src/deliverer.ts:232` stuffs `measurement_id`
and `firebase_app_id` — neither of which is a secret — inside the resolved
secret payload, because the secret store was the only per-`(project,
environment)` value store that existed.

A single destination consumer already serves every project on the shared
`analytics.events` stream, so per-project config *cannot* be process
environment by construction.

## 2. Rules being reversed

Both reversals land as explicit edits, not carve-outs.

**"PostgreSQL must not store configuration."**
`db/migrations/20260512000005_create_destinations.sql:44-49` and
`20260512000006_create_processor_activations.sql:53-59` prohibit
`config_blob` / `mapping` / `routing` / `field_map` columns, with tests in
`apps/polaris-cli/test/destinations-commands.test.ts` asserting their absence.
The prohibition is rewritten, not deleted: **PostgreSQL stores values for keys
declared in files; it never stores mappings, routing, transforms, or field
maps.** The tests are replaced with tests asserting that narrower rule, so the
guarantee that "the CLI cannot define semantics" survives intact.

**"The projects admin page is read-only."**
`apps/control-plane-api/src/admin/pages/projects.ts:8-13` refuses create/edit
because a UI that wrote would fork the YAML source of truth against git. That
reasoning holds for project *identity* and is preserved — the page still
cannot create, rename, or retire a project. It gains a per-environment
variables editor that writes values only (§3.6). The catalog stays
authoritative for identity; `project_config` is authoritative for values.
Nothing forks.

## 3. Target architecture

### 3.1 Declaration in code, values in Postgres

The declaration is not a new artifact. Each component already declares its
configuration as a Zod schema in `src/config.ts` — keys, types, defaults,
`required` (today fed from env vars). That schema stays the single source of
truth; the only change is where its input comes from. This follows the repo's
own doctrine — the `.env.example` header states that the Zod schemas define
what is required and documentation derives from them, "if it drifts, the
schemas win."

```ts
export const metaCapiProjectConfigSchema = z.object({
  graph_host: nonEmptyStringSchema.default(DEFAULT_GRAPH_HOST),
  request_timeout_ms: positiveIntSchema.default(5000),
  allow_replay: booleanFromStringSchema.default(false),
  action_source: z.enum(["website", "app", "physical_store"]).default("website"),
});
```

The existing coercion helpers (`booleanFromStringSchema`, `positiveIntSchema`)
already parse string inputs, so a value typed into a form parses exactly as its
env-var predecessor did — which is what keeps each service's cutover diff
small: the schema largely survives, its input source changes.

For the control plane — the admin UI's typed form, `polaris config validate`,
the compatibility check — each component's schema is **exported as a generated
JSON artifact, never hand-written**. This is an established repo pattern, not
an invention: `pnpm openapi` generates the OpenAPI document from the
ingester's Zod schemas and `openapi:check` fails CI when the generated file
drifts from the code (`scripts/openapi-generate.mjs`). `pnpm config-schemas` /
`--check` does the same per component. Enum keys survive
this round trip — `retry_policy IN ('standard','aggressive','conservative')`
and friends are CHECK-constrained enums today, and the generated artifact
carries `values`, so migrating them loses no validation.

**Projects may also declare keys no component schema knows.** The original
requirement is Vercel-style: the project page is where an operator declares a
variable, not just where they fill in blanks a repo PR created. And the
multi-tenancy trajectory requires it — a future client-owned consumer has no
schema in this repo, so its variables *cannot* be schema-declared here.
Free-form keys are accepted, stored, hydrated, and flagged
(`unknown to any component schema`) by `polaris config validate` as a warning,
not an error. They are safe because meaning lives in the reader, not the
store: every platform component parses its slice with a strict-typed schema
and ignores keys it doesn't declare, so a free-form key is inert until some
consumer ships code that reads it. The checkability argument survives intact —
"is storefront/production ready to run meta-capi?" is answered by meta-capi's
generated schema against the stored rows, unaffected by extra keys sitting
beside them.

### 3.2 Schema

```sql
CREATE TABLE project_config (
  project_id    text        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  environment   text        NOT NULL,
  namespace     text        NOT NULL,
  config_key    text        NOT NULL,
  value         jsonb       NOT NULL,
  is_secret     boolean     NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text        NOT NULL,
  PRIMARY KEY (project_id, environment, namespace, config_key),
  CONSTRAINT project_config_environment_allowed
    CHECK (environment IN ('development','staging','production')),
  CONSTRAINT project_config_namespace_format
    CHECK (namespace ~ '^[a-z][a-z0-9_-]{1,62}[a-z0-9]$'),
  CONSTRAINT project_config_key_format
    CHECK (config_key ~ '^[a-z][a-z0-9_]{0,62}[a-z0-9]$'),
  -- A secret-flagged value must be a JSON string. The `provider:ref`
  -- PATTERN this CHECK once required went with the move to stored secrets:
  -- a plaintext credential matches no pattern worth asserting. The string
  -- requirement stays so masking, reveal and redaction each have exactly one
  -- shape to handle.
  CONSTRAINT project_config_secret_is_string
    CHECK (NOT is_secret OR jsonb_typeof(value) = 'string')
);

CREATE TABLE project_config_versions (
  project_id   text        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  environment  text        NOT NULL,
  version      bigint      NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment)
);

CREATE INDEX project_config_lookup_idx
  ON project_config (project_id, environment, namespace);

-- Per-instance vendor config rides the instance row itself (§3.3).
ALTER TABLE destinations
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}';
```

Row-per-key, not one blob per project: per-key audit, per-key type validation,
and partial writes with no read-modify-write race between two operators
editing different keys. The JSON a consumer receives is *assembled* at read
time, so the consumer still gets exactly one object.

`project_config_versions` exists so the invalidation sweep (§4.2) can check
every cached key with one query instead of re-reading values.

`delivery_records` gains `config_version bigint NULL` in the same migration.
It is nullable so it costs nothing before services migrate, and it makes "what
config produced this delivery" answerable from the first migrated service
rather than retrofitted later.

**No separate history table.** `audit_records` already carries `project_id`,
`environment`, `command`, `arguments_redacted`, and `actor_*`, and every config
write goes through the CLI or admin API. It is the change history. A second
append-only table would duplicate it and drift.

### 3.3 Per-instance values live on the destination row

Destination consumers are not purely project-scoped. `destinations` carries
`UNIQUE (project_id, environment, vendor, instance_label)`
(`db/migrations/20260512000005_create_destinations.sql:89`), explicitly so an
operator can run two Meta CAPI instances for the same project and environment —
two pixels, say — and `resolveFanoutTargets` returns *all* of them for
delivery. A key of `(project, environment, namespace)` cannot hold two
different `pixel_id` values for one project.

An earlier draft of this plan solved that by adding an `instance_ref` column
inside `project_config`'s primary key, with an empty-string sentinel for
project-scoped rows. It worked, but it dragged sentinels into the key, an
un-enforceable FK, and pinning that could only run after fan-out resolution.
The simple mechanism was already in the schema: **the instance's values belong
on the instance's row.** `destinations` gains `config jsonb NOT NULL DEFAULT
'{}'`, holding the consumer-interpreted values that distinguish one instance
from its siblings (`pixel_id`; `measurement_id`; webhook-sink's URL and
headers).

Everything an instance needs already travels with that row: the runtime
fetches a `DestinationInstance` per delivery through an existing TTL+LRU cache
(`packages/shared-destinations/src/db/destination-instance.ts`, 60s default,
freshness contract documented in its header), mutations already flow through
audited CLI commands (`destinations create` / `update-ops`), and lifecycle
comes free — config dies with the row, so there is no orphan problem and no
conditional-FK gymnastics. No new cache, no new invalidation path, no sentinel.

Resolution order for a destination consumer, applied at Zod parse:

```text
schema defaults  →  project_config[namespace]  →  destinations.config
```

Shared settings (`graph_host`, `request_timeout_ms`) are set once per project;
distinguishing values are set per instance; the instance wins where both
speak.

**Boundary between the two stores**, stated so it cannot drift back into
ambiguity:

> A value lives in typed `destinations` **columns** if the shared destination
> runtime interprets it — `status`, `mode`, `max_rps`, `max_concurrency`,
> `retry_policy`, `dead_letter_threshold`, `replay_opt_in`. A value lives in
> `destinations.config` if the **consumer's own code** interprets it and it
> varies per instance. It lives in `project_config` if the consumer's code
> interprets it and it is shared across the project. The vendor credential
> stays in `secret_value`.

Consumers with two secrets per instance keep today's answer: `secret_value`
holds one JSON document carrying multiple fields. What changes is that
non-secret values no longer hide in there with them.

### 3.4 Namespace and version coexistence

A namespace is the **component name**, not the component version:
`meta-capi`, `sessionizer`, `ingest`. Two versions of a consumer can run
simultaneously as separate deployments reading the same stream — note that
`destinations` has no `consumer_version` column; only `delivery_records` and
`dlq_records` stamp the version that ran — so v1 and v2 share a namespace and
would otherwise fight over key types.

The rule that makes sharing safe: **within a namespace, config evolution is
additive-only.** A new component version may add optional keys with defaults.
It may not change an existing key's type, remove it, or promote it from
optional to required. A change that needs to break the contract takes a new
namespace (`meta-capi-v2`), and its migration runbook copies values across
first.

A compatibility check enforces this by diffing the **generated schema
artifacts** (§3.1) — the checked-in JSON that `pnpm config-schemas --check`
already keeps in sync with the code — against the previous commit, so
a breaking config change fails its own PR rather than a rolling deploy. Two
files diffed in CI, no database access needed.

### 3.5 What a component receives

A component receives its own namespace and nothing else. meta-capi cannot read
sessionizer's slice, and no component can read another project's values.

```ts
interface ProjectConfigSnapshot {
  readonly projectId: string;
  readonly environment: PolarisEnvironment;
  readonly namespace: string;
  readonly version: bigint;
  readonly values: Readonly<Record<string, unknown>>;
  readonly resolvedAt: number;
  /** Redacts secret-typed values. `JSON.stringify(snapshot)` is safe. */
  toJSON(): unknown;
}
```

Resolution at assembly: schema `default` → stored value. Missing + required is
a hard error, never a silent empty string.

**Slices parse in strip mode, never `.strict()`.** The repo uses `.strict()`
for catalog files, where an unknown field is a typo worth failing on. Here it
would be a footgun: free-form keys (§3.1) are legitimate residents of the same
`(project, environment)` bag, so a consumer that `.strict()`-parsed its slice
would start failing the moment an operator declared any key it doesn't know —
one free-form variable quarantining every project. Strip mode makes undeclared
keys inert by construction, which is precisely the property §3.1's free-form
argument relies on.

**A secret-typed key is marked secret by the server, not the caller.** The
database cannot know which keys are secret — that lives in the component's
schema — so both write surfaces consult the generated artifact and force
`is_secret = true` regardless of what the request said. The flag a caller
passes can only ADD sensitivity, for free-form keys no schema knows about.

This decides rather than refuses, which is the change from the reference era.
Then, omitting the flag meant a credential was about to be written into a
column documented to hold a pointer, and refusing was the only safe answer.
Every value now lives in the same column, so a forgotten flag is not an unsafe
write — it is a value that would be handled carelessly: printed in
`config list`, copied into the audit row. Deciding from the schema fixes that
without making the operator re-run the command with the credential in their
shell history a second time.

**JSON and the secret box.** The stored and wire form is JSON. The in-process
form is a frozen object in which secret-typed values are `Secret<T>` instances
(§6). The snapshot's own `toJSON()` redacts, so the object still *is* the JSON
of that `(project, environment)` pair for every purpose except that printing
it cannot leak a credential. Nothing hands raw plaintext to a serializer by
accident.

### 3.6 Admin UI: per-environment variables at `/admin/projects/{project_id}`

The project detail page gains a **Variables** panel. This is the interface the
requirement names — the CLI is its automation twin, not the other way round.

**Anatomy.** The three environments render as tabs — server-rendered links
carrying `?env=development|staging|production` (default `development`), the
same no-JavaScript filter idiom the rest of the admin uses. Under the active
tab, one table per namespace, and the table *is* the effective view — the
exact object §3.5's snapshot would assemble:

- a row for every key in the component's generated schema, defaults rendered
  greyed with source `default`; stored values with source `set`, plus
  `updated_at` / `updated_by`;
- free-form rows flagged `unknown to any schema` in warning colour;
- missing required keys pinned to the top of their namespace with a red chip,
  and a per-namespace status line ("meta-capi — 2 required keys missing") in
  the panel header. These are the same facts `polaris config validate` prints
  and `/health` lists, read through the same query — three surfaces, one
  truth.
- secret-typed rows show a badge and `[redacted]`. The panel never holds the
  plaintext to begin with: `listProjectConfig` masks on the way out, so a
  careless edit to the renderer cannot leak one. `polaris config get --reveal`
  is the disclosure path.
- namespaces whose consumer is instance-scoped (§3.3) end with a link to that
  project + environment's destination rows; per-instance values are edited on
  the destination detail page, which owns the row's lifecycle, not here.

**Write flows.** Three POSTs, re-rendering the detail page under action URLs
in the house style (`…/keys/x/revoke` precedent):

```text
POST /admin/projects/:projectId/config/:environment/set
POST /admin/projects/:projectId/config/:environment/unset
POST /admin/projects/:projectId/config/:environment/add     (free-form key)
```

- Inputs are typed from the generated schema — enum → `<select>`, boolean →
  select, integer → number field, string → text; secret-typed keys render a
  ref field rejected server-side unless it parses via `parseSecretReference`.
  The `add` form takes namespace (datalist of known namespaces, free text
  allowed), key, and value.
- Authorization is the admin's existing rule, unchanged: resolve the target,
  gate on the **row's** environment in the handler — `admin` for development
  and staging, `POLARIS_ADMIN_PRODUCTION_MIN_ROLE` (default `owner`) for
  production (`admin/actions/authorize.ts`, which also documents why the
  service-env production gate is deliberately not reused here).
- Friction is proportional to blast radius. Every mutation requires the
  reason field (`MIN_REASON_LENGTH`, landing verbatim in the audit record),
  and production forms carry the standard immediate-effect warning banner.
  The full typed-confirmation ritual is reserved for the two shapes that can
  break delivery in one click: unsetting a required key, and changing a
  secret ref in production.
- Concurrent edits: each edit form carries the row's `updated_at` as a hidden
  field and the write is compare-and-set. A mismatch re-renders with a
  conflict notice instead of silently clobbering the other operator. Row-per-
  key storage (§3.2) already makes edits to *different* keys conflict-free.

**Invariants.**

- **One write path.** The three handlers call the same shared mutation
  functions the CLI uses — upsert, version bump, audit record, `pg_notify`,
  one transaction (§4.4). The UI gets no SQL of its own; if the two surfaces
  can disagree, one of them is wrong.
- Project identity stays read-only per §2 — no create, rename, or retire.
- **No bulk ".env import" box, deliberately.** It is the feature an operator
  would most expect and the one that would hurt: it invites pasting a file
  containing live credentials as plain values, straight past the secret-ref
  enforcement in §3.5. The backfill script (§10) is the sanctioned migration
  path; it runs where the real values already live.
- Generated schema artifacts are baked into the control-plane image at build
  time, exactly like the catalog YAML the page header already warns about. A
  component deployed newer than the admin image renders its not-yet-known keys
  as free-form rows rather than typed ones — degraded rendering, never a
  blocked write.

Implementation lands as `admin/pages/project-config.ts` (renderer), reads
added to `admin/queries.ts`, routes registered in `admin/plugin.ts` beside the
destination mutations.

## 4. Cache and invalidation

New package `packages/shared-project-config`.

### 4.1 Transport: Postgres LISTEN/NOTIFY, not Redis

Redis pub/sub was the obvious choice and is the wrong one here. All five
destination consumers compose `service + http + rabbitmq + postgres` and
**none of them has Redis**; among processors only `sessionizer` does. A Redis
bus would add a new runtime dependency, a new failure mode, and new config to
9 of 16 services purely to carry an invalidation message.

Every service already holds a Postgres pool. And `NOTIFY` is delivered *only
when its transaction commits*, which gives transactionally atomic invalidation
natively — no publish-after-commit sequencing to get wrong, no window where a
rolled-back write has already announced itself. There is no pgbouncer in the
stack (transaction-mode pooling would break `LISTEN`), so nothing blocks it.

Cost: one dedicated non-pooled connection per process for the listener. On
reconnect the listener **invalidates everything**, because notifications
during the gap are lost — cheap, and it is the only correct recovery.

### 4.2 Read path

The cache is a bounded in-process LRU keyed
`${projectId}\0${environment}\0${namespace}` — matching the requirement's own
words: stored per project, per environment, once. Per-instance values are not
this cache's problem; they arrive on the `DestinationInstance` row through its
existing cache (§3.3). **Reads never touch the database except on cold miss.**
There is no inline revalidation.

Freshness comes from two independent mechanisms:

1. **`LISTEN polaris_config_changed`** — near-instant. Payload
   `{project_id, environment, version}`.
2. **A background sweep every 10s** — one query for every cached
   `(project, environment)` pair:
   ```sql
   SELECT project_id, environment, version
     FROM project_config_versions
    WHERE (project_id, environment) IN (...);
   ```
   Entries whose version moved are marked stale. This is one query per process
   per tick regardless of how many keys are cached — at ~64 replicas fleet-wide
   that is ~6 queries/second total, which Postgres will not notice.

The sweep is the backstop that makes a missed notification self-healing rather
than permanent. Sweep interval carries ±20% jitter per process so replicas do
not sweep in lockstep after a fleet deploy.

**Invalidation is lazy.** A notification or sweep marks an entry stale; it does
not eagerly refetch. The next reader refetches, single-flighted, so N
concurrent handlers on the same key issue one query and 64 replicas do not
stampede Postgres the instant an operator saves a form.

**Monotonic guard.** Notifications can arrive out of order or duplicated. An
entry is only invalidated by a message whose `version` is strictly greater
than the cached entry's version. A late v4 after a cached v5 is ignored.

**Negative caching.** A `(project, environment)` with no rows is legitimate —
it means "all schema defaults". That result is cached like any other, so an
all-defaults project does not query on every batch. This matches the auth
cache's existing negative-TTL behaviour.

**Bound: 4096 entries.** Keys are projects × environments × namespaces-used-
by-this-process, and a consumer uses one namespace — so 4096 is far above any
realistic fleet. Evictions are metered and alerted; a non-zero eviction rate
means the bound is wrong, not that the cache is working.

**Over-invalidation is a deliberate trade.** The version counter is per
`(project, environment)` while the cache key is per
`(project, environment, namespace)`, so writing meta-capi's config also
invalidates sessionizer's entry for that project. Per-namespace version
counters would avoid it. They are not worth the complexity: writes are
operator actions on the order of one per day, and the cost of over-invalidation
is one extra refetch of a small row set.

### 4.3 Secret-bearing entries need nothing extra

A second, independent freshness deadline lived here, and it is worth recording
why it existed and why it does not any more.

Version-based invalidation was **structurally blind to secret rotation.**
Rotating a credential in Vault did not change `project_config`, so
`project_config_versions.version` never moved, so neither `NOTIFY` nor the
sweep fired. A snapshot holding resolved plaintext would keep a revoked
credential indefinitely — worse than the behaviour it replaced, since the Vault
adapter's own five-minute cache had at least bounded it. The answer was a
separate wall-clock re-resolution deadline, deliberately NOT the sweep interval,
because the two watch different things.

Secrets are now stored values rather than pointers (§6). A secret changes only
by a write to `project_config`, and a write bumps the version and fires
`NOTIFY` in the same transaction — the two mechanisms already described cover
secrets exactly as they cover every other key. A deadline on top would be a
periodic refetch that cannot observe a change the version did not announce, so
`SECRET_REFRESH_DEADLINE_MS` was removed rather than left as a no-op.
`packages/shared-project-config/test/public-surface.test.ts` asserts its
absence, so re-adding one is a deliberate act with a test to change.

### 4.4 Write path

```sql
BEGIN;
  -- upsert project_config rows
  UPDATE project_config_versions
     SET version = version + 1, updated_at = now()
   WHERE project_id = $1 AND environment = $2
  RETURNING version;
  -- insert audit_records
  SELECT pg_notify('polaris_config_changed', $payload);
COMMIT;
```

Values, version bump, audit record, and notification are one transaction.
Rollback un-does all four. There is no ordering to get wrong.

### 4.5 Batch pinning

A batch off `analytics.events` carries events from many projects, so pinning is
a two-pass loop, not a single lookup: scan the batch for distinct
`(project_id, environment)` pairs, `pin()` them in one call, then process every
event against the pinned handle. A batch cannot straddle two project-config
versions, and the pinned `version` is stamped onto
`delivery_records.config_version`. Instance values are read from the
`DestinationInstance` the runtime has already fetched for the delivery, so
they need no pinning pass of their own; their freshness contract is that
cache's existing 60s TTL, the same one `status` and `max_rps` changes ride
today.

A project whose config fails to assemble is skipped for its own events only —
the rest of the batch proceeds. One project's misconfiguration must never stall
a shared stream.

**The ingester does not lazily miss.** It already enumerates projects at
startup for the readiness report (§5), so it prewarms every
`(project, environment)` pair then and relies on `NOTIFY` for projects created
later. A cold miss on the ingest request path serves schema defaults
immediately and warms asynchronously — it never adds a database round-trip to
ingest p99.

### 4.6 API

```ts
export interface ProjectConfigStore {
  /** Cached read; assembles the namespace slice, parsed by the component's schema. */
  get(key: ProjectConfigKey): Promise<ProjectConfigSnapshot>;
  /** Batch-pinned handle held for the lifetime of one batch. */
  pin(keys: readonly ProjectConfigKey[]): Promise<PinnedConfig>;
  invalidate(projectId: string, environment?: PolarisEnvironment): void;
  invalidateAll(): void;
  /** Opens the listener connection and starts the sweep. */
  start(): Promise<void>;
  close(): Promise<void>;
}
```

## 5. Failure semantics

Fail-closed everywhere is wrong here, and the asymmetry is deliberate:

| Path | Missing required key | Store unreachable |
|---|---|---|
| Service startup | **Start anyway**; quarantine that project, list it in `/health`. | **Refuse to start** — cannot serve any project. |
| Ingest (`ingester-api`) | **Fail soft** — apply schema default, meter, serve the request. | Serve last-known cache indefinitely. |
| Processors | Fail soft — schema default, meter. | Serve stale. |
| Delivery (consumers) | **Fail closed** — skip the instance, `reason="config_incomplete"`. | Serve stale. |

**A service never refuses to boot over a project's configuration.** An earlier
draft of this plan had it do exactly that, and the failure mode is
unacceptable: fifty projects, one typo, and every replica of all sixteen
services refuses to start — one project's misconfiguration converted into a
platform-wide outage, caused by the safety mechanism rather than the fault. A
service refuses to start only for conditions that make it unable to serve *any*
project: the config store unreachable at boot.

Per-project incompleteness is instead **quarantined**: the project is excluded
from that namespace's processing, logged once, metered on
`polaris_config_missing_total{project,environment,namespace,key}`, and listed
in the `/health` body so it is visible without log-diving. Every other project
keeps running.

**A quarantined project must never affect `/readyz`.** The platform exposes
`/healthz` and `/readyz` as distinct probes, and an implementation that folded
quarantine into readiness would pull every replica out of rotation the moment
one project's config was incomplete — reintroducing the fleet-wide outage this
whole section exists to prevent, one indirection further away where it is
harder to spot. Quarantine is descriptive state in the `/health` body and a
metric. `/readyz` reflects only whether the process can serve traffic at all.

The blocking gate therefore lives before the deploy, not inside the process
(§11). That is the correct place for it — a config error should stop a rollout,
not a running fleet.

Ingest fails soft because rejecting ingest destroys customer data
irrecoverably, while a wrong dedupe window is degraded-but-recoverable.
Delivery fails closed because sending to the wrong pixel with a defaulted
credential is worse than not sending. `config_incomplete` is a **skip**, not a
DLQ — it is an operator omission, not a data error. It joins
`no_active_destinations` as a label on
`polaris_destination_events_skipped_total`
(`packages/shared-destinations/src/runtime.ts:406`), *not* in
`packages/shared-schemas/src/reason-codes.ts`, which is scoped to the
ingester's batch-response vocabulary.

When the store is unreachable, every path serves the last-known cache
indefinitely and raises `polaris_config_staleness_seconds`. Stalling the
pipeline on a control-plane outage would convert a config problem into an
availability incident.

**Projects created after boot** take the same path — running services do not
restart when `polaris projects sync` adds one, so a new project simply arrives
quarantined until its config lands. `polaris projects sync` gains a post-sync
report listing the required config the new project still needs, so the operator
learns at creation time rather than from a metric.

## 6. Secrets

**Decision: per-project secrets are STORED values, not references.** A
destination's vendor credential lives in `destinations.secret_value` and a
project's sensitive configuration values live in `project_config` with
`is_secret = true` — both plaintext, both in the control-plane database. There
is no provider, no `provider:ref` format, and no resolution step.

This reverses the platform's oldest security rule ("PostgreSQL stores
references, never plaintext") and the reversal is the point of the change, not
a side effect. What it buys: one storage mechanism for everything a project
declares, editable from the admin UI, with no external dependency in the read
path and no propagation story beyond the one §4 already describes. What it
costs, stated plainly because it is permanent: **every reader of the
control-plane database, every `pg_dump`, every replica and every backup carries
live credentials.** Access to that database is access to every project's vendor
accounts.

An earlier revision of this plan kept refs and resolved them during assembly.
Three consequences that revision had to engineer away are simply gone: Vault on
the critical path of every cold assembly, a transient/permanent classification
for resolution failures, and the rotation-latency deadline in §4.3. The
resolver, its adapters and the Vault client were deleted rather than left
unreachable — they had exactly two callers and both are this change.

### What survived, and why

Storage changed. Handling did not, and it is enforced in two independent
places rather than by convention.

**Masking, at the data layer.** Every generic read returns the mask:
`listProjectConfig` and `findProjectConfigValue` funnel through one `toRow`
that replaces a secret value with `[redacted]`, and `DESTINATION_READ_COLUMNS`
simply does not select `secret_value`, so the credential never leaves
PostgreSQL on a list, `show`, export or audit path. Disclosure requires asking
by name: `revealProjectConfigSecret`, one greppable function behind
`polaris config get --reveal`. Destination credentials have no reader at all —
they are write-only through every Polaris surface, set at create, replaced with
`polaris destinations rotate-secret`, the same posture `api_keys.hash` has.

This is deliberately structural rather than a rule each call site follows.
Nine call sites printed, exported, logged or audit-snapshotted the old column
*because its name promised a pointer*; renaming it to `secret_value` made the
compiler visit every one, and moving the guarantee into the SQL means the next
one cannot be added by accident.

**Boxing, at the point of use.** A value a consumer legitimately holds arrives
wrapped:

```ts
class Secret<T = string> {
  #value: T;
  expose(): T { return this.#value; }
  toString() { return "[redacted]"; }
  toJSON() { return "[redacted]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "Secret([redacted])"; }
}
```

Logs, error serialization, DLQ payloads and delivery records redact
automatically; a leak requires an explicit `.expose()`. The box never had
anything to do with where a secret came from — it is about what happens to
plaintext once something holds it, and holding plaintext is now the normal case
rather than the brief one.

**The mask cannot be written back.** Every read returns `[redacted]`, so a
surface that round-trips a read into a write — a form pre-filled from a list, a
script piping `config list` into `config set` — would store that literal string
as the credential, failing much later as an opaque vendor 401.
`setProjectConfigValueWithAudit` refuses it (`MaskedSecretWriteError`) before
touching the database.

**Audit rows carry no secret.** An `audit_records` row outlives the row it
describes, gets exported and is read by more people, so this matters more than
it did when the snapshots held pointers. `before` arrives already masked from
the query layer; `after` is built from caller input and masks explicitly;
`rotate-secret` writes identical `before` and `after` because the only field
that changed is the one field the log may not hold, with `--reason` carrying
the meaning.

### Known properties, not defects

**Heap dumps — irreducible.** Plaintext sits in the heap for the cache lifetime.
JS strings are immutable and GC timing is not controllable, so there is no
zeroing story. The destination runtime no longer even clears its local alias
after a delivery: the credential lives on the cached instance row for the
cache's TTL either way, so clearing an alias would be theatre.

**No encryption at rest beyond the database's own.** Column-level encryption
would need a key, which would need a keystore, which is the dependency this
change removed. If that becomes necessary, it is a real piece of work and
belongs in `docs/architecture/11-production-readiness.md` as such — not a
retrofit.

**Rows written before the cutover hold pointers.** The migration renames the
column but cannot resolve what was in it. Those rows fail every consumer's
secret parse, so the first delivery lands as `failed_permanent` with
`error_class='auth'` naming the destination — loud on the first event rather
than silently misdelivering. Re-enter them with
`polaris destinations rotate-secret`.

## 7. Environment variables

Handler code loses environment access **structurally**. `loadEnv()` is called
once in each service's `main.ts` to build the bootstrap connection; everything
downstream receives a `ProjectConfigContext`. A new
`scripts/lint-process-env.mjs` — joining `lint-clickhouse-imports`,
`lint-nul-bytes`, `lint-dead-exports` in the `lint` script — fails any
`process.env` reference outside a declared bootstrap module.

The rule ships **on day one with a shrinking allowlist** naming every file that
currently violates it. Each service's migration PR deletes its own entries.
Enforcement is therefore incremental and irreversible: a migrated service can
never regress, and the allowlist reaching empty is the completion signal for
the whole programme.

That mechanism also closes six pre-existing holes:
`sync/legacy/analytics-projector/v1/src/app.ts:209` parses `process.env`
directly, and all five consumers pass raw `process.env` into
`EnvSecretProvider`, bypassing the frozen snapshot its own doc comment asks for.

**Corrected 2026-08-13 against the actual codebase.** An earlier revision of
this table estimated "~30 vars move, e.g. sessionizer inactivity, attribution
windows". Both examples were wrong, and the error was about to send a cutover
at a service with nothing to migrate:

- `POLARIS_SESSIONIZER_INACTIVITY_SECONDS` is **semantic**, not tunable. The
  runtime accepts the variable and ignores it, pinning the window to the
  manifest constant, because changing it alters which events v1 emits for the
  same input — that is a v2, not a deployment flag
  (`async/computation/sessionizer/v1/src/app.ts:511`). Moving it into
  `project_config` would let an operator change session semantics from a web
  form, which is precisely what §2's narrowed rule forbids.
- `attribution-engine` has no window variable at all.

**No processor has per-project configuration.** Every processor-specific
variable is a consumer group, a Redis key prefix, or the GeoIP database path —
all deployment-level. The processors are therefore not cutover candidates;
their C11 work is limited to the bootstrap split and the lint allowlist.

Verified per-service inventory:

| Service | Moves to project config | Notes |
|---|---|---|
| `ingester-api` | `INGEST_PROJECT_DEDUPE_WINDOWS`, `RATE_LIMIT_PROJECT_OVERRIDES` (deleted, superseded) + `INGEST_DEDUPE_DEFAULT_WINDOW_SEC`, `RATE_LIMIT_PER_API_KEY_RPS`, `INGEST_MAX_BATCH_EVENTS` become per-project with the same values as defaults | The two override strings are the design's motivating case |
| 5 destination consumers | `*_ALLOW_REPLAY`, `*_API_HOST` / `*_GRAPH_HOST`, `*_REQUEST_TIMEOUT_MS` (3 × 5 = 15) | Plus GA4's `measurement_id` / `firebase_app_id`, extracted out of the resolved secret into `destinations.config` (§3.3) |
| 6 processors | none | consumer groups, key prefixes, and the GeoIP path stay in env |
| Everything else | none | |

So roughly **20** variables move, of 103 — the rest are bootstrap
(postgres, rabbitmq, redis, clickhouse, http, service identity, log) or
per-deployment tuning that has no project dimension. The smaller number does
not weaken the case: the two comma-separated override strings it deletes are
the mechanism this whole plan exists to replace.

## 8. Destination fan-out gains a project filter

`packages/shared-destinations/src/runtime.ts:274` caches
`findActiveByVendor(vendor, environment)` and fans one envelope out to every
active instance of that vendor in that environment. `project_id` rides the
envelope and is stamped onto metrics, but is **not** a routing key — so an
event from project A already delivers to project B's destination row of the
same vendor. Resolving config by envelope `project_id` while routing ignores
it would be incoherent, so the filter lands with this work.

- `findActiveByVendor(vendor, environment)` →
  `findActiveByVendorAndProject(vendor, environment, projectId)`; the
  `activeTargets` cache key gains project.
- The `polaris-destination-id` header override (the replay path,
  `runtime.ts:280-281`) returns before fan-out resolution and is unaffected.
- **Pre-merge gate, discharged.** The plan called for joining
  `delivery_records` against `destinations` to enumerate instances currently
  receiving foreign-project events, on the grounds that every delivery it
  listed would stop. The gate was right and is now moot: the platform is
  pre-production, so there is no delivery history to enumerate and no
  dependency to break. The query
  (`scripts/fanout-cross-project-blast-radius.sql`) was deleted with the
  filter rather than left as a script whose header instructs the reader to run
  it against a production that does not exist.

## 9. Replay

Replay jobs reprocess historical events, so "which config?" must be answered
explicitly rather than fall out of implementation.

**Replay uses current config, and records the version it used.** Rationale:
replay is an operator-initiated corrective action, and delivering with
credentials that may since have been rotated or revoked fails the whole job for
no benefit. The alternative — config as of original event time — would also
resurrect a destination configuration the operator has deliberately moved away
from.

The replay job's `config_version` is stamped on every `delivery_records` row it
produces, so a replay is distinguishable from the original delivery by config
lineage. `docs/architecture/05-processors-and-replay.md` records the semantics,
and the `replay_opt_in` gate is unchanged.

## 10. Backfill

Values do not appear by themselves. `scripts/backfill-project-config.mjs`,
idempotent and `--dry-run` first, seeds `project_config` for every existing
project × environment from:

- the ~30 migrating `POLARIS_*` variables and their current deployed values,
- the two comma-separated override strings, expanded to one row per project,
- `measurement_id` and `firebase_app_id` **extracted out of** GA4 resolved
  secret payloads into each instance's `destinations.config`, leaving
  `api_secret` as the only genuinely secret field.

That last item shrinks the secret surface as a side effect and is the clearest
demonstration that the mechanism is doing its job.

The backfill runs per service, immediately before that service's cutover PR
deploys — not as one big-bang seed, so a failed backfill blocks exactly one
service.

**It runs as a one-shot job inside the target environment, not from a
workstation.** Its inputs are the currently deployed values, which live in that
environment's process environment and secret store — never in the repo. Run
locally, it would faithfully seed development values into production. The job
writes `updated_by = 'migration'`, reusing the actor vocabulary
`audit_records` already defines, so a backfilled row is distinguishable from an
operator edit forever.

## 11. Cutover and rollback

**Big-bang per service.** Each service's PR deletes its environment path in the
same commit the config path lands. No dual-read, no fallback, no dead code.

Big-bang is only safe with a gate that runs *before* the rollout, and CI cannot
be that gate — a PR pipeline has no access to production's `project_config`
table, so it can only check things that live in the repo. The two are split:

1. **In CI, per PR:** generated-schema drift (`pnpm config-schemas --check`,
   the `openapi:check` pattern) and the additive-only compatibility
   rule (§3.4). Catches "this schema change would break an existing project"
   at review time.
2. **As a pre-deploy job in the target environment:**
   `polaris config validate --env <env> [--component <ns>]`, run against that
   environment's own database with the rollout blocked on its exit code. It
   enumerates projects *and* active destination rows — a consumer with an
   instance schema is only complete when every active instance's
   `destinations.config` satisfies it, so validating per project would miss a
   newly created second pixel entirely. It lists missing
   `namespace[.instance].key` triples and warns (exit 0) on keys unknown to
   every schema (§3.1). There is no `--resolve`: with secrets stored rather
   than referenced, "is the value present" is the whole check, and there is no
   provider to dereference against.

3. **`pnpm lint:project-config-keys`**, which asks the question the two gates
   above cannot: does the component actually READ each key it declares?
   Declaring a key is what creates operator surface — a typed input in the
   Variables panel, a settable `config set`, a row in `config list` — and none
   of that requires the component to consume it. meta-capi shipped
   `allow_replay` in exactly that state: declared, generated, rendered,
   settable, and inert, because replay suppression runs in the runtime long
   before the deliverer the slice is handed to. No type error and no test
   catches that; this check does.

Quarantine (§5) is the runtime backstop underneath both, not a substitute for
either: it keeps a fifty-project fleet alive when one project is incomplete,
while these two gates keep incomplete config from reaching a rollout at all.

**Rollback insurance.** A rolled-back image reads environment variables the new
deployment manifest no longer sets. So each service's cutover PR **leaves its
env vars in the deployment manifests, inert, for one release.** The code has no
dual-read — the variables are simply unread — but rollback stays a pure image
revert with no manifest surgery under incident pressure. A single sweep PR
deletes them once every service has been stable for a release.

**Discharged, because the premise does not hold here.** The insurance is for a
deployed fleet with a previous image to revert to; this platform is
pre-production and has neither. C12 therefore ran immediately rather than a
release later. The reasoning above stands for the first cutover made after a
production deployment exists.

## 12. Observability

Following the `polaris_<component>_<thing>_<unit>` convention already in use:

| Metric | Type | Purpose |
|---|---|---|
| `polaris_config_cache_lookups_total{namespace,result}` | counter | `result` = `hit` \| `miss` \| `stale` \| `peek_hit` \| `peek_miss` — peek results are separate so request-path fallbacks do not distort the hit-rate gauge |
| `polaris_config_resolve_duration_seconds{namespace}` | histogram | cold-miss assembly cost incl. secret resolution |
| `polaris_config_missing_total{project,environment,namespace,key}` | counter | required key absent — alerts on any non-zero |
| `polaris_config_invalidations_total{source}` | counter | `source` = `notify` \| `sweep` \| `reconnect` |
| `polaris_config_staleness_seconds{project,environment}` | gauge | age of the cached version vs. last swept |
| `polaris_config_cache_evictions_total` | counter | non-zero means the 4096 bound is wrong |
| `polaris_config_listener_up` | gauge | 0 when the LISTEN connection is down |

The operational signal that matters: if `NOTIFY` delivery breaks,
`polaris_config_staleness_seconds` climbs to the sweep interval and plateaus.
If the sweep also breaks, it climbs without bound. One alert on that gauge
covers both mechanisms failing.

## 13. Workstreams

| # | Workstream | Depends on | Parallel? |
|---|---|---|---|
| C0 | **LANDED** `3a3e842` — single-source the environment enum (§15). Card `8KY5SKZX` | — | — |
| C1 | **LANDED** `611e496` — migrations, Kysely types, narrowed prohibition. Card `WDKNARYV` | C0 | — |
| C2 | **LANDED** `1442a2d` — read store: LRU, sweep, LISTEN/NOTIFY, single-flight, monotonic guard, `Secret<T>`. Card `Q54PQL99` | C1 | — |
| C3 | **LANDED** `88b8db9` — `pnpm config-schemas` / `--check`, additive-only compat check (§3.4). Registry empty until the first service exports a schema. Card `WFHTKR4A` | C1 | with C2 |
| C4 | **LANDED** `ba34527` — `polaris config get/set/unset/list/invalidate` + audited write path (card `VCJ896JN`); `99fbcfe` — `validate` and the projects-sync report (card `K8XNVW4T`). The pre-deploy validate job is NOT built: it gates a rollout, and there is no deploy pipeline to gate | C2, C3 | — |
| C5 | **LANDED** `f0a2692`, hardened in `8082ecd` — admin UI Variables panel per §3.6: three mutation routes, env tabs, effective view, free-form add, CAS conflict handling, server-decided ritual. Card `MEW685DZ` | C4 | yes |
| C6 | **LANDED then REVERSED.** `07eb4cb` shipped `createSecretResolver`, the transient/permanent split and five consumers off `process.env` (card `FR74FN42`). Superseded when per-project secrets became stored values: the resolver, its adapters and the Vault client had no callers left and were deleted (§6). The `process.env` half of the work stands. | C2 | yes |
| C7 | **LANDED** `e394682`, corrected in `9af465d`. Card `R3Q68W3E`. The allowlist's debt section is empty as of `b813e10` — both ClickHouse-connection readers were fixed rather than baselined | C2 | yes |
| C8 | **LANDED.** Fan-out project filter — `findActiveByVendorAndProject`, and the target cache keyed by project as well as environment. The pre-merge blast-radius query it was gated on is gone with it: the gate existed to enumerate live deliveries the filter would stop, and a pre-production platform has none | C2 | yes |
| C9 | **LANDED** `db0d231` — `seedProjectConfig` and the acceptance scenario's `control_plane_project_config` step (card `H2VXR9DP`), plus `tests/integration/project-config.test.ts` covering write → NOTIFY → store against real PostgreSQL. The smoke harness seeds no project config and needs none: it asserts the vertical slice, and every key falls back to a deployment default | C4 | yes |
| C10 | **LANDED** `29c9892` — `scripts/backfill-project-config.mjs`, registry-driven, `--env` checked against `POLARIS_ENV`, audited writes, idempotent, dry by default. Card `T7BNQK52` | C4 | yes |
| C11 | Per-service cutover: config path in, env path out, allowlist entry deleted, backfill run. **All six participating components landed** — ingest, meta-capi, ga4, tiktok, braze, webhook-sink. The other ten services have no per-project configuration to move (§7); a cutover card for them would have had nothing in it | C7, C9, C10 | 6-way |
| C12 | **LANDED.** The two per-project override strings are out of `docs/deployment/config-reference.md`, replaced by a note naming what they became and how to migrate an environment that still sets one. The one-release delay §11 specifies was rollback insurance for a deployed fleet; there is none | C11 | — |
| C13 | **LANDED** `7e9ff07` (architecture 02/11, deployment, operations, onboarding, release checklist, `.env.example` rewrite, `secret-rotation.md` rewritten end to end), `b813e10` (`docs/README.md` perimeter wording), `bd6387f` (the GA4 app-stream rotation runbook, card `MRFBR8X3`) | C11 | — |

Critical path is C0 → C1 → C2 → C4 → C11. C3 runs alongside C2; C5–C10 all
unblock at C4 and run in parallel; C11 is 16 independent PRs and is where the
calendar time goes. C6 blocks only the five consumers, not the ingester or
processors, so consumer cutovers can be scheduled after it while processor
cutovers proceed in parallel.

Each workstream becomes a kanban card with write-scope allow/forbid lists and
acceptance criteria in the repo's existing card format.

## 14. Caveats

**`forbidden-fields` should not move.**
`definitions/policy/forbidden-fields.<project_id>.ts` is PII policy — a safety
control, not a tuning knob. DB-editable means an operator can weaken PII
protection from a web form with no code review. It stays in files. If it must
move, it moves with a merge rule permitting only strengthening (adding
forbidden fields), never removal.

**`topic_isolations` should not move.** It changes stream topology rather than
behaviour, is read on the producer hot path with its own cache
(`packages/shared-transport/src/isolation-cache.ts`), and a stale read there
misroutes events rather than mistuning them. Different consistency
requirement, different mechanism.

**`processor_activations` folds in later, deliberately.** It is a genuine
per-`(project, environment)` toggle and fits the model, but it fails *open* on
DB error (`packages/shared-processor/src/activation-gate.ts:129-140`) while
config resolution fails closed at startup. Merging them silently changes a
gate's failure semantics, so it is a follow-up card with that change made
explicit — not a quiet consequence of this work.

**A schema change can invalidate every project.** Adding a required key with
no default makes every existing project invalid and blocks every deploy. The
additive-only rule in §3.4 is what prevents it, enforced by diffing the
generated artifacts in CI — the one check that *can* run in a PR, since it
compares two checked-in files and needs no database. A schema PR that would
break an existing project fails its own build.

**Config is not a security perimeter.** `docs/README.md:45` states project
boundaries are an operational scoping device, and authorization remains by
platform role, not project membership — any admin can read and write every
project's config. This plan delivers isolation between *components and
processes*, which is real. It does not deliver tenant isolation, and nothing
here should be described as multi-tenancy until the authorization model
changes to match. C13 updates that sentence to say so precisely.

**Sixteen services change config loading.** `tests/acceptance`, `tests/smoke`,
`tests/integration`, and every docker-compose file inject configuration through
the environment today. That is C9, scoped and sequenced before C11 rather than
discovered during it.

**The listener adds a connection per replica.** `LISTEN` cannot run on a pooled
connection, so the store opens a dedicated raw `pg.Client` alongside the Kysely
pool — `pg ^8.20.0` is already a direct dependency of
`packages/shared-db`, so this adds no new package. At ~64 replicas it is 64
extra connections against `max_connections`: small, but it must be checked
against deployed Postgres sizing before C2 ships, not after.

**Secret-bearing snapshots cost nothing extra.** An earlier revision of this
plan re-resolved them on a 5-minute clock regardless of traffic — one Vault
round-trip per `(project, environment)` per 5 minutes per replica, ~300
resolutions per 5 minutes at 20 projects × 3 environments × 5 replicas. Stored
secrets removed both the round-trip and the clock: a secret-bearing snapshot is
now exactly as expensive as any other, which is one row read on a cold miss.

## 15. Prerequisite

The environment enum is forked three ways and must be single-sourced before
anything keys on `(project_id, environment)`:

- `packages/shared-config/src/schemas/common.ts:11` — adds `local`
- `packages/shared-schemas/src/envelope/primitives.ts:42` — adds `test`, omits `local`
- six other definitions agree on `development | staging | production`

Left alone this produces rows one service can write and another cannot read.
Cheap now, expensive once there is data.

## 16. Decision register

| Decision | Choice | Why |
|---|---|---|
| Storage granularity | Row-per-key | Per-key audit and validation; no read-modify-write race between operators |
| Change history | `audit_records`, no new table | Every write goes through CLI/admin; a second table would drift |
| Invalidation transport | Postgres LISTEN/NOTIFY | 9 of 16 services have no Redis; all 16 have Postgres; NOTIFY-on-commit is atomic with the write |
| Freshness backstop | 10s jittered sweep, one batched query | Notification loss must self-heal |
| Secret storage | Plaintext in the control-plane database | One mechanism for everything a project declares, editable from the UI, no external dependency in the read path. Costs: the database and its backups become credential material (§6) |
| ~~Secret freshness~~ | ~~Separate 5-min re-resolution deadline~~ | Removed with stored secrets: a secret changes only by a write, which already bumps the version and fires NOTIFY (§4.3) |
| ~~Secret resolution failure~~ | ~~Transient retryable, permanent DLQs~~ | Removed with stored secrets: reading a column has no resolution step to fail (§6) |
| ~~Restricting `env:` in production~~ | ~~Warn, refuse under strict~~ | Removed with the provider abstraction itself |
| Secret disclosure | Masked at the data layer; reveal is a named function | Nine call sites leaked the old column because its NAME promised a pointer. Moving the guarantee into the SQL projection means the next one cannot be added by accident (§6) |
| Destination credential reads | Write-only; no read path at all | Nothing an operator does needs the current value — "is it right?" is answered by delivery history, "change it" by rotation. Same posture as `api_keys.hash` |
| Revalidation shape | Batched version sweep, not per-key inline | ~6 queries/sec fleet-wide; read path never blocks on I/O |
| Invalidation behaviour | Lazy mark-stale + single-flight refetch | Eager refetch stampedes Postgres when 64 replicas hear one save |
| Out-of-order notifications | Monotonic version guard | Duplicated/reordered NOTIFY must not downgrade a fresher entry |
| Cache bound | 4096 LRU, evictions alerted | Far above realistic fleet size; eviction means the bound is wrong |
| Secrets in snapshot | Resolved values, boxed in `Secret<T>` | Operator's call; boxing removes the serialization leak class |
| Namespace scheme | Component name, additive-only evolution | `destinations` has no version pin; v1/v2 coexist and share a namespace |
| Declaration model | Zod schema in each component's code; JSON artifact generated + CI drift-checked | The repo's stated doctrine ("if it drifts, the schemas win") and its `openapi:check` precedent; hand-written manifest YAML would be a second source of truth |
| Free-form project keys | Allowed; validate warns, never blocks | The original requirement ("declare … variables" on the project page) and the client-owned-consumer future both need keys no repo schema knows; strip-mode parsing keeps them inert |
| Per-instance values | `destinations.config jsonb`, merged over the project slice | Supersedes the earlier `instance_ref`-in-PK design: the instance row already exists with its own cache, audited mutations, and lifecycle — no sentinel, no conditional FK, no pin-after-fan-out |
| Slice parsing mode | Strip, never `.strict()` | A `.strict()` consumer would quarantine every project the moment one free-form key was declared |
| `destinations` typed columns | Stay put; nothing migrates | Shared-runtime knobs vs. consumer-interpreted values is the boundary — moving working columns is churn with no gain |
| Value types | Whatever the component's Zod schema expresses | Enum values are CHECK-constrained today; the schema keeps that validation, and coercion helpers make string inputs parse like env vars |
| UI write path | The CLI's shared mutation functions, verbatim | Two surfaces that could disagree means one is broken; the UI gets no SQL of its own |
| UI mutation friction | Reason always; typed confirmation only for unset-required and production secret changes | The house ritual exists for rare destructive acts; applying it to every value edit teaches operators to click through it |
| UI authorization | Gate on the row's environment, in the handler | `admin/actions/authorize.ts` documents why the service-env gate is a non-protection here; production rows escalate to `POLARIS_ADMIN_PRODUCTION_MIN_ROLE` |
| Bulk `.env` import | Excluded | Invites pasting live credentials as plain values past the secret-ref enforcement; the backfill job (§10) is the migration path |
| Replay config | Current config, version stamped | Rotated credentials would fail the job; stale config resurrects abandoned setup |
| Startup failure mode | Start and quarantine the project | Refusing to boot turns one project's typo into a fleet-wide outage |
| Quarantine vs. `/readyz` | Body field and metric only; never affects readiness | Folding it into readiness recreates the same outage one indirection away |
| Secret write enforcement | CLI ref-parse plus DB CHECK on the ref pattern | Two layers; the DB one holds against direct SQL, keeping plaintext out of Postgres absolutely |
| Value types | `string \| integer \| number \| boolean \| enum \| string[]` | The values being migrated include enums already CHECK-constrained; scalars only would lose existing validation |
| Blocking gate location | Pre-deploy job in the target environment | CI cannot see production's config table; a config error should stop a rollout, not a running fleet |
| Ingest failure mode | Fail soft to manifest default | Rejecting ingest destroys customer data irrecoverably |
| Delivery failure mode | Fail closed, skip not DLQ | Wrong pixel is worse than no send; operator omission is not a data error |
| Store unreachable | Serve stale indefinitely, alert | Control-plane outage must not become an availability incident |
| Cutover | Big-bang per service | Operator's call; made safe by the pre-deploy validate gate plus runtime quarantine |
| Namespace vs. version counter granularity | Version per `(project, environment)` | Over-invalidates across namespaces; writes are ~1/day so the extra refetch is cheaper than per-namespace counters |
| Rollback | Inert env vars kept one release | Rollback stays a pure image revert under incident pressure |
| Lint enforcement | Ship day one with shrinking allowlist | Incremental, irreversible; empty allowlist is the completion signal |
| `delivery_records.config_version` | Added in C1, nullable | Costs nothing early; forensics work from the first migrated service |
