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

## Review Rule

Before production traffic, revisit Redpanda sizing, ClickHouse physical design, secret manager choice, identity graph storage, and first event catalog inventory.

