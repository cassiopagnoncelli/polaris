/**
 * `polaris dlq` command group (P9-007).
 *
 * Operator triage surface for destination DLQ records:
 *
 *   - `polaris dlq list`                   mutates: false  — by destination or vendor
 *   - `polaris dlq show <dlq_id>`          mutates: false
 *   - `polaris dlq retry <dlq_id>`         mutates: true   — republish + mark resolved
 *   - `polaris dlq mark-resolved <dlq_id>` mutates: true
 *
 * Hard architectural rules:
 *
 *   - Secrets never appear in DLQ output. The schema does not store
 *     resolved secret values; only the destination's `secret_ref`.
 *     The `payload` column carries the original Kafka message bytes,
 *     which is the canonical Polaris envelope (no plaintext credential).
 *
 *   - Mutating commands (`retry`, `mark-resolved`) wrap the write + the
 *     `audit_records` insert in one Kysely transaction. Audit rows
 *     stamp `actor_source`, `actor_label`, action = `dlq.retry` /
 *     `dlq.mark-resolved`, target_type = `dlq_record`, target_id =
 *     `<dlq_id>`, plus before/after snapshots that exclude the bytes
 *     payload (to keep the audit row small and side-effect-free).
 *
 * @see docs/architecture/06-destinations.md "Retry and DLQ Policy"
 * @see docs/implementation/tasks/P9-007-destination-dlq-triage.md
 */
import type { CommandDefinition } from "../../command.js";
import { dlqListCommand } from "./list.js";
import { dlqMarkResolvedCommand } from "./mark-resolved.js";
import { dlqRetryCommand } from "./retry.js";
import { dlqShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  dlqListCommand,
  dlqShowCommand,
  dlqRetryCommand,
  dlqMarkResolvedCommand,
];

export const dlqCommand: CommandDefinition = {
  id: "dlq",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("dlq")
      .description(
        "Triage destination dead-letter queue entries. Inspect, retry, or mark resolved. Mutating subcommands write audit_records and respect the production gate.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { dlqListCommand, dlqMarkResolvedCommand, dlqRetryCommand, dlqShowCommand };
