/**
 * Retention for `attribution_touchpoint_chains`.
 *
 * ## Why this is safe to delete at all
 *
 * attribution-engine v2 resets a chain when the gap between an event's
 * `occurred_at` and the chain's `last_observed_at` exceeds its 90-day
 * inactivity window. So a row idle for longer than that window can never
 * be consulted again: the next event for that identifier is *guaranteed*
 * to open a new chain whether or not the old row still exists. Deleting
 * it is provably free of semantic effect, not a judgement call about how
 * much history is worth keeping.
 *
 * ## Why it refuses v1
 *
 * attribution-engine v1 has no window. A v1 chain is consulted however
 * old it is, so deleting one CHANGES OUTPUT — the next touchpoint for
 * that identifier would emit a `first_touch_assigned` it otherwise would
 * not. Under the semantic-immutability rule
 * (`docs/architecture/05-processors-and-replay.md` "Processor
 * Versioning") that is not a retention decision an operator may take; it
 * is a new processor version.
 *
 * The guard lives here rather than in the CLI because this is the layer
 * that owns the write. A future scheduled job, the control-plane API, or
 * a second CLI surface all inherit the refusal for free.
 *
 * @see async/computation/attribution-engine/v2/CHANGELOG.md
 * @see docs/operations/backup-and-retention.md "Attribution chain retention"
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import type { AuditEnvironment } from "../queries/audit-records.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

/**
 * Processor versions whose chains may be pruned, and the window each one
 * guarantees, in seconds. A version absent from this map has no window
 * and is therefore not prunable.
 *
 * Hand-maintained rather than parsed from the manifest: the window lives
 * in manifest prose, and a retention job that inferred a deletion bound
 * by reading English is a worse failure mode than one that refuses a
 * version nobody has told it about.
 */
export const PRUNABLE_ATTRIBUTION_VERSIONS: ReadonlyMap<string, number> = new Map([
  ["v2", 90 * 24 * 60 * 60],
]);

export interface PruneAttributionChainsInput {
  /** Processor version whose chains to prune. Must have a window. */
  readonly processorVersion: string;
  /**
   * Delete chains idle for longer than this. Defaults to the version's
   * own window. A LONGER value is allowed (more conservative); a shorter
   * one is refused, because rows inside the window can still be read.
   */
  readonly idleSeconds?: number;
  /** Optional narrowing. Omit to prune every project / environment. */
  readonly projectId?: string | null;
  readonly environment?: string | null;
  /** Count what would be deleted without deleting it. */
  readonly dryRun?: boolean;
}

export interface PruneAttributionChainsResult extends MutationOutcome {
  /** Rows deleted, or — on a dry run — rows that would be deleted. */
  readonly rows: number;
  /** Cutoff actually applied, echoed so the caller can report it. */
  readonly idleSeconds: number;
  readonly cutoff: Date;
  readonly dryRun: boolean;
}

/** Raised when the requested prune would change attribution output. */
export class UnprunableAttributionVersionError extends Error {
  constructor(version: string) {
    super(
      `attribution-engine ${version} has no attribution window, so pruning its touchpoint chains would change output: ` +
        "the next touchpoint for a deleted identifier would emit a first_touch_assigned it otherwise would not. " +
        `Prunable versions: ${[...PRUNABLE_ATTRIBUTION_VERSIONS.keys()].join(", ")}.`,
    );
    this.name = "UnprunableAttributionVersionError";
  }
}

/** Raised when the caller asks to delete rows the window still protects. */
export class IdleWindowTooShortError extends Error {
  constructor(version: string, requested: number, minimum: number) {
    super(
      `idleSeconds ${String(requested)} is shorter than attribution-engine ${version}'s ${String(minimum)}-second window. ` +
        "Rows inside the window can still be read, so deleting them would change attribution output.",
    );
    this.name = "IdleWindowTooShortError";
  }
}

/** Validate the request and resolve the effective cutoff. Pure. */
export function resolvePruneCutoff(
  input: Pick<PruneAttributionChainsInput, "processorVersion" | "idleSeconds">,
  now: Date,
): { readonly idleSeconds: number; readonly cutoff: Date } {
  const window = PRUNABLE_ATTRIBUTION_VERSIONS.get(input.processorVersion);
  if (window === undefined) throw new UnprunableAttributionVersionError(input.processorVersion);

  const idleSeconds = input.idleSeconds ?? window;
  if (idleSeconds < window) {
    throw new IdleWindowTooShortError(input.processorVersion, idleSeconds, window);
  }
  return { idleSeconds, cutoff: new Date(now.getTime() - idleSeconds * 1000) };
}

/**
 * Delete touchpoint chains the processor's own window has already made
 * unreadable.
 *
 * The audit row carries the request — version, cutoff, scope — and not
 * the row count. `withAudit` fixes the audit payload before the mutation
 * runs, and a count obtained by a separate pre-SELECT would be a
 * different number from the one the DELETE saw. Recording the *request*
 * is both accurate and the thing an operator is accountable for; the
 * count is returned to the caller to print.
 *
 * A dry run writes no audit row, and a prune that matches nothing writes
 * none either — a nightly job that deletes nothing should not fill the
 * audit log with silence.
 */
export async function pruneAttributionChainsWithAudit(
  db: Kysely<Database>,
  input: PruneAttributionChainsInput,
  audit: AuditContext,
): Promise<PruneAttributionChainsResult> {
  const { idleSeconds, cutoff } = resolvePruneCutoff(input, audit.occurredAt);
  const dryRun = input.dryRun ?? false;

  if (dryRun) {
    let q = db
      .selectFrom("attribution_touchpoint_chains")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("processor_version", "=", input.processorVersion)
      .where("last_observed_at", "<", cutoff);
    if (input.projectId != null) q = q.where("project_id", "=", input.projectId);
    if (input.environment != null) q = q.where("environment", "=", input.environment);
    const row = await q.executeTakeFirst();
    return {
      applied: false,
      auditId: null,
      rows: Number(row?.n ?? 0),
      idleSeconds,
      cutoff,
      dryRun: true,
    };
  }

  let deleted = 0;
  const outcome = await withAudit(
    db,
    audit,
    {
      action: "processors.attribution.chains.prune",
      targetType: "attribution_touchpoint_chains",
      targetId: input.processorVersion,
      projectId: input.projectId ?? null,
      environment: (input.environment ?? null) as AuditEnvironment | null,
      before: {
        processor_version: input.processorVersion,
        idle_seconds: idleSeconds,
        cutoff: cutoff.toISOString(),
        project_id: input.projectId ?? null,
        environment: input.environment ?? null,
      },
      after: { pruned_through: cutoff.toISOString() },
    },
    async (trx) => {
      let q = trx
        .deleteFrom("attribution_touchpoint_chains")
        .where("processor_version", "=", input.processorVersion)
        .where("last_observed_at", "<", cutoff);
      if (input.projectId != null) q = q.where("project_id", "=", input.projectId);
      if (input.environment != null) q = q.where("environment", "=", input.environment);
      const result = await q.executeTakeFirst();
      deleted = Number(result?.numDeletedRows ?? 0);
      return deleted > 0;
    },
  );

  return { ...outcome, rows: deleted, idleSeconds, cutoff, dryRun: false };
}
