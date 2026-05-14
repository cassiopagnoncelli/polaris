/**
 * `polaris replay` command group.
 *
 * Surfaces six commands:
 *
 *   - `polaris replay list`                              mutates: false
 *   - `polaris replay show <replay_job_id>`              mutates: false
 *   - `polaris replay create ...`                        mutates: true
 *   - `polaris replay cancel <replay_job_id> --reason`   mutates: true
 *   - `polaris replay pause  <replay_job_id> --reason`   mutates: true
 *   - `polaris replay resume <replay_job_id> --reason`   mutates: true
 *
 * Central architectural rule baked into this group:
 *
 *   The CLI MUST NOT define replay PLAN semantics. Plans (partitioning,
 *   chunking, transform overrides, topic routing) live in versioned code
 *   under the planner package shipped by P7-002. Every mutating command
 *   here runs `rejectReplayPlanArguments` against the parsed args before
 *   any DB work, so flags like `--partition-strategy` or `--transform-override`
 *   are refused with a usage error and never reach PostgreSQL.
 *
 * Bounded replay: replay is bounded to the operational retention window
 * (90 days for `raw.events` in v1). `replay create` enforces the bound on
 * `--from` with `replay_window_exceeded`. The migration deliberately does
 * NOT encode the bound (it would couple PostgreSQL to the Redpanda
 * retention config); the CLI is the gate.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { replayCancelCommand } from "./cancel.js";
import { replayCreateCommand } from "./create.js";
import { replayListCommand } from "./list.js";
import { replayPauseCommand } from "./pause.js";
import { replayResumeCommand } from "./resume.js";
import { replayShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  replayListCommand,
  replayShowCommand,
  replayCreateCommand,
  replayCancelCommand,
  replayPauseCommand,
  replayResumeCommand,
];

export const replayCommand: CommandDefinition = {
  id: "replay",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("replay")
      .description(
        "Manage replay jobs. PostgreSQL stores runtime state only; replay plans live in versioned code under the planner package (P7-002).",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  replayCancelCommand,
  replayCreateCommand,
  replayListCommand,
  replayPauseCommand,
  replayResumeCommand,
  replayShowCommand,
};
