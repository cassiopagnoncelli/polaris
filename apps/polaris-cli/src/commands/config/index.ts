/**
 * `polaris config` command group.
 *
 *   - `polaris config list ...`        mutates: false
 *   - `polaris config get ...`         mutates: false
 *   - `polaris config set ...`         mutates: true
 *   - `polaris config unset ...`       mutates: true
 *   - `polaris config invalidate ...`  mutates: true
 *
 * Two rules baked into this group:
 *
 *   1. **The CLI holds no SQL.** Every mutation delegates to a `*WithAudit`
 *      function in `@polaris/persistence-control-plane`, which owns the single
 *      transaction carrying the value write, the version bump, the
 *      `pg_notify`, and the audit row. The admin UI will call the same
 *      functions; two surfaces that could disagree means one is wrong.
 *   2. **Configuration is values, never semantics.** A key resembling a field
 *      map is refused before any write. `project_config.value` is jsonb, so
 *      this check is what carries a guarantee the schema used to carry on its
 *      own.
 *
 * `polaris config validate` is deliberately absent until component schemas are
 * generated (C3) — completeness cannot be judged without knowing what each
 * component declares.
 *
 * @see docs/implementation/project-config-plan.md
 */

import type { CommandDefinition } from "../../command.js";
import { configGetCommand } from "./get.js";
import { configInvalidateCommand } from "./invalidate.js";
import { configListCommand } from "./list.js";
import { configSetCommand } from "./set.js";
import { configUnsetCommand } from "./unset.js";
import { configValidateCommand } from "./validate.js";

const CHILDREN: readonly CommandDefinition[] = [
  configValidateCommand,
  configListCommand,
  configGetCommand,
  configSetCommand,
  configUnsetCommand,
  configInvalidateCommand,
];

export const configCommand: CommandDefinition = {
  id: "config",
  // Group container has no body; each child declares its own `mutates`.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("config")
      .description(
        "Manage per-(project, environment) configuration values. Values only — component schemas live in code.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { buildConfigGetRunner } from "./get.js";
export { buildConfigInvalidateRunner } from "./invalidate.js";
export { buildConfigListRunner } from "./list.js";
export { buildConfigSetRunner } from "./set.js";
export type { ConfigAuditPayload, ConfigHooks, ConfigScope, ConfigStore } from "./store.js";
export { buildConfigUnsetRunner } from "./unset.js";
export {
  buildConfigValidateRunner,
  configValidateCommand,
  type MissingKey,
  type UnknownKey,
  validateProject,
} from "./validate.js";
export {
  configGetCommand,
  configInvalidateCommand,
  configListCommand,
  configSetCommand,
  configUnsetCommand,
};
