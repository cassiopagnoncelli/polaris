# Pipeline Redesign Plan: the Staged Main Pipeline and the Profile Plane

Status: proposed (decision doc, per the scope-discipline rule in
`delivery-roadmap.md`). Supersedes the fan-out processing topology described in
`docs/architecture/00-overview.md` once accepted. Builds on the project-config
programme (`project-config-plan.md`, C0–C13) and does not replace it.

This is the "R programme". It restructures Polaris's processing model around
the shape that Segment's pipeline settled on, adapted to Polaris's RabbitMQ
backbone, file-heavy semantics, and internal posture. It is deliberately a
map of everything required, sequenced; individual workstreams get their own
cards.

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

**The main pipeline** is the per-event, low-latency path from SDK to
destination APIs and ClickHouse. It is a staged line, not a diamond:

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
profile-resolver        Stage 2  Resolve: match identifiers against the
    |                            profile store; find-or-create; merge;
    |                            update graph; stamp profile onto the event
    |                   Stage 3  Enrich: attach traits snapshot from the
    |                            same store row; attach context enrichment
    |                            (geo); stamp `enrichment`
    v
resolved.events         THE canonical spine. Same event_id as the source
    |                   event; envelope now carries platform-owned
    |                   `profile` and `enrichment` blocks
    |
    +--> destination consumers   Stage 4  Route & filter: per-instance
    |         |                           subscriptions, consent, project
    |         |                           scoping; then normalize -> map
    |         v
    |    vendor APIs             Stage 5  Deliver: batching, retries with
    |                                     real backoff, rate limits, DLQs,
    |                                     delivery records
    |
    +--> clickhouse-sink -> analytics_raw (+ profile_id)   [support plane]
    +--> sessionizer v2         -> session.events           [support plane]
    +--> attribution-engine v3  -> attribution.events       [support plane]
```

**The support plane** is everything asynchronous that feeds or reads the main
pipeline without adding latency to it:

| Process | Polaris implementation |
|---|---|
| Warehouse sync | `clickhouse-sink` (exists; streaming, not scheduled — deliberate divergence from Segment, whose batching exists because customer warehouses are slow; ClickHouse is ours and takes streams) |
| Derived facts | sessionizer, attribution-engine — now consuming `resolved.events`, keyed by `profile_id` |
| Trait & audience computation | new scheduled jobs: code-defined trait/audience definitions computed from ClickHouse projections, written into the profile store, changes emitted on `profile.events` |
| Retroactive merges | new worker consuming `identity.merged`: maintains the ClickHouse merge map; history is re-interpreted at read time, never rewritten |
| Profiles sync | `profile.updated` events → clickhouse-sink → `profiles` table in ClickHouse (streaming; no scheduler needed) |
| Reverse ETL | new `consumers/reverse-etl`: scheduled repo-defined ClickHouse queries whose rows re-enter the platform as canonical events through the ingester |
| Journeys | deferred; designed on top of audiences + `profile.events` later (§11) |

### 2.2 Stream families, before and after

```text
Family              Today                          Target
raw.events          producer facts                 unchanged (6 partitions)
analytics.events    raw passthrough (the spine)    RETIRED after cutover
enriched.events     geoip sibling facts            RETIRED (geo folds into Stage 3)
resolved.events     —                              NEW: the spine (6 partitions,
                                                   partition key = profile_id)
identity.events     link facts                     kept; schema v2 adds profile ids
session.events      session facts                  kept (emitted by sessionizer v2)
attribution.events  attribution facts              kept (emitted by attribution v3)
profile.events      —                              NEW: profile.updated,
                                                   trait.computed,
                                                   audience.entered / .exited
