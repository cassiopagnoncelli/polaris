/**
 * `polaris events` command group (V3L2TLWC).
 *
 * The read-side answer to "where is my event", in two verbs:
 *
 *   - `polaris events trace <event_id>`   mutates: false
 *   - `polaris events tail`               mutates: false
 *
 * Both are pure reads and neither adds storage. `trace` joins four stores
 * that already hold the answer; `tail` attaches a checkpoint-free reader
 * to a live family. There is deliberately no mutating verb here — an
 * event is an immutable fact, and the operator actions that change state
 * live under `polaris dlq` and `polaris replay`.
 *
 * @see docs/implementation/pipeline-redesign-plan.md §5.1
 */
import type { CommandDefinition } from "../../command.js";
import { eventsTailCommand } from "./tail.js";
import { eventsTraceCommand } from "./trace.js";

const CHILDREN: readonly CommandDefinition[] = [eventsTraceCommand, eventsTailCommand];

export const eventsCommand: CommandDefinition = {
  id: "events",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("events")
      .description(
        "Inspect individual events: join their lineage across stores, or watch a family live.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { eventsTailCommand, eventsTraceCommand };
