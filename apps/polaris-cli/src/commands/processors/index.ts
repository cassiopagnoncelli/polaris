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
 *   enable/disable wrap their mutation + insertAuditRecord in one Kysely
 *   transaction (wired in P6-006).
 *
 * Processor runs:
 *
 *   `runs list` / `runs show` read `processor_runs`, which each processor
 *   writes at boot through `@polaris/shared-processor`'s `openProcessorRun`.
 *   Activations say what SHOULD run; runs say what DID.
 *
 * @see docs/architecture/05-processors-and-replay.md
 * @see docs/architecture/02-control-plane.md "Processors"
 * @see docs/implementation/tasks/P6-005-processor-runtime-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { processorsDisableCommand } from "./disable.js";
import { processorsDlqCommand } from "./dlq/index.js";
import { processorsEnableCommand } from "./enable.js";
import { processorsListCommand } from "./list.js";
import { processorsRunsCommand } from "./runs.js";
import { processorsShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  processorsListCommand,
  processorsShowCommand,
  processorsRunsCommand,
  processorsDlqCommand,
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

export { processorsRunsListCommand, processorsRunsShowCommand } from "./runs.js";
export {
  processorsDisableCommand,
  processorsEnableCommand,
  processorsListCommand,
  processorsRunsCommand,
  processorsShowCommand,
};
