/**
 * `polaris journeys` — the journey graphs and their participants.
 *
 * Definitions live in `definitions/journeys/` as code: what a journey MEANS is
 * versioned with the repository, the same rule that keeps trait, audience
 * and mapping semantics out of PostgreSQL. Only participation — where a
 * profile is in the graph right now — is runtime state.
 */

import type { CommandDefinition } from "../../command.js";
import { journeysSweepCommand } from "./sweep.js";

export const journeysCommand: CommandDefinition = {
  id: "journeys",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("journeys")
      .description("Operate the journeys declared in definitions/journeys/.");
    journeysSweepCommand.register(group, deps);
  },
};

export {
  buildJourneysSweepRunner,
  type JourneysSweepSummary,
  journeysSweepCommand,
} from "./sweep.js";
