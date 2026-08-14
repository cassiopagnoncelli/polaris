/**
 * `polaris profiles show <identifier|profile_id>` — read-only.
 *
 * The first operator surface onto the profile plane. Answers the question
 * a support ticket actually asks: "this customer says their data is
 * wrong — who does Polaris think they are?"
 *
 * ## Resolving the argument
 *
 * An operator pasting a value out of a ticket knows the value, not the
 * platform's name for it, and often not whether it is a profile id at
 * all. So the argument is resolved in this order:
 *
 *   1. if it parses as a UUID, try `profiles.profile_id` — an exact hit
 *      is unambiguous and needs no scope;
 *   2. otherwise (or on a miss) look it up as an identifier VALUE within
 *      `--project` / `--env`, across every kind.
 *
 * Step 2 can match more than one row: the same string may be bound as
 * both a `customer_id` and an `anonymous_id`, and those may be different
 * people. The command REFUSES rather than picking one, and prints both
 * so the operator can re-run with `--kind`. Silently choosing would be
 * the kind of helpfulness that ends in someone reading the wrong
 * person's traits.
 *
 * ## Merge lineage
 *
 * A profile id an operator holds is often a LOSER's — it was stamped
 * into ClickHouse before the merge that absorbed it. Showing merge
 * lineage from both sides is what makes that id explainable instead of
 * looking like a dead end.
 *
 * `mutates: false`: this group has no write path at all. The profile
 * store's only sync-path writer is the identity stage, and
 * `polaris profiles rebuild` lands with R4 as an audited mutation.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  connectDb,
  findProfileById,
  findProfilesByIdentifierValue,
  listProfileIdentifiers,
  listProfileMerges,
  type ProfileIdentifierRow,
  type ProfileMergeRow,
  type ProfileRow,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ProfilesShowArgs {
  readonly target: string;
  readonly project?: string | undefined;
  readonly environment?: string | undefined;
  readonly kind?: string | undefined;
}

/** What the command renders: the profile plus everything hanging off it. */
export interface ProfileDetail {
  readonly profile: ProfileRow;
  readonly identifiers: readonly ProfileIdentifierRow[];
  readonly merges: readonly ProfileMergeRow[];
}

/** Storage seam. Tests inject an in-memory store; production is Kysely. */
export interface ProfilesShowStore {
  byId(profileId: string): Promise<ProfileRow | null>;
  byIdentifierValue(scope: {
    project_id: string;
    environment: string;
    value: string;
  }): Promise<readonly { kind: string; profile: ProfileRow }[]>;
  identifiers(profileId: string): Promise<readonly ProfileIdentifierRow[]>;
  merges(profileId: string): Promise<readonly ProfileMergeRow[]>;
  close(): Promise<void>;
}

export interface ProfilesShowHooks {
  readonly openStore?: (env: NodeJS.ProcessEnv) => ProfilesShowStore;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const profilesShowCommand: CommandDefinition = {
  id: "profiles.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <identifier>")
      .description(
        "Show the profile an identifier or profile_id resolves to, with its identifiers " +
          "and merge lineage. Read-only.",
      )
      .option("--project <project_id>", "Project scope. Required unless the argument is a UUID.")
      .option("--env <environment>", "Environment scope. Required unless the argument is a UUID.")
      .option("--kind <kind>", "Disambiguate when one value is bound as more than one kind.");
    cmd.action(
      async (
        identifier: string,
        opts: { project?: string; env?: string; kind?: string },
        command: Command,
      ) => {
        const wrapped = deps.runCommand<ProfilesShowArgs>(
          { id: "profiles.show", mutates: false },
          runProfilesShow,
        );
        await wrapped(
          {
            target: identifier,
            project: opts.project,
            environment: opts.env,
            kind: opts.kind,
          },
          command,
        );
      },
    );
  },
};

