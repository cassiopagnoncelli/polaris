# ADR 0004: Production Readiness Decision Ledger

This is a light decision ledger for production-facing Polaris defaults.

## Decisions

1. Production runs Docker images on Kubernetes.
2. Staging/test use Docker-based environments.
3. Development may use Docker or bare metal.
4. Production services must not assume Kubernetes-only runtime behavior.
5. Production secrets use provider-based references; plaintext secrets are never stored in PostgreSQL.
6. Vault is the preferred production secret-manager candidate, but not fully locked.
7. v1 control-plane permissions use a minimal trusted-operator model.
8. Operator identity has three sources: `cli_oidc` (authenticated through org IdP), `cli_token` (long-lived personal token), `declared` (display only).
9. v1 implements `cli_token` only. `cli_oidc` is a P11+ stretch goal.
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

## Review Rule

Before production traffic, revisit Redpanda retention byte caps, ClickHouse projection design, ClickHouse multi-shard layout, secret manager choice, identity graph storage, first event catalog inventory, per-project dedupe window overrides, and topic isolation activation thresholds tuned to observed traffic.
