/**
 * Per-project identity-stage override contract.
 *
 * This is the shape of the OPTIONAL `identity:` block in
 * `catalog/projects/<project_id>.yaml`. Two consumers parse it and they
 * must agree, which is why the schema lives here and not in either of
 * them:
 *
 *   - `apps/polaris-cli` validates it as part of the strict project-file
 *     schema, so `polaris catalog` commands reject a typo'd block at
 *     authoring time;
 *   - `sync/identity/resolver` loads it at boot to narrow the manifest's
 *     semantic parameters and install the identifier denylist.
 *
 * The block is a SEMANTIC input: changing it changes which events the
 * identity stage emits. That is why it is file-backed and deploy-time
 * (`docs/architecture/05-processors-and-replay.md` § "Per-Project
 * Semantic Parameters") — never `project_config`, never env — and why
 * the CLI's `projects sync` materializer deliberately does not copy it
 * into PostgreSQL.
 *
 * Range enforcement is intentionally NOT here. The manifest of the
 * consuming processor declares the allowed bounds, and the stage refuses
 * (at boot) an override outside them; this schema only pins the shape.
 */

import { z } from "zod";

/**
 * Identifier kinds a project may denylist. Mirrors the strong identity
 * kinds the resolver binds — `session_id` / `device_id` are reserved and
 * not bindable, so denylisting them would be dead configuration.
 *
 * The const is module-private (consumers read kinds off the schema or
 * the type); only the derived type travels.
 */
const IDENTITY_OVERRIDE_KINDS = ["customer_id", "anonymous_id"] as const;
export type IdentityOverrideKind = (typeof IDENTITY_OVERRIDE_KINDS)[number];

/**
 * `.strict()` is load-bearing: a misspelt key (`deny_list:`) must fail
 * validation, because the alternative is a safeguard that is silently
 * not installed.
 */
export const projectIdentityOverrideSchema = z
  .object({
    /** Narrow the per-kind identifier cap below the manifest default. */
    max_identifiers_per_kind: z.number().int().min(1).optional(),
    /** Narrow the merge-rate breaker threshold. */
    max_merges_per_window: z.number().int().min(1).optional(),
    /** Narrow the merge-rate breaker window. */
    merge_window_seconds: z.number().int().min(1).optional(),
    /** Narrow the trait-snapshot size guard. */
    max_traits_bytes: z.number().int().min(1).optional(),
    /**
     * Identifier VALUES that resolve as if absent, keyed by kind — kiosk
     * device ids, `customer_id: "guest"`, a bot's shared anonymous id.
     * These are the values that chain-merge thousands of profiles into
     * one; refusing them at collection time is cheaper than un-merging.
     */
    denylist: z
      .partialRecord(
        z.enum(IDENTITY_OVERRIDE_KINDS),
        z.array(z.string().min(1).max(512)).min(1).max(1000),
      )
      .optional(),
  })
  .strict();

export type ProjectIdentityOverride = z.infer<typeof projectIdentityOverrideSchema>;
