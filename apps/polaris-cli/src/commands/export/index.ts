/**
 * `polaris export` command group.
 *
 * Surfaces four commands (all read-only):
 *
 *   - `polaris export sources --project <id> --env <env>`         mutates: false
 *   - `polaris export api-keys --project <id> --env <env>`        mutates: false
 *   - `polaris export destinations --project <id> --env <env>`    mutates: false
 *   - `polaris export audit --since <iso> --until <iso> [--format json|ndjson]`
 *                                                                 mutates: false
 *
 * Hard rules baked into this group:
 *
 *   - API key exports NEVER include the argon2id `hash` column or the on-wire
 *     plaintext token. Only metadata (id, project, env, source, type, status,
 *     timestamps). The hash column is omitted from the SELECT in the
 *     repository helper too — even if the future export pipeline tries to
 *     dump the row, the data is not there.
 *
 *   - Destination exports emit the `secret_ref` literal (e.g.
 *     `env:META_CAPI_TOKEN_STOREFRONT_PROD`). The reference is safe to
 *     print — it names where the secret lives, not what it is. The CLI
 *     never resolves the value at export time.
 *
 *   - Audit exports never include `before` / `after` columns that the
 *     recorder accepted with secret-resolved values. The recorder is the
 *     gate; this group is downstream of it.
 *
 * Anchored to:
 *   - docs/architecture/02-control-plane.md "Secrets", "API Keys", "Sources"
 *   - docs/implementation/tasks/P6-006-audit-export-cli.md
 */
import type { CommandDefinition } from "../../command.js";
import { exportApiKeysCommand } from "./api-keys.js";
import { exportAuditCommand } from "./audit.js";
import { exportDestinationsCommand } from "./destinations.js";
import { exportSourcesCommand } from "./sources.js";

const CHILDREN: readonly CommandDefinition[] = [
  exportSourcesCommand,
  exportApiKeysCommand,
  exportDestinationsCommand,
  exportAuditCommand,
];

export const exportCommand: CommandDefinition = {
  id: "export",
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("export")
      .description(
        "Export runtime/control-plane state as JSON. Never includes plaintext secrets or argon2id hashes.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export {
  exportApiKeysCommand,
  exportAuditCommand,
  exportDestinationsCommand,
  exportSourcesCommand,
};
