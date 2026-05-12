/**
 * Wire format for Polaris API keys.
 *
 * The on-wire representation is a single opaque string that the ingester
 * parses through `parseApiKeyHeader` (`apps/ingester-api/src/auth/api-key.ts`).
 * Shape:
 *
 *   `<api_key_id>.<raw_secret>`
 *
 * where:
 *
 *   - `api_key_id` is the public lookup prefix stored in `api_keys.api_key_id`.
 *     We use the `polaris_ak_<uuidv7>` shape so the prefix is greppable in
 *     audit records and CLI output and reads as "polaris API key" at a
 *     glance. The shape is distinct from operator tokens (`polaris_ot_*`,
 *     coming in P6-007).
 *   - `raw_secret` is the high-entropy tail. The CLI generates 32 random
 *     bytes and encodes them base64url (no padding) so the secret is URL- and
 *     header-safe. Only the argon2id hash of this value is stored.
 *
 * The full token plaintext is shown ONLY in the one stdout write inside
 * `keys create` and `keys rotate`. It never appears in logs, audit records,
 * the database, or any subsequent CLI output.
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see apps/ingester-api/src/auth/api-key.ts
 */

import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

/**
 * Prefix marker on `api_key_id`. Distinct from `polaris_ot_` (operator
 * tokens, P6-007) and from any future credential prefix.
 */
const API_KEY_ID_PREFIX = "polaris_ak_";

/** Number of bytes pulled from CSPRNG for the secret tail. 32 = 256 bits. */
const SECRET_BYTES = 32;

/**
 * Separator between the public id and the secret tail. Matches the parser in
 * `apps/ingester-api/src/auth/api-key.ts`.
 */
const TOKEN_SEPARATOR = ".";

/**
 * Materialised key issuance: the public id, the raw secret, and the on-wire
 * token. The CLI returns this struct from the issue helper, prints the
 * on-wire `token` once, and stores only the `apiKeyId` + a derived hash.
 *
 * The `rawSecret` lives only inside the CLI process and the single stdout
 * write. It is never stored, never logged, never returned to any other
 * subsystem.
 */
export interface IssuedKeyMaterial {
  readonly apiKeyId: string;
  readonly rawSecret: string;
  readonly token: string;
}

/**
 * Generate a fresh `(api_key_id, raw_secret, token)` triple.
 *
 * The id is `polaris_ak_<uuidv7>`. The secret is 32 random bytes encoded as
 * base64url without padding. The token is `<id>.<secret>` — the exact shape
 * the ingester parses on the wire.
 */
export function generateKeyMaterial(): IssuedKeyMaterial {
  const apiKeyId = `${API_KEY_ID_PREFIX}${uuidv7()}`;
  const rawSecret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    apiKeyId,
    rawSecret,
    token: `${apiKeyId}${TOKEN_SEPARATOR}${rawSecret}`,
  };
}

/**
 * Format a key for the on-wire / one-time-stdout shape from an already-known
 * `(apiKeyId, rawSecret)` pair. Used by tests; production code calls
 * {@link generateKeyMaterial} which composes both.
 */
export function formatToken(apiKeyId: string, rawSecret: string): string {
  return `${apiKeyId}${TOKEN_SEPARATOR}${rawSecret}`;
}

/**
 * Visible only for unit tests. The literal prefix gives the issuer-side
 * generator and any future format-validation a shared constant.
 */
export const API_KEY_ID_PREFIX_FOR_TEST = API_KEY_ID_PREFIX;
