---
id: 0004
title: Production readiness decisions ledger
status: Accepted
date: 2026-05-12
deciders: legacy
supersedes:
superseded_by:
---

## Context and Problem Statement

The first architecture pass (ADR-0001) named platform shape; the engineering ledger (ADR-0002) named build-time choices; the SDK ledger (ADR-0003) named producer surface. Production readiness needed its own ledger for the runtime-facing defaults: where it runs, who can mutate it, how secrets are loaded, what topic counts ship by default, what backup targets apply per store, what ClickHouse engines are used, what replay does and does not promise.

This ADR is the legacy production-readiness decision ledger from the first deploy-readiness pass, transplanted from `docs/adr/0004-production-readiness-decisions.md` into MADR shape. The production-readiness handbook (`docs/architecture/11-production-readiness.md`), the deployment docs (`docs/deployment/`), and the operations runbooks (`docs/operations/`) are the prose source of truth.

Maturity tier assumed: SMB transitioning to production. v1 explicitly leaves room for an enterprise-tier follow-up (RBAC, multi-region, compliance) without rewrite.

## Decision Drivers

- Production runs on Kubernetes, but services must not assume Kubernetes-only behavior — local/dev runs the same containers.
- Plaintext secrets must never sit in PostgreSQL. The secret provider is swappable but Vault is the production default.
- Operator identity has three sources (`cli_oidc`, `cli_token`, `declared`), with one gate rule and no per-command lists.
- Replay is bounded by the operational retention window in v1 — Polaris does not promise anything past it.
- Per-project metrics labels are required from day one, so isolation triggers can be measured before they're activated.

## Considered Options

- A single production-readiness ledger (this file) — many decisions per ADR, handbook + runbooks alongside
- One MADR per individual production choice (~60 files) — full per-decision drivers/options
- Defer production-readiness decisions until first deploy

## Decision Outcome

Chosen: **production-readiness ledger transplanted as a single MADR**, preserving the original numbered list. The handbook and runbooks explain how each default plays out operationally; this ADR is the citation surface for the defaults themselves.

The numbered production-readiness decisions:

