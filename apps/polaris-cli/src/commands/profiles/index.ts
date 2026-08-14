/**
 * `polaris profiles` command group — the operator surface onto the
 * profile plane.
 *
 *   - `polaris profiles show <identifier|profile_id>`   mutates: false
 *   - `polaris profiles links <profile_id>`             mutates: false
 *
 * ## Read-only, structurally
 *
 * Every command here is `mutates: false`, and the group holds no write
 * path at all — not a disabled one, not a guarded one. The identity
 * stage is the profile store's only sync-path writer and the merge
 * worker (R4) will be the only other; a mutation verb in the CLI would
 * be a third write path to audit, reason about, and keep consistent
 * with the safeguards.
 *
 * Repair is not a mutation here either. A bad merge is undone by
 * rebuilding the projection under corrected policy
 * (`polaris profiles rebuild`, landing with R4), because the store is
 * derived state and the computation is the source of truth. There is no
 * un-merge verb and there is not meant to be one.
 *
 * ## A note on the name
 *
 * `--profile` already means something else in this CLI: the connection
 * profile in `~/.polaris/config.toml`, available globally on every
 * command. The two are unrelated, and the descriptions below say
 * "customer profile" where the distinction could bite.
 *
 * @see docs/implementation/pipeline-redesign-plan.md §4 "The profile plane"
 * @see db/migrations/20260814000001_create_profile_plane.sql
 */
import type { CommandDefinition } from "../../command.js";
import { profilesLinksCommand } from "./links.js";
import { profilesRebuildCommand } from "./rebuild.js";
import { profilesShowCommand } from "./show.js";

const CHILDREN: readonly CommandDefinition[] = [
  profilesRebuildCommand,
  profilesShowCommand,
  profilesLinksCommand,
];

export const profilesCommand: CommandDefinition = {
  id: "profiles",
  // Group container has no body. `mutates: false` matches the documented
  // contract that group definitions are read-only; here it is also true
  // of every child, because the group has no write path.
  mutates: false,
  register: (parent, deps) => {
    const group = parent
      .command("profiles")
      .description(
        "Inspect resolved customer profiles: who an identifier resolves to, and the evidence " +
          "behind it. Read-only — unrelated to the global --profile connection flag.",
      );
    for (const child of CHILDREN) {
      child.register(group, deps);
    }
  },
};

export { profilesLinksCommand, profilesShowCommand };
