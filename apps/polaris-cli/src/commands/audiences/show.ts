/**
 * `polaris audiences show <audience> --project X --env Y` — read-only.
 *
 * The definition and its current membership, side by side. Answering "who
 * is in this audience and why" from the two halves separately means
 * reading a TypeScript file and writing SQL, and the two can disagree —
 * a definition edited but never run looks authoritative and describes
 * nobody.
 *
 * So the output names the definition's version AND the version stamped on
 * the stored rows. When they differ, the audience has been edited since
 * its last run and the membership shown is stale; the command says so
 * rather than leaving an operator to compare two numbers nobody
 * highlighted.
 *
 * `--limit` bounds the member list. A default of 20 keeps the common case
 * — "did this work?" — from paging a million uuids through a terminal;
 * `members` always reports the true total regardless.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import { AUDIENCE_DEFINITIONS, type AudienceDefinition } from "@polaris/audience-catalog";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  connectDb,
  countOpenAudienceMemberships,
  listOpenAudienceMemberships,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

/** Default and maximum size of the printed member list. */
export const AUDIENCE_SHOW_DEFAULT_LIMIT = 20;
export const AUDIENCE_SHOW_MAX_LIMIT = 1000;

export interface AudiencesShowArgs {
  readonly audience: string;
  readonly project?: string;
  readonly env?: string;
  readonly limit?: number;
}

export interface AudiencesShowMember {
  readonly profileId: string;
  readonly enteredAt: Date;
  readonly audienceVersion: number;
}

export interface AudiencesShowStore {
  count(): Promise<number>;
  members(limit: number): Promise<readonly AudiencesShowMember[]>;
  close(): Promise<void>;
}

export interface AudiencesShowHooks {
  readonly openStore?: (
    ctx: CommandContext,
    scope: { projectId: string; environment: string; audience: string },
  ) => AudiencesShowStore;
}

export function buildAudiencesShowRunner(hooks: AudiencesShowHooks = {}) {
  return async function runner(args: AudiencesShowArgs, ctx: CommandContext): Promise<undefined> {
    const key = args.audience.trim();
    const projectId = args.project?.trim();
    const environment = args.env?.trim();
    if (projectId === undefined || projectId.length === 0) {
      throw new UsageError("--project is required");
    }
    if (environment === undefined || environment.length === 0) {
      throw new UsageError("--env is required");
    }

    const definition = AUDIENCE_DEFINITIONS.find((d) => d.key === key);
    if (definition === undefined) {
      throw new UsageError(
        `unknown audience "${key}". Defined: ${AUDIENCE_DEFINITIONS.map((d) => d.key).join(", ")}`,
      );
    }

    const limit = args.limit ?? AUDIENCE_SHOW_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new UsageError("--limit must be a positive integer");
    }
    if (limit > AUDIENCE_SHOW_MAX_LIMIT) {
      throw new UsageError(`--limit cannot exceed ${String(AUDIENCE_SHOW_MAX_LIMIT)}`);
    }

    const openStore = hooks.openStore ?? defaultStore;
    const store = openStore(ctx, { projectId, environment, audience: key });

    let members: readonly AudiencesShowMember[];
    let total: number;
    try {
      total = await store.count();
      members = await store.members(limit);
    } finally {
      await store.close();
    }

    // Stale means: rows exist that a previous definition version produced.
    // An empty audience cannot be stale — there is nothing to disagree.
    const staleVersions = [
      ...new Set(
        members
          .filter((m) => m.audienceVersion !== definition.version)
          .map((m) => m.audienceVersion),
      ),
    ].sort((a, b) => a - b);

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human: renderHuman({ definition, projectId, environment, total, members, staleVersions }),
        json: {
          audience: definition.key,
          version: definition.version,
          description: definition.description,
          source: definition.source,
          project_id: projectId,
          environment,
          members: total,
          stale_versions: staleVersions,
          shown: members.map((m) => ({
            profile_id: m.profileId,
            entered_at: m.enteredAt.toISOString(),
            audience_version: m.audienceVersion,
          })),
        },
      }),
    );
    return undefined;
  };
}

const runAudiencesShow = buildAudiencesShowRunner();

function renderHuman(input: {
  definition: AudienceDefinition;
  projectId: string;
  environment: string;
  total: number;
  members: readonly AudiencesShowMember[];
  staleVersions: readonly number[];
}): string {
  const lines: string[] = [];
  lines.push(`audience ${input.definition.key} v${String(input.definition.version)}`);
  lines.push(`  ${input.definition.description}`);
  lines.push(`  source       ${input.definition.source}`);
  lines.push(`  scope        ${input.projectId}/${input.environment}`);
  lines.push(`  members      ${String(input.total)}`);
  if (input.staleVersions.length > 0) {
    lines.push(
      `  STALE: rows still stamped v${input.staleVersions.join(", v")} — the definition has ` +
        "been edited since the last run. Run `polaris audiences compute` to re-derive.",
    );
  }
  lines.push("");
  if (input.members.length === 0) {
    lines.push("  (no current members)");
  } else {
    for (const member of input.members) {
      lines.push(
        `  ${member.profileId}  entered=${member.enteredAt.toISOString()}  v${String(member.audienceVersion)}`,
      );
    }
    if (input.total > input.members.length) {
      lines.push(`  … ${String(input.total - input.members.length)} more`);
    }
  }
  return lines.join("\n");
}

function defaultStore(
  ctx: CommandContext,
  scope: { projectId: string; environment: string; audience: string },
): AudiencesShowStore {
  const handle = connectDb({ env: ctx.env });
  return {
    count: () => countOpenAudienceMemberships(handle.db, scope),
    members: async (limit) => {
      const rows = await listOpenAudienceMemberships(handle.db, scope, limit);
      return rows.map((row) => ({
        profileId: row.profileId,
        enteredAt: row.enteredAt,
        audienceVersion: row.audienceVersion,
      }));
    },
    close: () => handle.close(),
  };
}

export const audiencesShowCommand: CommandDefinition = {
  id: "audiences.show",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("show <audience>")
      .description("Show an audience definition and its current membership")
      .requiredOption("--project <id>")
      .requiredOption("--env <environment>")
      .option("--limit <n>", "max members to list", (raw: string) => Number.parseInt(raw, 10))
      .action(
        async (
          audience: string,
          opts: { project?: string; env?: string; limit?: number },
          command: Command,
        ) => {
          const wrapped = deps.runCommand<AudiencesShowArgs>(
            { id: "audiences.show", mutates: false },
            runAudiencesShow,
          );
          await wrapped(
            {
              audience,
              ...(opts.project !== undefined ? { project: opts.project } : {}),
              ...(opts.env !== undefined ? { env: opts.env } : {}),
              ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            },
            command,
          );
        },
      );
  },
};
