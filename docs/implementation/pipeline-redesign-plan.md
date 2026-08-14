# Pipeline Redesign Plan: the Staged Main Pipeline and the Profile Plane

Status: accepted 2026-08-14 (decision doc, per the scope-discipline rule in
`delivery-roadmap.md`). Supersedes the fan-out processing topology described in
`docs/architecture/00-overview.md` once accepted. Builds on the project-config
programme (`project-config-plan.md`), which has landed, and does not replace it.

> **Landed since first draft (2026-08-13, same day):** the C programme
> completed on `main` — the admin Variables panel, backfill, validate,
> process-env lint, the ingester and all five destination-consumer cutovers
> (consumers now receive a per-`(project, environment)` config slice through
> `DelivererContext.projectConfig`), and **C8**: destination fan-out routes on
> `project_id`, closing the cross-project delivery defect this plan cited.
> Separately, per-project secret storage was reversed: the secret resolver and
> Vault layer are deleted; `destinations.secret_ref` is now write-only
> plaintext `secret_value` (rotated via `polaris destinations rotate-secret`)
> and `project_config.is_secret_ref` became `is_secret`. Consequences for this
> plan: R3's routing gate rides the landed config seam instead of introducing
> one; nothing here depended on Vault; R7's reverse-ETL ingester key is an
> `is_secret` config value. Affected sections are amended below.

This is the "R programme". It restructures Polaris's processing model around
the shape that Segment's pipeline settled on, adapted to Polaris's RabbitMQ
backbone, file-heavy semantics, and internal posture. The reference model is
preserved in full: all five sync stages **and all six async pipelines** —
journeys and scheduled warehouse/profile syncs included — have designed,
sequenced workstreams. It is deliberately a map of everything required;
individual workstreams get their own cards.

---

## 1. Why

### 1.1 The reference model

Segment's main pipeline is a staged, per-event path. Five stages, in order:

```text
1. Ingest         SDK sends the raw event; schema validated and cleaned
2. Identity       identifiers matched against the identity graph inline;
                  profile found or created
3. Enrichment     latest pre-computed profile traits attached to the event
4. Per-dest       filters drop or pass the event; attributes mapped into the
                  destination's format
5. Delivery       the reshaped event is sent to each destination's API
```

Everything else is an async support process that feeds or reads the main path
without sitting on it: warehouse loads, computed traits and audiences,
retroactive profile merges, profiles-to-warehouse sync, reverse ETL, journey
orchestration.

The load-bearing property: **the event that reaches a destination has already
been resolved and enriched.** Destinations receive one artifact that carries
the person, not just the identifiers the producer happened to have.

### 1.2 What the current fan-out costs

Polaris today fans out from `raw.events` into parallel sibling streams:

```text
raw.events ──┬─> analytics-projector ─> analytics.events   (verbatim passthrough)
             ├─> geoip-enricher      ─> enriched.events    (geo facts, siblings)
             ├─> sessionizer         ─> session.events
             └─> identity-resolver   ─> identity.events    (link facts, siblings)
analytics.events ──> destinations + clickhouse-sink + attribution-engine
```

`00-overview.md` states the principle: "There is no enriched copy of a source
event anywhere in the system." The consequences, all observable in the code
today:

- **Destinations never see resolved identity.** They consume
  `analytics.events`, which is `raw.events` re-published verbatim
  (`processors/analytics-projector/v1/src/transform.ts` copies every field).
  Match quality is whatever the producer sent: Meta CAPI builds `external_id`
  only when the event itself carried `customer_id`; GA4's `client_id` is
  synthesized from the delivery key (a documented v1 shortcut) so server
  events cannot stitch to browser sessions; Braze can only build a profile
  from fields present on that one event.
- **Nothing reads the identity work we do.** `identity_links` has exactly one
  writer and zero readers. The resolver's output is an audit trail, not an
  input to anything.
- **Three processors reinvent identity, each weakly.** The sessionizer keys
  sessions on `customer_id > anonymous_id > session_id`, so a login changes
  the key and orphans the pre-login session (no `session.ended`, no
  stitching). The attribution engine keys chains the same way, so a chain
  fragments at the anonymous→known transition — exactly the moment
  attribution exists to survive. The resolver records the link but neither
  consumer can use it.
- **There is no person.** No profile store, no canonical person ID, no
  traits (both SDKs accept `identify(customerId, traits)` and discard the
  traits), no computed traits, no audiences. `identify()` does not even emit
  an event; linking is inferred from identifier overlap on the next event.
- **Retroactive correction is impossible by construction.** `identity.merged`
  records that a merge happened; re-attribution of history is "deferred to
  later identity work" in three separate files, and replay cannot express it
  (replaying re-runs the same rule on the same events).

None of these are implementation bugs. They are the fan-out shape working as
designed. The design is what this plan changes.

### 1.3 Why now

The migration surface is close to its minimum. Only two producer events are
registered in the catalog (`page.viewed`, `checkout.started`); four of the
five events the vendor mappers support are not registered at all, so only
`checkout.started` can traverse ingest→delivery end to end today. The
destination consumers, ClickHouse contracts, and SDKs are all v1 with a
single blueprint project. Every quarter of real adoption makes this cutover
more expensive.

---

## 2. Target architecture

### 2.1 The two planes

**The main pipeline** is the per-event, low-latency path from SDK to the
destination APIs. It is a staged line, not a diamond:

```text
SDKs / producers
    |
    v
ingester-api            Stage 1  Ingest: authenticate, stamp, validate,
    |                            policy reject/redact, dedupe-lease, publish
    v
raw.events              immutable producer facts (unchanged, still the
    |                   replay source and the retention anchor)
    v
identity resolver       Stage 2  Resolve: match identifiers against the
    |                            profile store; find-or-create; merge.
    |                            ALL profile-store writes live here
    |                            (bindings, merges, trait patches);
    |                            stamps profile_id onto the event
    v
identified.events       intermediate family: profile stamped, not yet
    |                   enriched. Short retention; regenerable
    v
enrichment stage        Stage 3  Enrich: attach the latest traits
    |                            snapshot (profile-store READ) and the
    |                            context enrichers (geo); stamps
    |                            `profile.traits` + `enrichment`
    v
resolved.events         THE canonical spine. Same event_id as the source
    |                   event; envelope now carries platform-owned
    |                   `profile` and `enrichment` blocks
    v
destination consumers   Stage 4  Transformation: per-instance
    |                            subscriptions, consent, project scoping;
    |                            then normalize -> map
    v
vendor APIs             Stage 5  Deliver: batching, retries with real
                                 backoff, rate limits, DLQs, delivery
                                 records
```

