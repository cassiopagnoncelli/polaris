/**
 * Read helpers for the profile plane.
 *
 * The plane has three tables and they answer three different questions,
 * which is why this module exposes them separately rather than as one
 * fat join:
 *
 *   - `profiles`             who exists, and what we believe about them
 *   - `profile_identifiers`  who is this? (the resolved graph)
 *   - `profile_merges`       when did two people turn out to be one?
 *
 * plus `identity_links`, the EVIDENCE ledger explaining why a binding was
 * made. An operator asking "why is this person's profile like this?" is
 * asking for the ledger; an operator asking "who is this?" is asking for
 * the graph.
 *
 * READ-ONLY, by construction and on purpose. The identity stage is the
 * profile store's only sync-path writer; the merge worker (R4) will be
 * the only other one. A mutation helper here would be a second write path
 * to audit, so there is none — `polaris profiles rebuild` lands with R4
 * as an audited mutation, not as a query.
 *
 * @see db/postgres/migrations/20260814000001_create_profile_plane.sql
 * @see sync/identity/resolver/v1/src/repository.ts
 */
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

/**
 * A profile as the command layer renders it.
 *
 * `traits_version` is `bigint` in PostgreSQL, so the driver hands it back
 * as a string; it is narrowed to a number here because the envelope
 * carries it as one and an operator comparing the two should not have to
 * think about the difference.
 */
export interface ProfileRow {
  readonly profile_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly canonical_customer_id: string | null;
  readonly traits: Record<string, unknown>;
  readonly traits_version: number;
  /** Set when this profile LOST a merge. Audit-only; never a routing hop. */
  readonly merged_into: string | null;
  readonly first_seen_at: string;
  readonly updated_at: string;
}

