/**
 * `polaris profiles links <profile_id>` — read-only.
 *
 * The evidence trail: not "who is this person" but "why does Polaris
 * believe these identifiers are one person". Two tables answer it and
 * they answer different halves:
 *
 *   - `identity_links`  the LEDGER. One row per pair of identifiers
 *                       observed together, with the processor and run
 *                       that concluded it and the source event that
 *                       proved it.
 *   - `profile_merges`  the CONSEQUENCE. When two profiles turned out to
 *                       be one, which won, which lost, and on what event.
 *
 * `profiles show` answers "who is this?" from `profile_identifiers`, the
 * resolved graph. This command answers "how did it get that way?", which
 * is the question asked when the answer looks wrong — a support agent
 * logging into customer accounts, a kiosk device shared by a thousand
 * people, a denylist gap.
 *
 * The ledger is keyed on identifiers, not on profiles, so the command
 * reads the profile's identifiers first and then asks the ledger about
 * them. That indirection is deliberate in the schema: evidence outlives
 * any particular profile, and after a merge the losing profile's
 * identifiers now belong to the winner while the evidence rows still
 * describe the pair as first seen.
 *
 * `mutates: false`. Un-merging is not a verb here and never will be —
 * a bad merge is repaired by rebuilding the projection under corrected
 * policy (`polaris profiles rebuild`, R4), because the store is derived
 * state and the computation is the source of truth.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  connectDb,
  findProfileById,
  type IdentityLinkRow,
  listIdentityLinks,
  listProfileIdentifiers,
  listProfileMerges,
  type ProfileMergeRow,
  type ProfileRow,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ProfilesLinksArgs {
  readonly profileId: string;
  readonly limit?: number | undefined;
}

export interface ProfileLinksDetail {
  readonly profile_id: string;
  readonly project_id: string;
  readonly environment: string;
  /** The identifiers the ledger was queried for, in `<kind>:<value>` form. */
  readonly identifiers: readonly string[];
  readonly links: readonly IdentityLinkRow[];
  readonly merges: readonly ProfileMergeRow[];
}

/** Storage seam. Tests inject an in-memory store; production is Kysely. */
export interface ProfilesLinksStore {
  byId(profileId: string): Promise<ProfileRow | null>;
  identifiers(profileId: string): Promise<readonly { kind: string; value: string }[]>;
  links(
    scope: { project_id: string; environment: string; identifiers: readonly string[] },
    limit: number,
  ): Promise<readonly IdentityLinkRow[]>;
  merges(profileId: string): Promise<readonly ProfileMergeRow[]>;
  close(): Promise<void>;
}

export interface ProfilesLinksHooks {
  readonly openStore?: (env: NodeJS.ProcessEnv) => ProfilesLinksStore;
}

const DEFAULT_LIMIT = 100;

export const profilesLinksCommand: CommandDefinition = {
  id: "profiles.links",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("links <profile_id>")
      .description(
        "Show the evidence trail for a profile: identity_links pair evidence and merge history. " +
          "Read-only.",
      )
      .option("--limit <n>", `Maximum ledger rows to return (default ${DEFAULT_LIMIT}).`);
    cmd.action(async (profileId: string, opts: { limit?: string }, command: Command) => {
      const wrapped = deps.runCommand<ProfilesLinksArgs>(
        { id: "profiles.links", mutates: false },
        runProfilesLinks,
      );
      await wrapped({ profileId, limit: parseLimit(opts.limit) }, command);
    });
  },
};

