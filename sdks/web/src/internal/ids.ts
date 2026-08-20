/**
 * SDK-side ID generation for `@polaris/web-sdk`.
 *
 * Per `docs/architecture/09-engineering-standards.md`:
 *   - SDK-generated `event_id` should be UUIDv7.
 *
 * `anonymous_id` and `session_id` use the same UUIDv7 generator with a
 * stable `anon_` / `sess_` prefix so log lines and downstream identity
 * resolver evidence remain readable. The Node SDK uses the identical
 * shape — application code can compare IDs across runtimes without
 * special-casing.
 *
 * `event_id` is an unadorned UUIDv7 (no prefix) so it matches the
 * envelope's `event_id` field shape directly.
 */

import { v7 as uuidv7 } from "uuid";

export type IdentityPrefix = "anon" | "sess";

/** Fresh UUIDv7 suitable for `anonymous_id` / `session_id` defaults. */
export function newIdentityId(prefix: IdentityPrefix): string {
  return `${prefix}_${uuidv7()}`;
}

/** Fresh UUIDv7 suitable for `event_id`. */
export function newEventId(): string {
  return uuidv7();
}
