/**
 * argon2id hash verification for API key authentication.
 *
 * API keys are stored as argon2id hashes (`packages/shared-db` `api_keys.hash`).
 * The ingester only needs the verify side in P2-002 — issuance happens through
 * the lifecycle CLI in P6-003, which will reuse this primitive (or extract it
 * into a shared package) without introducing a second hashing library.
 *
 * Rules baked into this module:
 *
 *   - Plaintext never leaves this module. It enters as a `string` argument and
 *     is dropped after the verify call returns. The `hash` argument is the
 *     opaque PHC string from PostgreSQL; the verifier reads cost parameters
 *     from the PHC prefix.
 *   - Verification is constant-time on success/failure relative to a given
 *     hash, because that is what `@node-rs/argon2`'s `verify` guarantees.
 *   - We do not surface argon2 errors to the caller. Any failure (malformed
 *     hash, wrong algorithm, library exception) maps to `false` so the auth
 *     layer can return a single `invalid_api_key` Problem Details response and
 *     not leak which arm of the check failed.
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/implementation/tasks/P6-003-api-key-lifecycle-cli.md
 */

import { verify as argon2Verify } from "@node-rs/argon2";

/**
 * Verify a plaintext API key secret against a stored argon2id hash.
 *
 * Returns `true` only when `@node-rs/argon2` confirms the match. Any error
 * (malformed PHC string, algorithm mismatch, native failure) is swallowed and
 * surfaced as `false` — the upstream auth layer only needs a boolean to pick
 * between `invalid_api_key` and accept, and we deliberately avoid exposing
 * which branch failed so timing/error inspection cannot distinguish a bad
 * secret from a bad hash row.
 *
 * The caller passes the `hash_algorithm` column so we can reject any row that
 * was written with a non-argon2id primitive (forward compatibility — the
 * column defaults to `'argon2id'` today).
 *
 * @param plaintext  the secret tail from the request header
 * @param hash       the PHC string stored in `api_keys.hash`
 * @param algorithm  the algorithm tag stored in `api_keys.hash_algorithm`
 */
export async function verifyApiKeyHash(
  plaintext: string,
  hash: string,
  algorithm: string,
): Promise<boolean> {
  if (algorithm !== "argon2id") {
    return false;
  }
  try {
    return await argon2Verify(hash, plaintext);
  } catch {
    return false;
  }
}
