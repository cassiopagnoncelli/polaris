/**
 * Kysely-backed adapter that implements the {@link OperatorTokenRepository}
 * contract from `@polaris/shared-control-plane`.
 *
 * The resolver does not know about Kysely; it accepts an interface so the
 * future control-plane API can wire it to an HTTP-backed implementation
 * without touching `@polaris/shared-control-plane`. This file is the
 * concrete implementation the CLI uses.
 *
 * The hash column is fetched via `findOperatorTokenAuthRowById` (the
 * dedicated auth view that includes `hash` and `hash_algorithm`). The
 * regular `findOperatorTokenById` view omits the hash entirely, so any
 * accidental future call from a non-resolver caller cannot leak it.
 *
 * The `touchLastUsedAt` path is fire-and-forget on the resolver side:
 * failures are swallowed there, and we do not log here either — a transient
 * outage that prevents the touch must not produce noisy noise on every CLI
 * invocation.
 *
 * @see packages/shared-control-plane/src/resolver.ts
 * @see apps/polaris-cli/src/db/operator-tokens.ts
 */
import type {
  OperatorTokenRepository,
  OperatorTokenRow as ResolverOperatorTokenRow,
} from "@polaris/shared-control-plane";
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

import {
  findOperatorTokenAuthRowById,
  touchOperatorTokenLastUsedAt,
} from "../db/operator-tokens.js";

/**
 * Wrap a Kysely client in the resolver's repository contract.
 *
 * The returned object is stateless — the same `db` may be shared across
 * commands. Callers that opened a `connectDb({ env: process.env })`
 * handle pass the `db` field here and close the handle when the command
 * finishes (the resolver does not close the db itself).
 */
export function createKyselyOperatorTokenRepository(db: Kysely<Database>): OperatorTokenRepository {
  return {
    findById: async (operatorTokenId): Promise<ResolverOperatorTokenRow | null> => {
      const row = await findOperatorTokenAuthRowById(db, operatorTokenId);
      if (row === null) return null;
      // The resolver only cares about a closed set of fields, and the
      // status column comes back typed as the CHECK-constrained union.
      // Map the row through a fresh object so the resolver never receives
      // an unknown column by accident.
      return {
        operator_token_id: row.operator_token_id,
        operator_label: row.operator_label,
        hash: row.hash,
        hash_algorithm: row.hash_algorithm,
        status: row.status,
      };
    },
    touchLastUsedAt: async (operatorTokenId, at): Promise<void> => {
      await touchOperatorTokenLastUsedAt(db, operatorTokenId, at);
    },
  };
}
