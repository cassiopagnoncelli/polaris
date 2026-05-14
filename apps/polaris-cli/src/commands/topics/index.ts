/**
 * `polaris topics` command group.
 *
 * Surfaces three commands:
 *
 *   - `polaris topics list [--project <id>] [--env <env>]`    mutates: false
 *   - `polaris topics isolate ...`                            mutates: true
 *   - `polaris topics deisolate ...`                          mutates: true
 *
 * Central architectural rule baked into this group:
 *
 *   The CLI is the ONE surface that activates / deactivates a project's
 *   topic isolation. Both mutating commands wrap the `topic_isolations`
 *   write and the matching `audit_records` row in the SAME Kysely
 *   transaction so isolation state and audit trail are always
 *   consistent. The P6-007 production-mutation gate sees `mutates: true`
 *   and refuses the run when `POLARIS_ENV=production` and the actor
 *   source is `'declared'`.
 *
 * Cutover hand-off:
 *
 *   `polaris topics isolate` does NOT auto-cut producers and consumers
 *   over to the dedicated topic. The runtime resolver in
 *   `@polaris/shared-kafka` reads the active row through a TTL-bounded
 *   cache, so the cutover becomes live within one TTL window across
 *   all services that wired the cache in. The
 *   `docs/operations/topic-isolation-cutover.md` runbook walks
 *   operators through the producer-first / consumer-second sequence.
 *
 * @see docs/architecture/03-redpanda-topics.md "Topic Isolation Triggers"
 * @see docs/architecture/03-redpanda-topics.md "Topic Families"
 * @see docs/operations/topic-isolation-cutover.md
 * @see docs/implementation/tasks/P11-008-topic-isolation.md
 */
import type { CommandDefinition } from "../../command.js";
import { topicsDeisolateCommand } from "./deisolate.js";
import { topicsIsolateCommand } from "./isolate.js";
import { topicsListCommand } from "./list.js";

const CHILDREN: readonly CommandDefinition[] = [
  topicsListCommand,
  topicsIsolateCommand,
  topicsDeisolateCommand,
];

export const topicsCommand: CommandDefinition = {
  id: "topics",
  // Group container has no body. `mutates: false` matches the documented
  // contract that group definitions are read-only; each child declares
  // its own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("topics")
      .description(
        "Manage Redpanda topic isolation. PostgreSQL stores runtime state only; canonical topic families live in @polaris/shared-kafka.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { topicsDeisolateCommand, topicsIsolateCommand, topicsListCommand };