export function buildProfilesLinksRunner(hooks: ProfilesLinksHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: ProfilesLinksArgs, ctx: CommandContext): Promise<undefined> {
    const profileId = args.profileId.trim();
    if (profileId.length === 0) {
      throw new UsageError("profile_id is required");
    }
    // Validated HERE, not only in the `.action()` wrapper: the runner is
    // the contract, and a caller reaching it directly (a test, a future
    // programmatic use) deserves the same refusal a CLI user gets. A
    // limit of 0 would otherwise flow into the query as a real bound and
    // return an empty ledger that reads as "no evidence".
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
      throw new UsageError(`--limit must be a positive integer (got "${String(args.limit)}")`);
    }

    const store = openStore(ctx.env);
    try {
      const profile = await store.byId(profileId);
      if (profile === null) {
        throw new UsageError(`profile "${profileId}" not found`);
      }

      const identifiers = await store.identifiers(profileId);
      // The ledger stores identifiers in `<kind>:<value>` form; the
      // resolved graph stores the halves separately.
      const encoded = identifiers.map((identifier) => `${identifier.kind}:${identifier.value}`);

      const [links, merges] = await Promise.all([
        store.links(
          {
            project_id: profile.project_id,
            environment: profile.environment,
            identifiers: encoded,
          },
          args.limit ?? DEFAULT_LIMIT,
        ),
        store.merges(profileId),
      ]);

      emit(ctx, {
        profile_id: profile.profile_id,
        project_id: profile.project_id,
        environment: profile.environment,
        identifiers: encoded,
        links,
        merges,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

/**
 * Convert the flag's string to a number. Judging it is the runner's job
 * — see the guard there — so a non-numeric value passes through as NaN
 * and is refused with the same message as a negative one.
 */
function parseLimit(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : Number(raw);
}

const runProfilesLinks = buildProfilesLinksRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProfilesLinksStore {
  const handle = connectDb({ env });
  return {
    byId: (profileId) => findProfileById(handle.db, profileId),
    identifiers: (profileId) => listProfileIdentifiers(handle.db, profileId),
    links: (scope, limit) => listIdentityLinks(handle.db, scope, limit),
    merges: (profileId) => listProfileMerges(handle.db, profileId),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, detail: ProfileLinksDetail): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(detail),
      json: detail,
    }),
  );
}

function renderHuman(detail: ProfileLinksDetail): string {
  const lines = [
    `profile_id   ${detail.profile_id}`,
    `project_id   ${detail.project_id}`,
    `environment  ${detail.environment}`,
    "",
    `identifiers queried (${detail.identifiers.length})`,
  ];
  if (detail.identifiers.length === 0) {
    lines.push("  (none — nothing resolves to this profile, so the ledger has nothing to say)");
  } else {
    for (const identifier of detail.identifiers) lines.push(`  ${identifier}`);
  }

  lines.push("", `evidence (${detail.links.length} link${detail.links.length === 1 ? "" : "s"})`);
  if (detail.links.length === 0) {
    // Two different reasons for an empty ledger, and conflating them
    // would mislead: one identifier means there was never a pair to
    // evidence, while a merged profile's pair evidence is the merge
    // record itself — the ledger only fires when a binding is NEW, and
    // a merge repoints identifiers that were already bound elsewhere.
    lines.push(
      detail.identifiers.length < 2
        ? "  (none — a profile with fewer than two identifiers has no pair to evidence)"
        : "  (none — this profile's identifiers were joined by a merge; see merges below)",
    );
  } else {
    for (const link of detail.links) {
      const superseded = link.superseded_at === null ? "" : `  SUPERSEDED ${link.superseded_at}`;
      lines.push(
        `  ${link.created_at}  ${link.left_identifier} <-> ${link.right_identifier}${superseded}`,
      );
      lines.push(
        `      ${link.confidence} / ${link.evidence_type}   by ${link.processor_name}@${link.processor_version}` +
          `   run ${link.run_id ?? "(unrecorded)"}`,
      );
      lines.push(`      ${link.reason}`);
    }
  }

  lines.push("", `merges (${detail.merges.length})`);
  if (detail.merges.length === 0) {
    lines.push("  (none)");
  } else {
    for (const merge of detail.merges) {
      const role = merge.winner_profile_id === detail.profile_id ? "won" : "lost";
      lines.push(
        `  ${merge.merged_at}  ${role}   winner ${merge.winner_profile_id}  loser ${merge.loser_profile_id}`,
      );
      lines.push(`      source_event ${merge.source_event_id}`);
    }
  }

  return lines.join("\n");
}