The main pipeline is only the line above. Everything else that reads
`resolved.events` is an **async-pipeline tap on the spine — a reader of it,
not a stage of it**:

```text
resolved.events --> clickhouse-sink        --> analytics_raw (+ profile_id)
resolved.events --> sessionizer v2         --> session.events
resolved.events --> attribution-engine v3  --> attribution.events
resolved.events --> journey-orchestrator   --> profile.events   (R11, later)
```

**The async pipelines** are the six background processes of the reference
model. They feed or read the main pipeline without adding latency to it, and
every stream-attached unit of them lives under `async/` (§2.3):

| Process | Polaris implementation |
|---|---|
| Warehouse sync | Two halves: `clickhouse-sink` (exists; streaming — ClickHouse is ours and takes streams) **plus scheduled batch exports** to object storage: the raw archive (replay beyond the 90-day stream window) and Parquet loads for any external warehouse (§6.2) |
| Trait & audience computation | `async/computation/`: sessionizer v2 and attribution-engine v3 — background aggregations over the spine, keyed by `profile_id` (§2.4) — plus code-defined computed traits and audiences from ClickHouse projections, written into the profile store, changes emitted on `profile.events` |
| Retroactive merges | new worker consuming `identity.merged`: maintains the ClickHouse merge map; history is re-interpreted at read time, never rewritten |
| Profiles sync | `profile.updated` events → clickhouse-sink → `profiles` table in ClickHouse (streaming), plus the scheduled profile export riding the warehouse-export job (§6.2) |
| Reverse ETL | new `async/reverse-etl/runner`: scheduled repo-defined ClickHouse queries whose rows re-enter the platform as canonical events through the ingester |
| Journeys | `journey-orchestrator` processor: versioned code-defined journeys, participant state machine in Postgres, wait timers, actions as canonical events through the existing destination path (§6.1) |

### 2.2 Stream families, before and after

```text
Family              Today                          Target
raw.events          producer facts                 unchanged (6 partitions)
analytics.events    raw passthrough (the spine)    RETIRED after cutover
enriched.events     geoip sibling facts            RETIRED (geo folds into Stage 3)
identified.events   —                              NEW: intermediate between the
                                                   identity and enrichment
                                                   stages (6 partitions, key =
                                                   profile_id, short retention;
                                                   regenerable, never a replay
                                                   anchor)
resolved.events     —                              NEW: the spine (6 partitions,
                                                   partition key = profile_id)
identity.events     link facts                     kept; schema v2 adds profile ids
session.events      session facts                  kept (emitted by sessionizer v2)
attribution.events  attribution facts              kept (emitted by attribution v3)
profile.events      —                              NEW: profile.updated,
                                                   trait.computed,
                                                   audience.entered / .exited
```

`identified.events` and `resolved.events` partition by
`project_id:environment:profile_id`. This is strictly stronger than today's
`best_available_identity` key: after Stage 2, every event for a person rides
one partition regardless of which identifier the producer sent, so the
sessionizer, the attribution engine, and every destination consumer inherit
per-person ordering. Width matches `raw.events` (6) because it carries the
same volume.

Two mechanics the implementation must respect. First, this is a **new
builder** (`buildProfilePartitionKey`) beside the existing
`buildRawEventsPartitionKey`, not an edit to it: the identity fallback
chain in `partition-key.ts` is a wire contract, and inserting `profile_id`
at its head would silently re-partition `raw.events` itself mid-deploy —
the precise failure the streams doc warns about. Second, profile-less
events (§4.2 step 1) fall back to `event_id`, which is correct: with no
person to order against, there is no ordering to preserve.

### 2.3 The repository tree is the pipeline map

Processors form the backbone of specific stages of specific pipelines, so
their placement should say which pipeline and which stage. The flat
`processors/` + `consumers/` directories are retired in favour of a
hierarchy keyed `{sync,async}/{stage}/{name}/{version}`:

```text
sync/                              the main pipeline, in stage order
  identity/
    resolver/v1/                   stage 2 — the profile store's only writer:
                                   find-or-create, merge, trait patches;
                                   stamps profile_id
  enrichment/
    runtime/v1/                    stage 3 runtime — composes the pinned
                                   enricher versions into one process
    traits/v1/                     enricher: latest traits snapshot (store read)
    geoip/v1/                      enricher: geo from context.ip
  destinations/                    stages 4–5 — one consumer per vendor;
    webhook-sink/v1/               the internal normalize/ mappers/ deliver/
    meta-capi/v1/  ga4/v1/         layout is the stage-4/stage-5 split,
    tiktok/v1/     braze/v1/       exactly as consumers ship today

async/                             the six async pipelines
  warehouse/
    clickhouse-sink/v1/            streaming loads (moves out of consumers/ —
                                   it was never a destination)
    archiver/v1/                   raw.events -> object storage        (R10)
    export/v1/                     scheduled Parquet job               (R10)
  computation/                     "trait & audience computation"
    sessionizer/v2/                background aggregations over the
    attribution-engine/v3/         spine (§2.4)
    traits/v1/                     compute runner (definitions live in
                                   catalog/traits/, like schemas)      (R5)
    audiences/v1/                  membership runner (definitions in
                                   catalog/audiences/)                 (R6)
  merges/
    merge-worker/v1/               retroactive merges                  (R4)
  profiles-sync/
    export/v1/                     profiles slice of the export        (R10)
  reverse-etl/
    runner/v1/                                                        (R7)
  journeys/
    orchestrator/v1/                                                   (R11)
```

Stage 1 (ingest) stays `apps/ingester-api` — it is an HTTP app, not a
stream worker; the tree hosts stream-attached units. Component names,
versions, and the processor chassis are unchanged: a directory move is
non-semantic (the ADR-0005 precedent), so nothing re-versions by moving.

**Every unit sits at exactly four levels**, including the enrichment
runtime, so the workspace globs stay uniform: `processors/*/*` +
`consumers/*/*` become `sync/*/*/*` + `async/*/*/*`. A unit that skipped
its version directory would need a fifth glob and would be the one
component whose path could not say which version is deployed.

Two structural decisions inside the tree:

- **Identity and enrichment are separate stage processors** with an
  intermediate `identified.events` family — reversing this plan's first
  draft, which fused them. The split wins on mechanism: no invented
  sub-stage versioning (each enricher and the resolver carry plain
  processor versions), independent scaling of the ordering-constrained
  write path vs the embarrassingly-parallel read path, failure isolation
  (a geo bug cannot stall identity), and a tree that reads as the
  topology. The price — one extra broker hop through a short-retention,
  regenerable family — is accepted. Ownership line: **the identity stage
  is the profile store's only writer; the enrichment stage only reads.**
