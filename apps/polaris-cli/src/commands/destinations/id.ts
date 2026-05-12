/**
 * `destination_id` generator and constants for the `polaris destinations`
 * command group.
 *
 * The id shape mirrors the `polaris_ak_<uuidv7>` shape used for API keys
 * (see `commands/keys/token.ts`) so platform-issued ids stay greppable and
 * type-distinguishable at a glance:
 *
 *   - `polaris_ak_<uuidv7>`  API key id (P6-003)
 *   - `polaris_dst_<uuidv7>` destination instance id (P6-004, this file)
 *   - `polaris_ot_<uuidv7>`  operator token id (P6-007)
 *
 * Mirrors the `destinations_destination_id_format` CHECK constraint in
 * `db/migrations/20260512000005_create_destinations.sql`.
 */

import { v7 as uuidv7 } from "uuid";

/**
 * Prefix marker on `destination_id`. Distinct from other Polaris-issued id
 * prefixes so id strings are self-describing.
 */
export const DESTINATION_ID_PREFIX = "polaris_dst_";

/**
 * Generate a fresh `polaris_dst_<uuidv7>` id. UUIDv7 keeps the lexical
 * ordering aligned with creation time so the migration's index supports
 * range scans by recency without an explicit `created_at` index.
 */
export function generateDestinationId(): string {
  return `${DESTINATION_ID_PREFIX}${uuidv7()}`;
}
