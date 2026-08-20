/**
 * `polaris reverse-etl` — warehouse rows back into the platform.
 *
 * Runs only. Jobs are code in `definitions/reverse-etl/`, so there is no
 * create or edit verb here: what a job MEANS is versioned with the
 * repository, the same rule that keeps trait and audience definitions out
 * of PostgreSQL.
 */

import type { CommandDefinition } from "../../command.js";
import { reverseEtlRunCommand } from "./run.js";

export const reverseEtlCommand: CommandDefinition = {
  id: "reverse-etl",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("reverse-etl")
      .description("Run the reverse-ETL jobs declared in definitions/reverse-etl/.");
    reverseEtlRunCommand.register(group, deps);
  },
};

export { buildReverseEtlRunRunner, reverseEtlRunCommand } from "./run.js";
