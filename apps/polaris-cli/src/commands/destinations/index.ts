/**
 * `polaris destinations` command group.
 *
 * Surfaces nine commands:
 *
 *   - `polaris destinations list`                              mutates: false
 *   - `polaris destinations show <destination_id>`             mutates: false
 *   - `polaris destinations create ...`                        mutates: true
 *   - `polaris destinations enable <destination_id>`           mutates: true
 *   - `polaris destinations disable <destination_id> ...`      mutates: true
 *   - `polaris destinations set-config <destination_id>`       mutates: true
 *   - `polaris destinations update-ops <destination_id>`       mutates: true
 *   - `polaris destinations rotate-secret <destination_id> ...`  mutates: true
 *   - `polaris destinations enable-replay <destination_id> ...`  mutates: true  (P7-004)
 *   - `polaris destinations disable-replay <destination_id> ...` mutates: true  (P7-004)
 *
 * No command in this group PRINTS a destination's credential. `create` and
 * `rotate-secret` accept one; `show`, `list` and the JSON export cannot emit
 * one, because `DestinationRow` does not carry it.
 *
 * Central architectural rule baked into this group:
 *
 *   The CLI MUST NOT define event-to-vendor mapping semantics. Mapping
 *   semantics live in versioned consumer code under
 *   `connectors/destinations/<vendor>/<version>/src/mapper.ts`. Every command in this group runs
 *   `rejectMappingArguments` against the parsed args before any DB work,
 *   so a flag like `--field-map` or `--event-map` is refused with a usage
 *   error and never reaches PostgreSQL.
 *
 * Audit hand-off:
 *
 *   Every mutating subcommand (create, enable, disable, update-ops,
 *   enable-replay, disable-replay) wraps its write + insertAuditRecord in
 *   one Kysely transaction. create stamps a default rationale on the
 *   audit row when `--reason` is omitted; update-ops, disable,
 *   enable-replay, and disable-replay require `--reason`.
 *
 * Replay-guardrail commands (P7-004):
 *
 *   `enable-replay` / `disable-replay` flip the per-instance
 *   `replay_opt_in` column on the destination row. The destination
 *   runtime consults this column on every replayed message; until an
 *   operator flips it on, replay traffic against the destination is
 *   suppressed. The defaults are safe: every destination is opt-out
 *   until an operator explicitly enables replay.
 *
 * @see docs/architecture/06-destinations.md
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/architecture/02-control-plane.md "Destinations"
 * @see docs/implementation/tasks/P6-004-destination-instance-cli.md
 * @see docs/implementation/tasks/P7-004-destination-replay-guardrails.md
 */
import type { CommandDefinition } from "../../command.js";
import { destinationsCreateCommand } from "./create.js";
import { destinationsDisableCommand } from "./disable.js";
import { destinationsDisableReplayCommand } from "./disable-replay.js";
import { destinationsEnableCommand } from "./enable.js";
import { destinationsEnableReplayCommand } from "./enable-replay.js";
import { destinationsListCommand } from "./list.js";
import { destinationsRotateSecretCommand } from "./rotate-secret.js";
import { destinationsSetConfigCommand } from "./set-config.js";
import { destinationsShowCommand } from "./show.js";
import { destinationsUpdateOpsCommand } from "./update-ops.js";

const CHILDREN: readonly CommandDefinition[] = [
  destinationsListCommand,
  destinationsShowCommand,
  destinationsCreateCommand,
  destinationsEnableCommand,
  destinationsDisableCommand,
  destinationsSetConfigCommand,
  destinationsUpdateOpsCommand,
  destinationsRotateSecretCommand,
  destinationsEnableReplayCommand,
  destinationsDisableReplayCommand,
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
        "Manage runtime destination instances. PostgreSQL stores runtime state only; mapping semantics live in versioned consumer code under connectors/destinations/<vendor>/<version>/src/mapper.ts.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  destinationsCreateCommand,
  destinationsDisableCommand,
  destinationsDisableReplayCommand,
  destinationsEnableCommand,
  destinationsEnableReplayCommand,
  destinationsListCommand,
  destinationsRotateSecretCommand,
  destinationsShowCommand,
  destinationsUpdateOpsCommand,
};
