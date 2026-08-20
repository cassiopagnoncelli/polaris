/**
 * `@polaris/runtime-service-bootstrap` — thin Fastify service bootstrap.
 *
 * Polaris services (ingester, control-plane API, future dashboard API) use
 * this package to standardise:
 *
 *   - per-request UUIDv7 IDs propagated through logs and response headers
 *   - RFC 7807 Problem Details error responses with stable `code` and
 *     `request_id` fields
 *   - `/health` and `/ready` routes with pluggable readiness probes
 *   - `/metrics` route stub ready for P10 metrics-standardisation wiring
 *   - OpenAPI integration hook for Fastify + Zod route schemas
 *   - graceful shutdown handlers for SIGTERM/SIGINT
 *
 * The bootstrap composes `@polaris/runtime-config` for runtime config and
 * `@polaris/observability-logger` for Pino logging. Services should never import
 * `fastify` or `pino` directly — pull them in transitively through this
 * package so platform-wide changes (logger redaction, request ID shape,
 * Problem code catalog) ship through a single release.
 *
 * @see docs/architecture/09-engineering-standards.md "Fastify Service Structure"
 * @see docs/architecture/09-engineering-standards.md "HTTP Error Contract"
 * @see docs/architecture/08-observability-and-operations.md "Service Contract"
 */

export * from "./bootstrap/index.js";
export * from "./problem/index.js";
