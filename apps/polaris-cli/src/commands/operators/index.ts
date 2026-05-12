/**
 * `polaris operators` command group.
 *
 * Surfaces three commands:
 *
 *   - `polaris operators create`  mutates: true
 *   - `polaris operators list`    mutates: false
 *   - `polaris operators revoke`  mutates: true
 *
 * Raw token plaintext is shown ONLY on `create` — never persisted, never
 * logged, never re-emitted by `list` or `revoke`.
 *
 * Hashing uses the platform-standard argon2id primitive from
 * `@polaris/shared-secrets` — the same primitive `keys create` uses, so
 * a token issued by this CLI verifies through the same code path the
 * dispatcher's resolver uses.
 *
 * The token-format primitives (prefix, parser, formatter) and the
 * dispatcher gate live in `@polaris/shared-control-plane` so the future
 * control-plane API can re-use them without a refactor.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 * @see docs/implementation/tasks/P6-007-operator-tokens-and-mutation-gate.md
 */
import type { CommandDefinition } from "../../command.js";
import { operatorsCreateCommand } from "./create.js";
import { operatorsListCommand } from "./list.js";
import { operatorsRevokeCommand } from "./revoke.js";

const CHILDREN: readonly CommandDefinition[] = [
  operatorsCreateCommand,
  operatorsListCommand,
  operatorsRevokeCommand,
];

export const operatorsCommand: CommandDefinition = {
  id: "operators",
  // The group container never executes a body. `mutates: false` matches
  // the documented contract that group definitions are read-only; each
  // child declares its own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("operators")
      .description(
        "Issue, list, and revoke Polaris operator tokens. Raw token plaintext is shown only once at create time.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { operatorsCreateCommand, operatorsListCommand, operatorsRevokeCommand };
