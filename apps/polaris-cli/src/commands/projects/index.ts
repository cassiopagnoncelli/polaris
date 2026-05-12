/**
 * `polaris projects` command group.
 *
 * Surfaces three commands:
 *
 *   - `polaris projects list`               read-only
 *   - `polaris projects show <project_id>`  read-only
 *   - `polaris projects sync`               mutates: true
 *
 * The group itself is a `CommandDefinition` so the existing
 * `BUILTIN_COMMANDS` array in `../index.ts` can register it the same way it
 * registers `version`. Internally, the group creates a subcommand and
 * delegates to each child command's `register`.
 */
import type { CommandDefinition } from "../../command.js";
import { projectsListCommand } from "./list.js";
import { projectsShowCommand } from "./show.js";
import { projectsSyncCommand } from "./sync.js";

const CHILDREN: readonly CommandDefinition[] = [
  projectsListCommand,
  projectsShowCommand,
  projectsSyncCommand,
];

export const projectsCommand: CommandDefinition = {
  id: "projects",
  // The group container itself never executes a body. `mutates: false`
  // matches the documented contract that group definitions are read-only;
  // each child declares its own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("projects")
      .description("Inspect and materialize Polaris projects.");
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { projectsListCommand, projectsShowCommand, projectsSyncCommand };