export interface ProfileIdentifierRow {
  readonly kind: string;
  readonly value: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export interface ProfileMergeRow {
  readonly merge_id: string;
  readonly winner_profile_id: string;
  readonly loser_profile_id: string;
  readonly source_event_id: string;
  readonly evidence: Record<string, unknown>;
  readonly merged_at: string;
}

export interface IdentityLinkRow {
  readonly link_id: string;
  readonly left_identifier: string;
  readonly right_identifier: string;
  readonly confidence: string;
  readonly evidence_type: string;
  readonly evidence: Record<string, unknown>;
  readonly reason: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly run_id: string | null;
  readonly created_at: string;
  readonly superseded_at: string | null;
}

/** Scope for an identifier lookup. The identifier PK is project-bounded. */
export interface IdentifierLookup {
  readonly project_id: string;
  readonly environment: string;
  readonly kind: string;
  readonly value: string;
}

const PROFILE_COLUMNS = [
  "profile_id",
  "project_id",
  "environment",
  "canonical_customer_id",
  "traits",
  "traits_version",
  "merged_into",
  "first_seen_at",
  "updated_at",
] as const;

/** Find one profile by id. `null` when unknown. */
export async function findProfileById(
  db: Kysely<Database>,
  profileId: string,
): Promise<ProfileRow | null> {
  const row = await db
    .selectFrom("profiles")
    .select(PROFILE_COLUMNS)
    .where("profile_id", "=", profileId)
    .executeTakeFirst();
  return row === undefined ? null : toProfileRow(row);
}

/**
 * Find the profile an identifier resolves to.
 *
 * One lookup, no traversal: merges repoint every identifier row to the
 * winner inside the merging transaction, so a live identifier always
 * points at a live profile. `merged_into` is not followed here — if a
 * caller somehow holds a losing profile's id, saying so plainly is more
 * useful than silently redirecting.
 */
export async function findProfileByIdentifier(
  db: Kysely<Database>,
  lookup: IdentifierLookup,
): Promise<ProfileRow | null> {
  const row = await db
    .selectFrom("profile_identifiers")
    .innerJoin("profiles", "profiles.profile_id", "profile_identifiers.profile_id")
    .select(PROFILE_COLUMNS.map((column) => `profiles.${column}` as const))
    .where("profile_identifiers.project_id", "=", lookup.project_id)
    .where("profile_identifiers.environment", "=", lookup.environment)
    .where("profile_identifiers.kind", "=", lookup.kind)
    .where("profile_identifiers.value", "=", lookup.value)
    .executeTakeFirst();
  return row === undefined ? null : toProfileRow(row);
}

/**
 * Find the profile an identifier VALUE resolves to, without being told
 * its kind.
 *
 * An operator pasting a customer id from a support ticket knows the
 * value, not the platform's name for it. Ambiguity is possible in
 * principle — the same string bound as both a `customer_id` and an
 * `anonymous_id` — so this returns every match and lets the caller say
 * so rather than picking one silently.
 */
export async function findProfilesByIdentifierValue(
  db: Kysely<Database>,
  scope: { readonly project_id: string; readonly environment: string; readonly value: string },
): Promise<readonly { readonly kind: string; readonly profile: ProfileRow }[]> {
  const rows = await db
    .selectFrom("profile_identifiers")
    .innerJoin("profiles", "profiles.profile_id", "profile_identifiers.profile_id")
    .select([
      "profile_identifiers.kind as identifier_kind",
      ...PROFILE_COLUMNS.map((column) => `profiles.${column}` as const),
    ])
    .where("profile_identifiers.project_id", "=", scope.project_id)
    .where("profile_identifiers.environment", "=", scope.environment)
    .where("profile_identifiers.value", "=", scope.value)
    .orderBy("profile_identifiers.kind", "asc")
    .execute();
  return rows.map((row) => ({ kind: row.identifier_kind, profile: toProfileRow(row) }));
}

/** Every identifier bound to a profile, in canonical order. */
export async function listProfileIdentifiers(
  db: Kysely<Database>,
  profileId: string,
): Promise<readonly ProfileIdentifierRow[]> {
  const rows = await db
    .selectFrom("profile_identifiers")
    .select(["kind", "value", "first_seen_at", "last_seen_at"])
    .where("profile_id", "=", profileId)
    .orderBy("kind", "asc")
    .orderBy("value", "asc")
    .execute();
  return rows.map((row) => ({
    kind: row.kind,
    value: row.value,
    first_seen_at: iso(row.first_seen_at),
    last_seen_at: iso(row.last_seen_at),
  }));
}

/**
 * Merge lineage touching a profile, from BOTH sides.
 *
 * A profile is interesting as a winner (it absorbed others) and as a
 * loser (it was absorbed). Returning only one side would make half the
 * lineage invisible depending on which id an operator happened to hold —
 * and the id they hold is often the loser's, because that is the one
 * stamped into ClickHouse before the merge happened.
 */
export async function listProfileMerges(
  db: Kysely<Database>,
  profileId: string,
): Promise<readonly ProfileMergeRow[]> {
  const rows = await db
    .selectFrom("profile_merges")
    .select([
      "merge_id",
      "winner_profile_id",
      "loser_profile_id",
      "source_event_id",
      "evidence",
      "merged_at",
    ])
    .where((eb) =>
      eb.or([eb("winner_profile_id", "=", profileId), eb("loser_profile_id", "=", profileId)]),
    )
    .orderBy("merged_at", "desc")
    .execute();
  return rows.map((row) => ({
    merge_id: row.merge_id,
    winner_profile_id: row.winner_profile_id,
    loser_profile_id: row.loser_profile_id,
    source_event_id: row.source_event_id,
    evidence: (row.evidence as Record<string, unknown> | null) ?? {},
    merged_at: iso(row.merged_at),
  }));
}

/**
 * The evidence ledger for a set of identifiers.
 *
 * `identity_links` stores identifiers in `<kind>:<value>` form on either
 * side of a pair, with the alphabetically-smaller kind on the left. The
 * caller passes the profile's identifiers in that same encoded form and
 * this matches either side, because "why do we believe these two are one
 * person" is symmetric.
 */
export async function listIdentityLinks(
  db: Kysely<Database>,
  scope: {
    readonly project_id: string;
    readonly environment: string;
    readonly identifiers: readonly string[];
  },
  limit = 100,
): Promise<readonly IdentityLinkRow[]> {
  if (scope.identifiers.length === 0) return [];
  const rows = await db
    .selectFrom("identity_links")
    .select([
      "link_id",
      "left_identifier",
      "right_identifier",
      "confidence",
      "evidence_type",
      "evidence",
      "reason",
      "processor_name",
      "processor_version",
      "run_id",
      "created_at",
      "superseded_at",
    ])
    .where("project_id", "=", scope.project_id)
    .where("environment", "=", scope.environment)
    .where((eb) =>
      eb.or([
        eb("left_identifier", "in", [...scope.identifiers]),
        eb("right_identifier", "in", [...scope.identifiers]),
      ]),
    )
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    link_id: row.link_id,
    left_identifier: row.left_identifier,
    right_identifier: row.right_identifier,
    confidence: row.confidence,
    evidence_type: row.evidence_type,
    evidence: (row.evidence as Record<string, unknown> | null) ?? {},
    reason: row.reason,
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    run_id: row.run_id,
    created_at: iso(row.created_at),
    superseded_at: row.superseded_at === null ? null : iso(row.superseded_at),
  }));
}

function toProfileRow(row: {
  profile_id: string;
  project_id: string;
  environment: string;
  canonical_customer_id: string | null;
  traits: Record<string, unknown>;
  traits_version: string | number;
  merged_into: string | null;
  first_seen_at: Date;
  updated_at: Date;
}): ProfileRow {
  return {
    profile_id: row.profile_id,
    project_id: row.project_id,
    environment: row.environment,
    canonical_customer_id: row.canonical_customer_id,
    traits: (row.traits as Record<string, unknown> | null) ?? {},
    // `bigint` arrives as a string; the envelope carries a number.
    traits_version: Number(row.traits_version ?? 0),
    merged_into: row.merged_into,
    first_seen_at: iso(row.first_seen_at),
    updated_at: iso(row.updated_at),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
