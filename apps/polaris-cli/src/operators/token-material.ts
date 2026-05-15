/**
 * Issuer-side generator for the on-wire operator-token shape.
 *
 * Mirrors the `apps/polaris-cli/src/commands/keys/token.ts` generator for
 * API keys, with the `polaris_ot_` prefix and a separate id namespace.
 *
 *   `polaris_ot_<uuidv7>.<base64url(32B)>`
 *
 * The shape is parsed back into `(operator_token_id, raw_secret)` by
 * `@polaris/shared-control-plane`'s `parseOperatorToken` — this generator
 * and that parser share the prefix/separator constants from the shared
 * package so a future format change happens in one place.
 *
 * The raw secret lives only:
 *
 *   - inside the CLI process during `polaris operators create`,
 *   - in the single stdout write that emits the token to the operator,
 *   - in the operator's clipboard / env var.
 *
 * It is NEVER stored in PostgreSQL, NEVER written to a log line, NEVER
 * returned by any subsequent CLI command.
 */

import { randomBytes } from "node:crypto";
import { formatOperatorToken, OPERATOR_TOKEN_ID_PREFIX } from "@polaris/shared-control-plane";
import { v7 as uuidv7 } from "uuid";

/** Number of bytes pulled from CSPRNG for the secret tail. 32 = 256 bits. */
const SECRET_BYTES = 32;

/**
 * Materialized operator-token issuance: the public id, the raw secret, and
 * the on-wire token. The CLI returns this struct from the issue helper,
 * prints the on-wire `token` once, and stores only the
 * `operatorTokenId` + a derived argon2id hash.
 *
 * The `rawSecret` lives only inside the CLI process and the single stdout
 * write. It is never stored, never logged, never returned to any other
 * subsystem.
 */
export interface IssuedOperatorTokenMaterial {
  readonly operatorTokenId: string;
  readonly rawSecret: string;
  readonly token: string;
}

/**
 * Generate a fresh `(operator_token_id, raw_secret, token)` triple.
 *
 * The id is `polaris_ot_<uuidv7>`. The secret is 32 random bytes encoded
 * as base64url without padding. The token is `<id>.<secret>` — the exact
 * shape `parseOperatorToken` reverses on the dispatcher side.
 */
export function generateOperatorTokenMaterial(): IssuedOperatorTokenMaterial {
  const operatorTokenId = `${OPERATOR_TOKEN_ID_PREFIX}${uuidv7()}`;
  const rawSecret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    operatorTokenId,
    rawSecret,
    token: formatOperatorToken(operatorTokenId, rawSecret),
  };
}
