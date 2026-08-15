/**
 * `polaris violations` — the schema-governance quarantine.
 *
 * Read-only. Rejections are written by the ingester and expire on the
 * table's TTL; there is no verb here to delete or amend one, deliberately.
 * A quarantine an operator can edit is a quarantine whose counts nobody
 * can trust, and the whole point of the table is that its counts answer
 * "is this getting worse?".
 */

import type { CommandDefinition } from "../../command.js";
import { violationsListCommand } from "./list.js";

export const violationsCommand: CommandDefinition = {
  id: "violations",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("violations")
      .description("Inspect quarantined ingest rejections (schema governance).");
    violationsListCommand.register(group, deps);
  },
};

export { buildViolationsListRunner, violationsListCommand } from "./list.js";
