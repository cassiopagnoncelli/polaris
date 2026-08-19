/**
 * The mutations the admin UI can perform.
 *
 * Every one is reversible, already implemented and audited in the CLI, and
 * routed through `@polaris/shared-control-plane-db`'s `*WithAudit` functions
 * — so the UI and the CLI write identical SQL, identical audit snapshots, and
 * identical `action` strings, inside one transaction.
 *
 * Nothing irreversible is here, and that is a policy rather than a backlog:
 *
 *   - `replay execute` republishes real events to a live topic, fanning out
 *     to vendor destinations with real end-user effects, and writes no audit
 *     row today.
 *   - `dlq retry` republishes a stored envelope to a vendor's redelivery
 *     queue — again, a real delivery.
 *   - `clickhouse-rebuild create` issues real INSERT…SELECT into a projection.
 *   - `keys rotate` kills the old key the instant it commits, with no grace
 *     period, breaking whatever producer holds it.
 *
 * Those stay on the CLI, where an operator has already typed a deliberate
 * command with flags rather than clicked something.
 *
 * `dlq mark-resolved` IS here. The triage half of `dlq_records` now lives in
 * `@polaris/shared-control-plane-db` alongside every other control-plane
 * write, so resolving a row no longer means depending on
 * `@polaris/shared-destinations` and dragging the whole delivery stack —
 * RabbitMQ transport included — into a service that speaks to no broker.
 * `dlq retry` still does not: republishing needs a broker, and that is the
 * dependency the split was drawn to avoid.
 */

import {
  type AuditContext,
  disableDestinationWithAudit,
  disableProcessorActivationWithAudit,
  enableDestinationWithAudit,
  enableProcessorActivationWithAudit,
  findActivationByKey,
  findApiKeyById,
  findDestinationById,
  type InvalidateProjectConfigInput,
  invalidateProjectConfigWithAudit,
  type MutationOutcome,
  markDlqResolvedWithAudit,
  type ProcessorActivationKey,
  revokeApiKeyWithAudit,
  type SetProjectConfigInput,
  setProjectConfigValueWithAudit,
  type UnsetProjectConfigInput,
  unsetProjectConfigValueWithAudit,
} from "@polaris/shared-control-plane-db";
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

export type { MutationOutcome };

/**
 * Identity and reason for the audit row, as the UI knows it.
 *
 * `actorLabel` is the operator's Idp email, taken from the signed,
 * subject-bound identity cookie. `requestId` is the service's UUIDv7 request
 * id, which makes the audit row joinable against the structured logs — CLI
 * rows stamp `request_id = audit_id` because they have no request.
 */
export interface AdminActor {
  readonly auditId: string;
  readonly actorLabel: string;
  readonly requestId: string;
  readonly occurredAt: Date;
}

export interface AdminMutations {
  disableDestination(
    destinationId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  enableDestination(
    destinationId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  revokeApiKey(apiKeyId: string, reason: string, actor: AdminActor): Promise<MutationOutcome>;
  enableProcessor(
    key: ProcessorActivationKey,
    reason: string,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  markDlqResolved(
    target: {
      dlqId: string;
      projectId: string;
      environment: string;
      vendor: string;
      reason: string;
    },
    note: string,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  disableProcessor(
    key: ProcessorActivationKey,
    reason: string,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  /**
   * `reason` is nullable on these two alone.
   *
   * A routine value edit carries no typed confirmation and no written
   * justification — see `MutationRequest.reason`. The other mutations here
   * are all ritual-gated, so a `string` on their signatures is the contract,
   * not an oversight.
   */
  setProjectConfig(
    input: SetProjectConfigInput,
    reason: string | null,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  unsetProjectConfig(
    input: UnsetProjectConfigInput,
    reason: string | null,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
  invalidateProjectConfig(
    input: InvalidateProjectConfigInput,
    reason: string,
    actor: AdminActor,
  ): Promise<MutationOutcome>;
}

/** Thrown when the target row vanished between the page render and the POST. */
export class MutationTargetMissing extends Error {
  constructor(what: string) {
    super(`${what} no longer exists`);
    this.name = "MutationTargetMissing";
  }
}

export function createKyselyAdminMutations(db: Kysely<Database>): AdminMutations {
  const context = (actor: AdminActor, reason: string | null): AuditContext => ({
    auditId: actor.auditId,
    // Idp-authenticated operators map to `declared`: `audit_records
    // .actor_source` is a CHECK-constrained enum with no `idp` member, and
    // `declared` is what the rest of the platform reads as "an authenticated
    // human". The email in `actor_label` distinguishes UI writes from CLI
    // ones without needing a second column.
    actorSource: "declared",
    actorLabel: actor.actorLabel,
    reason,
    requestId: actor.requestId,
    occurredAt: actor.occurredAt,
  });

  return {
    // The three below hold no SQL of their own: they delegate to the same
    // *WithAudit functions the polaris CLI calls, which own the single
    // transaction carrying the value write, the version bump, the pg_notify
    // and the audit row. Two surfaces that could disagree means one is wrong.
    async setProjectConfig(input, reason, actor) {
      return setProjectConfigValueWithAudit(db, context(actor, reason), input);
    },

    async unsetProjectConfig(input, reason, actor) {
      return unsetProjectConfigValueWithAudit(db, context(actor, reason), input);
    },

    async invalidateProjectConfig(input, reason, actor) {
      return invalidateProjectConfigWithAudit(db, context(actor, reason), input);
    },

    async disableDestination(destinationId, reason, actor) {
      const row = await findDestinationById(db, destinationId);
      if (row === null) throw new MutationTargetMissing("destination");
      return disableDestinationWithAudit(db, { row, reason }, context(actor, reason));
    },

    async enableDestination(destinationId, reason, actor) {
      const row = await findDestinationById(db, destinationId);
      if (row === null) throw new MutationTargetMissing("destination");
      return enableDestinationWithAudit(db, { row }, context(actor, reason));
    },

    async revokeApiKey(apiKeyId, reason, actor) {
      const row = await findApiKeyById(db, apiKeyId);
      if (row === null) throw new MutationTargetMissing("api key");
      return revokeApiKeyWithAudit(db, { row }, context(actor, reason));
    },

    async markDlqResolved(target, note, actor) {
      return markDlqResolvedWithAudit(
        db,
        {
          dlqId: target.dlqId,
          projectId: target.projectId,
          environment: target.environment,
          owner: target.vendor,
          reason: target.reason,
        },
        { resolvedBy: actor.actorLabel, note },
        context(actor, note),
      );
    },

    async enableProcessor(key, reason, actor) {
      const existing = await findActivationByKey(db, key);
      return enableProcessorActivationWithAudit(
        db,
        { key, existing, changedBy: actor.actorLabel },
        context(actor, reason),
      );
    },

    async disableProcessor(key, reason, actor) {
      const existing = await findActivationByKey(db, key);
      return disableProcessorActivationWithAudit(
        db,
        { key, existing, changedBy: actor.actorLabel },
        context(actor, reason),
      );
    },
  };
}
