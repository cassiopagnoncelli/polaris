/**
 * Audited topic-isolation mutations.
 *
 * Isolating a project splits a shared stream family into a dedicated
 * `<family>.<project_id>` topic. The row here is only the *record* of that
 * decision — it does not create the RabbitMQ topic or move any traffic. The
 * CLI prints a six-step operator runbook alongside, and the row exists so a
 * later reader can tell which projects were cut over and why.
 *
 * That is exactly why the audit row matters more than usual: the database
 * state is a claim about the broker, and the audit trail is the only place
 * recording who made the claim.
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import {
  deactivateIsolation,
  type InsertTopicIsolationInput,
  insertTopicIsolation,
  type TopicIsolationRow,
} from "../queries/topic-isolations.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

export async function isolateTopicWithAudit(
  db: Kysely<Database>,
  input: InsertTopicIsolationInput,
  audit: AuditContext,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "topics.isolate",
      targetType: "topic_isolation",
      targetId: input.id,
      projectId: input.project_id,
      environment: input.environment as AuditEnvironment,
      before: null,
      after: {
        id: input.id,
        project_id: input.project_id,
        environment: input.environment,
        topic_family: input.topic_family,
        concrete_topic: input.concrete_topic,
      },
    },
    async (trx) => {
      // The partial unique index on (family, project, environment) WHERE
      // deactivated_at IS NULL enforces one active isolation per triple. A
      // duplicate raises here and rolls the audit row back with it, rather
      // than recording an isolation that does not exist.
      await insertTopicIsolation(trx, input);
      return true;
    },
  );
}

/** Deactivate an isolation. Idempotent — an already-inactive row is a no-op. */
export async function deisolateTopicWithAudit(
  db: Kysely<Database>,
  input: { row: TopicIsolationRow },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = {
    id: input.row.id,
    project_id: input.row.project_id,
    environment: input.row.environment,
    topic_family: input.row.topic_family,
    concrete_topic: input.row.concrete_topic,
    deactivated_at: input.row.deactivated_at,
  };
  return withAudit(
    db,
    audit,
    {
      action: "topics.deisolate",
      targetType: "topic_isolation",
      targetId: input.row.id,
      projectId: input.row.project_id,
      environment: input.row.environment as AuditEnvironment,
      before,
      after: { ...before, deactivated_at: audit.occurredAt.toISOString() },
    },
    (trx) => deactivateIsolation(trx, input.row.id, audit.occurredAt),
  );
}
