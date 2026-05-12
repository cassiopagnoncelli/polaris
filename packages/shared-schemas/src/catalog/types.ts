import { type ZodTypeAny, z } from "zod";
import {
  eventNameSchema,
  isoUtcTimestampSchema,
  schemaVersionSchema,
} from "../envelope/primitives.js";

/**
 * Catalog lifecycle. `active` versions accept new producer traffic; old
 * versions are marked `deprecated` with a `sunset_at` date. After
 * `sunset_at`, the ingester returns reason code `schema_version_sunset`.
 *
 * v1 has only these two states. A future `experimental` flag may live on
 * the entry as a sibling field rather than a lifecycle value, since
 * experimental events follow a separate governance path.
 */
export const lifecycleSchema = z.enum(["active", "deprecated"]);
export type Lifecycle = z.infer<typeof lifecycleSchema>;

/**
 * Shape of a single YAML catalog file. One file = one (event, version)
 * pair. Multiple files coexist for an event so historical versions remain
 * documented during the deprecation window.
 */
export const catalogEntryFileSchema = z
  .object({
    name: eventNameSchema,
    schema_version: schemaVersionSchema,
    domain: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, {
        message: "domain must be lowercase snake_case",
      }),
    owner: z.string().min(1).max(128),
    description: z.string().min(1).max(4096),
    lifecycle: lifecycleSchema,
    /** ISO 8601 UTC timestamp; required when lifecycle === "deprecated". */
    sunset_at: isoUtcTimestampSchema.optional(),
    /** ISO date (YYYY-MM-DD) recording when this version was first registered. */
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "since must be an ISO date (YYYY-MM-DD)" })
      .optional(),
    notes: z.string().max(8192).optional(),
    /** Module reference for the Zod schema (informational). */
    schema_module: z.string().min(1).max(256).optional(),
    /** Named export inside the schema module (informational). */
    schema_export: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.lifecycle === "deprecated" && !entry.sunset_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sunset_at"],
        message: "deprecated entries must declare sunset_at",
      });
    }
    if (entry.lifecycle === "active" && entry.sunset_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sunset_at"],
        message: "active entries must not declare sunset_at",
      });
    }
  });

export type CatalogEntryFile = z.infer<typeof catalogEntryFileSchema>;

/**
 * A fully-resolved catalog entry: YAML metadata plus the bound Zod
 * `properties` schema. The Zod schema is supplied at registration time
 * rather than dynamically imported from `schema_module`, so consumers
 * (ingester, tests, CLI) get static type checking and SDK builds never
 * accidentally pull the whole catalog tree.
 */
export interface CatalogEntry extends CatalogEntryFile {
  propertiesSchema: ZodTypeAny;
}

/** Binding from (event, schema_version) to a Zod properties schema. */
export interface SchemaBinding {
  event: string;
  schema_version: number;
  propertiesSchema: ZodTypeAny;
}
