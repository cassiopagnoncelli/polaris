/**
 * Per-project override contracts for the spine stages.
 *
 * These are the shapes of the OPTIONAL `identity:` and `enrichment:`
 * blocks in `catalog/projects/<project_id>.yaml`. Two kinds of consumer
 * parse them and they must agree, which is why the schemas live here and
 * not in either:
 *
 *   - `apps/polaris-cli` validates them as part of the strict
 *     project-file schema, so `polaris catalog` commands reject a typo'd
 *     block at authoring time;
 *   - each stage loads its own block at boot to narrow the manifest's
 *     semantic parameters (and, for identity, to install the identifier
 *     denylist).
 *
 * The blocks are SEMANTIC inputs: changing one changes which events its
 * stage emits. That is why they are file-backed and deploy-time
 * (`docs/architecture/05-processors-and-replay.md` § "Per-Project
 * Semantic Parameters") — never `project_config`, never env — and why
 * the CLI's `projects sync` materializer deliberately does not copy them
 * into PostgreSQL.
 *
 * Range enforcement is intentionally NOT here. The manifest of the
 * consuming processor declares the allowed bounds, and the stage refuses
 * (at boot) an override outside them; these schemas only pin the shape.
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

/**
 * Shape of the OPTIONAL `enrichment:` block in
 * `catalog/projects/<project_id>.yaml`.
 *
 * Same contract as `identity:` above, one stage further down the spine:
 * file-backed, deploy-time, narrowing-only, validated eagerly at boot
 * against the bounds the enrichment runtime's manifest declares.
 *
 * `max_traits_bytes` here bounds what the spine will CARRY on an event.
 * It is deliberately a different knob from the identically-named one
 * under `identity:`, which bounds what one `identify` call may WRITE to
 * the store — a profile can pass the write guard many times over and
 * still grow past what is sane to copy onto every downstream event.
 */
export const projectEnrichmentOverrideSchema = z
  .object({
    max_traits_bytes: z.number().int().min(1).optional(),
  })
  .strict();

export type ProjectEnrichmentOverride = z.infer<typeof projectEnrichmentOverrideSchema>;
