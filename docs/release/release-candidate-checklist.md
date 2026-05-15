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
| **Destination owner** | The engineer who owns the consumer being shipped (per `consumers/<vendor>/v1/consumer.manifest.yaml`). | Destination delivery / retry / DLQ surface for that vendor. One signature per active vendor in the RC. |

If a role holder is unavailable on the day of the release, the role's
team lead is the canonical fallback. Sign-offs from "the person who
happened to be online" are not acceptable — track the role assignment
explicitly.

## The Checklist

Every item from
[`P12-005 Implementation Notes`](../implementation/tasks/P12-005-release-candidate-checklist.md#implementation-notes)
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
| **Product acceptance test** | Acceptance runbook walked end-to-end. See **Status** below. | Release captain + Engineering owner per service touched | Runbook exists, the captain executes every step, every step passes. | **Status: Blocked on [P12-003](../implementation/tasks/P12-003-product-acceptance-test.md).** The acceptance runbook (`docs/release/acceptance-test-runbook.md`) lands with P12-003. Until P12-003 ships, the RC captain marks this row `BLOCKED` and the release cannot promote. |
| **Internal onboarding guide reviewed** | Captain walks `docs/onboarding/` end-to-end against the current local stack and confirms a fresh internal user can onboard. See **Status** below. | Engineering owner | Every onboarding step is reproducible against the current `main`. | **Status: Blocked on [P12-004](../implementation/tasks/P12-004-internal-onboarding-guide.md).** Until P12-004 ships, the captain notes the guide is missing and falls back to [`docs/development/getting-started.md`](../development/getting-started.md). The RC may proceed if the captain explicitly accepts onboarding-doc gap as a known limitation; see [Known Limitations](#known-limitations). |

### Operational runbooks

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Backup/restore runbook reviewed** | Captain reads [`docs/operations/backup-and-retention.md`](../operations/backup-and-retention.md) end-to-end; the quarterly drill log is up to date; the runbook's "Future Extensions" section has no open items that block the RC. | Operator-on-call | The most recent quarterly drill row in the runbook's drill log shows `outcome: ok`. Quarterly drill cadence is honored (no drill more than one quarter stale). | The runbook is the binding source on RPO/RTO. Disagreements between this runbook and `docs/architecture/11-production-readiness.md` resolve in favor of the architecture doc; fix the runbook in the same RC. |
| **DLQ runbook reviewed** | Captain reads [`docs/operations/destination-dlq-triage.md`](../operations/destination-dlq-triage.md); SLA targets understood; `polaris deliveries list` and `polaris dlq list` CLI commands run against the local stack and return expected output. See **Status** below for general DLQ triage doc. | Operator-on-call | The destination-DLQ workflow is rehearsable from the runbook with no improvisation required. | **Note: The general DLQ triage runbook (`docs/operations/dlq-triage-runbook.md`) is [P10-006](../implementation/tasks/P10-006-dlq-triage-runbook.md), still backlog.** Today, the destination-DLQ runbook covers the destination path end-to-end; the per-topic / per-processor DLQ triage path lands with P10-006. Captain notes the gap if the RC includes a processor whose DLQ behavior is not yet documented. |
| **Topic-isolation runbook reviewed** | Captain reads [`docs/operations/topic-isolation-cutover.md`](../operations/topic-isolation-cutover.md) and confirms the four dashboards it depends on are live (per the [Dashboards available](#dashboards-available) row). | Operator-on-call | Cutover procedure is unambiguous; all four trigger dashboards under [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/) load against the local Grafana. | Only required if the RC enables isolation for any project. If isolation is not exercised in the RC scope, this row is `n/a`. |
| **Replay dry-run verified** | Captain runs `polaris replay create --processor <name> --from <ts> --to <ts> --mode dry-run` to seed a row, then `polaris replay plan <replay_job_id>` and confirms the dry-run plan renders. See [`apps/polaris-cli/src/commands/replay/plan.ts`](../../apps/polaris-cli/src/commands/replay/plan.ts) and [P7-002](../implementation/tasks/P7-002-replay-planner-dry-run.md). | Engineering owner (replay) | `polaris replay plan` returns a deterministic plan for a known dry-run job; no production gate is hit because `replay plan` is read-only. | The CLI's `mutates: false` posture means `replay plan` bypasses the [P6-007](../implementation/tasks/P6-007-operator-tokens-and-mutation-gate.md) production gate. `replay create` does **not** bypass; the captain must hold a valid operator token if exercising mutation against `POLARIS_ENV=production`. |

### SDK and API documentation

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **SDK docs reviewed** | Captain reads [`docs/sdk/`](../sdk/) (README + installation + initialization + api-reference at minimum); the install snippets in [`docs/sdk/installation.md`](../sdk/installation.md) are byte-identical to the snippets the onboarding guide will reference once [P12-004](../implementation/tasks/P12-004-internal-onboarding-guide.md) lands. | SDK owner | Install snippets compile against the current workspace; reason codes documented in [`docs/sdk/retries-and-errors.md`](../sdk/retries-and-errors.md) match the strings emitted by the ingester. | Until P12-004 lands, the captain only validates SDK handbook internal consistency; the cross-doc identity is a future RC check. |
| **API docs reviewed** | Captain reads [`docs/api/README.md`](../api/README.md); `pnpm openapi:check` exits 0 (proves `openapi.yaml`/`openapi.json` regenerates byte-identical from the Zod sources). | Engineering owner (ingester) | `pnpm openapi:check` is green on the RC commit; the committed `openapi.yaml` matches the Zod definitions in [`packages/shared-schemas`](../../packages/shared-schemas/). | `pnpm openapi:check` is the canonical drift detector. CI already runs `pnpm test`; `openapi:check` is currently an explicit step, not a workflow gate — the captain runs it locally for the RC. |

### Observability and alerting

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Dashboards available** | Captain brings up the local Grafana via `docker compose -f docker-compose.observability.yml up -d`, opens each dashboard JSON from [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/) (`polaris-overview`, `per-project-shared-topic-throughput`, `per-partition-skew`, `per-project-consumer-lag`, `per-project-schema-validation`), and confirms each panel has recent data when traffic is flowing. | Operator-on-call | Every committed dashboard JSON loads in Grafana; every panel shows non-empty data against the local stack with the smoke test traffic flowing. | The dashboards listed in [`docs/operations/topic-isolation-cutover.md`](../operations/topic-isolation-cutover.md) are the load-bearing set for isolation triggers; all four exist today. The canonical dashboards-doc index (`docs/operations/dashboards.md`) lands with [P10-003](../implementation/tasks/P10-003-grafana-dashboards.md) — until then the captain uses the directory listing directly. |
| **Alert / runbook links available** | Captain spot-checks 3 alerts from the alerts doc and confirms each `runbook_url` resolves to an existing runbook section. See **Status** below. | Operator-on-call | Every `runbook_url` referenced in the alerts file resolves to an existing anchor in `docs/operations/`. | **Status: Blocked on [P10-005](../implementation/tasks/P10-005-alerts-runbooks.md).** Until P10-005 ships, alerts exist only in the architecture doc ([`docs/architecture/08-observability-and-operations.md`](../architecture/08-observability-and-operations.md)). The captain marks this row `BLOCKED` and lists it under [Known Limitations](#known-limitations). The RC may proceed if the operator-on-call explicitly accepts the alert-coverage gap. |
| **Logging pipeline reviewed** | Captain confirms the Loki ingestion path exists at [`infra/loki/loki.yaml`](../../infra/loki/loki.yaml) and that services emit structured JSON logs per the [Engineering Standards / Logging](../architecture/09-engineering-standards.md#logging) rules. See **Status** below. | Operator-on-call | Production services configured to push to Loki; no plaintext-payload logging in production builds. | **Status: Loki pipeline doc is [P10-004](../implementation/tasks/P10-004-loki-logging-pipeline.md), still backlog.** Until P10-004 ships, the captain validates the structural rule (JSON logs, redacted) against the shared logger package directly; the operational doc lands with P10-004. |

### Security and secrets

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Secrets not stored in repo** | `rg -nE '(password|secret|token|key)\s*=\s*[\"'\''`]?[A-Za-z0-9+/=._-]{8,}' . --hidden -g '!node_modules' -g '!*.lock' -g '!*.md' -g '!docs/release/release-candidate-checklist.md'` returns no plaintext credentials. Manually inspect any hits — substrings like `secret_ref` or `api_key_id` are structural and acceptable; the offending pattern is a literal that looks credential-shaped. The only committed `.env*` template is [`db/.env.example`](../../db/.env.example), which holds a local-only password. | Security reviewer | Zero literal credentials in the repo. The `db/.env.example` template is the only `.env*` file and it documents that real values are never committed. | The grep is intentionally noisy. The reviewer reads every hit, not "approximately zero" hits. |
| **Secrets not stored in PostgreSQL** | The control-plane schema stores `(secret_provider, secret_ref)` literals, never plaintext. Verified by inspecting [`packages/shared-secrets/src/index.ts`](../../packages/shared-secrets/src/index.ts) (`PostgreSQL stores references, never plaintext`) and the destination / API key migrations under [`db/migrations/`](../../db/migrations/) — `api_keys.hash` is argon2id, `operator_tokens.hash` is argon2id, `destinations.secret_ref` is a `provider:ref` literal. | Security reviewer | No PostgreSQL column holds a plaintext secret. argon2id hashes are the only credential-derived bytes in the DB. | The `shared-secrets` package documents this as the load-bearing platform rule. A regression here is a release-blocker. |
| **Secret provider configured for production** | Production secret provider configured per the architecture rule. See **Status** below. | Security reviewer | Production deployment resolves `(secret_provider, secret_ref)` through Vault (or the architecturally-equivalent managed service). | **Status: Blocked on [P11-004](../implementation/tasks/P11-004-production-secret-provider.md).** Local development uses the `env` adapter ([`packages/shared-secrets/src/providers/`](../../packages/shared-secrets/src/providers/)); production needs the Vault adapter. The deployment doc (`docs/deployment/secret-provider-vault.md`) lands with P11-004. Until then, the security reviewer documents the production secret-resolution path manually and notes the gap. |
| **Audit posture verified** | Captain confirms every state-changing CLI command writes an `audit_records` row by reading the runbook coverage in [`docs/development/audit-and-export.md`](../development/audit-and-export.md). For any service that introduces new mutations in the RC scope, the engineering owner confirms the corresponding `audit_records` write is in place. | Compliance operator | No mutation surface ships without a matching `audit_records` row. | The architectural rule: every `polaris` CLI mutation is audited. Tests cover the existing surface; new surface introduced in the RC needs explicit verification. |

### Release artifact discipline

| Item | Evidence required | Owner role | Pass criteria | Notes |
| --- | --- | --- | --- | --- |
| **Known limitations documented** | Captain reads [Known Limitations](#known-limitations) below and confirms every entry is current. Any new v1 caveat surfaced during this RC cycle is added to that section in the same commit. | Release captain | The section reflects the RC's actual gap surface; no gap is in production without being listed here. | This is the operator-readable view of the platform's "we know about this and it's not fixed in v1" surface. |
| **Release notes drafted** | Captain has drafted the RC release notes pulling from this checklist's `BLOCKED` rows and the [Known Limitations](#known-limitations) section. | Release captain | Release notes name every known limitation an internal consumer will hit. | The release notes live wherever the team publishes them (PR description on the release branch, an internal page); the checklist does not own their location. |
| **Versioning and build metadata** | Captain confirms the RC build embeds package version, git SHA, build timestamp, and image metadata per [Engineering Standards / Versioning](../architecture/09-engineering-standards.md#versioning-and-releases). See **Status** below. | Release captain | `/version` or equivalent endpoint on every shipped service returns the expected metadata. | **Status: Blocked on [P11-007](../implementation/tasks/P11-007-release-versioning-build-metadata.md).** Until P11-007 lands, the captain confirms manually that the build process at least stamps the git SHA on the container image; the standardised metadata endpoint is future work. |

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
  `cli_oidc` actor source is a P11+ stretch goal. Reference:
  [Production Readiness / Control-Plane Permissions](../architecture/11-production-readiness.md#control-plane-permissions).
- **No object-storage raw archive.** Replay is bounded by the 90-day
  Redpanda retention window. Tiered storage or out-of-cluster archive
  is honest future work, gated on first-production-month data.
  Reference:
  [`docs/operations/backup-and-retention.md` / Future Extensions](../operations/backup-and-retention.md#future-extensions).
- **Automated backup verification is manual.** Today's restore drill is
  a quarterly human cadence. The automated nightly verification cron is
  follow-up work. Reference: same runbook section.

### Operational doc surface

- **Alerts and SLOs doc not yet published.** Alert thresholds are
  defined structurally in
  [`docs/architecture/08-observability-and-operations.md`](../architecture/08-observability-and-operations.md);
  the operator-facing `docs/operations/alerts.md` and the
  per-alert `runbook_url` linkage land with
  [P10-005](../implementation/tasks/P10-005-alerts-runbooks.md). Until
  then, alerts exist as architectural intent, not as a live Prometheus
  rule set. The RC captain explicitly accepts this gap or holds the
  release.
- **General DLQ triage runbook not yet published.** Destination-side
  DLQ triage is covered by
  [`docs/operations/destination-dlq-triage.md`](../operations/destination-dlq-triage.md);
  the per-topic / per-processor DLQ triage doc lands with
  [P10-006](../implementation/tasks/P10-006-dlq-triage-runbook.md).
- **Loki ingestion doc not yet published.** Structural rule (JSON-only,
  redacted) is enforced via the shared logger; the operator-facing
  pipeline doc lands with
  [P10-004](../implementation/tasks/P10-004-loki-logging-pipeline.md).
- **Dashboards index doc not yet published.** Dashboard JSON exists
  under [`infra/grafana/dashboards/`](../../infra/grafana/dashboards/);
  the dashboard catalog doc lands with
  [P10-003](../implementation/tasks/P10-003-grafana-dashboards.md).
- **Acceptance test runbook not yet published.** The product
  acceptance scenario lands with
  [P12-003](../implementation/tasks/P12-003-product-acceptance-test.md);
  the RC captain marks the "Product acceptance test" row `BLOCKED`
  until P12-003 ships.
- **Onboarding guide not yet published.** Internal-team onboarding
  reference lands with
  [P12-004](../implementation/tasks/P12-004-internal-onboarding-guide.md).
  Until then the captain falls back to
  [`docs/development/getting-started.md`](../development/getting-started.md).

### Secret and config management

- **Production secret provider adapter not yet shipped.** The
  architectural decision is locked on HashiCorp Vault; the Vault
  adapter lands with
  [P11-004](../implementation/tasks/P11-004-production-secret-provider.md).
  The `env` adapter
  ([`packages/shared-secrets/src/providers/`](../../packages/shared-secrets/src/providers/))
  is the only adapter wired today.
- **Production config templates not yet published.**
  [P11-003](../implementation/tasks/P11-003-production-config-templates.md)
  ships the canonical templates; the captain documents the
  per-environment config surface manually until it lands.
- **Release versioning metadata not yet standardised.** Per-service
  `/version` endpoints arrive with
  [P11-007](../implementation/tasks/P11-007-release-versioning-build-metadata.md).

### Per-consumer caveats (v1)

Consolidated from each consumer's `SPEC.md`. The destination owner
confirms each row matches the live consumer code.

- **Meta CAPI v1:** `signup.completed` and `subscription.renewed` are
  not in v1 (future minor releases). Mobile-source detection (`app`
  channel for `action_source`) is deferred until the normalize layer
  carries `app_*` slots. See
  [`consumers/meta-capi/v1/SPEC.md`](../../consumers/meta-capi/v1/SPEC.md).
- **TikTok v1:** Same event-coverage gap as Meta CAPI (`signup.completed`,
  `subscription.renewed` deferred); mobile-source detection deferred.
  See
  [`consumers/tiktok/v1/SPEC.md`](../../consumers/tiktok/v1/SPEC.md).
- **Webhook sink v1:** Passthrough mapper only; per-event vendor-style
  mappers are the structural template for future vendors but the
  webhook sink itself stays event-agnostic. See
  [`consumers/webhook-sink/v1/SPEC.md`](../../consumers/webhook-sink/v1/SPEC.md).
- **GA4 v1 and Braze v1:** not yet shipped. References:
  [P9-004](../implementation/tasks/P9-004-ga4-consumer-v1.md),
  [P9-006](../implementation/tasks/P9-006-braze-consumer-v1.md).

### Open production decisions (wait-for-data)

These are not gaps so much as deliberate "decide after observing real
traffic" parking spaces. Listed for transparency; the captain
references them when sizing the RC's operational expectations.

- **Redpanda byte-cap retention and tiered storage.** Time-based
  retention is locked at 90 days for `raw.events`; byte caps revisited
  after first-project disk data.
- **Per-project ingress dedupe window overrides.** 15-min default
  locked; project-specific extensions (up to 24h) gated on demonstrated
  producer-side need.
- **Topic isolation activation thresholds.** Triggers are structural;
  the `>25% share` threshold and similar numeric tails are revisited
  after observed traffic.
- **Initial alert thresholds and SLOs.** Defaults land with
  [P10-005](../implementation/tasks/P10-005-alerts-runbooks.md); they
  tighten after observed traffic.

Reference for this whole section:
[Production Readiness / Open Production Decisions](../architecture/11-production-readiness.md#open-production-decisions).

## Pre-Launch Deployment Order

The deployment-side ordering for production rollout, once every row in
the checklist above is green. Encouraged but not load-bearing — the
captain may sequence differently if the deployment topology demands it,
provided every step lands.

1. **Provision infrastructure.** Redpanda cluster (RF=3, min-ISR=2),
   PostgreSQL primary + WAL streaming, ClickHouse Replicated engines +
   Keeper, Redis. Reference: [Data
   Classes](../deployment/data-classes.md) for store-level retention.
2. **Provision secret references.** Populate Vault (or the equivalent
   managed provider) with every `secret_ref` the production
   `destinations` rows will name. Reference: [P11-004 task
   card](../implementation/tasks/P11-004-production-secret-provider.md)
   (until shipped); the architectural rule is in
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
   Drills](../operations/backup-and-retention.md#quarterly-recovery-drills),
   the alerts doc (when [P10-005](../implementation/tasks/P10-005-alerts-runbooks.md)
   lands).

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
