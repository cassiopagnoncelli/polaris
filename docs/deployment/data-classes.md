# Data Classes

One-page reference. Every Polaris data class maps here to its
retention, regulatory class, and the operator role that owns retention
policy decisions for it.

This page is operator-facing. The architectural source of truth for
retention windows is
[Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults);
the recovery procedure for each row of this table lives in
[`docs/operations/backup-and-retention.md`](../operations/backup-and-retention.md).

## Regulatory classes

| Class | What it means | Examples |
| --- | --- | --- |
| **PII** | Directly identifies a natural person. | (none in v1 platform tables; producer-supplied PII is application-defined and lives in `properties_json` / `context_json`) |
| **pseudonymized PII** | Identifiers that map to a person only via an internal lookup. | `identity_links`, `analytics_raw.anonymous_id`, `analytics_raw.session_id`, `analytics_raw.customer_id` |
| **sensitive** | Credentials, hashes, or secret material. Plaintext is never stored. | `api_keys.hash`, `operator_tokens.hash` |
| **regulatory** | Held for compliance / audit obligations, not operational need. | `audit_records` |
| **operational** | Mutable runtime / control state. Not regulated; held as long as the platform needs it. | `projects`, `sources`, `destinations`, `processor_activations`, `processor_runs`, `replay_jobs`, `delivery_records` |
| **analytical** | Aggregate / event-shaped data for analytics. | `analytics_raw`, `analytics_ingest_log`, projection tables |
| **transport** | In-flight event records on the streaming backbone. | RabbitMQ topics (`raw.events`, `resolved.events`, ...) |
| **ephemeral** | Caches, counters, dedupe windows. No durability commitment. | Redis keys |

## Data class reference

| Data class | Store | Retention | Regulatory class | Retention owner |
| --- | --- | --- | --- | --- |
| `projects` | PostgreSQL | indefinite (operational manifest) | operational | Platform operator |
| `sources` | PostgreSQL | indefinite | operational | Platform operator |
| `api_keys` (hash + metadata) | PostgreSQL | active lifetime + 2 years after revoke | sensitive | Platform operator |
| `operator_tokens` (hash + metadata) | PostgreSQL | active lifetime + 2 years after revoke | sensitive | Platform operator |
| `destinations` | PostgreSQL | indefinite | operational | Platform operator |
| `processor_activations` | PostgreSQL | indefinite | operational | Platform operator |
| `processor_runs` | PostgreSQL | 1 year | operational | Platform operator |
| `replay_jobs` | PostgreSQL | 2 years | operational | Platform operator |
| `delivery_records` | PostgreSQL | 180 days | operational | Destination owner |
| `audit_records` | PostgreSQL | 2 years | regulatory | Compliance operator |
| `identity_links` | PostgreSQL | identity policy (see [P8-002](../../agents/pm/kanban/done/P8-002-identity-resolver-v1.md)) | pseudonymized PII | Identity / privacy owner |
| `analytics_ingest_log` | ClickHouse | 30 days (TTL) | analytical | Platform operator |
| `analytics_raw` | ClickHouse | 400 days (TTL) | analytical (contains pseudonymized PII) | Platform operator |
| Projection tables | ClickHouse | per projection (default 400 days, TTL) | analytical | Projection owner |
| Operational metrics | ClickHouse | 180 days | analytical | Observability owner |
| `raw.events` | RabbitMQ | 90 days | transport (canonical raw, contains pseudonymized PII) | Platform operator |
| `identity.events` | RabbitMQ | 30 days | transport | Platform operator |
| `attribution.events` | RabbitMQ | 30 days | transport | Platform operator |
| `resolved.events` | RabbitMQ | 30 days | transport | Platform operator |
| `identified.events` | RabbitMQ | 7 days | transport | Platform operator |
| `profile.events` | RabbitMQ | 30 days | transport | Platform operator |
| Retry topics | RabbitMQ | 7 days | transport | Destination owner |
| DLQ topics | RabbitMQ | retain unresolved + 30 days after resolution | transport | Destination owner |
| Ingress dedupe window | Redis | 15 min default; up to 24 h on opt-in | ephemeral | Platform operator |
| Rate-limit counters | Redis | window-scoped TTL | ephemeral | Platform operator |
| Processor ephemeral state | Redis | processor-specific TTL | ephemeral | Processor owner |
| Web SDK queued events | Browser storage | bounded by count / bytes, max age configurable | ephemeral | SDK owner |
| Node SDK memory queue | Process memory | process lifetime (unless durable adapter configured) | ephemeral | SDK owner |
| Per-project secret material | PostgreSQL (`destinations.secret_value`, `project_config`) | lifetime of the row | sensitive | Security operator |
| App / deployment credentials | Process environment | deployment lifetime | sensitive | Platform operator |

## Owner glossary

The "Retention owner" column is the role that decides retention policy
for that data class. In v1 most rows collapse to "Platform operator"
because Polaris ships a single trusted-operator model
([Production Readiness / Control-Plane Permissions](../architecture/11-production-readiness.md#control-plane-permissions)).
The role labels are kept distinct so a future RBAC migration can split
them without re-deriving the table.

| Owner | What they own |
| --- | --- |
| Platform operator | Default for control-plane and analytical tables. Has access to `polaris_operator` ClickHouse role. |
| Compliance operator | Owns `audit_records` retention and any future regulated-data window decisions. |
| Identity / privacy owner | Owns `identity_links` policy; reviews any change that could increase pseudonymized-PII surface area. |
| Destination owner | Owns destination-side records (`delivery_records`, retry / DLQ topics). |
| Projection owner | Author of a projection table (the engineer who shipped its DDL). |
| Observability owner | Owns the operational metrics retention window. |
| Processor owner | Author of a processor version; chooses ephemeral state TTLs. |
| SDK owner | Owns SDK queue behavior; bounds local-storage retention. |
| Security operator | Owns the external secret provider; Polaris owns only the references. |

## See also

- [`docs/operations/backup-and-retention.md`](../operations/backup-and-retention.md)
  — recovery procedures for each row of the table above.
- [Production Readiness / Data Lifecycle Defaults](../architecture/11-production-readiness.md#data-lifecycle-defaults)
  — architectural source of truth for retention windows.
- [Control Plane / PostgreSQL Owns](../architecture/02-control-plane.md)
  — what may legitimately live in PostgreSQL.
- [ClickHouse / Two-Layer Raw Storage](../architecture/07-clickhouse.md#two-layer-raw-storage)
  — engine families and TTL semantics.