- **The enrichment stage composes enrichers in-process** rather than one
  hop per enricher. `sync/enrichment/runtime` pins enricher versions the
  way a destination consumer's descriptor pins its normalize/mapper/
  deliverer versions — an existing idiom, not new machinery. One hop for
  stage 3 total, regardless of how many enrichers exist.

`analytics-projector` retires — the identity stage occupies its slot
(first hop off `raw.events`) and does real work in it. `identity-resolver`
v1 is superseded by `sync/identity/resolver` v1; its pairwise-ledger
semantics (including the known dead branch and the
partial-supersede-on-double-conflict defect in
`processors/identity-resolver/v1/src/runtime.ts:555`) are not carried
forward — the profile store's find-or-create is the v2 semantics.
`geoip-enricher` retires as a processor; its transform survives as the
`sync/enrichment/geoip` enricher.

### 2.4 What "sessionizer v2" and "attribution-engine v3" are

Not new components, and not stages 4–5: they are the next versions of two
derived-fact processors that already exist — **stages of the async
computation pipeline** (`async/computation/<name>/v<N>/`), not of the sync
one, and not helpers of the identity stage (they play no role in
resolution, and coupling session or attribution windows into the spine
would re-version the spine every time those semantics change). Each re-homes its input
to `resolved.events` and re-keys its state from "best raw identifier"
(`customer_id > anonymous_id > session_id`) to the stamped `profile_id`.
That change alters emitted events — session boundaries and ids, chain
identity — so the semantic-immutability rule forces a new major version
rather than an in-place change. Sessionizer is at v1 today, hence v2;
attribution-engine already has v1 and v2 in-tree (v2 added the 90-day
inactivity window), hence v3.

| | today | at v2 / v3 |
|---|---|---|
| sessionizer | keys Redis windows on raw identifiers; a login flips the key, orphaning the pre-login session with no `session.ended` | keys on `profile_id`; login no longer moves the key, so the session survives identify (rotation shrinks to rare merge moments) |
| attribution-engine | keys chains on raw identifiers; chains fragment exactly at the anonymous→known transition | keys on `profile_id`; one chain per person across the transition |

Everything else carries forward unchanged: the Redis TTL mechanics and
deterministic session-id derivation, the campaign tuple, touchpoint
hashing, the Postgres chain store. Cutover mechanics are already proven by
attribution v1/v2 coexistence (activation gates, `processor_version` in
the chain PK, disjoint state per version).

In reference-model terms they belong to the trait-and-audience-computation
pipeline — background aggregation reading the spine the way
clickhouse-sink does. Stages 4–5 belong exclusively to the destination
consumers.

---

## 3. Rule changes

This plan amends written principles. Explicitly, so nobody discovers it by
diff:

| Where | Today | After |
|---|---|---|
| `00-overview.md` | "Processors fan out from `raw.events` rather than chaining … There is no 'enriched copy' of a source event anywhere in the system" | "The main pipeline is staged: `raw.events` → `resolved.events`. A source event has exactly one resolved form — the same fact with platform resolution attached, same `event_id`. Genuinely *derived* facts (sessions, attributions, identity links, profile updates) remain sibling events with derived ids." |
| `docs/README.md` rule 11 / `claude.md` hard rule | "clickhouse-sink … consumes `analytics.events`" | "clickhouse-sink consumes `resolved.events` (source facts) and the derived-fact families" |
| `claude.md` core path | `raw.events -> versioned processors -> derived topics` | `raw.events -> sync/identity -> identified.events -> sync/enrichment -> resolved.events -> sync/destinations -> vendor APIs`, with `async/*` reading the spine |
| new rule | — | "Destination **subscriptions, filters, and consent requirements are configuration values** (`project_config` / `destinations.config`). Destination **transformations are code**. The mapping prohibition is unchanged and absolute." |
| new rule | flat `processors/` + `consumers/` in `claude.md`'s Expected Repository Shape | "Stream-attached units live at **`{sync,async}/{stage}/{name}/{version}`** — the tree is the pipeline map (§2.3). `apps/` keeps HTTP services; `packages/` keeps libraries." |
| unchanged | "Ingestion stays thin" | unchanged — resolution happens at the first hop *after* ingest, not in the HTTP path. Segment's "inline" is also post-ingest; nothing about this plan touches the ingester's do-not list. |
| unchanged | "Raw events are immutable, append-only, replayable" | unchanged — `raw.events` is untouched; `resolved.events` is a derived stream regenerable from `raw.events` + the profile store + versioned code. |
| unchanged | normalize → map → deliver, mappings code-only | unchanged — Stage 4/5 keep the three-stage consumer contract; this plan adds a routing gate *before* normalize. |

One honesty note on replayability: a resolved event's traits snapshot is
as-of-delivery, not as-of-occurrence. Replaying Stage 2/3 later attaches
*current* traits. This matches Segment ("latest pre-computed traits") and is
acceptable because (a) destination sends during replay are already disabled
by default, and (b) every stamped `profile` block carries `traits_version`,
so any historical delivery is explainable from `delivery_records` +
`profiles` history. The reconstructibility principle survives with "as-of"
precision documented.

---

## 4. The profile plane

The single biggest net-new piece. Everything in this section is Postgres
runtime state — derived, rebuildable from `raw.events` by replay, and
therefore legal under "PostgreSQL stores mutable runtime/control state."

### 4.1 Storage

```sql
profiles (
  profile_id            uuid PRIMARY KEY,      -- uuidv7, platform-generated
  project_id            text NOT NULL REFERENCES projects,
  environment           text NOT NULL,         -- shared-environments CHECK
  canonical_customer_id text,                  -- latest authoritative customer_id
  traits                jsonb NOT NULL DEFAULT '{}',
  traits_version        bigint NOT NULL DEFAULT 0,   -- bumped on every trait write
  merged_into           uuid REFERENCES profiles,    -- audit pointer; readers
                                                     -- never traverse it (4.3)
  first_seen_at         timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL
)

profile_identifiers (
  project_id     text NOT NULL,
  environment    text NOT NULL,
  kind           text NOT NULL,      -- 'customer_id' | 'anonymous_id' (v1);
                                     -- 'device_id', 'email' reserved
  value          text NOT NULL,
  profile_id     uuid NOT NULL REFERENCES profiles,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  PRIMARY KEY (project_id, environment, kind, value)
)

profile_merges (
  merge_id          uuid PRIMARY KEY,
  project_id        text NOT NULL,
  environment       text NOT NULL,
  winner_profile_id uuid NOT NULL,
  loser_profile_id  uuid NOT NULL,
  source_event_id   uuid NOT NULL,   -- the event that caused the merge
  evidence          jsonb NOT NULL,
  merged_at         timestamptz NOT NULL
)
```

