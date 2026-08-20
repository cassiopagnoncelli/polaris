/**
 * `polaris processors dlq` subcommand group (3L2HKMND).
 *
 * Surfaces:
 *
 *   polaris processors dlq list   --processor <name>      mutates: false
 *   polaris processors dlq show   <dlq_id>                mutates: false
 *   polaris processors dlq retry  <dlq_id> [--dry-run]    mutates: true
 *   polaris processors dlq mark-resolved <dlq_id>         mutates: true
 *
 * Backed by the `processor_dlq_records` table. The processor
 * runtime dual-writes (Kafka topic + Postgres row) so the existing
 * `<processor>.dlq` topic consumers continue to work while
 * operators get a queryable view for triage.
 *
 * @see docs/operations/dlq-triage-runbook.md
 * @see libs/pipeline/src/db/processor-dlq-records.ts
 */

import type { CommandDefinition } from "../../../command.js";
import { processorsDlqListCommand } from "./list.js";
import { processorsDlqMarkResolvedCommand } from "./mark-resolved.js";
import { processorsDlqRetryCommand } from "./retry.js";
import { processorsDlqShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  processorsDlqListCommand,
  processorsDlqShowCommand,
  processorsDlqRetryCommand,
  processorsDlqMarkResolvedCommand,
];

export const processorsDlqCommand: CommandDefinition = {
  id: "processors.dlq",
  // Group container has no body. Each child declares its own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("dlq")
      .description(
        "Inspect the processor DLQ queue (list / show / retry / mark-resolved). Backed by processor_dlq_records.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  processorsDlqListCommand,
  processorsDlqMarkResolvedCommand,
  processorsDlqRetryCommand,
  processorsDlqShowCommand,
};
