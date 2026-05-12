/**
 * `polaris audit` command group.
 *
 * Surfaces two commands:
 *
 *   - `polaris audit list`                    mutates: false
 *   - `polaris audit show <audit_id>`         mutates: false
 *
 * Both are read-only inspections of the `audit_records` table the recorder
 * writes. Bulk export of audit rows lives under `polaris export audit ...`
 * so the export-shaped commands cluster together.
 *
 * Anchored to:
 *   - docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 *   - docs/implementation/tasks/P6-006-audit-export-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { auditListCommand } from "./list.js";
import { auditShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [auditListCommand, auditShowCommand];

export const auditCommand: CommandDefinition = {
  id: "audit",
  // Group container has no body. Children declare their own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("audit")
      .description(
        "Inspect audit records persisted by mutating CLI commands. Read-only; use `polaris export audit` for bulk export.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { auditListCommand, auditShowCommand };