`identity_links` survives as the evidence ledger (why two identifiers are
believed to be one person), written in the same transaction. The graph's
*resolved state* is `profile_identifiers`; the graph's *justification* is
`identity_links`. The profile store is project-bounded, like the link ledger
today; cross-project identity stays out of scope.

### 4.2 Resolution (Stage 2), one transaction per event

1. Collect strong identifiers from the envelope (`customer_id`,
   `anonymous_id`). None present → the event is stamped
   `profile: null` and continues (destinations already classify
   `dropped_no_identity` per instance; the spine does not drop).
2. Look up `profile_identifiers` for all collected identifiers, locking
   matched rows `FOR UPDATE` in canonical `(kind, value)` order (deadlock
   avoidance).
3. Zero profiles → insert a new profile + identifier bindings
   (`ON CONFLICT DO NOTHING`, re-select on conflict — races resolve to the
   winner's row).
4. One profile → bind any unbound identifiers to it.
5. Two profiles → **merge**: winner is the older `first_seen_at` (tie: lower
   `profile_id`). Repoint the loser's identifier rows to the winner, stamp
   `merged_into` on the loser, insert `profile_merges` + `identity_links`
   evidence, emit `identity.merged` (schema v2, carrying both profile ids).
   The retroactive-merge worker (§6, R4) picks it up from `identity.events`.
6. If the event is identify-family (`user.identified`), merge-patch its
   traits into `profiles.traits`, bump `traits_version`, emit
   `profile.updated` on `profile.events`.
7. Stamp `profile.profile_id` and `profile.canonical_customer_id` onto the
   emitted event. Traits are attached downstream by the enrichment stage —
   a committed-state read by `profile_id`, race-free for this event (the
   event reaches enrichment only after the resolver's transaction commits)
   and deliberately "latest" for every later one. **Commit-before-publish
   is the invariant that makes this true** — the resolver must complete
   its Postgres transaction before emitting onto `identified.events`, the
   ordering v1 already uses. Reversing it would let enrichment read a
   profile that does not exist yet, and no amount of partition ordering
   would cover it.

Properties worth stating:

- **Idempotent under redelivery.** Every step is an upsert or a no-op on
  re-execution; a rewind that replays the merge event finds the identifiers
  already repointed and emits nothing new. This removes the
  emit-then-rewind hazard the v1 resolver documents (a replayed merge
  currently downgrades to `identity.linked`).
- **Ordering.** Per-partition ordering serializes the common case (all
  events carrying a given identifier). The residual race — the linking event
  lands on a different partition than the anonymous history, because the
  partition key upgrades to `customer_id` — is inherent (it existed in the
  Kafka era and exists at Segment) and is exactly what step 5's row locks +
  unique constraints serialize. Correctness never depends on partition
  placement; partitioning is a throughput and locality optimization.
- **Bounds.** Identifier bindings per (profile, kind) are capped
  (default 100). The cap changes emitted events, which makes it a
  **semantic parameter**: manifest-declared default + bound, per-project
  override in `catalog/projects/<id>.yaml` — never `project_config` — per
  the rule in `05-processors-and-replay.md`. At the cap, the binding is
  refused with a metric and an `identity.link_rejected` fact — a runaway
  producer cannot inflate one profile into a hot row that stalls its
  partition.
- **Merge safety.** Two guards against merge storms — the classic
  identity-graph incident, where one promiscuous identifier (a kiosk
  device, `customer_id: "guest"`, a bot's anonymous_id) chain-merges
  thousands of profiles into one: an **identifier value denylist** in
  catalog policy (the forbidden-fields pattern; denylisted values resolve
  as if absent) and a **merge-rate breaker** — a profile that exceeds the
  merge-rate bound stops accepting merges and emits an
  `identity.merge_suspended` fact for operator review. Both change
  emitted events → semantic parameters, and both ship inside R1:
  retrofitting either after the resolver is live is a new major version
  under the immutability rule.
- **Throughput.** One transaction per event on the spine. At Polaris's
  internal volumes this holds on `profile_identifiers`' primary-key lookup;
  the escape hatch, when needed, is a read-through Redis cache of
  `identifier → profile_id` for the no-write fast path (the overwhelming
  majority of events bind nothing new), invalidated on merge. Build it when
  p99 resolve latency demands it, not before.

### 4.3 Merge semantics

Repointing is eager: after a merge commits, every identifier row references
the winner, so the read path is always one hop — `merged_into` is audit, not
routing, and chains never need traversal. Losers keep their row (tombstone)
so historical `profile_id` stamps in ClickHouse remain explainable through
`profile_merges`.

**Un-merge is replay, not surgery.** A wrong merge (a support agent
logging into customer accounts; a denylist gap) is repaired by rebuilding
the project's profile store from `raw.events` under corrected policy:
`polaris profiles rebuild --project` pauses the resolver via its
activation gate, truncates the project's profile rows, replays the window
through the resolver, and resumes. The store is derived state, so this is
the same replay-as-repair contract every processor already honors;
ClickHouse follows through the merge dictionary (R4). Rebuild depth is
bounded by `raw.events` retention until the archive lands — R10 is what
makes un-merge complete.

### 4.4 The envelope: `profile` and `enrichment` blocks

The canonical envelope gains two optional, platform-owned, strict blocks:

```text
profile: {
  profile_id            uuid
  canonical_customer_id string | null
  traits                object          # snapshot at resolution time
  traits_version        integer
}
enrichment: {
  geo: { country, region, city, source } | null
}
```

plus the existing processor stamp (each stage stamps like any processor).
The `profile` block is completed across the two stages: the identity stage
writes `profile_id` / `canonical_customer_id`; the enrichment stage fills
`traits` / `traits_version` and the whole `enrichment` block. The producer
envelope schema does **not** accept either block —
both `.strict()` schemas already reject unknown top-level fields, so a
producer attempting to forge a profile gets `invalid_envelope` with no new
code. Events on `raw.events` never carry the blocks; events on
`resolved.events` always carry `profile` (possibly `null`-bodied, §4.2 step 1)
and `enrichment`.

`identity` (producer-observed identifiers) is untouched. Producer truth and
platform resolution stay in separate blocks with separate owners — the same
split as `occurred_at` vs `ingested_at`.

Traits snapshots are size-guarded (default 32 KiB; a semantic parameter like
the identifier cap — manifest default + bound, catalog override; over-cap
events carry `traits: null` + a metric, never a dropped event).

### 4.5 The identify contract (SDK change)

`identify(customerId, traits)` today persists the id locally and discards
traits. Target:

- `identify()` **emits** `user.identified` (catalog-registered, schema v1)
  carrying traits as properties, alongside its current local-persistence
  behavior. `track()` is unchanged.
- Traits mutate profiles **only** via identify-family events (plus computed
  traits and reverse ETL, §6). Last-write-wins per key at the resolver, which
  is safe because all events carrying a given `customer_id` serialize on one
  partition.
- The four unregistered mapper events (`payment.approved`,
  `user.identified`, `signup.completed`, `subscription.renewed`) get catalog
  YAML + Zod bindings — today they are rejected at ingest with
  `unknown_event`, which makes most of the destination surface dead code.

---

## 5. Stage-by-stage gap analysis: the main pipeline

| # | Segment stage | Polaris today | Target | Net-new work |
|---|---|---|---|---|
| 1 | Ingest (Protocols) | **Strong.** API-key auth with trusted stamping, file-backed catalog + Zod validation, two-tier forbidden-field policy, dedupe lease, per-event batch results | Unchanged in shape | Register the 4 missing events; load per-project policy overrides (wired but never populated); nothing structural |
| 2 | Identity resolution (Unify) | Pairwise link ledger; no person, no graph reads, no envelope effect; nobody consumes the output | Profile store + find-or-create + merge inline on the spine; `profile_id` stamped on every event; sole writer of the profile store | §4 entirely: migrations, `sync/identity/resolver` v1, `identity.events` v2, CLI surface (`polaris profiles show/links`), metrics |
| 3 | Enrichment | Geo-only, emitted as *sibling* events nothing joins; production backend is a no-op (no MaxMind, `source:"no_lookup"`); no traits anywhere | Traits snapshot + geo stamped on the spine event by the read-only enrichment stage | `sync/enrichment` stage (runtime + `traits` and `geoip` enrichers, composed in-process); real MaxMind backend; traits snapshot plumbing |
| 4 | Transformation (per-destination processing) | Fan-out is project-scoped (C8) and per-project config slices reach every consumer (C11) — but nothing *filters* on them yet: event selection is still "does a hand-written mapper exist"; consent dimensions hard-coded per vendor; planned skip indistinguishable from failure in `delivery_records` | Routing gate before normalize: per-instance event subscriptions, property filters, consent requirements — all config *values* riding the landed slice; mappers stay code and stay the terminal safety | Subscription/filter evaluator in `shared-destinations` harness; config schema (`destinations.config` + `project_config`); distinct `skipped_unmapped` / `skipped_filtered` delivery statuses |
| 5 | Delivery | Normalize/map/deliver contract solid; but retry ladder provisioned and unused (failures rewind with no backoff), `dead_letter_threshold` unreachable (attempt counter never increments), `retry_policy` stored and never read, dedupe + rate limiting single-process in-memory | Real tiered retries via the existing `<component>.retry.*` queues with attempt propagation; `retry_policy` maps to tier schedules; Redis-backed delivery dedupe + rate limiting so replicas > 1 are safe | Wire `republishToRetry` into the destination error path; Redis adapters for dedupe/limiter; consolidate the 5× copy-pasted ~370-line `app.ts` into the harness while touching all five |

Stage 2/3 mechanics that come free from existing infrastructure: super-stream
partition ordering, Postgres checkpoints, poison→DLQ, run records, activation
gates, golden-fixture testing — the processor chassis is already built.

### 5.1 Beyond the stages: governance and event observability (R12)

Two operational surfaces the stage table cannot express. Both additive;
together they are most of the distance between "sound architecture" and
the operational loop that makes reference products trustworthy.

- **Violations quarantine.** Today a rejected event returns a reason code
  and vanishes — schema governance without the feedback loop. R12 adds a
  short-retention `rejected.events` family (the diagnostics-stream
  pattern): after rejecting, the ingester fire-and-forget publishes a
  violation record — reason, field paths, and a **redacted** sample. The
  policy-before-any-logging rule extends to the quarantine: events
  rejected for forbidden fields contain exactly the payloads the policy
  blocks, so raw samples never land. Violation records are wrapper
  documents, not canonical envelopes (a rejected event failed envelope
  validation by definition); the family feeds one small ClickHouse
  violations table for dashboards plus per-event-type volume-anomaly
  alerts, and never feeds destinations. The quarantine publish is
  fail-open — ingest never blocks on it.
- **Event-level tracing.** `polaris events trace <event_id>` joins what
  already exists — `analytics_ingest_log` transport lineage, processor
  stamps, `delivery_records`, the DLQ ledgers — into one answer to
  "where is my event". A live tail rides the transport's timestamp
  attach. Pure read-side; deepens as R2/R3 land but useful from day one.

---

## 6. Async-pipeline gap analysis

| Segment async process | Polaris today | Target | Work |
|---|---|---|---|
| Warehouse sync | `clickhouse-sink` streams `analytics.events` + 4 derived families into `analytics_raw` / `analytics_processed`. No batch loads, no archive: replay dies at the 90-day stream retention, which `03-rabbitmq-streams.md` already names as the gap | Streaming half: same sink, consuming `resolved.events` as the source-fact input; `analytics_raw` gains `profile_id`, `traits_version`. Scheduled half: batch exports to object storage — the raw archive + Parquet warehouse loads (§6.2) | Additive DDL + MV update (rebuild machinery exists); flip input family; **give clickhouse-sink a Dockerfile + build entry** (it has none); the export job (§6.2) |
| Trait & audience computation | Nothing | Trait definitions as code (`catalog/traits/*.ts`: key, type, projection-backed SQL); scheduled compute (host cron + `polaris traits compute`, same pattern as the attribution prune); writes via profile store, bumps `traits_version`, emits `trait.computed` + `profile.updated`. Audiences: code-defined predicates over traits/projections; membership in `audience_memberships` (PG runtime state); transitions emit `audience.entered` / `audience.exited` on `profile.events` | New: definitions loader, compute runner, membership table, CLI verbs, catalog events. Trait SQL reads **projections only** (service role) — a governance line that keeps trait compute off `analytics_raw` |
| Retroactive profile merges | Explicitly deferred in three files; replay cannot express it | Merge worker consumes `identity.merged` v2 → upserts ClickHouse `profile_merge_map` (ReplacingMergeTree) backing a `profile_canonical` dictionary; person-keyed queries and projections resolve `dictGetOrDefault('profile_canonical', ...)` at read time. **History is never rewritten** — immutability holds; re-interpretation happens at read. Optional: schedule a `clickhouse-rebuild` for materialized person-keyed projections | New worker (small — one consumer, one upsert), dict DDL, projection guidance in `07-clickhouse.md`. No destination re-sends after merges (Segment doesn't either) |
| Profiles sync | Nothing | `profile.updated` events flow through clickhouse-sink into a `profiles` ClickHouse table (`ReplacingMergeTree(traits_version)`) — streaming, reuses the sink wholesale — and the scheduled export job pushes the unified-profiles snapshot to the warehouse tier alongside events (§6.2) | Sink routing entry + DDL + MV; profiles slice of the export job |
| Reverse ETL | Nothing (a reverse-ETL consumer is in the blessed repo shape but absent) | `async/reverse-etl/runner/v1`: repo-defined SQL (file-heavy) against projections; schedule + enablement + params in `project_config`; each run POSTs resulting canonical events to the ingester with `source.type: internal` — full validation/policy/dedupe applies; trait-shaped results ride `user.identified`-family events | New consumer + `polaris reverse-etl run <job>` cron verb + job SQL registry; run records reuse `processor_runs` shape |
| Journeys | Nothing | `journey-orchestrator` processor advancing profiles through code-defined, versioned journeys: triggers, waits, branches, actions (§6.1) | New processor + `journey_participants` table + timer sweep + catalog events; sequenced last (needs audiences) |

### 6.1 Journey orchestration

Sequenced last because it stands on audiences, but designed now so nothing
upstream forecloses it. Everything is existing Polaris idiom:

- **Definitions are code**, like traits and mappings:
  `catalog/journeys/<name>.v<N>.ts` declares a versioned step graph —
  *trigger* (audience entered, or an event predicate), *wait* (duration or
  until-timestamp), *branch* (predicate over profile traits / audience
  membership), *action* (emit a canonical `journey.*` event). Any change to
  the graph is a new journey version; participants finish on the version
  they entered (the processor semantic-immutability rule, applied to
  journeys).
- **Runtime** is a normal processor, `async/journeys/orchestrator/v1`,
  consuming `resolved.events` + `profile.events` (triggers and branch
  inputs arrive per-profile-ordered on the spine's partition key). State is
  one Postgres table, `journey_participants` `(journey, journey_version,
  project_id, environment, profile_id, current_step, status, entered_at,
  wait_until)` — runtime state, rebuildable, DB-light-legal. Entry is
  idempotent per `(journey, profile_id)`; re-entry policy is declared per
  journey.
- **Waits** are `wait_until` rows swept by a timer (the crontab + CLI-verb
  pattern the attribution prune already uses; in-process sweep with jitter
  if latency ever matters). No new scheduler infrastructure.
- **Actions are events, never vendor calls.** A step that messages a user
  emits `journey.step_reached` (or a domain event) onto `profile.events`;
  the existing destination path — subscriptions, consent, normalize, map,
  deliver — carries it to Braze or any vendor. The orchestrator gets no
  network access and no vendor semantics, preserving the adapter rule.
- **Loop guard.** The orchestrator never treats `journey.*`-namespaced
  events as triggers. Its own emissions ride `profile.events`, which it
  also consumes — a journey that could trigger on journey output is a
  feedback loop by construction, so the exclusion is structural, not
  per-definition discipline.
- **Observability**: `journey.entered` / `.step_advanced` / `.exited`
  catalog events flow to ClickHouse through the sink like every other
  derived fact, so journey funnels are projections, not bespoke storage.

### 6.2 Scheduled warehouse and profile exports (the archive)

The scheduled-batch half of the reference model, which streaming ClickHouse
ingestion does not cover, and the piece that lifts replay beyond the 90-day
stream window (`03-rabbitmq-streams.md` names this exact gap: "long-term raw
replay should eventually come from an object-storage archive").

- **Raw archive**: a small archiver consumer on `raw.events` writing
  size/time-bounded batches to object storage as partitioned NDJSON
  (`project/environment/date/partition-offset-range`), checkpointed like
  every consumer. The archive becomes the replay source for windows older
  than stream retention; `shared-replay` gains an archive
  `ReplayExecutorSource` next to the stream driver — the planner and
  executor contracts already abstract the source, so this is an adapter,
  not a redesign.
- **Warehouse loads**: a scheduled export job (`polaris warehouse export`,
  host cron — the existing pattern) writing Parquet snapshots of the
  projection tables and `analytics_raw` slices to the same object-storage
  tier, partitioned by day. That tier *is* "your data warehouse" for any
  internal consumer that is not ClickHouse (Spark, DuckDB, pandas, a future
  lakehouse); loads into a second OLAP store, if one ever exists, read from
  these files rather than re-tapping the pipeline.
- **Profiles Sync**: the same job exports the unified-profiles snapshot
  (profiles + traits + merge map) on the same schedule, satisfying the
  reference model's "profiles pushed down into your warehouse" without a
  second mechanism.
- Export queries run under the `operator` ClickHouse profile through
  `shared-clickhouse` (they legitimately read `analytics_raw` with the
  sanctioned dedupe idiom), and every run writes a job record — same
  lifecycle shape as `clickhouse_rebuild_jobs`.

---

## 7. Migration and cutover

Dual-run, one consumer at a time, dedupe-protected. No flag-day.

```text
M0  Repo re-layout (R0L): processors/ and consumers/ move under sync/
    and async/ per §2.3 (workspace globs, docker-build, docs). Component
    names and versions unchanged — moves are non-semantic; everything
    after this is born in place.
M1  Provision identified.events + resolved.events (width 6, matching
    raw.events) + profile.events (width 3); declare the sync-identity,
    sync-enrichment, and merge-worker component queues. The new stage
    components are named for their tree path, NOT "identity-resolver":
    the legacy processor keeps running through M6, and reusing its
    component name would share its retry/redeliver/DLQ queues during
    coexistence. Topology change, runbook exists.
M2  Land profile-store migrations + the two stage processors:
    sync/identity/resolver v1 (raw.events -> identified.events, plus
    identity.events v2 + profile.events) and sync/enrichment v1
    (identified.events -> resolved.events). analytics-projector keeps
    running; they coexist (different output families).
M3  clickhouse-sink v2: add resolved.events to the source-fact input set
    (new columns nullable/default).

    Overlap needs care, and the naive reading is wrong. Both feeds carry
    the SAME event_id and therefore the same `analytics_raw` sort key
    `(project_id, environment, event, event_id)`. ReplacingMergeTree does
    collapse them to one row — but it keeps the row with the highest
    `_version`, and among equal versions the winner is arbitrary. The two
    rows are NOT interchangeable: only the resolved-path row carries
    `profile_id` and `traits_version`. A dual-run that lets the old path
    win silently produces un-enriched analytical rows.

    So: verify parity from `analytics_ingest_log` (append-only, keeps both
    rows distinctly with transport lineage — this is exactly what it is
    for), never by reading `analytics_raw` during the overlap. Then make
    the resolved path win deterministically before the overlap begins,
    either by ranking `_version` on the source family or by cutting the
    sink's input over rather than overlapping it. Confirm the choice
    against the DDL when the card is written; do not assume dedupe alone
    resolves it.

    Only then drop analytics.events from the sink's subscriptions.
M4  Destination consumers: flip input family to resolved.events and adopt
    the routing gate + profile-aware normalize (pickBestIdentity prefers
    canonical_customer_id / profile_id; GA4 client_id from anonymous_id —
    kills the delivery-key shortcut; Braze/Meta gain traits and stable
    external ids). webhook-sink first (exemplar + SPEC.md), then the four
    vendors, one PR each. The C8 project filter is already live, so the
    per-project rollout is safe by construction. Before each vendor's live
    flip, run the new-path consumer in the existing `test` mode alongside
    the old path and diff `delivery_records` payloads — parity of
    transformation, not just volume (M3 covers volume).
M5  sessionizer v2 + attribution-engine v3: input resolved.events, keyed
    by profile_id. Sessions stop orphaning at login (key is stable across
    identify); chains stop fragmenting at anonymous→known. Both are new
    major versions under the semantic-immutability rule; run records and
    activation gates handle coexistence, as attribution v1/v2 already
    proved.
M6  Retire: analytics-projector (activation-disable, then delete),
    geoip-enricher (delete; transform survives as sync/enrichment/geoip),
    identity-resolver v1 (deprecate, delete after M4/M5 verify),
    enriched.events + analytics.events families (decommission = topology
    migration; retention is declaration-time).
M7  Async pipelines: merge worker + merge dictionary (R4),
    traits/audiences (R5, R6), reverse ETL (R7), warehouse exports +
    archive (R10), journeys (R11).
```

Replay across the cutover: `raw.events` replays reach the identity stage
naturally (same first-hop position as the projector). A replay of Stage 2/3
attaches current profiles — documented as-of semantics (§3). Person-keyed
ClickHouse rebuilds go through the merge dictionary and are deterministic.

---

## 8. Workstreams (the R programme)

Sequenced like the C programme; one row ≈ one card unless noted. Sizes:
S ≤ 2 days, M ≤ 1 week, L > 1 week of focused work.

| # | Workstream | Size | Depends on | Contents |
|---|---|---|---|---|
| R0 | Contract evolution | M | — | Envelope `profile`/`enrichment` blocks in `shared-schemas`; catalog + bindings for the 4 missing mapper events (incl. `user.identified`); SDK `identify()` emits + sends traits (web + node); `profile.events` + `identity.*` v2 + `trait/audience` catalog entries |
| R0L | Pipeline-shaped repo layout | M | — (parallel with R0) | §2.3 tree: move `processors/` + `consumers/` under `sync/` and `async/`; workspace globs, docker-build, docs; moves are non-semantic, nothing re-versions |
| R1 | Profile store + the two spine stages | L | R0, R0L | §4 migrations; `sync/identity/resolver` v1 + `sync/enrichment` v1 (traits + geoip enrichers; manifests, golden fixtures); **merge safeguards: identifier denylist + merge-rate breaker + `identity.merge_suspended` (§4.2 — must ship inside R1, not after)**; MaxMind backend + mmdb refresh job; `identity.events` v2 emission; `polaris profiles` CLI; metrics + dashboards |
| R2 | Spine cutover | L | R1 | M1–M3, M6: topology provisioning, sink v2 + DDL, parity verification, retirements; docs updates (`00`, `03`, `05`, `07`, `docs/README.md`, `claude.md`, onboarding "project or source?" guidance) |
| R3 | Destination platform | L | R2 (M4) | Routing gate (subscriptions/filters/consent as config values, on the landed `DelivererContext.projectConfig` seam); profile-aware normalize; retry-ladder adoption + attempt propagation + `retry_policy` semantics; Redis dedupe/rate-limit; per-instance circuit breakers (trip on consecutive vendor 5xx, half-open probes); per-destination freshness SLO panels; `skipped_unmapped`/`skipped_filtered` statuses; harness-owned `app.ts` |
| R4 | Retroactive merge | M | R2 | Merge worker; `profile_merge_map` + dictionary DDL; person-keyed query guidance; optional rebuild wiring |
| R5 | Traits + profiles sync | M | R2 | Trait definition loader + `polaris traits compute` cron verb; `profiles` CH table fed from `profile.events`; `profile.updated` end-to-end |
| R6 | Audiences | M | R5 | Audience definitions; membership table; entered/exited events; destination delivery of audience transitions (attribute-style via existing vendor consumers) |
| R7 | Reverse ETL | M | R5 | `consumers/reverse-etl/v1`; job SQL registry; cron verb; ingester round-trip |
| R8 | Sessionizer v2 + attribution v3 | M | R2 | M5 as its own stream — mechanical rekeying to `profile_id`, new majors, fixture refresh |
| R9 | Hardening (rolling) | S× | parallel | Items in §9 not consumed by other workstreams |
| R10 | Warehouse exports + raw archive | M | R2 (events); R5 (profiles slice) | §6.2: archiver consumer on `raw.events`; `polaris warehouse export` cron verb; Parquet snapshots; archive `ReplayExecutorSource` for `shared-replay`; export job records. Also unlocks full-depth profile rebuilds (§4.3) |
| R11 | Journey orchestration | L | R6 | §6.1: definition loader, `journey-orchestrator` v1, `journey_participants`, wait sweep, `journey.*` catalog events, funnels projection |
| R12 | Governance & event observability | M | R0 (parallel; deepens after R2/R3) | §5.1: `rejected.events` quarantine with redacted samples; violations table + per-event-type volume-anomaly alerts; `polaris events trace` + live tail |

Critical path: **R0 → R1 → R2 → R3**, with R8 and R4 fanning out after R2.
R0L is mechanical, runs parallel with R0, and lands first so R1's
components are born under the new tree.
R5→R6→R7 are sequential among themselves but independent of R3. R10's
archiver needs only R2's spine (its profiles slice waits on R5). R11 closes
the programme after R6 — the full reference model, including journeys, is
then live. R12 runs parallel from the start — its tracing view deepens as
R2/R3 land. The C programme has landed in full, so the R programme starts
unblocked: R3 builds directly on `project_config`, the per-consumer config
slices, and the project-scoped fan-out.

### 8.1 Stack impact

The full programme — gold-standard items included — adds **one service
and one data artifact** to the stack: object storage for the
archive/export tier (R10; MinIO locally, managed S3-compatible in
production — kept thin because ClickHouse exports Parquet to S3
natively, so bulk data never flows through Node) and the MaxMind database
plus its refresh job (R1). Two boring npm dependencies come with them
(`mmdb-lib`, `@aws-sdk/client-s3`). Deliberately **not** added: a
workflow engine (journeys are a Postgres table + the crontab sweep), a
stream-processing framework (traits are scheduled ClickHouse queries
over projections), a schema registry (the catalog is the registry), a
separate identity service (the store is Postgres behind the resolver).
Any card that arrives wanting more than these two additions is deviating
from this plan and gets flagged.

---

## 9. Existing defects this plan absorbs or supersedes

Found during the survey; each is either consumed by an R workstream or
independent hardening.

**Superseded (do not fix in place):**
- `identity-resolver` v1 dead branch + partial supersede on double conflict
  (`runtime.ts:555–597`) — v2 semantics replace the whole block (R1).
- GA4 `client_id`-from-delivery-key shortcut — profile-aware normalize (R3/M4).
- Sessionizer login-orphan and attribution chain fragmentation — R8.

**Already fixed on `main` since first draft:**
- Fan-out ignores `project_id` (cross-project delivery) — C8 landed,
  including the project-keyed target cache; the blast-radius gate was
  deleted as moot (pre-production, no delivery history to break).

**Consumed by workstreams:**
- Retry ladder dead; `dead_letter_threshold` unreachable; `retry_policy`
  never read — R3.
- In-memory dedupe/rate-limit unsafe beyond one replica — R3.
- Mapper skip vs missing indistinguishable in `delivery_records` — R3.
- 4 mapper events unregistered in catalog — R0.
- MaxMind backend absent (prod geo is all-null) — R1.
- clickhouse-sink has no Dockerfile/build entry — R2. attribution v2 image
  missing from `docker-build.mjs` — R9 (or moot after R8's v3).
- Traits discarded by SDKs — R0.

**Independent (R9 backlog):**
- Per-project policy overrides never loaded (ingester) nor passed
  (destination second pass).
- Topic isolation exists in schema/CLI but no runtime constructs
  `StreamIsolationCache` (destination consumers also ignore isolated
  families; today only clickhouse-sink threads them).
- Processor/consumer manifests are decorative — wiring doesn't read them;
  add a drift check (manifest families vs hardcoded constants) at minimum.
- Sessionizer manifest still declares `memory:sessions` (Redis since ADR
  0005); stale runtime header comment.
- Doc drift: `docs/README.md` links to a nonexistent
  `docs/implementation/kanban.md` and to ADRs outside the repo;
  `shared-db` types 12 of 18 tables.

---

## 10. What we deliberately do not copy from Segment

- **Config-driven field mappings / a mapping UI.** The mapping prohibition
  stands. Segment's transformation config is their most-litigated surface;
  Polaris keeps transformations in versioned, golden-tested code. We move
  only *selection* (subscriptions, filters, consent) into config values —
  the narrowed rule already drew this line.
- **Batching into our own OLAP store.** ClickHouse takes streams, so its
  ingestion stays streaming; the reference model's scheduled-batch
  semantics live where they earn their keep — the exports and archive
  (§6.2) — not in the sink.
- **Per-instance delivery infrastructure.** Vendor-level consumers fanning
  to instances in-process stay; per-instance streams would multiply the
  operational surface for no current need. If one instance's lag or rate
  ceiling starts dragging its vendor's other instances, that is the same
  graduation decision as topic isolation — noted as a trigger, not built.
- **Inline resolution in the ingest HTTP path.** Ingest stays thin;
  resolution is the first hop behind the broker. The SDK-visible latency
  contract is unchanged.

## 11. Non-goals and deferrals

- Cross-project identity resolution (graph stays project-bounded).
- Probabilistic / heuristic matching (`confidence='candidate'` stays
  reserved; only deterministic evidence in v1).
- RBAC / consumer-side access control (unchanged trusted-operator posture).
- Customer deletion — the designed-not-built tombstone flow in
  `01-event-contract.md` gains a natural anchor (the profile) but remains
  deferred until a project needs it.

## 12. Decision log

| Decision | Alternatives considered | Why this way |
|---|---|---|
| Two stage processors (identity → enrichment) with `identified.events` between; enrichers composed in-stage | One fused spine processor (this plan's first draft); or one hop per enricher | Uniform processor versioning beats invented sub-stage machinery; the ordering-constrained write path scales apart from read-only enrichment; a geo bug cannot stall identity; the tree reads as the topology. Cost: one extra hop through a short-retention, regenerable family. **Reversed from the first draft on review** |
| Repo layout `{sync,async}/{stage}/{name}/{version}` | Flat `processors/` + `consumers/` | Placement encodes pipeline and stage — the tree is the pipeline map; stage membership stops being tribal knowledge |
| New family `resolved.events`; retire `analytics.events` + `enriched.events` | Reuse `analytics.events` name for the enriched spine; keep geo sibling stream | Reuse would silently change a family's semantics under consumers mid-cutover — a rename forces every consumer to opt in knowingly; `enriched.events` name is burned (geoip siblings) |
| Partition spine by `profile_id` | Keep `best_available_identity` key | Per-person ordering downstream regardless of producer identifier churn; the resolver is the last place the weaker key is needed |
| Profile store in Postgres, traits inline on `profiles` | Separate traits table; Redis-first store | One row read per event; traits history lives in ClickHouse (`profile.updated` events), not Postgres; Redis is a later cache, not the source of truth (rebuildability) |
| Merge = eager repoint + read-time ClickHouse dictionary | Rewrite historical rows; query-time graph traversal in PG | Immutability preserved; O(1) reads both sides; dictionary is the standard ClickHouse idiom for exactly this |
| Traits mutate only via identify-family events (+ computed/reverse-ETL writers) | Traits on any `track` context | One serialization point per customer partition; last-write-wins stays explainable |
| Audiences/traits computed from projections only | Compute from `analytics_raw` | Keeps trait compute on the service role and inside the sanctioned query surface |
| Reverse ETL re-enters through the ingester | Direct publish to `raw.events` | Full validation/policy/dedupe for free; `source.type: internal` marks provenance; no second write path to audit |
| Stay on RabbitMQ for the R programme | Switch to Kafka "to unlock gold standard" | None of the gold-standard gaps are broker-shaped (all seven are store logic, harness code, or read-side tooling); delayed retries are strictly better on RabbitMQ (broker-owned TTL tiers vs consumer-slept backoff); the streams migration just landed; `shared-transport` is a port, so the option survives. Recorded flip conditions: static-assignment toil at sustained multi-team scale, a hard multi-DC replication requirement, or org-level adoption of a Flink-class processing layer |
