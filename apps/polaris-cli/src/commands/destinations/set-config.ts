/**
 * `polaris destinations set-config <destination_id> --config <json> --reason <why>`
 *
 * The write path for `destinations.config`, the per-instance half of the
 * configuration precedence chain:
 *
 *   schema defaults -> project_config[namespace] -> destinations.config
 *
 * Until this command the column had no write path at all. It existed, the
 * destination runtime read it for the routing gate, and the only way to set
 * it was direct SQL against production — which meant no audit row, no
 * validation, and no mapping guard. `project_config` has been guarded at its
 * write path since it shipped, so an unguarded `destinations.config` was the
 * last place in the system where a field map could be stored.
 *
 * ## Whole-bag replacement
 *
 * `--config` takes the complete bag, not a patch. A merge would make removing
 * a key impossible through this path, and the routing gate reads the bag as a
 * unit anyway — half a config is not a smaller config, it is a different one.
 * `--config '{}'` is how an instance goes back to inheriting the project's
 * settings.
 *
 * ## What this refuses
 *
 * Mapping semantics, by key name, before any database access. Configuration
 * decides WHETHER an event reaches a vendor and with which parameters; what
 * the event LOOKS LIKE on arrival is versioned mapper code, and a jsonb bag
 * that could express it would put vendor semantics in a database row.
 *
 * A malformed `routing` value, for the same reason `polaris config set` does:
 * the gate degrades to "unconfigured" on a value it cannot parse, which is
 * right at delivery time — a typo must not mute a destination — but it makes
 * the typo invisible at write time. The operator sets it, believes the gate
 * is on, and every event keeps flowing.
 *
 * @see packages/shared-control-plane-db/src/mutations/destinations.ts
 * @see docs/implementation/project-config-plan.md §3.3
 */

import { assertNoMappingSemantics } from "@polaris/shared-control-plane";
import { parseRoutingGateConfig, ROUTING_GATE_CONFIG_KEY } from "@polaris/shared-destinations";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  type DestinationRow,
  findDestinationById,
  updateDestinationConfigWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { DestinationAuditSnapshot } from "./enable.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsSetConfigArgs {
  readonly destinationId: string;
  readonly config: string;
  readonly reason?: string;
}

export interface DestinationsSetConfigStore {
  findById(id: string): Promise<DestinationRow | null>;
  setConfigWithAudit(
    id: string,
    config: Readonly<Record<string, unknown>>,
    now: Date,
    audit: {
      readonly auditId: string;
      readonly actorSource: AuditActorSource;
      readonly actorLabel: string;
      readonly reason: string;
      readonly before: DestinationAuditSnapshot;
      readonly after: DestinationAuditSnapshot;
      readonly projectId: string;
      readonly environment: AuditEnvironment;
    },
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsSetConfigHooks {
  readonly openStore?: () => DestinationsSetConfigStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export function buildDestinationsSetConfigRunner(hooks: DestinationsSetConfigHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);

  return async function runner(
    args: DestinationsSetConfigArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    // Same defense-in-depth as `update-ops`: the dispatcher checks the raw
    // commander opts, this checks the typed args, so a programmatic caller
    // gets the same refusal.
    rejectMappingArguments(args as unknown as Record<string, unknown>);

    const id = args.destinationId.trim();
    if (id.length === 0) throw new UsageError("destination_id is required");

    const reason = args.reason?.trim();
    if (reason === undefined || reason.length === 0) {
      throw new UsageError("--reason is required for audit traceability");
    }
    if (reason.length > 1024) {
      throw new UsageError("--reason must be 1024 characters or fewer");
    }

    const config = parseConfigBag(args.config);
    // Over the BAG's keys, not just the argument names. `rejectMappingArguments`
    // above sees `destinationId` / `config` / `reason` and would wave through a
    // `field_map` nested inside the JSON — the whole surface this command opens.
    // `updateDestinationConfigWithAudit` guards it again at the write path;
    // this one fires before a database connection is even opened, and is what
    // makes the refusal the CLI's own guarantee rather than a side effect of
    // which store it happens to be talking to.
    assertNoMappingSemantics(Object.keys(config), "destination configuration");
    validateKnownKeys(config);

    const store = hooks.openStore?.() ?? defaultStore(ctx.env);
    try {
      const existing = await store.findById(id);
      if (existing === null) throw new UsageError(`destination "${id}" not found`);

      const now = nowFn();
      const before = toSnapshot(existing);
      const applied = await store.setConfigWithAudit(id, config, now, {
        auditId: generateAuditId(),
        actorSource: ctx.actor.source,
        actorLabel: hooks.actorLabel?.() ?? ctx.actor.label,
        reason,
        before,
        after: before,
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
      });

      const keys = Object.keys(config).sort();
      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human:
            keys.length === 0
              ? `destination ${id}: configuration cleared; the instance now inherits the project's settings`
              : `destination ${id}: configuration replaced (${keys.join(", ")})`,
          // Keys, never values. The bag holds no credentials by contract, but
          // a routing filter can name a property whose presence is itself a
          // hint, and command output lands in shell history and CI logs.
          json: { destination_id: id, applied, keys },
        }),
      );
      return undefined;
    } finally {
      await store.close();
    }
  };
}

