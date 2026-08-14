import { z } from "zod";

/**
 * `identity.linked` v1 — ACTIVE.
 *
 * Emitted by `sync/legacy/identity-resolver/v1/` the first time an authoritative
 * overlap is observed between two identifiers — for example, a single event
 * carrying both `anonymous_id` and `customer_id`. v1 of the resolver only
 * recognizes the **explicit-overlap** rule from
 * `docs/architecture/05-processors-and-replay.md` § "Identity Resolution":
 *
 *   > Canonical merges only happen from authoritative links.
 *   > Authoritative links include events that explicitly contain both
 *   > identifiers, such as `anonymous_id + customer_id`.
 *
 * The `confidence` enum is the canonical link-quality marker mirrored on the
 * PostgreSQL `identity_links.confidence` column. Only `authoritative` is
 * emitted by v1; `candidate` is reserved for the heuristic processors that
 * land later (P8-005 attribution-engine, P8-006 sessionizer extensions) so
 * downstream consumers can already filter on it without a future event-shape
 * migration.
 *
 * The `evidence_type` and `evidence` slots are an **open** vocabulary: new
 * heuristic rule types land by inserting events with a new `evidence_type`
 * value (and code that interprets it) — no schema migration is required. The
 * Zod schema therefore validates `evidence_type` as free-form text and
 * `evidence` as an arbitrary record. The expected shape per
 * `evidence_type` is documented in a small in-code registry adjacent to each
 * rule implementation.
 *
 * `link_id` is the UUIDv7 of the `identity_links` row this event represents,
 * so downstream consumers can join the event back to the durable record.
 */

/** Canonical link-confidence vocabulary. Mirrors `identity_links.confidence`. */
export const identityLinkConfidenceSchema = z.enum(["authoritative", "candidate"]);
export type IdentityLinkConfidence = z.infer<typeof identityLinkConfidenceSchema>;

/**
 * Canonical identifier reference. The shape `<kind>:<value>` is the same
 * representation persisted in `identity_links.left_identifier` /
 * `identity_links.right_identifier`. Encoding both halves in one string keeps
 * the table indexable without a dedicated `kind` column and makes governance
 * queries (graph traversal) cheap.
 */
export const identityIdentifierSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[a-z][a-z0-9_]*:[\x20-\x7e]{1,}$/u, {
    message: "identifier must be in the form '<snake_case_kind>:<value>'",
  });

export const identityLinkedV1PropertiesSchema = z
  .object({
    /** UUIDv7 of the `identity_links` row this event represents. */
    link_id: z.string().min(1).max(64),
    /** Canonical link-quality marker. v1 only ever emits `authoritative`. */
    confidence: identityLinkConfidenceSchema,
    /**
     * Left identifier in `<kind>:<value>` form (e.g. `anonymous_id:anon_abc`).
     * Convention: the alphabetically-smaller `kind` is placed left so any
     * given `(left, right)` pair has exactly one canonical orientation.
     */
    left_identifier: identityIdentifierSchema,
    /** Right identifier in `<kind>:<value>` form. */
    right_identifier: identityIdentifierSchema,
    /**
     * Open vocabulary of evidence types. v1 emits `explicit_overlap` only;
     * future rules may emit values like `session_proximity` or
     * `device_continuity` without a schema migration.
     */
    evidence_type: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/u, {
        message: "evidence_type must be lowercase snake_case",
      }),
    /**
     * Heuristic-specific data; shape is per-`evidence_type`. For
     * `explicit_overlap` the resolver writes
     * `{ source_event_id, source_event_name, source_schema_version }`. The
     * Zod schema intentionally allows any record so the table can absorb new
     * rule types without altering this file.
     */
    evidence: z.record(z.string(), z.unknown()),
    /** Short human-readable explanation for operator triage. */
    reason: z.string().min(1).max(2048),
    /**
     * Run id that recorded the link. Mirrors the
     * `processor_runs.run_id` value the resolver is currently registered as.
     */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type IdentityLinkedV1Properties = z.infer<typeof identityLinkedV1PropertiesSchema>;
