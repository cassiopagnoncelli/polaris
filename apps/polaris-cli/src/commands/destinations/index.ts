/**
 * `polaris destinations` command group.
 *
 * Surfaces six commands:
 *
 *   - `polaris destinations list`                          mutates: false
 *   - `polaris destinations show <destination_id>`         mutates: false
 *   - `polaris destinations create ...`                    mutates: true
 *   - `polaris destinations enable <destination_id>`       mutates: true
 *   - `polaris destinations disable <destination_id> ...`  mutates: true
 *   - `polaris destinations update-ops <destination_id>`   mutates: true
 *
 * Central architectural rule baked into this group:
 *
 *   The CLI MUST NOT define event-to-vendor mapping semantics. Mapping
 *   semantics live in versioned consumer code under
 *   `consumers/<vendor>/v<n>/mappers/`. Every command in this group runs
 *   `rejectMappingArguments` against the parsed args before any DB work,
 *   so a flag like `--field-map` or `--event-map` is refused with a usage
 *   error and never reaches PostgreSQL.
 *
 * Audit hand-off:
 *
 *   enable and disable wrap their UPDATE + insertAuditRecord in one Kysely
 *   transaction (wired in P6-006). create and update-ops are mutating but
 *   are not yet recorder-instrumented.
 *
 * @see docs/architecture/06-destinations.md
 * @see docs/architecture/02-control-plane.md "Destinations"
 * @see docs/implementation/tasks/P6-004-destination-instance-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { destinationsCreateCommand } from "./create.js";
import { destinationsDisableCommand } from "./disable.js";
import { destinationsEnableCommand } from "./enable.js";
import { destinationsListCommand } from "./list.js";
import { destinationsShowCommand } from "./show.js";
import { destinationsUpdateOpsCommand } from "./update-ops.js";

const CHILDREN: readonly CommandDefinition[] = [
  destinationsListCommand,
  destinationsShowCommand,
  destinationsCreateCommand,
  destinationsEnableCommand,
  destinationsDisableCommand,
  destinationsUpdateOpsCommand,
];

export const destinationsCommand: CommandDefinition = {
  id: "destinations",
  // Group container has no body. `mutates: false` matches the documented
  // contract that group definitions are read-only; each child declares its
  // own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("destinations")
      .description(
        "Manage runtime destination instances. PostgreSQL stores runtime state only; mapping semantics live in versioned consumer code under consumers/<vendor>/v<n>/mappers/.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  destinationsCreateCommand,
  destinationsDisableCommand,
  destinationsEnableCommand,
  destinationsListCommand,
  destinationsShowCommand,
  destinationsUpdateOpsCommand,
};
