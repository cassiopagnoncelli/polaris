/**
 * `polaris deliveries` command group (P9-007).
 *
 * Read-only inspection of `delivery_records`:
 *
 *   - `polaris deliveries list <destination_id>`   mutates: false
 *   - `polaris deliveries show <delivery_id>`      mutates: false
 *
 * Mutating commands intentionally do not live in this group — a delivery
 * record is an immutable per-attempt log line. Operator actions that
 * change state (retry, mark-resolved) live under `polaris dlq` against
 * the `dlq_records` table.
 *
 * Secrets are never displayed: the schema does not carry any resolved
 * secret value, only the destination's `secret_ref`. Vendor response
 * bodies are absent by design.
 *
 * @see docs/architecture/06-destinations.md "Delivery Model"
 * @see docs/implementation/tasks/P9-007-destination-dlq-triage.md
 */
import type { CommandDefinition } from "../../command.js";
import { deliveriesListCommand } from "./list.js";
import { deliveriesShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [deliveriesListCommand, deliveriesShowCommand];

export const deliveriesCommand: CommandDefinition = {
  id: "deliveries",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("deliveries")
      .description(
        "Inspect destination delivery records. The table is an immutable per-attempt log; operator actions that change state live under `polaris dlq`.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { deliveriesListCommand, deliveriesShowCommand };
