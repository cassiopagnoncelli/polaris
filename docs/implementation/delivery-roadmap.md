# Polaris Delivery Roadmap

This roadmap extends the first vertical slice into a properly deliverable internal product.

The roadmap is intentionally phased. Claude or any other worker should pick one task card at a time from the kanban and should not skip dependencies.

## Delivery Definition

Polaris is product-delivered when an internal team can:

1. register a project/source
2. create scoped write keys
3. install the Web or Node SDK
4. send governed events
5. see accepted/rejected ingestion outcomes
6. process events into identity/session/analytics streams
7. persist analytics into ClickHouse
8. enable at least one destination safely
9. inspect delivery records and DLQs
10. run controlled replay/dry-run workflows
11. operate the platform with logs, metrics, dashboards, and runbooks
12. deploy services with repeatable CI/CD and secret handling

## Phase Summary

```text
P0 Foundation packages and workspace
P1 Local infrastructure and storage
P2 Ingester API
P3 SDKs
P4 First processor and ClickHouse integration
P5 Vertical slice smoke test
P6 Control-plane CLI
P7 Replay system
P8 Production processors
P9 Destination consumers
P10 Observability and operations
P11 Deployment, security, and data lifecycle
P12 Release readiness and internal product delivery
```

## P0-P5: First Vertical Slice

Goal:

```text
SDK/test client
  -> ingester
  -> RabbitMQ raw.events
  -> simple processor
  -> RabbitMQ analytics.events
  -> ClickHouse
  -> smoke test
```

This phase proves the architecture without building every production feature.

Exit criteria:

- local core stack starts
- one governed event schema exists
- ingester accepts a valid event and rejects invalid events
- event is published to `raw.events`
- one processor emits `analytics.events`
- ClickHouse persists analytical rows
- smoke test or repeatable script proves the path

## P6: Control-Plane CLI

Goal:

Make operational state manageable without ad hoc SQL.

CLI must cover:

- projects
- sources
- API keys
- destination instances
- processor runtime state
- replay job creation/inspection
- audit/export commands

Exit criteria:

- internal operator can create/revoke a key without manual SQL
- internal operator can inspect sources, destinations, processors, and audit records
- CLI outputs are stable enough for scripts

## P7: Replay System

Goal:

Make replay deliberate, scoped, auditable, and safe.

Replay must cover:

- dry runs
- source topic/time/offset planning
- processor replay
- destination suppression by default
- explicit destination replay opt-in
- ClickHouse rebuild workflows

Exit criteria:

- replay jobs are stored in PostgreSQL
- CLI can create dry-run and executable replay jobs
- replay lineage records source range, target version, requester, reason, status, and outcome
- destinations are suppressed unless explicitly enabled

## P8: Production Processors

Goal:

Replace the single skeleton processor with the first useful processing graph.

Initial processors:

- identity resolver v1
- sessionizer v1
- geoip enricher v1
- attribution engine v1
- analytics projector v1

Exit criteria:

- each processor is versioned
- each processor has manifest, changelog, fixtures, and tests
- outputs include processor metadata
- processor runs are recorded
- no processor mutates raw events

## P9: Destination Consumers

Goal:

Deliver canonical events to downstream systems safely.

Initial consumers:

- webhook sink v1
- Meta CAPI v1
- GA4 v1
- TikTok v1
- Braze v1

Exit criteria:

- consumer mappings are code-only
- destination instances are runtime state
- delivery records exist
- retries and DLQs exist
- vendor dedupe fields are used where supported
- replay sends are disabled by default

## P10: Observability and Operations

Goal:

Make Polaris operable by internal engineers.

Deliver:

- optional observability compose
- metrics standardization
- dashboards
- Loki logging pipeline
- alert rules
- incident runbooks
- DLQ triage runbook

Exit criteria:

- local observability stack starts optionally
- core services emit standard metrics and logs
- dashboards cover ingestion, RabbitMQ, processors, destinations, and ClickHouse
- alerts and runbooks exist for obvious failure modes

## P11: Deployment, Security, and Data Lifecycle

Goal:

Prepare Polaris for real internal traffic.

Deliver:

- production Dockerfiles
- CI workflow
- deployment templates
- secret provider production adapter
- origin/rate-limit hardening
- backup and restore runbooks
- data retention policy implementation
- build metadata/version stamping

Exit criteria:

- images build repeatably
- CI gates match the engineering standards
- secrets are referenced, not stored
- API key and frontend origin controls exist
- backup/restore expectations are documented

## P12: Release Readiness

Goal:

Make Polaris usable and supportable by internal teams.

Deliver:

- SDK handbook
- API documentation
- internal onboarding guide
- release checklist
- product acceptance test
- example integration project

Exit criteria:

- one internal project can onboard using docs
- one Web SDK event and one Node SDK event are demonstrated
- dashboards and DLQ inspection are documented
- operational owner can run replay dry-run
- release candidate checklist is complete

## Post-P12: Pipeline Redesign (the R Programme)

P0–P12 delivered the v1 fan-out platform. The accepted redesign
([pipeline-redesign-plan.md](./pipeline-redesign-plan.md)) restructures it
into a staged main pipeline (ingest → resolve → enrich → transform →
deliver) with a profile plane and the six async pipelines of the reference
model, organized in the repo as `{sync,async}/{stage}/{name}/{version}`.

```text
R0L Pipeline-shaped repo layout      mechanical; parallel with R0, lands first
R0  Contract evolution               envelope blocks, catalog registration,
                                     SDK identify() emits traits
R1  Profile store + spine stages     sync/identity/resolver, sync/enrichment
R2  Spine cutover                    identified/resolved.events, sink v2,
                                     projector/geoip/identity-resolver retire
R3  Destination platform             routing gate, retry ladder, Redis limits
R4  Retroactive merges               merge worker + ClickHouse merge dictionary
R5  Traits compute + profiles sync
R6  Audiences
R7  Reverse ETL
R8  Sessionizer v2 + attribution v3  async/computation, profile_id-keyed
R9  Rolling hardening backlog
R10 Warehouse exports + raw archive  scheduled batch tier; replay past 90 days
R11 Journey orchestration
```

Critical path: `R0 → R1 → R2 → R3`; R8 and R4 fan out after R2;
R5 → R6 → R7 sequence among themselves; R10 needs R2 (profiles slice R5);
R11 closes the programme after R6.

Polaris is redesign-delivered when:

1. every event on `resolved.events` carries `profile` + `enrichment`
2. destinations receive resolved, enriched, filtered events, with
   subscriptions/filters/consent as configuration values
3. profiles, traits, computed traits, and audiences exist and are queryable
4. retroactive merges re-link history at read time via the merge dictionary
5. events and unified profiles reach the warehouse tier on schedule
   (exports + object-storage archive)
6. reverse ETL re-enters the platform through the ingester
7. journeys advance profiles through waits and branches
8. the repo tree matches `{sync,async}/{stage}/{name}/{version}`

Workstream detail, migration ladder (M0–M7), and decision log live in the
plan doc.

## Scope Discipline

If a task tries to introduce a major new architectural concept, stop and create a new decision doc before coding.

Examples of changes that require explicit review:

- moving event schemas into PostgreSQL
- adding a heavy stream processing framework
- introducing a new ORM
- adding a new package manager/task runner
- adding automatic SDK page tracking
- adding fingerprinting
- making destination replay sends default-on
- querying ClickHouse ingestion interface tables directly

