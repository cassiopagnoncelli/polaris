/**
 * Human-readable renderer for a {@link ReplayPlan}.
 *
 * The CLI's `polaris replay plan` dry-run command consumes this when
 * `--output human` is selected (the default). JSON output bypasses
 * this module entirely — the JSON shape is the {@link ReplayPlan}
 * itself, so it stays in sync with the planner contract automatically.
 *
 * The renderer mirrors the field set the task card specified:
 *
 *   - source topic
 *   - project/environment scope
 *   - time or offset range
 *   - target processor/consumer/version
 *   - expected destination behavior
 *   - known risk flags
 *   - planned consumer group
 *
 * Output is intentionally line-oriented: every section is one paragraph
 * with `  key   value` rows, matching the pattern other `polaris replay
 * show` commands use so operators see a consistent visual language.
 */
import type { ReplayPlan } from "./types.js";

/**
 * Render a {@link ReplayPlan} as a human-readable multi-line string.
 * Returns the string WITHOUT a trailing newline; the caller's output
 * stream adds one.
 */
export function renderPlanHuman(plan: ReplayPlan): string {
  const lines: string[] = [];
  lines.push(`polaris replay plan (dry-run; planner ${plan.planner_version})`);
  lines.push(`  replay_job_id          ${plan.replay_job_id}`);
  lines.push(`  project_id             ${plan.project_id}`);
  lines.push(`  environment            ${plan.environment}`);
  lines.push(`  target                 ${plan.target}`);
  lines.push(`  mode                   ${plan.mode}`);
  lines.push(`  source_topic_family    ${plan.source_topic_family}`);
  lines.push(`  partition_key_strategy ${plan.partition_key_strategy}`);
  lines.push(`  window_from            ${plan.window_from}`);
  lines.push(`  window_to              ${plan.window_to}`);
  lines.push(`  chunk_count            ${plan.chunk_count}`);
  lines.push(`  chunk_size_days        ${plan.chunk_size_days}`);
  lines.push(`  event_name             ${plan.event_name ?? "(all)"}`);
  lines.push(`  event_id               ${plan.event_id ?? "(all)"}`);
  lines.push(`  processor_name         ${plan.processor_name ?? "(not pinned)"}`);
  lines.push(`  processor_version      ${plan.processor_version ?? "(not pinned)"}`);
  lines.push(
    `  destinations_enabled   ${plan.destinations_enabled ? "true (opt-in)" : "false (disabled by default)"}`,
  );
  if (plan.destination_opt_in_note !== null) {
    lines.push(`  destination_opt_in     ${plan.destination_opt_in_note}`);
  }
  lines.push(`  consumer_group         ${plan.consumer_group}`);
  lines.push(`  events_estimated       ${plan.events_estimated ?? "unknown"}`);
  lines.push(`  planned_at             ${plan.planned_at}`);

  if (plan.risks.length === 0) {
    lines.push(`  risks                  (none)`);
  } else {
    lines.push(`  risks                  ${plan.risks.length} flagged`);
    for (const risk of plan.risks) {
      lines.push(`    [${risk.code}] ${risk.message}`);
    }
  }

  return lines.join("\n");
}
