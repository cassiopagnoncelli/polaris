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
import type { Database } from "@polaris/shared-db";
import type { ColumnType, Kysely } from "kysely";

/**
 * Typed mirror of the `operator_tokens` table. Duplicated from
 * `apps/polaris-cli/src/db/operator-tokens.ts` for the same reason the
 * CLI declares it: module augmentation is additive, so both apps may
 * declare the augmentation and TypeScript merges them without
 * conflict. The migration in
 * `db/migrations/20260512000009_create_operator_tokens.sql` is the
 * source of truth.
 */
export const OPERATOR_TOKEN_STATUSES = ["active", "revoked"] as const;
export type OperatorTokenStatus = (typeof OPERATOR_TOKEN_STATUSES)[number];

export interface OperatorTokensTable {
  operator_token_id: string;
  operator_label: string;
  hash: string;
  hash_algorithm: ColumnType<string, string | undefined, string>;
  status: ColumnType<OperatorTokenStatus, OperatorTokenStatus | undefined, OperatorTokenStatus>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  last_used_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
}

declare module "@polaris/shared-db" {
  interface Database {
    operator_tokens: OperatorTokensTable;
  }
}

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
