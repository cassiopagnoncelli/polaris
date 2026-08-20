# Release Candidate Checklist

This is the gate. **If any row in [The Checklist](#the-checklist)
below is not green, do not cut the release candidate.**

Polaris is internal infrastructure, not an externally-marketed SaaS, but
"internal" is not an excuse for skipping operational discipline. The
release-candidate path is the same regardless of audience: every
operator surface the platform owns must be verified, every runbook the
on-call uses must be reviewed, every dashboard the captain points at
must be live, and the secret-handling posture must be proven before a
build is promoted.

This document is the canonical pre-flight list. Sign-offs are by **role**
(see [Sign-off Roles](#sign-off-roles)), not by person — the role
holder on the day of the release fills the row. Roles may rotate, the
checklist must not change.

The checklist embodies the rule from
[Engineering Standards](../architecture/09-engineering-standards.md):
**boring and explicit**. Every "Evidence required" cell points at a
concrete command, file path, dashboard UID, or runbook section. If a
verification step requires interpretation, the row is wrong and should
be rewritten before the next RC cycle, not waived.

## Required Reading

Read before walking the checklist for the first time:

- [Delivery Roadmap](../implementation/delivery-roadmap.md) — the phase
  story this RC closes.
- [Coverage Matrix](../implementation/coverage-matrix.md) — what's
  covered by tests vs runbooks vs gates.
- [Engineering Standards](../architecture/09-engineering-standards.md)
  — the "boring and explicit" rule the checklist embodies.
- [Production Readiness](../architecture/11-production-readiness.md) —
  the open decisions and the secret-management posture.
- [Backup and Retention](../operations/backup-and-retention.md) — the
  backup/restore runbook.
- [Destination DLQ Triage](../operations/destination-dlq-triage.md) —
  the DLQ triage runbook.

## Sign-off Roles

The roles below are the canonical sign-off owners. A release captain
must collect every row in [The Checklist](#the-checklist) and route
each row to the named role. The captain owns the assembly, the role
holders own their rows.

| Role | Who fills it | What they sign off on |
| --- | --- | --- |
| **Release captain** | Platform on-call engineer for the release window. | Overall RC assembly. Signs the final row only after all role-specific rows are green. |
| **Engineering owner** | The engineer who owns the affected service (per `consumer.manifest.yaml`'s `owner:` field, or per the relevant `apps/<service>/` `CODEOWNERS` entry). | Rows that touch a specific service (processors, consumers, ingester, CLI). One signature per affected service. |
| **Security reviewer** | The platform security engineer on call for the release window. | Secret-handling validation. Independent confirmation that no credentials live in the repo, PostgreSQL, or backup artifacts. |
| **Operator-on-call** | The operations engineer paired to the release window. | Runbook readiness. Confirms every operator-facing runbook is reachable, accurate, and has no known unaddressed gaps. |
| **Compliance operator** | The compliance owner named in [Data Classes](../deployment/data-classes.md). | `audit_records` retention posture, identity / PII rows on the deletion list, and any regulated-data exception. |
| **SDK owner** | The engineer who owns the SDK package being shipped. | SDK handbook accuracy, install snippets, and reason-code stability. |
| **Destination owner** | The engineer who owns the consumer being shipped (per `sync/destinations/<vendor>/v1/consumer.manifest.yaml`). | Destination delivery / retry / DLQ surface for that vendor. One signature per active vendor in the RC. |

If a role holder is unavailable on the day of the release, the role's
team lead is the canonical fallback. Sign-offs from "the person who
happened to be online" are not acceptable — track the role assignment
explicitly.

## The Checklist

Every item from
`P12-005 Implementation Notes`
gets at least one row. Rows are grouped by surface for the captain's
sanity; the order is not load-bearing.

### Build, test, and CI

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **CI green** | `gh run list --workflow=ci.yml --branch <rc-branch> --limit 1` returns a `success` run; PR view shows green for `static-analysis`, `test`, `migrations`. See [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). | Release captain | Latest `ci.yml` run on the RC commit is `success`; no required check is `skipped`. | A `skipped` required check is **not** green. Re-run via Actions UI if needed. |
| **Vertical-slice smoke test** | Local: `pnpm install && docker compose up -d --wait && pnpm db:migrate && pnpm clickhouse:bootstrap-local && pnpm smoke:vertical-slice` exits 0. CI: the integration workflow [`.github/workflows/integration.yml`](../../.github/workflows/integration.yml) ran on the RC commit with the smoke job green. See [`tests/smoke/vertical-slice.test.ts`](../../tests/smoke/vertical-slice.test.ts) and [`docs/implementation/runbooks/vertical-slice-smoke.md`](../implementation/runbooks/vertical-slice-smoke.md). | Release captain | Smoke run produces a `checkout.started v1` row in `analytics_raw` and the vitest wrapper `pnpm test:smoke` exits 0 with `POLARIS_SMOKE_DOCKER=1` set. | Smoke is required-on-merge once it stabilises; today it is gated by the integration workflow trigger (label `integration`, scheduled at 06:00 UTC, or manual dispatch). Trigger it explicitly for the RC commit. |
| **Workspace gate locally** | `pnpm install && pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all exit 0 on the RC commit. | Release captain | All six commands exit 0; `pnpm test` covers the workspace Vitest suite + `pnpm test:scripts`. | This is the same gate `ci.yml` runs. Running it locally is the captain's "have I rebased onto a clean main" check. |

### Product acceptance

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Product acceptance test** | `POLARIS_ACCEPTANCE_TEST=1 pnpm test:acceptance` exits 0 against the local compose stack. The runner is [`scripts/run-acceptance.mjs`](../../scripts/run-acceptance.mjs); the scenario lives at [`tests/acceptance/scenarios/full-pipeline.test.ts`](../../tests/acceptance/scenarios/full-pipeline.test.ts) and is described in [`docs/release/acceptance-test-runbook.md`](./acceptance-test-runbook.md). Captain walks every step in the runbook and confirms a clear pass/fail verdict. | Release captain + Engineering owner per service touched | Acceptance runner exits 0; every step in the runbook shows `PASS`. | The delivery step uses the webhook-sink consumer because Meta CAPI / TikTok / GA4 / Braze need vendor sandboxes; that's a documented scope decision, not a gap. |
| **Internal onboarding guide reviewed** | Captain walks [`docs/onboarding/`](../onboarding/) end-to-end against the current local stack and confirms a fresh internal user can onboard. The 11-file guide covers project lifecycle, API keys, schemas, Web SDK, Node SDK, first-event verification, analytics, destinations, support/escalation, and troubleshooting. | Engineering owner | Every onboarding step is reproducible against the current `main`. | Org-specific operator/on-call channel names in `09-support-and-escalation.md` are deliberate placeholders pending org-level fill-in. |

### Operational runbooks

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Backup/restore runbook reviewed** | Captain reads [`docs/operations/backup-and-retention.md`](../operations/backup-and-retention.md) end-to-end; the quarterly drill log is up to date; the runbook's "Future Extensions" section has no open items that block the RC. | Operator-on-call | The most recent quarterly drill row in the runbook's drill log shows `outcome: ok`. Quarterly drill cadence is honored (no drill more than one quarter stale). | The runbook is the binding source on RPO/RTO. Disagreements between this runbook and `docs/architecture/11-production-readiness.md` resolve in favor of the architecture doc; fix the runbook in the same RC. |
| **DLQ runbook reviewed** | Captain reads [`docs/operations/dlq-triage-runbook.md`](../operations/dlq-triage-runbook.md) (the canonical operator playbook) AND [`docs/operations/destination-dlq-triage.md`](../operations/destination-dlq-triage.md) (destination-side details); SLA targets understood verbatim; `polaris dlq list`, `polaris dlq summary`, `polaris deliveries list` CLI commands run against the local stack and return expected output. | Operator-on-call | Both runbooks rehearsable with no improvisation; SLA targets internalised. | Processor DLQ CLI promotion + cross-vendor `--all` aggregate are documented future-work items in the runbook itself. |
| **Topic-isolation runbook reviewed** | Captain reads [`docs/operations/topic-isolation-cutover.md`](../operations/topic-isolation-cutover.md) and confirms the four dashboards it depends on are live (per the [Dashboards available](#dashboards-available) row). | Operator-on-call | Cutover procedure is unambiguous; all four trigger dashboards under [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/) load against the local Grafana. | Only required if the RC enables isolation for any project. If isolation is not exercised in the RC scope, this row is `n/a`. |
| **Replay dry-run verified** | Captain runs `polaris replay create --processor <name> --from <ts> --to <ts> --mode dry-run` to seed a row, then `polaris replay plan <replay_job_id>` and confirms the dry-run plan renders. See [`apps/polaris-cli/src/commands/replay/plan.ts`](../../apps/polaris-cli/src/commands/replay/plan.ts) and `P7-002`. | Engineering owner (replay) | `polaris replay plan` returns a deterministic plan for a known dry-run job; no production gate is hit because `replay plan` is read-only. | The CLI's `mutates: false` posture means `replay plan` bypasses the `P6-007` production gate. `replay create` does **not** bypass; the captain must hold a valid operator token if exercising mutation against `POLARIS_ENV=production`. |

### SDK and API documentation

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **SDK docs reviewed** | Captain reads [`docs/sdk/`](../sdk/) (README + installation + initialization + api-reference at minimum); the install snippets in [`docs/sdk/installation.md`](../sdk/installation.md) are byte-identical to the snippets quoted in [`docs/onboarding/04-install-web-sdk.md`](../onboarding/04-install-web-sdk.md) and [`docs/onboarding/05-install-node-sdk.md`](../onboarding/05-install-node-sdk.md). | SDK owner | Install snippets compile against the current workspace; reason codes documented in [`docs/sdk/retries-and-errors.md`](../sdk/retries-and-errors.md) match the strings emitted by the ingester; onboarding-guide snippets are byte-identical to the handbook. | The cross-doc identity check is now live (P12-001 + P12-004 both shipped). |
| **API docs reviewed** | Captain reads [`docs/api/README.md`](../api/README.md); `pnpm openapi:check` exits 0 (proves `openapi.yaml`/`openapi.json` regenerates byte-identical from the Zod sources). | Engineering owner (ingester) | `pnpm openapi:check` is green on the RC commit; the committed `openapi.yaml` matches the Zod definitions in [`libs/spec`](../../libs/spec/). | `pnpm openapi:check` is the canonical drift detector. CI already runs `pnpm test`; `openapi:check` is currently an explicit step, not a workflow gate — the captain runs it locally for the RC. |

### Observability and alerting

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Dashboards available** | Captain brings up the local Grafana via `docker compose -f docker-compose.observability.yml up -d`, opens each P10-003 service-level dashboard JSON from [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/) (`polaris-ingestion`, `polaris-rabbitmq`, `polaris-processors`, `polaris-destinations`, `polaris-clickhouse`) plus the P11-008 per-project drilldowns (`per-project-consumer-lag`, `per-project-schema-validation`, `per-partition-skew`, `per-project-shared-topic-throughput`), and confirms each panel has recent data when traffic is flowing. The canonical index is [`docs/operations/dashboards.md`](../operations/dashboards.md). | Operator-on-call | Every committed dashboard JSON loads in Grafana; every panel shows non-empty data against the local stack with the smoke test traffic flowing. | Some panels are placeholders pending a dedicated ClickHouse Prometheus exporter and histogram metrics; these gaps are listed verbatim in `docs/operations/dashboards.md`. |
| **Alert / runbook links available** | Captain reads [`docs/operations/alerts.md`](../operations/alerts.md) (14 alert rules — 10 page + 4 warn), spot-checks 3 alerts and confirms each `runbook_url` resolves to an existing runbook anchor under [`docs/operations/`](../operations/). The recording-rule + alert-rule files are at [`infra/prometheus/rules/`](../../infra/prometheus/rules/). | Operator-on-call | Every `runbook_url` in `alerts.md` resolves to an existing anchor; SLOs in [`docs/operations/slos.md`](../operations/slos.md) match what the dashboards surface. | Six v1 metric placeholders are flagged as `_TODO_` in `alerts.md` with `vector(0) > N` guards so the alert never fires until the metric ships — the operator-on-call reviews the list. |
| **Logging pipeline reviewed** | Captain reads [`docs/operations/logging.md`](../operations/logging.md), confirms the promtail config at [`infra/loki/promtail-config.yaml`](../../infra/loki/promtail-config.yaml) tails the Pino stdout streams, and verifies the four-label cardinality posture (`service`/`env`/`level`/`project_id` only). | Operator-on-call | Loki + promtail come up via the observability compose, services do not depend on them, and no plaintext-payload logging escapes the shared logger's redaction. | Redaction lives in `@polaris/shared-logger`; Loki sees what the logger emits. |

### Security and secrets

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Secrets not stored in repo** | `rg -nE '(password|secret|token|key)\s*=\s*[\"'\''`]?[A-Za-z0-9+/=._-]{8,}' . --hidden -g '!node_modules' -g '!*.lock' -g '!*.md' -g '!docs/release/release-candidate-checklist.md'` returns no plaintext credentials. Manually inspect any hits — substrings like `secret_ref` or `api_key_id` are structural and acceptable; the offending pattern is a literal that looks credential-shaped. The only committed `.env*` template is [`db/.env.example`](../../db/.env.example), which holds a local-only password. | Security reviewer | Zero literal credentials in the repo. The `db/.env.example` template is the only `.env*` file and it documents that real values are never committed. | The grep is intentionally noisy. The reviewer reads every hit, not "approximately zero" hits. |
| **Per-project secrets are masked on every read path** | PostgreSQL deliberately DOES hold plaintext per-project credentials (`destinations.secret_value`, `project_config.value` with `is_secret`). What must hold is that no read path discloses one: verify `DESTINATION_READ_COLUMNS` in [`libs/persistence/control-plane/src/queries/destinations.ts`](../../libs/persistence/control-plane/src/queries/destinations.ts) omits `secret_value`; that `toRow` in [`queries/project-config.ts`](../../libs/persistence/control-plane/src/queries/project-config.ts) masks; and that `revealProjectConfigSecret` is the only unmasked reader. `api_keys.hash` and `operator_tokens.hash` remain argon2id. | Security reviewer | No list view, `show`, export, log line or audit snapshot emits a credential. The two deliberate disclosure paths are `polaris config get --reveal` and the deliverer's `DelivererContext.secret`. | A regression here is a release-blocker. Grep the delivery logs of a staging soak for a known destination credential — the highest-volume disclosure would be one log line per delivered event. |
| **Control-plane database treated as credential material** | The database holds live vendor credentials in plaintext, so its access controls and backups carry that sensitivity. Verify: production PostgreSQL is not readable by any role that does not need write access to the control plane; backups are encrypted at rest; the restore runbook names credential rotation as a post-incident step. Rotation runbook at [`docs/operations/secret-rotation.md`](../operations/secret-rotation.md). | Security reviewer | Database access list reviewed and minimal; backup encryption confirmed; on-call knows a leaked backup means rotating every destination. | This is the standing cost of the plaintext design and the thing most likely to be forgotten. There is no external secret manager to fall back on. |
| **Audit posture verified** | Captain confirms every state-changing CLI command writes an `audit_records` row by reading the runbook coverage in [`docs/development/audit-and-export.md`](../development/audit-and-export.md). For any service that introduces new mutations in the RC scope, the engineering owner confirms the corresponding `audit_records` write is in place. | Compliance operator | No mutation surface ships without a matching `audit_records` row. | The architectural rule: every `polaris` CLI mutation is audited. Tests cover the existing surface; new surface introduced in the RC needs explicit verification. |

### Release artifact discipline

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Known limitations documented** | Captain reads [Known Limitations](#known-limitations) below and confirms every entry is current. Any new v1 caveat surfaced during this RC cycle is added to that section in the same commit. | Release captain | The section reflects the RC's actual gap surface; no gap is in production without being listed here. | This is the operator-readable view of the platform's "we know about this and it's not fixed in v1" surface. |
| **Release notes drafted** | Captain has drafted the RC release notes pulling from this checklist's `BLOCKED` rows and the [Known Limitations](#known-limitations) section. | Release captain | Release notes name every known limitation an internal consumer will hit. | The release notes live wherever the team publishes them (PR description on the release branch, an internal page); the checklist does not own their location. |
| **Versioning and build metadata** | Captain confirms every shipped service's `/health` returns `service`, `version`, `git_sha`, `build_time`, `release_label` per the hybrid versioning model in [`docs/deployment/versioning.md`](../deployment/versioning.md). The shared helper is `getBuildMetadata()` in [`libs/runtime/service-bootstrap`](../../libs/runtime/service-bootstrap/src/bootstrap/build-metadata.ts); image-side build args (`POLARIS_BUILD_VERSION` / `POLARIS_GIT_SHA` / `POLARIS_BUILD_TIME`) are injected by [`scripts/docker-build.mjs`](../../scripts/docker-build.mjs). | Release captain | `/health` on every service returns all five fields; `POLARIS_RELEASE_LABEL` is set per the rollout cadence; the same image rolls forward across releases with the label updating at container start. | `delivery_records.consumer_build_version` is stamped on every new row by all five v1 consumers (M0DROHV3, migration [`db/migrations/20260515000002_add_delivery_records_consumer_build_version.sql`](../../db/migrations/20260515000002_add_delivery_records_consumer_build_version.sql)); pre-migration rows stay NULL. Bisecting a regression to a specific rollout no longer requires joining against the rollout timeline. See [`docs/deployment/versioning.md`](../deployment/versioning.md#records-that-pin-the-semantic-version) for the full record-axis table. |

## Known Limitations

Operator-relevant v1 caveats. Consolidated from the consumer SPECs, the
runbook "Future Extensions" sections, the architecture's "Open
Production Decisions" block, and the kanban's outstanding tasks. The
captain reviews this section every RC cycle and prunes / extends it.

### Platform scope

- **Single-region v1.** Cross-region backup replication and PII
  residency controls land with the multi-region work. Reference:
  [Production Readiness / Locked Decisions](../architecture/11-production-readiness.md#locked-decisions-that-previously-sat-here).
- **No automated `audit_records` purge cron.** The 2-year retention
  policy is documented; the physical purge job is operator-owned today.
  Reference:
  [`docs/operations/backup-and-retention.md` / Future Extensions](../operations/backup-and-retention.md#future-extensions).
- **No customer-deletion API.** The deletion pattern is deferred; today
  PII removal is an operator workflow against `analytics_raw` and
  `identity_links`. Reference:
  [Coverage Matrix / Customer deletion](../implementation/coverage-matrix.md#architecture-coverage).
- **RBAC deferred.** v1 ships a single trusted-operator model; the
  a dedicated IdP-backed CLI actor source is a P11+ stretch goal. Reference:
  [Production Readiness / Control-Plane Permissions](../architecture/11-production-readiness.md#control-plane-permissions).
- **No object-storage raw archive.** Replay is bounded by the 90-day
  RabbitMQ retention window. Tiered storage or out-of-cluster archive
  is honest future work, gated on first-production-month data.
  Reference:
  [`docs/operations/backup-and-retention.md` / Future Extensions](../operations/backup-and-retention.md#future-extensions).
- **Automated backup verification is manual.** Today's restore drill is
  a quarterly human cadence. The automated nightly verification cron is
  follow-up work. Reference: same runbook section.

### Observability stack v1 caveats

- **Six alert rules carry `_TODO_` metric placeholders.** Alert
  thresholds are pinned by [`docs/operations/alerts.md`](../operations/alerts.md)
  but six rules are wired with `vector(0) > N` guards because the
  underlying metric does not exist in v1 (publish failure, ClickHouse
  ingestion lag, ClickHouse MV state, replay job progress, operator
  gate denial). They never fire today; the operator-on-call reviews
  the `_TODO_` list each cycle to track what's still missing.
- **Some dashboard panels are placeholders.** No histogram metrics in
  v1 (the `_ms_last` gauges are the proxy), no dedicated
  publish-failure metric, no native ClickHouse Prometheus exporter;
  gaps documented verbatim in
  [`docs/operations/dashboards.md`](../operations/dashboards.md).

### Per-consumer caveats (v1)

Consolidated from each consumer's `SPEC.md`. The destination owner
confirms each row matches the live consumer code.

- **Meta CAPI v1:** No outstanding v1 caveats — the v1.x event matrix
  is closed (`checkout.started`, `payment.approved`, `user.identified`,
  `signup.completed`, `subscription.renewed`) and mobile-source
  detection lands `action_source: "app"` on the wire. See
  [`sync/destinations/meta-capi/v1/SPEC.md`](../../sync/destinations/meta-capi/v1/SPEC.md).
- **TikTok v1:** No outstanding v1 caveats — same event-matrix and
  mobile-source coverage as Meta CAPI; `event_source: "app"` lands on
  the request wrapper. See
  [`sync/destinations/tiktok/v1/SPEC.md`](../../sync/destinations/tiktok/v1/SPEC.md).
- **Webhook sink v1:** Passthrough mapper only; per-event vendor-style
  mappers are the structural template for future vendors but the
  webhook sink itself stays event-agnostic. No app-channel branching by
  design — receivers consume `event.context.app_*` directly off the
  canonical envelope. See
  [`sync/destinations/webhook-sink/v1/SPEC.md`](../../sync/destinations/webhook-sink/v1/SPEC.md).
- **GA4 v1:** Uses GA4 Measurement Protocol with API-secret
  URL-redaction defense in the deliverer summary. GA4 has no
  recommended event for recurring billing, so `subscription.renewed`
  is mapped to a snake_case custom event (`subscription_renewed`),
  which GA4 does not cross-channel dedupe. Firebase / app-stream
  routing (via the credential's optional `firebase_app_id` slot)
  requires operators to rotate the credential to include the Firebase
  app id; without it, app-source events flow through the web-stream
  URL with the synthesized `client_id`. Operators have a path:
  [GA4 Firebase app-stream rotation](../operations/ga4-firebase-app-stream-rotation.md).
  See [`sync/destinations/ga4/v1/SPEC.md`](../../sync/destinations/ga4/v1/SPEC.md).
- **Braze v1:** Braze provides no vendor-side event dedupe; the
  Polaris-side `(destination_id, delivery_key)` defense in
  `@polaris/shared-destinations` is the canonical idempotency guard.
  No first/last-name slots (canonical envelope lacks them). See
  [`sync/destinations/braze/v1/SPEC.md`](../../sync/destinations/braze/v1/SPEC.md).

### Open production decisions (wait-for-data)

These are not gaps so much as deliberate "decide after observing real
traffic" parking spaces. Listed for transparency; the captain
references them when sizing the RC's operational expectations.

- **RabbitMQ byte-cap retention and tiered storage.** Time-based
  retention is locked at 90 days for `raw.events`; byte caps revisited
  after first-project disk data.
- **Per-project ingress dedupe window overrides.** 15-min default
  locked; project-specific extensions (up to 24h) gated on demonstrated
  producer-side need.
- **Topic isolation activation thresholds.** Triggers are structural;
  the `>25% share` threshold and similar numeric tails are revisited
  after observed traffic.
- **Initial alert thresholds and SLOs.** Defaults shipped in
  [`docs/operations/alerts.md`](../operations/alerts.md) and
  [`docs/operations/slos.md`](../operations/slos.md) per the v1
  posture; they tighten after observed traffic.

Reference for this whole section:
[Production Readiness / Open Production Decisions](../architecture/11-production-readiness.md#open-production-decisions).

## Pre-Launch Deployment Order

The deployment-side ordering for production rollout, once every row in
the checklist above is green. Encouraged but not load-bearing — the
captain may sequence differently if the deployment topology demands it,
provided every step lands.

1. **Provision infrastructure.** RabbitMQ cluster (RF=3, min-ISR=2),
   PostgreSQL primary + WAL streaming, ClickHouse Replicated engines +
   Keeper, Redis. Reference: [Data
   Classes](../deployment/data-classes.md) for store-level retention.
2. **Provision credentials.** Create each production destination with
   its vendor credential (`polaris destinations create --secret-value`)
   and set any per-project secret values (`polaris config set
   --secret`). Confirm the database's access controls and backup
   encryption first — these writes put live credentials in it.
   Reference: [Secret Rotation runbook](../operations/secret-rotation.md);
   the architectural rule is in
   [Production Readiness / Secret Management](../architecture/11-production-readiness.md#secret-management).
3. **Run migrations.** `pnpm db:migrate` against the production
   PostgreSQL; `pnpm clickhouse:migrate` against the production
   ClickHouse cluster. Both are idempotent.
4. **Deploy services.** Ingester first (the entry point), then
   processors, then destination consumers. Each service ships its own
   container image with embedded git SHA. Reference: [Engineering
   Standards / Containers](../architecture/09-engineering-standards.md#containers).
5. **Seed control-plane state.** Create the first project, sources,
   API keys, and destinations via the CLI. Every mutation writes an
   `audit_records` row.
6. **Light traffic.** Send one canonical event via each shipped SDK
   and confirm the row lands in `analytics_raw` (the same pattern the
   smoke test exercises). Reference: [Vertical-Slice Smoke
   Runbook](../implementation/runbooks/vertical-slice-smoke.md).
7. **Enable one destination.** Activate one destination instance and
   verify `polaris deliveries list` returns `accepted` rows. Reference:
   [Destination DLQ Triage](../operations/destination-dlq-triage.md).
8. **Schedule operational cadence.** Wire the quarterly backup drill,
   the alert routing, and the on-call rotation. References:
   [Backup and Retention / Quarterly Recovery
   Drills](../operations/backup-and-retention.md#quarterly-recovery-drills)
   and [Alerts](../operations/alerts.md).

## See Also

- [Delivery Roadmap](../implementation/delivery-roadmap.md) — phase
  story this RC closes.
- [Coverage Matrix](../implementation/coverage-matrix.md) — what's
  covered by tests vs runbooks vs gates.
- [Engineering Standards / CI Quality
  Gates](../architecture/09-engineering-standards.md#ci-quality-gates).
- [Production Readiness](../architecture/11-production-readiness.md).
- [Vertical-Slice Smoke Runbook](../implementation/runbooks/vertical-slice-smoke.md).
- [Backup and Retention](../operations/backup-and-retention.md).
- [Destination DLQ Triage](../operations/destination-dlq-triage.md).
- [Topic-Isolation Cutover](../operations/topic-isolation-cutover.md).
- [Data Classes](../deployment/data-classes.md).
- [SDK Handbook](../sdk/README.md).
- [API Documentation](../api/README.md).