/** Parse `--config`. A bag, never an array or a scalar. */
function parseConfigBag(raw: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--config must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--config must be a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * Validate the keys this build knows how to interpret.
 *
 * Unknown keys pass. The bag is read in strip mode by design — a project may
 * carry a key a newer consumer will read — and refusing them here would make
 * the CLI the reason a rollout has to happen in a particular order.
 */
function validateKnownKeys(config: Readonly<Record<string, unknown>>): void {
  const routing = config[ROUTING_GATE_CONFIG_KEY];
  if (routing !== undefined && parseRoutingGateConfig(routing) === undefined) {
    throw new UsageError(
      `"${ROUTING_GATE_CONFIG_KEY}" is not a valid routing gate configuration. ` +
        "The gate would ignore it and every event would keep flowing, which is " +
        "why this is refused here rather than at delivery time.",
    );
  }
}

function defaultStore(env: NodeJS.ProcessEnv): DestinationsSetConfigStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    setConfigWithAudit: async (id, config, now, audit) => {
      const row = await findDestinationById(handle.db, id);
      if (row === null) return false;
      const outcome = await updateDestinationConfigWithAudit(
        handle.db,
        { row, config },
        {
          auditId: audit.auditId,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          reason: audit.reason,
          occurredAt: now,
          before: audit.before,
          after: audit.after,
        },
      );
      return outcome.applied;
    },
    close: () => handle.close(),
  };
}

function toSnapshot(row: DestinationRow): DestinationAuditSnapshot {
  return {
    destination_id: row.destination_id,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    instance_label: row.instance_label,
    status: row.status,
    mode: row.mode,
  } as DestinationAuditSnapshot;
}

export const destinationsSetConfigCommand: CommandDefinition = {
  id: "destinations.set-config",
  mutates: true,
  register: (program, deps) => {
    program
      .command("set-config")
      .description("Replace a destination instance's configuration bag")
      .argument("<destination_id>")
      .requiredOption("--config <json>", "the complete configuration bag, as JSON")
      .requiredOption("--reason <text>", "why this change is being made (audited)")
      .action(
        async (
          destinationId: string,
          opts: { config: string; reason?: string },
          command: Command,
        ) => {
          const wrapped = deps.runCommand<DestinationsSetConfigArgs>(
            { id: "destinations.set-config", mutates: true },
            buildDestinationsSetConfigRunner(),
          );
          rejectMappingArguments({ ...opts });
          await wrapped(
            {
              destinationId,
              config: opts.config,
              ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
            },
            command,
          );
        },
      );
  },
};
