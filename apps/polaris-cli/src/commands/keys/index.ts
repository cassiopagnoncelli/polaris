/**
 * `polaris keys` command group.
 *
 * Surfaces four commands:
 *
 *   - `polaris keys create`  mutates: true
 *   - `polaris keys list`    mutates: false
 *   - `polaris keys revoke`  mutates: true
 *   - `polaris keys rotate`  mutates: true
 *
 * Raw key plaintext is shown ONLY on `create` and `rotate` — never persisted,
 * never logged, never re-emitted by `list`. `mutates: true` on the writer
 * commands so the dispatcher gate from P6-007 plugs in cleanly.
 *
 * Hashing uses the platform-standard argon2id primitive from
 * `@polaris/shared-secrets`. The same primitive runs in the ingester
 * (`apps/ingester-api/src/auth/hash.ts`), so a key issued by this CLI
 * verifies on the next ingester request.
 *
 * @see docs/architecture/02-control-plane.md "API Keys"
 * @see docs/implementation/tasks/P6-003-api-key-lifecycle-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { keysCreateCommand } from "./create.js";
import { keysListCommand } from "./list.js";
import { keysRevokeCommand } from "./revoke.js";
import { keysRotateCommand } from "./rotate.js";

const CHILDREN: readonly CommandDefinition[] = [
  keysCreateCommand,
  keysListCommand,
  keysRevokeCommand,
  keysRotateCommand,
];

export const keysCommand: CommandDefinition = {
  id: "keys",
  // The group container never executes a body. `mutates: false` matches the
  // documented contract that group definitions are read-only; each child
  // declares its own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("keys")
      .description(
        "Issue, list, revoke, and rotate Polaris API keys. Raw key plaintext is shown only once at create/rotate time.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { keysCreateCommand, keysListCommand, keysRevokeCommand, keysRotateCommand };
