/**
 * Stable human renderer for the ClickHouse rebuild plan.
 *
 * Mirrors the `renderPlanHuman` helper in `@polaris/archive-replay`:
 * one place to format the dry-run digest the CLI prints so the
 * formatting is deterministic and assertable in tests.
 *
 * @see types.ts
 */

import type { ClickhouseRebuildPlanned } from "./types.js";

/**
 * Render the planned rebuild as a human-readable digest. The output
 * is intentionally narrow (no ASCII tables, no colour) so it pipes
 * cleanly into log aggregators and `tee`.
 *
 * Caller is responsible for prefixing additional context lines (e.g.
 * "polaris clickhouse-rebuild plan (dry-run; planner v1)" header).
 * This helper renders only the body — keeping the header in the
 * runner lets the CLI customise it per command (`plan` vs `create
 * --dry-run`) without forking the renderer.
 */
export function renderClickhouseRebuildPlanHuman(plan: ClickhouseRebuildPlanned): string {
  const lines: string[] = [
    `polaris clickhouse-rebuild plan (dry-run; planner ${plan.plannerVersion})`,
    `  projection             ${plan.projection}`,
    `  description            ${plan.descriptor.description}`,
    `  target_table           ${plan.targetTableQualified}`,
    `  source_sql             ${plan.descriptor.sqlFile}`,
    `  feeder_mv_sql          ${plan.descriptor.feederMvFile}`,
    `  source_range_from      ${plan.sourceRangeFrom ?? "(full table)"}`,
    `  source_range_to        ${plan.sourceRangeTo ?? "(full table)"}`,
    `  partitions             ${plan.partitionCount}`,
    `  rows_total_estimated   ${plan.rowsTotalEstimated}`,
    `  planned_at             ${plan.plannedAt}`,
  ];
  if (plan.partitionCount > 0) {
    lines.push("  partition_details:");
    for (const p of plan.partitions) {
      lines.push(`    - ${p.partition}  rows~${p.rowsEstimated}`);
    }
  }
  if (plan.knownGaps.length > 0) {
    lines.push("  known_gaps:");
    for (const gap of plan.knownGaps) {
      lines.push(`    - ${gap}`);
    }
  }
  return lines.join("\n");
}