```

`resolved.events` partitions by `project_id:environment:profile_id`. This is
strictly stronger than today's `best_available_identity` key: after Stage 2,
every event for a person rides one partition regardless of which identifier
the producer sent, so the sessionizer, the attribution engine, and every
destination consumer inherit per-person ordering. Width matches `raw.events`
(6) because it carries the same volume.

### 2.3 One spine processor, not three

Stages 2 and 3 are one physical processor, `processors/profile-resolver/v1`,
with independently versioned sub-stages (`resolve_version`,
`traits_version`, `context_version` in its manifest — same pattern as the
destination consumers' normalize/mapper/deliverer versions). Reasons:

- The traits the enricher attaches come from the same row the resolver just
  touched; one Postgres transaction returns both. Splitting the stages buys
  a second broker hop, a second checkpointed consumer, and an eventual-read
  race for zero semantic gain.
- Geo enrichment is stateless and adds no ordering constraint; folding it in
  costs nothing and removes an entire processor (`geoip-enricher`) and an
  entire stream family (`enriched.events`) from the operational surface.
- The sub-stage versions preserve the independent-versioning rule: a geo DB
  swap bumps `context_version` without re-versioning identity semantics.

`analytics-projector` retires: `profile-resolver` occupies the same slot in
the topology (first hop off `raw.events`, emits the spine) and does real work
in it. `identity-resolver` v1 is superseded by the resolve sub-stage; its
pairwise-ledger semantics (including the known dead branch and the
partial-supersede-on-double-conflict defect in
`processors/identity-resolver/v1/src/runtime.ts:555`) are not carried
forward — the profile store's find-or-create is the v2 semantics.

---

## 3. Rule changes

This plan amends written principles. Explicitly, so nobody discovers it by
diff:

| Where | Today | After |
|---|---|---|
| `00-overview.md` | "Processors fan out from `raw.events` rather than chaining … There is no 'enriched copy' of a source event anywhere in the system" | "The main pipeline is staged: `raw.events` → `resolved.events`. A source event has exactly one resolved form — the same fact with platform resolution attached, same `event_id`. Genuinely *derived* facts (sessions, attributions, identity links, profile updates) remain sibling events with derived ids." |
| `docs/README.md` rule 11 / `claude.md` hard rule | "clickhouse-sink … consumes `analytics.events`" | "clickhouse-sink consumes `resolved.events` (source facts) and the derived-fact families" |
| `claude.md` core path | `raw.events -> versioned processors -> derived topics` | `raw.events -> profile-resolver -> resolved.events -> {destinations, clickhouse-sink, derived-fact processors}` |
| new rule | — | "Destination **subscriptions, filters, and consent requirements are configuration values** (`project_config` / `destinations.config`). Destination **transformations are code**. The mapping prohibition is unchanged and absolute." |
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
   The retroactive-merge worker (§7.3) picks it up from `identity.events`.
6. If the event is identify-family (`user.identified`), merge-patch its
   traits into `profiles.traits`, bump `traits_version`, emit
   `profile.updated` on `profile.events`.
7. Return the snapshot `{profile_id, canonical_customer_id, traits,
   traits_version}` for stamping.

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
  (default 100, a `project_config` value). At the cap, the binding is
  refused with a metric and an `identity.link_rejected` fact — a runaway
  producer cannot inflate one profile into a hot row that stalls its
  partition.
- **Throughput.** One transaction per event on the spine. At Polaris's
  internal volumes this holds with the two partial indexes above;
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

plus the existing processor stamp (`profile-resolver` stamps like any
processor). The producer envelope schema does **not** accept either block —
both `.strict()` schemas already reject unknown top-level fields, so a
producer attempting to forge a profile gets `invalid_envelope` with no new
code. Events on `raw.events` never carry the blocks; events on
`resolved.events` always carry `profile` (possibly `null`-bodied, §4.2.1)
and `enrichment`.

`identity` (producer-observed identifiers) is untouched. Producer truth and
platform resolution stay in separate blocks with separate owners — the same
split as `occurred_at` vs `ingested_at`.

Traits snapshots are size-guarded (cap per `project_config`, default 32 KiB;
over-cap events carry `traits: null` + a metric, never a dropped event).

### 4.5 The identify contract (SDK change)

`identify(customerId, traits)` today persists the id locally and discards
traits. Target:

- `identify()` **emits** `user.identified` (catalog-registered, schema v1)
  carrying traits as properties, alongside its current local-persistence
  behavior. `track()` is unchanged.
- Traits mutate profiles **only** via identify-family events (plus computed
  traits and reverse ETL, §7). Last-write-wins per key at the resolver, which
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
| 2 | Identity resolution (Unify) | Pairwise link ledger; no person, no graph reads, no envelope effect; nobody consumes the output | Profile store + find-or-create + merge inline on the spine; `profile` stamped on every event | §4 entirely: migrations, `profile-resolver` resolve sub-stage, `identity.events` v2, CLI surface (`polaris profiles show/links`), metrics |
| 3 | Enrichment | Geo-only, emitted as *sibling* events nothing joins; production backend is a no-op (no MaxMind, `source:"no_lookup"`); no traits anywhere | Traits snapshot + geo stamped on the spine event | Enrich sub-stage (reuses geoip transform code as a library); real MaxMind backend; traits snapshot plumbing |
| 4 | Per-destination processing | Filter = "does a hand-written mapper exist"; fan-out ignores `project_id` (cross-project delivery defect, C8); consent dimensions hard-coded per vendor; planned skip indistinguishable from failure in `delivery_records` | Routing gate before normalize: per-instance event subscriptions, property filters, consent requirements, project scoping — all config *values*; mappers stay code and stay the terminal safety | Subscription/filter evaluator in `shared-destinations` harness; config schema (`destinations.config` + `project_config`); C8 lands inside this; distinct `skipped_unmapped` / `skipped_filtered` delivery statuses |
| 5 | Delivery | Normalize/map/deliver contract solid; but retry ladder provisioned and unused (failures rewind with no backoff), `dead_letter_threshold` unreachable (attempt counter never increments), `retry_policy` stored and never read, dedupe + rate limiting single-process in-memory | Real tiered retries via the existing `<component>.retry.*` queues with attempt propagation; `retry_policy` maps to tier schedules; Redis-backed delivery dedupe + rate limiting so replicas > 1 are safe | Wire `republishToRetry` into the destination error path; Redis adapters for dedupe/limiter; consolidate the 5× copy-pasted ~370-line `app.ts` into the harness while touching all five |

Stage 2/3 mechanics that come free from existing infrastructure: super-stream
partition ordering, Postgres checkpoints, poison→DLQ, run records, activation
gates, golden-fixture testing — the processor chassis is already built.

---

## 6. Support-plane gap analysis

| Segment async process | Polaris today | Target | Work |
|---|---|---|---|
| Warehouse sync | `clickhouse-sink` streams `analytics.events` + 4 derived families into `analytics_raw` / `analytics_processed` | Same sink, consuming `resolved.events` as the source-fact input; `analytics_raw` gains `profile_id`, `traits_version` columns | Additive DDL + MV update (rebuild machinery exists); flip input family; **give clickhouse-sink a Dockerfile + build entry** (it has none) |
| Trait & audience computation | Nothing | Trait definitions as code (`catalog/traits/*.ts`: key, type, projection-backed SQL); scheduled compute (host cron + `polaris traits compute`, same pattern as the attribution prune); writes via profile store, bumps `traits_version`, emits `trait.computed` + `profile.updated`. Audiences: code-defined predicates over traits/projections; membership in `audience_memberships` (PG runtime state); transitions emit `audience.entered` / `audience.exited` on `profile.events` | New: definitions loader, compute runner, membership table, CLI verbs, catalog events. Trait SQL reads **projections only** (service role) — a governance line that keeps trait compute off `analytics_raw` |
| Retroactive profile merges | Explicitly deferred in three files; replay cannot express it | Merge worker consumes `identity.merged` v2 → upserts ClickHouse `profile_merge_map` (ReplacingMergeTree) backing a `profile_canonical` dictionary; person-keyed queries and projections resolve `dictGetOrDefault('profile_canonical', ...)` at read time. **History is never rewritten** — immutability holds; re-interpretation happens at read. Optional: schedule a `clickhouse-rebuild` for materialized person-keyed projections | New worker (small — one consumer, one upsert), dict DDL, projection guidance in `07-clickhouse.md`. No destination re-sends after merges (Segment doesn't either) |
| Profiles sync | Nothing | `profile.updated` events flow through clickhouse-sink into a `profiles` ClickHouse table (`ReplacingMergeTree(traits_version)`) — streaming, no scheduler, reuses the sink wholesale | Sink routing entry + DDL + MV |
| Reverse ETL | Nothing (`consumers/reverse-etl/` is in the blessed repo shape but absent) | `consumers/reverse-etl/v1`: repo-defined SQL (file-heavy) against projections; schedule + enablement + params in `project_config`; each run POSTs resulting canonical events to the ingester with `source.type: internal` — full validation/policy/dedupe applies; trait-shaped results ride `user.identified`-family events | New consumer + `polaris reverse-etl run <job>` cron verb + job SQL registry; run records reuse `processor_runs` shape |
| Journeys | Nothing | Deferred (§11): state machine over `profile.events` + audiences + a timer store; not designed here | — |

---

## 7. Migration and cutover

Dual-run, one consumer at a time, dedupe-protected. No flag-day.

```text
M1  Provision resolved.events (width 6) + profile.events (width 3)
    families; declare profile-resolver + merge-worker component queues.
    Topology change, runbook exists.
M2  Land profile-store migrations + profile-resolver v1 consuming
    raw.events, emitting resolved.events + identity.events v2 +
    profile.events. analytics-projector keeps running; the two coexist
    (different output families).
M3  clickhouse-sink v2: add resolved.events to the source-fact input set
    (new columns nullable/default). Overlap with analytics.events is safe:
    same event_id, same sort key — ReplacingMergeTree collapses. Verify
    parity (counts by event/day between the two feeds), then drop
    analytics.events from the sink's subscriptions.
M4  Destination consumers: flip input family to resolved.events and adopt
    the routing gate + profile-aware normalize (pickBestIdentity prefers
    canonical_customer_id / profile_id; GA4 client_id from anonymous_id —
    kills the delivery-key shortcut; Braze/Meta gain traits and stable
    external ids). webhook-sink first (exemplar + SPEC.md), then the four
    vendors, one PR each. Ordered after C8's blast-radius query.
M5  sessionizer v2 + attribution-engine v3: input resolved.events, keyed
    by profile_id. Sessions stop orphaning at login (key is stable across
    identify); chains stop fragmenting at anonymous→known. Both are new
    major versions under the semantic-immutability rule; run records and
    activation gates handle coexistence, as attribution v1/v2 already
    proved.
M6  Retire: analytics-projector (activation-disable, then delete),
    geoip-enricher (delete; transform code survives as the enrich
    sub-stage's library), identity-resolver v1 (deprecate, delete after
    M4/M5 verify), enriched.events + analytics.events families
    (decommission = topology migration; retention is declaration-time).
M7  Support plane: merge worker + merge dictionary (R4), traits/audiences
    (R5, R6), reverse ETL (R7).
```

Replay across the cutover: `raw.events` replays reach `profile-resolver`
naturally (same first-hop position as the projector). A replay of Stage 2/3
attaches current profiles — documented as-of semantics (§3). Person-keyed
ClickHouse rebuilds go through the merge dictionary and are deterministic.

---

## 8. Workstreams (the R programme)

Sequenced like the C programme; one row ≈ one card unless noted. Sizes:
S ≤ 2 days, M ≤ 1 week, L > 1 week of focused work.

| # | Workstream | Size | Depends on | Contents |
|---|---|---|---|---|
| R0 | Contract evolution | M | — | Accept this doc; envelope `profile`/`enrichment` blocks in `shared-schemas`; catalog + bindings for the 4 missing events and `user.identified`; SDK `identify()` emits + sends traits (web + node); `profile.events` + `identity.*` v2 + `trait/audience` catalog entries |
| R1 | Profile store + resolver | L | R0 | §4 migrations; `profile-resolver` v1 (resolve + enrich sub-stages, manifests, golden fixtures); MaxMind backend; `identity.events` v2 emission; `polaris profiles` CLI; metrics + dashboards |
| R2 | Spine cutover | L | R1 | M1–M3, M6: topology provisioning, sink v2 + DDL, parity verification, retirements; docs updates (`00`, `03`, `05`, `07`, `docs/README.md`, `claude.md`) |
| R3 | Destination platform | L | R2 (M4) | Routing gate (subscriptions/filters/consent as config values); C8 project scoping; profile-aware normalize; retry-ladder adoption + attempt propagation + `retry_policy` semantics; Redis dedupe/rate-limit; `skipped_unmapped`/`skipped_filtered` statuses; harness-owned `app.ts` |
| R4 | Retroactive merge | M | R2 | Merge worker; `profile_merge_map` + dictionary DDL; person-keyed query guidance; optional rebuild wiring |
| R5 | Traits + profiles sync | M | R2 | Trait definition loader + `polaris traits compute` cron verb; `profiles` CH table fed from `profile.events`; `profile.updated` end-to-end |
| R6 | Audiences | M | R5 | Audience definitions; membership table; entered/exited events; destination delivery of audience transitions (attribute-style via existing vendor consumers) |
| R7 | Reverse ETL | M | R5 | `consumers/reverse-etl/v1`; job SQL registry; cron verb; ingester round-trip |
| R8 | Sessionizer v2 + attribution v3 | M | R2 | M5 as its own stream — mechanical rekeying to `profile_id`, new majors, fixture refresh |
| R9 | Hardening (rolling) | S× | parallel | Items in §9 not consumed by R1–R8 |

Critical path: **R0 → R1 → R2 → R3**, with R8 and R4 fanning out after R2.
R5→R6→R7 are sequential among themselves but independent of R3. The C
programme interleaves: R3 consumes C2/C4 (config store) and C8; the C11
per-service cutovers and R2/R4 touch disjoint code.

---

## 9. Existing defects this plan absorbs or supersedes

Found during the survey; each is either consumed by an R workstream or
independent hardening.

**Superseded (do not fix in place):**
- `identity-resolver` v1 dead branch + partial supersede on double conflict
  (`runtime.ts:555–597`) — v2 semantics replace the whole block (R1).
- GA4 `client_id`-from-delivery-key shortcut — profile-aware normalize (R3/M4).
- Sessionizer login-orphan and attribution chain fragmentation — R8.

**Consumed by workstreams:**
- Fan-out ignores `project_id` (cross-project delivery) — C8, lands inside R3.
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
- **Scheduled warehouse batching.** ClickHouse takes streams; the sink
  stays streaming.
- **Per-instance delivery infrastructure.** Vendor-level consumers fanning
  to instances in-process stay; per-instance streams would multiply the
  operational surface for no current need. If one instance's lag or rate
  ceiling starts dragging its vendor's other instances, that is the same
  graduation decision as topic isolation — noted as a trigger, not built.
- **Inline resolution in the ingest HTTP path.** Ingest stays thin;
  resolution is the first hop behind the broker. The SDK-visible latency
  contract is unchanged.
- **Journey orchestration now.** It sits on audiences + timers and has no
  consumer yet; designing it before audiences exist would be fiction.

## 11. Non-goals and deferrals

- Cross-project identity resolution (graph stays project-bounded).
- Probabilistic / heuristic matching (`confidence='candidate'` stays
  reserved; only deterministic evidence in v1).
- RBAC / consumer-side access control (unchanged trusted-operator posture).
- Object-storage raw archive (replay beyond the 90-day window) — separate
  programme; this plan neither needs nor blocks it.
- Customer deletion — the designed-not-built tombstone flow in
  `01-event-contract.md` gains a natural anchor (the profile) but remains
  deferred until a project needs it.
- Journeys (§10).

## 12. Decision log

| Decision | Alternatives considered | Why this way |
|---|---|---|
| One spine processor (resolve+enrich folded) | Separate identity and enrichment processors (Segment's conceptual split) | Same store row feeds both; one broker hop instead of two; sub-stage versioning preserves independent evolution; split later if scaling demands it |
| New family `resolved.events`; retire `analytics.events` + `enriched.events` | Reuse `analytics.events` name for the enriched spine; keep geo sibling stream | Reuse would silently change a family's semantics under consumers mid-cutover — a rename forces every consumer to opt in knowingly; `enriched.events` name is burned (geoip siblings) |
| Partition spine by `profile_id` | Keep `best_available_identity` key | Per-person ordering downstream regardless of producer identifier churn; the resolver is the last place the weaker key is needed |
| Profile store in Postgres, traits inline on `profiles` | Separate traits table; Redis-first store | One row read per event; traits history lives in ClickHouse (`profile.updated` events), not Postgres; Redis is a later cache, not the source of truth (rebuildability) |
| Merge = eager repoint + read-time ClickHouse dictionary | Rewrite historical rows; query-time graph traversal in PG | Immutability preserved; O(1) reads both sides; dictionary is the standard ClickHouse idiom for exactly this |
| Traits mutate only via identify-family events (+ computed/reverse-ETL writers) | Traits on any `track` context | One serialization point per customer partition; last-write-wins stays explainable |
| Audiences/traits computed from projections only | Compute from `analytics_raw` | Keeps trait compute on the service role and inside the sanctioned query surface |
| Reverse ETL re-enters through the ingester | Direct publish to `raw.events` | Full validation/policy/dedupe for free; `source.type: internal` marks provenance; no second write path to audit |
