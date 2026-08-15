/**
 * Command registry for the `polaris` CLI shell.
 *
 * This file is the central seam where future task cards plug their command
 * trees in:
 *
 *   - P6-002 adds `projects` and `sources` groups
 *   - P6-003 adds `keys` lifecycle commands
 *   - P6-004 adds `destinations` commands
 *   - P6-005 adds `processors` commands
 *   - P6-006 adds `audit` and `export` commands
 *   - P6-007 adds `operators` commands
 *   - P7-001 adds `replays` commands
 *
 * Each future task only needs to import its own `CommandDefinition`s and add
 * them to `BUILTIN_COMMANDS` (or extend the list at registration time). The
 * dispatcher in `program.ts` and the version command in `version.ts` are the
 * shell's only built-ins for P6-001.
 */
import type { CommandDefinition } from "../command.js";
import { auditCommand } from "./audit/index.js";
import { clickhouseRebuildCommand } from "./clickhouse-rebuild/index.js";
import { configCommand } from "./config/index.js";
import { deliveriesCommand } from "./deliveries/index.js";
import { destinationsCommand } from "./destinations/index.js";
import { dlqCommand } from "./dlq/index.js";
import { exportCommand } from "./export/index.js";
import { keysCommand } from "./keys/index.js";
import { operatorsCommand } from "./operators/index.js";
import { processorsCommand } from "./processors/index.js";
import { profilesCommand } from "./profiles/index.js";
import { projectsCommand } from "./projects/index.js";
import { replayCommand } from "./replay/index.js";
import { sourcesCommand } from "./sources/index.js";
import { topicsCommand } from "./topics/index.js";
import { traitsCommand } from "./traits/index.js";
import { versionCommand } from "./version.js";
import { violationsCommand } from "./violations/index.js";

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  versionCommand,
  projectsCommand,
  sourcesCommand,
  keysCommand,
  destinationsCommand,
  processorsCommand,
  profilesCommand,
  traitsCommand,
  violationsCommand,
  configCommand,
  operatorsCommand,
  auditCommand,
  exportCommand,
  replayCommand,
  deliveriesCommand,
  dlqCommand,
  topicsCommand,
  clickhouseRebuildCommand,
];

export {
  auditCommand,
  clickhouseRebuildCommand,
  configCommand,
  deliveriesCommand,
  destinationsCommand,
  dlqCommand,
  exportCommand,
  keysCommand,
  operatorsCommand,
  processorsCommand,
  profilesCommand,
  projectsCommand,
  replayCommand,
  sourcesCommand,
  topicsCommand,
  traitsCommand,
  versionCommand,
  violationsCommand,
};
