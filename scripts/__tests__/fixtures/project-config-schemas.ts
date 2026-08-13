/**
 * Fixture Zod schemas for the project-config schema-artifact generator tests.
 *
 * Fed straight to the generator's PURE core (`buildArtifacts`) — no fixture
 * package, no builds. `fixtureProjectSchema` / `fixtureInstanceSchema` model
 * a full participating destination consumer; the `compat*` variants model one
 * component schema evolving, each exercising one rule of the additive-only
 * compatibility check (docs/implementation/project-config-plan.md §3.4).
 */

import { z } from "zod";

/** Namespace under which the full fixture entry publishes its artifacts. */
export const FIXTURE_NAMESPACE = "fixture-widgets";

/** Project-scoped keys: a secret, defaulted keys, an enum, one optional. */
export const fixtureProjectSchema = z.object({
  api_key: z.string().meta({ secret: true }),
  graph_host: z.string().default("graph.example.com"),
  request_timeout_ms: z.number().int().positive().default(5000),
  action_source: z.enum(["website", "app", "physical_store"]).default("website"),
  optional_note: z.string().optional(),
});

/** Instance-scoped keys (destination consumers only). */
export const fixtureInstanceSchema = z.object({
  access_token: z.string().meta({ secret: true }),
  pixel_id: z.string(),
  test_event_code: z.string().optional(),
});

/** Baseline for the compat cases: v1 of an evolving component schema. */
export const compatBaseSchema = z.object({
  keep_me: z.string(),
  typed_key: z.number().default(1),
  promote_me: z.string().optional(),
});

/** BREAKING evolution of the baseline: `keep_me` removed. */
export const compatRemovalSchema = z.object({
  typed_key: z.number().default(1),
  promote_me: z.string().optional(),
});

/** BREAKING evolution of the baseline: `typed_key` changed number -> string. */
export const compatTypeChangeSchema = z.object({
  keep_me: z.string(),
  typed_key: z.string().default("1"),
  promote_me: z.string().optional(),
});

/** BREAKING evolution of the baseline: `promote_me` required, no default. */
export const compatPromotionSchema = z.object({
  keep_me: z.string(),
  typed_key: z.number().default(1),
  promote_me: z.string(),
});

/** Additive evolution of the baseline: the only kind the rules allow. */
export const compatAdditiveSchema = z.object({
  keep_me: z.string(),
  typed_key: z.number().default(1),
  promote_me: z.string().optional(),
  new_optional: z.string().optional(),
  new_defaulted: z.boolean().default(false),
});
