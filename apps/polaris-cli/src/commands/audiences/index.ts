/**
 * `polaris audiences` — audience definitions and their membership.
 *
 * Definitions live in `catalog/audiences/` as code, not as rows: what an
 * audience MEANS is versioned with the repository, the same rule that
 * keeps trait semantics and mapping semantics out of PostgreSQL. Only
 * membership — which profile is in it right now — is runtime state.
 */

import type { CommandDefinition } from "../../command.js";
import { audiencesComputeCommand } from "./compute.js";
import { audiencesShowCommand } from "./show.js";

export const audiencesCommand: CommandDefinition = {
  id: "audiences",
  // Group container. `mutates: false` on the group; `compute` declares its
  // own `mutates: true`, `show` is read-only.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("audiences")
      .description("Evaluate and inspect the audiences declared in catalog/audiences/.");
    audiencesComputeCommand.register(group, deps);
    audiencesShowCommand.register(group, deps);
  },
};

export { audiencesComputeCommand, buildAudiencesComputeRunner } from "./compute.js";
export { audiencesShowCommand, buildAudiencesShowRunner } from "./show.js";
