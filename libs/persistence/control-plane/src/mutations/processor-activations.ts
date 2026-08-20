/**
 * Audited processor-activation mutations.
 *
 * The activation row is a runtime on/off switch keyed by
 * (name, version, project, environment). Processor *semantics* — inputs,
 * outputs, mode, replay support — live in each processor's
 * `processor.manifest.yaml` and in code, and nothing here can write them.
 *
 * `target_id` is the composite key joined with colons, matching what the CLI
 * writes, so `polaris audit list --target-id <key>` finds both surfaces'
 * rows.
 *
 * Note the CLI's snapshot vocabulary: `enabled_state` is `"(no row)"` when
 * the activation did not exist before. That is deliberate — it distinguishes
 * "was disabled" from "was never configured", which matters when reading back
 * why a processor started running.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import {
  disableProcessorActivation,
  enableProcessorActivation,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
} from "../queries/processor-activations.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

export type { ProcessorActivationKey };

export interface ProcessorAuditSnapshot {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly enabled_state: "enabled" | "disabled" | "(no row)";
  readonly enabled_at: string | null;
  readonly disabled_at: string | null;
  readonly last_changed_by: string;
}

/** Snapshot of the activation as it stands, or the "(no row)" placeholder. */
export function toProcessorSnapshot(
  key: ProcessorActivationKey,
  row: ProcessorActivationRow | null,
  fallbackChangedBy: string,
): ProcessorAuditSnapshot {
  if (row === null) {
    return {
      processor_name: key.processor_name,
      processor_version: key.processor_version,
      project_id: key.project_id,
      environment: key.environment,
      enabled_state: "(no row)",
      enabled_at: null,
      disabled_at: null,
      last_changed_by: fallbackChangedBy,
    };
  }
  return {
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    project_id: row.project_id,
    environment: row.environment,
    enabled_state: row.enabled_state,
    enabled_at: toIso(row.enabled_at),
    disabled_at: toIso(row.disabled_at),
    last_changed_by: row.last_changed_by,
  };
}

/** `name:version:project:environment` — the CLI's `target_id` shape. */
export function processorTargetId(key: ProcessorActivationKey): string {
  return `${key.processor_name}:${key.processor_version}:${key.project_id}:${key.environment}`;
}

export async function enableProcessorActivationWithAudit(
  db: Kysely<Database>,
  input: {
    key: ProcessorActivationKey;
    existing: ProcessorActivationRow | null;
    changedBy: string;
  },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toProcessorSnapshot(input.key, input.existing, input.changedBy);
  return withAudit(
    db,
    audit,
    {
      action: "processors.enable",
      targetType: "processor_activation",
      targetId: processorTargetId(input.key),
      projectId: input.key.project_id,
      environment: input.key.environment as AuditEnvironment,
      before,
      after: {
        ...before,
        enabled_state: "enabled",
        enabled_at: audit.occurredAt.toISOString(),
        last_changed_by: input.changedBy,
      },
    },
    (trx) =>
      enableProcessorActivation(trx, {
        ...input.key,
        enabledAt: audit.occurredAt,
        lastChangedBy: input.changedBy,
      }),
  );
}

export async function disableProcessorActivationWithAudit(
  db: Kysely<Database>,
  input: {
    key: ProcessorActivationKey;
    existing: ProcessorActivationRow | null;
    changedBy: string;
  },
  audit: AuditContext,
): Promise<MutationOutcome> {
  const before = toProcessorSnapshot(input.key, input.existing, input.changedBy);
  return withAudit(
    db,
    audit,
    {
      action: "processors.disable",
      targetType: "processor_activation",
      targetId: processorTargetId(input.key),
      projectId: input.key.project_id,
      environment: input.key.environment as AuditEnvironment,
      before,
      after: {
        ...before,
        enabled_state: "disabled",
        disabled_at: audit.occurredAt.toISOString(),
        last_changed_by: input.changedBy,
      },
    },
    (trx) =>
      disableProcessorActivation(trx, {
        ...input.key,
        disabledAt: audit.occurredAt,
        lastChangedBy: input.changedBy,
      }),
  );
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}
