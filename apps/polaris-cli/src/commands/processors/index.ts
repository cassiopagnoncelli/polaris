/**
 * `polaris processors` command group.
 *
 * Surfaces six commands:
 *
 *   - `polaris processors list`                                       mutates: false
 *   - `polaris processors show <name> --version <v>`                  mutates: false
 *   - `polaris processors runs list`                                  mutates: false
 *   - `polaris processors runs show <run_id>`                         mutates: false
 *   - `polaris processors enable <name> --version <v> --project <id> --env <env>`
 *                                                                     mutates: true
 *   - `polaris processors disable <name> --version <v> --project <id> --env <env>`
 *                                                                     mutates: true
 *
 * Central architectural rule baked into this group:
 *
 *   The CLI MUST NOT define processor transform semantics. Processor
 *   transform rules (inputs, outputs, mode, transform code) live in
 *   versioned code under `processors/<name>/v<n>/`. Every command in this
 *   group runs `rejectProcessorRuleArguments` against the parsed args
 *   before any DB work, so a flag like `--transform`, `--input-topic`,
 *   `--field-map`, or `--routing` is refused with a usage error and never
 *   reaches PostgreSQL.
 *
 * Audit hand-off:
 *
 *   `enable` and `disable` emit a structured audit-intent log line and
 *   write a stderr TODO marker. The `audit_records` table itself lands in
 *   P6-006; this group must be extended to INSERT into that table once
 *   the schema exists. The audit-intent log carries the same canonical
 *   fields the future record will store, so the shim is one line.
 *
 * Processor-runs hand-off:
 *
 *   `processor_runs` is owned by P8-001. Until that lands, `runs list`
 *   and `runs show` surface a structured "not yet provisioned" message
 *   instead of crashing.
 *
 * @see docs/architecture/05-processors-and-replay.md
 * @see docs/architecture/02-control-plane.md "Processors"
 * @see docs/implementation/tasks/P6-005-processor-runtime-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { processorsDisableCommand } from "./disable.js";
import { processorsEnableCommand } from "./enable.js";
import { processorsListCommand } from "./list.js";
import { processorsRunsCommand } from "./runs.js";
import { processorsShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  processorsListCommand,
  processorsShowCommand,
  processorsRunsCommand,
  processorsEnableCommand,
  processorsDisableCommand,
];

export const processorsCommand: CommandDefinition = {
  id: "processors",
  // Group container has no body. `mutates: false` matches the documented
  // contract that group definitions are read-only; each child declares its
  // own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("processors")
      .description(
        "Inspect processor manifests, list runs, and toggle per-(project, env) activations. " +
          "PostgreSQL stores runtime state only; transform semantics live in versioned code " +
          "under processors/<name>/v<n>/.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  processorsDisableCommand,
  processorsEnableCommand,
  processorsListCommand,
  processorsRunsCommand,
  processorsShowCommand,
};
export { processorsRunsListCommand, processorsRunsShowCommand } from "./runs.js";
