/**
 * `polaris traits` — computed-trait definitions and their runs.
 *
 * Definitions live in `definitions/traits/` as code, not as rows: what a trait
 * MEANS is versioned with the repository, the same rule that keeps mapping
 * semantics out of PostgreSQL. This group is how an operator runs them.
 */

import type { CommandDefinition } from "../../command.js";
import { traitsComputeCommand } from "./compute.js";

export const traitsCommand: CommandDefinition = {
  id: "traits",
  // Group container. `mutates: false` on the group; `compute` declares its
  // own `mutates: true`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("traits")
      .description("Compute the trait definitions declared in definitions/traits/.");
    traitsComputeCommand.register(group, deps);
  },
};

export { buildTraitsComputeRunner, traitsComputeCommand } from "./compute.js";
