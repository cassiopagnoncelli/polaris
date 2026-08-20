/**
 * SDK-side ID generation.
 *
 * Per `docs/architecture/09-engineering-standards.md`:
 *   - SDK-generated `event_id` should be UUIDv7.
 *
 * UUIDv7 is preferred so the ingester's short-window dedupe layer and any
 * downstream ClickHouse storage can take advantage of the time-ordered
 * prefix for clustering. The same `uuid@^14` package is already used by
 * `@polaris/runtime-service-bootstrap`, so this is a re-use, not a new dep
 * choice for the workspace.
 */

import { v7 as uuidv7 } from "uuid";

/** Fresh UUIDv7 suitable for `event_id`. */
export function newEventId(): string {
  return uuidv7();
}

/** Fresh UUIDv7 suitable for `anonymous_id` / `session_id` defaults. */
export function newIdentityId(prefix: "anon" | "sess"): string {
  return `${prefix}_${uuidv7()}`;
}
