/**
 * Public surface of the ingester origin guard module.
 *
 * Composition:
 *
 *   repository.findFor  ->  cache.findFor  ->  guard.preHandler
 *
 * The preflight route (`OPTIONS /v1/events`) is exported separately so the
 * route registrar in `routes/events.ts` can mount it next to the POST.
 *
 * @see docs/architecture/11-production-readiness.md "Security Hardening"
 */

export { AllowedOriginsCache, type AllowedOriginsCacheOptions } from "./cache.js";
export {
  createOriginGuardPreHandler,
  ORIGIN_NOT_ALLOWED_CODE,
  type OriginGuardDeps,
  registerCorsPreflightRoute,
} from "./guard.js";
export { createPostgresAllowedOriginsRepository } from "./repository.js";
export type {
  AllowedOriginsRepository,
  AllowedOriginsResult,
  OriginLookupInput,
} from "./types.js";

// Side-effect import: applies `declare module "@polaris/persistence-postgres"` so the
// `Database` interface gains `source_allowed_origins` for typed Kysely
// queries. Without this import the repository's `db.selectFrom(...)` won't
// know the table exists.
import "./db.js";

export type { SourceAllowedOriginsTable } from "./db.js";