1. Production runs Docker images on Kubernetes.
2. Staging/test use Docker-based environments.
3. Development may use Docker or bare metal.
4. Production services must not assume Kubernetes-only runtime behavior.
5. Production secrets use provider-based references; plaintext secrets are never stored in PostgreSQL.
6. Production secret manager is HashiCorp Vault. Local/dev uses the `env` provider. The provider interface stays open for cloud-native adapters if needed later.
7. v1 control-plane permissions use a minimal trusted-operator model.
8. Operator identity has three sources: `cli_oidc` (authenticated through Keycloak), `cli_token` (long-lived personal token), `declared` (display only).
9. v1 implements `cli_token` only. `cli_oidc` (Keycloak integration) is a P11+ stretch goal.
10. Each CLI command declares `mutates: boolean`. The gate is one dispatcher rule: production mutations with `declared` source are rejected. Everything else is allowed.
11. No risk tiers, no per-command lists, no separate gate-decision audit records.
12. `--actor` is a display label only and cannot upgrade a `declared` source.
13. RBAC is deferred. Future RBAC must not require rewriting the control-plane data model.
14. Mutating CLI operations write one audit record. Gate denials land on the same record with `result = denied` and `denied_reason` set.
15. Token rotation immediately revokes the old token; no grace period. Overlap is achieved through explicit `create` then later `revoke`.
16. Replay jobs start as dry runs and are stored durably in PostgreSQL.
17. Replay execution uses scoped jobs and unique replay consumer groups.
18. Replay output defaults to dry-run or shadow topics before canonical writes.
19. Destination sends during replay are disabled by default.
20. Replay jobs reject targets older than the source topic's retention with reason `outside_retention_window`.
21. Replayability is bounded by the operational retention window in v1.
22. Web SDK production snippets should pin exact versions.
23. Versioned SDK CDN assets should be immutable and long-cacheable.
24. Data lifecycle defaults are configurable.
25. Redpanda `raw.events` starts with 90-day retention.
26. Object-storage raw archive is future work.
27. Production Redpanda starts with 3 brokers, replication factor 3, and min in-sync replicas 2.
28. Production `raw.events` and `analytics.events` start with 24 partitions.
29. Production identity/enriched/attribution topics start with 12 partitions.
30. Production retry and DLQ topics start with 6 partitions.
31. Local development may use one Redpanda broker, replication factor 1, and 1-3 partitions.
32. Redpanda partition counts remain configurable per environment.
33. Shared canonical topics are the default. Dedicated topics activate on named isolation triggers (volume share, retention divergence, lag isolation, schema risk, operational quarantine).
34. Per-project metrics labels are required from day one (`project_id`, `environment`, `topic_family`, `concrete_topic`, `partition`).
35. Ingress dedupe defaults to a 15-minute window; up to 24 hours is opt-in per project.
36. Downstream idempotency is the canonical dedupe layer; ingress dedupe is a retry-storm absorber.
37. Forbidden-field policy is two-tier (reject vs redact), code-backed in `catalog/policy/forbidden-fields.ts`, with closed-set reason codes. Default is **default-capture, narrow-reject** — only named-field `pii_card` and `pii_secret` rules block capture. Pattern-based detections redact-with-metric, not reject.
38. Forbidden-field reject rejects the full event with `forbidden_field_rejected`; redact replaces values with `"[REDACTED:<reason>]"` and the event continues. Pattern-based redactions emit `polaris_ingest_redacted_pattern_total` for observability.
39. Project overrides may not downgrade a platform reject without a documented exception. IBAN, account numbers, raw email, and raw phone are intentionally not on the platform default lists; projects opt into stricter handling via their override files.
40. Destination consumers run normalize, map, deliver stages, each independently versioned.
41. Shared destination normalization primitives live in a workspace package, not duplicated per consumer.
42. ClickHouse Kafka Engine tables are transient and never queried directly.
43. `analytics_ingest_log` uses MergeTree (local/dev) or ReplicatedMergeTree (production) with monthly `ingested_at` partitions.
44. `analytics_raw` uses ReplacingMergeTree (local/dev) or ReplicatedReplacingMergeTree (production) with monthly `occurred_at` partitions.
45. `analytics_raw` orders by project, environment, event, and event ID.
46. `analytics_raw` is never queried without explicit dedupe.
47. MVs use `argMax(col, _version)` to feed deduped rows into projection tables. Projection tables are the read surface.
48. ClickHouse TTL defaults are configurable, starting at 30 days for ingest log and 400 days for analytical raw.
49. Production ClickHouse runs `Replicated*` engines and ClickHouse Keeper from day one, single-shard single-replica. Adding replicas is straightforward; multi-shard is honest future work.
50. DDL uses a `{replicated}` macro so the same SQL files work in local/dev (plain engines) and production (replicated engines).
51. ClickHouse access uses two roles: `polaris_service` (SELECT on projection tables and `analytics_ingest_log` only) and `polaris_operator` (broader access including `analytics_raw`). The `packages/shared-clickhouse/` workspace package is the only sanctioned in-process access path; direct `@clickhouse/client` imports outside it are blocked.
52. CLI is a thin client to a small control-plane API service. Bash-invocable, env-var auth (`POLARIS_TOKEN`), profile config in `~/.polaris/config.toml`. No interactive login.
53. Regional posture is single-region in v1. PII residency is not a v1 constraint.
54. Identity graph storage uses confidence + open evidence_type + jsonb evidence so new heuristic rules land without migrations.
55. GeoIP v1 backend is MaxMind GeoLite2 with operator-provided files; provider interface is swappable.
56. Destination consumer versions coexist per-instance with no hot dual-write; migration is operator-driven per instance.
57. Consent defaults to `true` per consumer normalize stage when absent from the canonical event.
58. SDK diagnostic emission is opt-in via the `polaris.diagnostics.events` topic; never feeds analytics or destinations.
59. Customer deletion is deferred. The designed pattern uses `customer.deletion_requested` tombstone events plus a downstream deletion-list service.
60. Property-level conventions inside `properties` are event-owner discretion; the platform enforces envelope rules only.
61. Backup/recovery v1 defaults: PostgreSQL RPO 5 min / RTO 1 h via WAL streaming and daily snapshots; ClickHouse `analytics_raw` RPO 24 h / RTO 4 h via `BACKUP TABLE` to object storage; projections rebuilt from `analytics_raw`; ingest_log RPO 7 d / RTO 4 h; Redpanda RPO 0 via RF=3 / min-ISR=2; Redis no backup; secret provider managed by the provider.
62. Initial alert thresholds and SLOs are documented as v1 defaults in `docs/operations/alerts.md` and `docs/operations/slos.md`; tightened after observed traffic.
63. Initial DLQ triage SLAs are documented as v1 defaults in `docs/operations/dlq-triage-runbook.md`.
64. API keys do not auto-expire in v1. Rotation is operator-driven; tooling surfaces key age so a forced-rotation policy can be added later without rebuilding the tooling.

### Review Rule

Before production traffic, revisit Redpanda retention byte caps, ClickHouse projection design, ClickHouse multi-shard layout, secret manager choice, identity graph storage, first event catalog inventory, per-project dedupe window overrides, and topic isolation activation thresholds tuned to observed traffic.

## Consequences

- Positive: every production default is citeable by number from runbooks, pm cards, and PR descriptions.
- Positive: the trusted-operator model and `cli_token`-only v1 are explicit, so a future RBAC ADR can supersede specific lines without ambiguity.
- Negative: many lines are "v1 defaults" tied to observed traffic that doesn't yet exist; expect superseding ADRs as production telemetry lands.
- Follow-up: when a default is meaningfully retuned (e.g. partition counts, retention windows, dedupe windows), open a per-decision MADR that supersedes the relevant line.
- Revisit if: a compliance framework applies, a second team takes ownership of an area, or production traffic invalidates one of the v1 defaults.

## Pros and Cons of the Options

_n/a_
