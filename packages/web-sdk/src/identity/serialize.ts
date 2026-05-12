/**
 * Identity record (de)serialization shared by every storage layer.
 *
 * The SDK persists a single JSON-encoded record per layer so a cookie
 * write does not need to manage four separate cookies and so a
 * localStorage read sees the same shape as a cookie read. Validation here
 * is intentionally permissive: a partial or corrupt payload (e.g. a
 * cross-version SDK that wrote a different shape) is treated as "nothing
 * stored", and the SDK falls forward to a fresh identity rather than
 * exploding on the customer's tab.
 */

import type { PersistedIdentity, StorageLayer } from "../types.js";

const KNOWN_LAYERS: readonly StorageLayer[] = [
  "cookie",
  "localStorage",
  "sessionStorage",
  "memory",
];

export function serializeIdentity(identity: PersistedIdentity): string {
  return JSON.stringify({
    anonymous_id: identity.anonymous_id,
    session_id: identity.session_id,
    customer_id: identity.customer_id,
    last_activity_at: identity.last_activity_at,
    storage_layer: identity.storage_layer,
  });
}

export function deserializeIdentity(raw: string | null | undefined): PersistedIdentity | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;

  const anonymous_id = candidate["anonymous_id"];
  const session_id = candidate["session_id"];
  const customer_id = candidate["customer_id"];
  const last_activity_at = candidate["last_activity_at"];
  const storage_layer = candidate["storage_layer"];

  if (typeof anonymous_id !== "string" || anonymous_id.length === 0) return null;
  if (typeof session_id !== "string" || session_id.length === 0) return null;
  if (customer_id !== null && (typeof customer_id !== "string" || customer_id.length === 0)) {
    return null;
  }
  if (typeof last_activity_at !== "number" || !Number.isFinite(last_activity_at)) return null;
  if (typeof storage_layer !== "string" || !KNOWN_LAYERS.includes(storage_layer as StorageLayer)) {
    return null;
  }

  return {
    anonymous_id,
    session_id,
    customer_id,
    last_activity_at,
    storage_layer: storage_layer as StorageLayer,
  };
}
