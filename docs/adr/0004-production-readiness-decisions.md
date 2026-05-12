# ADR 0004: Production Readiness Decision Ledger

This is a light decision ledger for production-facing Polaris defaults.

## Decisions

1. Production runs Docker images on Kubernetes.
2. Staging/test use Docker-based environments.
3. Development may use Docker or bare metal.
4. Production services must not assume Kubernetes-only runtime behavior.
5. Production secrets use provider-based references; plaintext secrets are never stored in PostgreSQL.
6. Vault is the preferred production secret-manager candidate, but not fully locked.
7. v1 control-plane permissions use a trusted-operator model.
8. Whoever can run the production `polaris` CLI with credentials is treated as an admin operator in v1.
9. RBAC is deferred.
10. Mutating CLI operations must write audit records with actor information.
11. Replay jobs start as dry runs and are stored durably in PostgreSQL.
12. Replay execution uses scoped jobs and unique replay consumer groups.
13. Replay output defaults to dry-run or shadow topics before canonical writes.
14. Destination sends during replay are disabled by default.
15. Web SDK production snippets should pin exact versions.
16. Versioned SDK CDN assets should be immutable and long-cacheable.
17. Data lifecycle defaults are configurable.
18. Redpanda `raw.events` starts with 90-day retention.
19. Object-storage raw archive is future work.
20. Production Redpanda starts with 3 brokers, replication factor 3, and min in-sync replicas 2.
21. Production `raw.events` and `analytics.events` start with 24 partitions.
22. Production identity/enriched/attribution topics start with 12 partitions.
23. Production retry and DLQ topics start with 6 partitions.
24. Local development may use one Redpanda broker, replication factor 1, and 1-3 partitions.
25. Redpanda partition counts remain configurable per environment.
26. ClickHouse Kafka Engine tables are transient and never queried directly.
27. `analytics_ingest_log` uses MergeTree with monthly `ingested_at` partitions.
28. `analytics_raw` uses ReplacingMergeTree with monthly `occurred_at` partitions.
29. `analytics_raw` orders by project, environment, event, and event ID.
30. ClickHouse TTL defaults are configurable, starting at 30 days for ingest log and 400 days for analytical raw.
31. Single-node ClickHouse is acceptable initially, but production design must remain compatible with replicated/distributed ClickHouse later.

## Review Rule

Before production traffic, revisit Redpanda retention byte caps, ClickHouse projection design, ClickHouse cluster shape, secret manager choice, identity graph storage, and first event catalog inventory.
