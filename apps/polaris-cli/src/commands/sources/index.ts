/**
 * `polaris sources` command group.
 *
 *   - `polaris sources list [--project <id>]`  read-only
 *   - `polaris sources show <source_id>`        read-only
 *   - `polaris sources sync [--dry-run]`        mutates: true
 */
import type { CommandDefinition } from "../../command.js";
import { sourcesListCommand } from "./list.js";
import { sourcesShowCommand } from "./show.js";
import { sourcesSyncCommand } from "./sync.js";

const CHILDREN: readonly CommandDefinition[] = [
  sourcesListCommand,
  sourcesShowCommand,
  sourcesSyncCommand,
];

export const sourcesCommand: CommandDefinition = {
  id: "sources",
  mutates: false,
  register: (parent, deps) => {
    const group = parent.command("sources").description("Inspect and materialize Polaris sources.");
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { sourcesListCommand, sourcesShowCommand, sourcesSyncCommand };
