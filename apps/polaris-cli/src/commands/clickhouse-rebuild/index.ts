/**
 * `polaris clickhouse-rebuild` command group.
 *
 * Surfaces five commands:
 *
 *   - `polaris clickhouse-rebuild list`                   mutates: false
 *   - `polaris clickhouse-rebuild show <id>`              mutates: false
 *   - `polaris clickhouse-rebuild plan ...`               mutates: false
 *   - `polaris clickhouse-rebuild create ... [--dry-run]` mutates: true
 *   - `polaris clickhouse-rebuild abort <id> --reason`    mutates: true
 *
 * Central architectural rules baked into this group:
 *
 *   1. ClickHouse projection rebuilds are PLANNED workflows. Hand-rolled
 *      `ALTER TABLE … DROP PARTITION` or ad-hoc `INSERT INTO …` is NOT
 *      the supported fix path; the audit story breaks, the Kafka Engine
 *      consumers race, and the snapshot becomes inconsistent across
 *      replicas. Operators issue rebuilds through this CLI surface.
 *
 *   2. The planner is read-only and lives in
 *      `@polaris/shared-clickhouse/rebuild`. PostgreSQL stores only the
 *      rebuild-job declaration (projection, optional range, reason,
 *      requester, status, outcome).
 *
 *   3. The executor that actually re-derives the projection is
 *      DEFERRED to a follow-up task. `polaris clickhouse-rebuild
 *      create` without --dry-run persists a `pending` row + audit
 *      trail but exits non-zero with reason code
 *      `clickhouse_rebuild_executor_not_implemented` so an operator
 *      cannot believe a rebuild already ran.
 *
 * @see docs/architecture/07-clickhouse.md "Replay and Rebuild"
 * @see docs/development/clickhouse-rebuilds.md
 * @see docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md
 */
import type { CommandDefinition } from "../../command.js";
import { clickhouseRebuildAbortCommand } from "./abort.js";
import { clickhouseRebuildCreateCommand } from "./create.js";
import { clickhouseRebuildListCommand } from "./list.js";
import { clickhouseRebuildPlanCommand } from "./plan.js";
import { clickhouseRebuildShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  clickhouseRebuildListCommand,
  clickhouseRebuildShowCommand,
  clickhouseRebuildPlanCommand,
  clickhouseRebuildCreateCommand,
  clickhouseRebuildAbortCommand,
];

export const clickhouseRebuildCommand: CommandDefinition = {
  id: "clickhouse-rebuild",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("clickhouse-rebuild")
      .description(
        "Manage controlled ClickHouse projection rebuilds. Postgres stores job runtime state; the planner lives in @polaris/shared-clickhouse/rebuild. Executor is deferred — see docs/development/clickhouse-rebuilds.md.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  clickhouseRebuildAbortCommand,
  clickhouseRebuildCreateCommand,
  clickhouseRebuildListCommand,
  clickhouseRebuildPlanCommand,
  clickhouseRebuildShowCommand,
};
