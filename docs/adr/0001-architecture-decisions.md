# ADR 0001: Polaris Architecture Decision Ledger

This is a light decision ledger for the first Polaris architecture pass. The handbook files are the primary readable source of truth.

## Decisions

1. Polaris is an internal multi-project event infrastructure platform.
2. Redpanda is the canonical immutable event backbone.
3. `project_id` is required. `environment` is stamped from the API key.
4. The event envelope is rigid and platform-owned.
5. Event names are registered lowercase dotted facts with optional namespace depth.
6. Normal events require registered code-backed Zod property schemas.
7. `experimental.*` events are allowed for controlled prototyping.
8. Polaris records consent/privacy metadata but does not enforce consent in v1.
9. Hard sensitive-data prohibitions are enforced at ingestion through a two-tier reject-or-redact policy in code.
10. Redpanda uses shared canonical topics by default.
11. Dedicated topics are activated by named isolation triggers (volume share >25%, retention divergence, lag isolation, schema risk, operational quarantine), routed through topic families.
12. `raw.events` uses a project/environment-scoped identity-aware partition key.
13. `raw.events` retention starts at 90 days.
14. Long-term raw replay should use object storage archive later.
15. Ingress dedupe is a 15-minute retry-storm absorber by default; longer windows (up to 24h) are opt-in per project.
16. Downstream idempotency is mandatory and remains the canonical dedupe layer.
17. Identity resolution uses an explicit-link canonical graph.
18. Identity heuristics are optional non-authoritative derived signals.
19. Replay is a first-class control-plane capability, bounded by the operational retention window.
20. Destination sends are disabled by default during replay.
21. Destination consumers use reliable at-least-once delivery.
22. Vendor dedupe mechanisms are used as best-effort secondary defenses.
23. ClickHouse uses an append-only ingest log plus deduped analytical raw table.
24. Processor versions are immutable in semantic behavior.
25. SDKs are thin transport SDKs with identity/session helpers.
26. Ingestion uses partial acceptance for event batches.
27. API keys are source-scoped per project/environment.
28. Frontend keys are publishable write keys; backend keys are secret keys.
29. Sources are explicit platform objects.
30. Polaris is file-heavy and database-light.
31. PostgreSQL stores mutable runtime/control state, not semantic truth.
32. Event catalog and schemas live in files/code.
33. Destination consumers run a three-stage pipeline: normalize, map, deliver. Each stage is independently versioned. Shared normalization primitives live in a workspace package.
34. Destination instances store non-semantic operational knobs in PostgreSQL.
35. Processor semantics live in versioned code; PostgreSQL may store non-semantic runtime settings.
36. Secrets use provider-based references and are never stored plaintext in PostgreSQL.
37. Observability target includes Grafana, Loki, Prometheus, and OpenTelemetry with graceful degradation.
38. Local development uses lean core compose plus optional secondary compose files.
39. Documentation uses a hybrid handbook plus light ADRs.
40. MVP implementation should be a vertical slice first.
41. `project_id` is an operational scoping device, not a security perimeter. Cross-project read access within the organization is allowed by design.
42. Replayability is bounded by the operational retention window. Polaris does not promise replay beyond that window in v1.
43. Event schema evolution is governed by explicit in-place vs version-bump rules, with deprecated-version coexistence and sunset dates.
44. Forbidden-field policy is two-tier (reject vs redact), code-backed, with closed-set reason codes and project overrides that may not downgrade platform rejects. The platform default is **default-capture, narrow-reject**: only named-field `pii_card` and `pii_secret` rules block capture; pattern-based detections (PAN-in-unexpected-field, AWS key shape, GitHub token shape, JWT shape, generic high-entropy) redact-with-metric so producer leaks are observable without dropping events on regex false positives.
45. Operator identity has three sources (`cli_oidc`, `cli_token`, `declared`). The gate is a single rule: production mutations require an authenticated source. Each CLI command declares `mutates: boolean`; the dispatcher applies the rule. No per-command lists, no tier enums, no separate gate-decision audit record. `cli_token` is the v1 authenticated source; `cli_oidc` is a P11+ stretch.
46. ClickHouse production uses `Replicated*` engines and ClickHouse Keeper from day one, on single-shard single-replica. Multi-shard is honest future work.
47. `analytics_raw` is never queried without explicit dedupe. MVs use `argMax(_version)`; projection tables are the query surface.
48. ClickHouse access is enforced through database roles (`polaris_service`, `polaris_operator`) plus a workspace ClickHouse helper package. The regex-based SQL lint was rejected as brittle; grants are the enforcement mechanism, the helper is the ergonomic surface.
49. The CLI is a thin client (bash-invocable, env-var auth via `POLARIS_TOKEN`, profile config in `~/.polaris/config.toml`) talking to a small control-plane API service. No interactive login.
50. Regional posture is single-region in v1. PII residency is not a v1 constraint. Multi-region is post-v1 and would land as per-project topic isolation across regionally-deployed Polaris instances.
51. Identity graph uses a flexible storage shape (`confidence` enum + open `evidence_type` text + `evidence` jsonb). New heuristic rule types land by inserting rows, not migrations.
52. GeoIP v1 source is MaxMind GeoLite2 with operator-provided database files. The provider interface is swappable for future GeoIP2 / alternative backends.
53. Destination consumer version coexistence is per-instance with no hot dual-write. Migration is operator-driven, one instance at a time.
54. Consent fields default to `true` per consumer normalize stage when absent from the canonical event, because most vendor APIs interpret missing consent more strictly than missing fields.
55. SDK diagnostic emission is opt-in. Diagnostic events use a dedicated `polaris.diagnostics.events` topic and never feed analytics or destinations.
56. Customer deletion is deferred. The designed pattern uses `customer.deletion_requested` tombstone events plus a deletion-list service consumed by processors and destination consumers.
57. Property-level conventions inside `properties` are event-owner discretion. The platform enforces envelope rules only.
58. Backup/recovery targets per store are documented v1 defaults: PostgreSQL RPO 5 min / RTO 1 h, ClickHouse `analytics_raw` RPO 24 h / RTO 4 h, projection tables rebuilt from `analytics_raw`, Redpanda RPO 0 via RF=3, Redis no backup.

## Superseded Direction

An earlier control-plane framing considered a hybrid or PostgreSQL-first model for more semantic configuration. That was narrowed.

Final position:

- semantic contracts live in files/code
- PostgreSQL stores mutable runtime/control state
- Redis stores cache and short-lived operational state

## Review Rule

When a future change modifies semantic meaning, prefer a code/file change with versioning and tests. Do not move semantic meaning into PostgreSQL for convenience.

