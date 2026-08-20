/**
 * `MemoryStore` — last-resort identity layer.
 *
 * Always available, scoped to a single execution context, cleared on
 * page reload. The SDK uses memory only when cookie, localStorage, and
 * sessionStorage are all unavailable (typical for some ad WebViews and
 * locked-down iframes).
 */

import { describe, expect, it } from "vitest";

import { MemoryStore } from "../src/identity/memory-store.js";
import type { PersistedIdentity } from "../src/types.js";

const identity: PersistedIdentity = {
  anonymous_id: "anon_mem",
  session_id: "sess_mem",
  customer_id: null,
  last_activity_at: 1_700_000_000_000,
  storage_layer: "memory",
};

describe("MemoryStore", () => {
  it("is always available", () => {
    expect(new MemoryStore().isAvailable()).toBe(true);
  });

  it("round-trips a write and a read", () => {
    const store = new MemoryStore();
    store.write(identity);
    expect(store.read()?.anonymous_id).toBe("anon_mem");
  });

  it("clear removes the in-memory record", () => {
    const store = new MemoryStore();
    store.write(identity);
    store.clear();
    expect(store.read()).toBeNull();
  });
});