export function buildProfilesShowRunner(hooks: ProfilesShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: ProfilesShowArgs, ctx: CommandContext): Promise<undefined> {
    const target = args.target.trim();
    if (target.length === 0) {
      throw new UsageError("an identifier value or profile_id is required");
    }

    const store = openStore(ctx.env);
    try {
      const profile = await resolveProfile(store, target, args);
      const [identifiers, merges] = await Promise.all([
        store.identifiers(profile.profile_id),
        store.merges(profile.profile_id),
      ]);
      emit(ctx, { profile, identifiers, merges });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

async function resolveProfile(
  store: ProfilesShowStore,
  target: string,
  args: ProfilesShowArgs,
): Promise<ProfileRow> {
  if (UUID_PATTERN.test(target)) {
    const byId = await store.byId(target);
    if (byId !== null) return byId;
    // Fall through: a UUID-shaped string can legitimately be an
    // `anonymous_id` — the web SDK mints those as UUIDs.
  }

  const project = args.project?.trim();
  const environment = args.environment?.trim();
  if (project === undefined || project.length === 0) {
    throw new UsageError(
      "--project is required when the argument is not a known profile_id " +
        "(identifiers are scoped to one project and environment)",
    );
  }
  if (environment === undefined || environment.length === 0) {
    throw new UsageError("--env is required when the argument is not a known profile_id");
  }

  const matches = await store.byIdentifierValue({
    project_id: project,
    environment,
    value: target,
  });
  const wanted =
    args.kind === undefined ? matches : matches.filter((match) => match.kind === args.kind);

  if (wanted.length === 0) {
    throw new UsageError(
      `no profile found for "${target}" in ${project}/${environment}` +
        (args.kind === undefined ? "" : ` with kind "${args.kind}"`),
    );
  }
  if (wanted.length > 1) {
    // Two kinds, possibly two different people. Naming them beats
    // guessing.
    const kinds = wanted.map((match) => match.kind).join(", ");
    throw new UsageError(
      `"${target}" is bound as more than one identifier kind (${kinds}); ` +
        "re-run with --kind to choose",
    );
  }
  return (wanted[0] as { profile: ProfileRow }).profile;
}

const runProfilesShow = buildProfilesShowRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProfilesShowStore {
  // `connectDb({ env })`, not `connectDb()`: `command.ts` states the MUST —
  // reading process.env directly leaks the developer's real environment
  // into tests that mean to exercise the "no var set" path.
  const handle = connectDb({ env });
  return {
    byId: (profileId) => findProfileById(handle.db, profileId),
    byIdentifierValue: (scope) => findProfilesByIdentifierValue(handle.db, scope),
    identifiers: (profileId) => listProfileIdentifiers(handle.db, profileId),
    merges: (profileId) => listProfileMerges(handle.db, profileId),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, detail: ProfileDetail): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(detail),
      json: detail,
    }),
  );
}

function renderHuman(detail: ProfileDetail): string {
  const { profile } = detail;
  const lines = [
    `profile_id             ${profile.profile_id}`,
    `project_id             ${profile.project_id}`,
    `environment            ${profile.environment}`,
    `canonical_customer_id  ${profile.canonical_customer_id ?? "(none)"}`,
    `traits_version         ${profile.traits_version}`,
    `first_seen_at          ${profile.first_seen_at}`,
    `updated_at             ${profile.updated_at}`,
  ];

  if (profile.merged_into !== null) {
    // The single most important thing to say about this row: it lost a
    // merge, so a caller holding this id is holding history.
    lines.push(
      "",
      `MERGED AWAY into ${profile.merged_into}`,
      "  This profile lost a merge. Its identifiers were repointed at the winner,",
      "  so nothing resolves here any more — the row survives so profile_ids already",
      "  stamped into ClickHouse stay explainable.",
    );
  }

  lines.push("", `identifiers (${detail.identifiers.length})`);
  if (detail.identifiers.length === 0) {
    lines.push("  (none — nothing resolves to this profile)");
  } else {
    for (const identifier of detail.identifiers) {
      lines.push(
        `  ${identifier.kind.padEnd(14)} ${identifier.value}` +
          `   first_seen ${identifier.first_seen_at}  last_seen ${identifier.last_seen_at}`,
      );
    }
  }

  const traitKeys = Object.keys(profile.traits).sort();
  lines.push("", `traits (${traitKeys.length} key${traitKeys.length === 1 ? "" : "s"})`);
  if (traitKeys.length === 0) {
    lines.push("  (none)");
  } else {
    for (const key of traitKeys) {
      lines.push(`  ${key.padEnd(20)} ${JSON.stringify(profile.traits[key])}`);
    }
  }

  lines.push("", `merges (${detail.merges.length})`);
  if (detail.merges.length === 0) {
    lines.push("  (none)");
  } else {
    for (const merge of detail.merges) {
      const side = merge.winner_profile_id === profile.profile_id ? "absorbed" : "absorbed BY";
      const other =
        merge.winner_profile_id === profile.profile_id
          ? merge.loser_profile_id
          : merge.winner_profile_id;
      lines.push(`  ${merge.merged_at}  ${side} ${other}  (source_event ${merge.source_event_id})`);
    }
  }

  return lines.join("\n");
}
