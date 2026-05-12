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
9. Hard sensitive-data prohibitions are enforced at ingestion.
10. Redpanda uses shared canonical topics by default.
11. Dedicated topics are an explicit operational escape hatch.
12. `raw.events` uses a project/environment-scoped identity-aware partition key.
13. `raw.events` retention starts at 90 days.
14. Long-term raw replay should use object storage archive later.
15. Ingress dedupe is short-window and Redis-backed.
16. Downstream idempotency remains mandatory.
17. Identity resolution uses an explicit-link canonical graph.
18. Identity heuristics are optional non-authoritative derived signals.
19. Replay is a first-class control-plane capability.
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
33. Destination mappings are code-only semantic logic.
34. Destination instances store non-semantic operational knobs in PostgreSQL.
35. Processor semantics live in versioned code; PostgreSQL may store non-semantic runtime settings.
36. Secrets use provider-based references and are never stored plaintext in PostgreSQL.
37. Observability target includes Grafana, Loki, Prometheus, and OpenTelemetry with graceful degradation.
38. Local development uses lean core compose plus optional secondary compose files.
39. Documentation uses a hybrid handbook plus light ADRs.
40. MVP implementation should be a vertical slice first.

## Superseded Direction

An earlier control-plane framing considered a hybrid or PostgreSQL-first model for more semantic configuration. That was narrowed.

Final position:

- semantic contracts live in files/code
- PostgreSQL stores mutable runtime/control state
- Redis stores cache and short-lived operational state

## Review Rule

When a future change modifies semantic meaning, prefer a code/file change with versioning and tests. Do not move semantic meaning into PostgreSQL for convenience.

