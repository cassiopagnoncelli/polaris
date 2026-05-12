/**
 * `polaris processors runs` subcommand group.
 *
 * Wraps the two run-inspection commands under one parent so the help text
 * lays out as:
 *
 *   polaris processors runs list
 *   polaris processors runs show <run_id>
 *
 * Both are read-only and surface a "processor_runs table not yet
 * provisioned — wired in P8-001" message until the table lands.
 */
import type { CommandDefinition } from "../../command.js";
import { processorsRunsListCommand } from "./runs-list.js";
import { processorsRunsShowCommand } from "./runs-show.js";

const CHILDREN: readonly CommandDefinition[] = [
  processorsRunsListCommand,
  processorsRunsShowCommand,
];

export const processorsRunsCommand: CommandDefinition = {
  id: "processors.runs",
  // Group container has no body. `mutates: false` matches the documented
  // contract that group definitions are read-only; each child declares its
  // own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("runs")
      .description(
        "Inspect processor runs (list, show). Surfaces 'not yet provisioned' until P8-001.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { processorsRunsListCommand, processorsRunsShowCommand };
