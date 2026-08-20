/**
 * argon2id hashing primitive shared across Polaris services and CLI tools.
 *
 * Both the ingester (which verifies API keys on every request) and the
 * polaris CLI (which issues new keys + operator tokens through the lifecycle
 * commands) must use the *same* hashing primitive. Owning the implementation
 * here keeps that contract one-source-of-truth and prevents a second library
 * (bcrypt, scrypt, raw sha) from sneaking in through a parallel app.
 *
 * Rules baked into this module:
 *
 *   - argon2id is the only supported algorithm. The wider workspace uses the
 *     same algorithm tag in PostgreSQL columns (`api_keys.hash_algorithm`
 *     etc.) and CLI prints. A future migration to a different primitive is
 *     possible, but it MUST go through this module so both sides flip
 *     together.
 *   - Plaintext never leaves the function it enters. The caller hands a
 *     `string`; nothing inside this module logs, persists, or echoes it.
 *   - Verification swallows every internal error and returns `false`. The
 *     upstream auth layer only needs a boolean and we deliberately avoid
 *     exposing which arm of the check failed (malformed PHC, algorithm
 *     mismatch, native library exception, ...) so timing/error inspection
 *     cannot distinguish a bad secret from a bad row.
 *   - Cost parameters are read from the PHC prefix on verify (argon2's PHC
 *     string is self-describing). Hash issuance uses the library defaults,
 *     which are calibrated for ~30-80ms on modern hardware — slow enough to
 *     resist offline brute-force while staying invisible during a CLI
 *     interactive issue call.
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/implementation/tasks/P6-003-api-key-lifecycle-cli.md
 */

import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * Stable algorithm tag stored alongside every hash.
 *
 * Persisted in `api_keys.hash_algorithm` (and future `operator_tokens` rows).
 * Centralising the string here keeps every consumer in sync — a future
 * algorithm change rewrites this constant and bumps the migrations together.
 */
export const POLARIS_HASH_ALGORITHM = "argon2id" as const;

/**
 * Type of the algorithm tag. Currently a single-element literal union; a
 * future parameter bump (e.g. `"argon2id-v2"`) would widen it through a
 * coordinated migration.
 */
export type PolarisHashAlgorithm = typeof POLARIS_HASH_ALGORITHM;

/**
 * Hash a secret with the platform-standard argon2id parameters.
 *
 * The returned string is the opaque PHC representation produced by
 * `@node-rs/argon2`. Callers store it verbatim in PostgreSQL — never the
 * plaintext, never a truncated form, never a separately-derived index.
 *
 * Hashing is intentionally slow (tens of milliseconds). Use this only at
 * issuance time (`polaris keys create`, `polaris keys rotate`,
 * `polaris operators create`), never on the hot path.
 *
 * @param plaintext  the secret tail to hash; must be non-empty
 * @returns the PHC-encoded argon2id hash to store in PostgreSQL
 * @throws {TypeError} when `plaintext` is empty
 */
export async function hashSecret(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("hashSecret(plaintext): plaintext must be a non-empty string");
  }
  return argon2Hash(plaintext);
}

/**
 * Verify a plaintext secret against a stored argon2id hash.
 *
 * Returns `true` only when `@node-rs/argon2` confirms the match. Any error
 * (malformed PHC string, algorithm mismatch, native failure) is swallowed and
 * surfaced as `false` — the upstream auth layer only needs a boolean to pick
 * between `invalid_api_key` and accept, and we deliberately avoid exposing
 * which branch failed so timing/error inspection cannot distinguish a bad
 * secret from a bad hash row.
 *
 * The caller passes the algorithm tag stored alongside the hash so we can
 * reject rows written with a non-argon2id primitive (forward compatibility —
 * the column defaults to `'argon2id'` today).
 *
 * @param plaintext  the secret tail from the request header
 * @param hash       the PHC string stored in the database
 * @param algorithm  the algorithm tag stored alongside the hash
 */
export async function verifySecret(
  plaintext: string,
  hash: string,
  algorithm: string,
): Promise<boolean> {
  if (algorithm !== POLARIS_HASH_ALGORITHM) {
    return false;
  }
  try {
    return await argon2Verify(hash, plaintext);
  } catch {
    return false;
  }
}
