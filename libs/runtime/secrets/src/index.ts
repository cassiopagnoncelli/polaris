/**
 * `@polaris/shared-secrets` — the workspace's argon2id hashing primitive.
 *
 * Both the ingester (which verifies API keys on every request) and the polaris
 * CLI (which issues keys and operator tokens) consume {@link hashSecret} /
 * {@link verifySecret}; no parallel hashing library is permitted.
 *
 * ## What used to be here
 *
 * This package was a provider-based secret RESOLVER: PostgreSQL stored
 * `(provider, ref)` pairs, and adapters for `env`, `vault` and
 * `aws-secrets-manager` turned them into plaintext at the point of use. Its
 * hard rule was "PostgreSQL stores references, never plaintext".
 *
 * That rule no longer holds, deliberately. Per-project secrets — a project's
 * own sensitive variables and its destination credentials — are stored in the
 * control-plane database as plaintext
 * (`db/postgres/migrations/20260813000004_plaintext_project_secrets.sql`). Those two
 * were the resolver's ONLY callers, so the adapters, the reference format, the
 * failure classifier and the Vault client had nothing left to serve and were
 * removed rather than kept as unreachable code.
 *
 * App and deployment secrets are unaffected and never went through the
 * resolver either: a service reads its Postgres and broker credentials from
 * the process environment at bootstrap, before it can reach any store.
 *
 * What survived the change is the HANDLING discipline, which never depended on
 * where a secret came from:
 *
 *   - `Secret<T>` in `@polaris/shared-project-config` boxes a value a consumer
 *     legitimately holds, so it cannot be stringified into a log line, a DLQ
 *     payload or a delivery record by accident;
 *   - `maskIfSecret` in `@polaris/shared-control-plane` keeps stored secrets
 *     out of list views, exports and audit snapshots in the first place.
 *
 * @see docs/architecture/02-control-plane.md "Secrets"
 * @see docs/implementation/project-config-plan.md "Secrets"
 */

export {
  hashSecret,
  POLARIS_HASH_ALGORITHM,
  type PolarisHashAlgorithm,
  verifySecret,
} from "./hashing.js";
