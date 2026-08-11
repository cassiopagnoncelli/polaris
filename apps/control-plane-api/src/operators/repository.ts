/**
 * Kysely-backed adapter implementing
 * `OperatorTokenRepository` (`@polaris/shared-control-plane`) for the
 * control-plane API.
 *
 * The CLI ships an equivalent adapter in
 * `apps/polaris-cli/src/operators/repository.ts`; both implementations
 * conform to the same interface so the resolver does not branch on the
 * caller. Future cleanup (a P6-002+ refactor) will likely hoist the
 * helper into `@polaris/shared-control-plane` and remove the
 * duplication. Until then, keeping the helper local to each app avoids
 * a cross-app import.
 *
 * Hash plaintext is never logged, persisted, or echoed back to the
 * client. The `findById` view fetches `hash` + `hash_algorithm`
 * because the resolver needs them to verify the supplied secret
 * tail; both stay strictly in the resolver's call frame.
 */
import type { OperatorTokenRepository, OperatorTokenRow } from "@polaris/shared-control-plane";
import {
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenStatus,
  type OperatorTokensTable,
} from "@polaris/shared-control-plane-db";
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

export type { OperatorTokenStatus, OperatorTokensTable };
/**
 * The `operator_tokens` table shape and its `declare module` augmentation
 * live in `@polaris/shared-control-plane-db`, which owns them for both this
 * service and the CLI. They used to be declared here AND in the CLI: module
 * augmentation is additive, so TypeScript merged the two copies silently —
 * right up until someone edited one of them.
 */
export { OPERATOR_TOKEN_STATUSES };

/**
 * Build a Kysely-backed `OperatorTokenRepository`.
 *
 * Stateless: the same client may be shared across requests. The
 * resolver passes through `touchLastUsedAt` calls best-effort; we
 * swallow errors at the resolver layer, not here, because the contract
 * separation is "decide who this is" vs. "guarantee bookkeeping
 * completeness".
 */
export function createKyselyOperatorTokenRepository(db: Kysely<Database>): OperatorTokenRepository {
  return {
    findById: async (operatorTokenId): Promise<OperatorTokenRow | null> => {
      const row = await db
        .selectFrom("operator_tokens")
        .select(["operator_token_id", "operator_label", "hash", "hash_algorithm", "status"])
        .where("operator_token_id", "=", operatorTokenId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        operator_token_id: row.operator_token_id,
        operator_label: row.operator_label,
        hash: row.hash,
        hash_algorithm: row.hash_algorithm,
        status: row.status,
      };
    },
    touchLastUsedAt: async (operatorTokenId, at): Promise<void> => {
      await db
        .updateTable("operator_tokens")
        .set({ last_used_at: at })
        .where("operator_token_id", "=", operatorTokenId)
        .execute();
    },
  };
}
