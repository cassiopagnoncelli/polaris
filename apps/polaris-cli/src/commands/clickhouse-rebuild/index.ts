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
 *   3. The executor re-derives the projection from a full partition
 *      scan and drives the row pending -> running -> completed (or
 *      failed). `create` without --dry-run invokes it and exits
 *      non-zero on failure, so an operator can neither believe a
 *      rebuild ran when it did not, nor miss one that broke.
 *
 *      This is the repair path for the incremental projections, which
 *      over-count cross-block duplicates by construction — see
 *      sql/clickhouse/materialized-views/41_*.sql. A full-partition
 *      scan sees every duplicate at once, which is exactly what a
 *      per-insert-block materialized view cannot do.
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
