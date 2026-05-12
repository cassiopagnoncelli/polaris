/**
 * `LayeredIdentityStore` — capability detection + fallback orchestration.
 *
 * Verifies the doctrinal fallback order from `10-sdk-standards.md`:
 *   cookie -> localStorage -> sessionStorage -> memory.
 *
 * The store hydrates from the strongest available layer; if the primary
 * layer is empty but a lower-priority layer has data, it promotes the
 * record up to the primary layer. The mirror layer (typically
 * localStorage) is also written so the localStorage-mirror rule from
 * the architecture doc holds.
 */

import { describe, expect, it } from "vitest";

import { LayeredIdentityStore } from "../src/identity/layered-store.js";
import { MemoryStore } from "../src/identity/memory-store.js";
import type {
  IdentityCapability,
  IdentityStore,
  PersistedIdentity,
  StorageLayer,
} from "../src/types.js";

class FakeStore implements IdentityStore {
  public readonly layer: StorageLayer;
  public available: boolean;
  public reads: number = 0;
  public writes: PersistedIdentity[] = [];
  public clears: number = 0;
  private value: PersistedIdentity | null;

  public constructor(
    layer: StorageLayer,
    available: boolean,
    initial: PersistedIdentity | null = null,
  ) {
    this.layer = layer;
    this.available = available;
    this.value = initial;
  }

  public isAvailable(): boolean {
    return this.available;
  }
  public read(): PersistedIdentity | null {
    this.reads += 1;
    return this.value;
  }
  public write(identity: PersistedIdentity): boolean {
    this.writes.push(identity);
    this.value = identity;
    return true;
  }
  public clear(): boolean {
    this.clears += 1;
    this.value = null;
    return true;
  }
}

function makeCapability(
  primary: StorageLayer,
  available: readonly StorageLayer[],
): IdentityCapability {
  return Object.freeze({
    available: Object.freeze([...available]),
    primary,
    degraded: primary === "memory" || primary === "sessionStorage",
    webview: false,
    secureContext: false,
  });
}

const baseIdentity: PersistedIdentity = {
  anonymous_id: "anon_layered",
  session_id: "sess_layered",
  customer_id: null,
  last_activity_at: 1_700_000_000_000,
  storage_layer: "cookie",
};

describe("LayeredIdentityStore", () => {
  it("writes to the highest-priority available layer", () => {
    const cookie = new FakeStore("cookie", true);
    const local = new FakeStore("localStorage", true);
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, new MemoryStore()],
      capability: makeCapability("cookie", ["cookie", "localStorage", "memory"]),
      mirrorLayer: "localStorage",
    });
    const landed = layered.write(baseIdentity);
    expect(landed).toBe("cookie");
    expect(cookie.writes).toHaveLength(1);
    expect(cookie.writes[0]?.storage_layer).toBe("cookie");
  });

  it("mirrors writes into the mirror layer when distinct from primary", () => {
    const cookie = new FakeStore("cookie", true);
    const local = new FakeStore("localStorage", true);
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, new MemoryStore()],
      capability: makeCapability("cookie", ["cookie", "localStorage", "memory"]),
      mirrorLayer: "localStorage",
    });
    layered.write(baseIdentity);
    expect(local.writes).toHaveLength(1);
    expect(local.writes[0]?.storage_layer).toBe("localStorage");
  });

  it("does not mirror when mirror equals primary", () => {
    // Cookie unavailable -> primary is localStorage; mirror is localStorage too.
    const local = new FakeStore("localStorage", true);
    const layered = new LayeredIdentityStore({
      stores: [local, new MemoryStore()],
      capability: makeCapability("localStorage", ["localStorage", "memory"]),
      mirrorLayer: "localStorage",
    });
    layered.write(baseIdentity);
    expect(local.writes).toHaveLength(1);
  });

  it("falls forward to the next layer when the primary is unavailable", () => {
    const cookie = new FakeStore("cookie", false);
    const local = new FakeStore("localStorage", true);
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, new MemoryStore()],
      capability: makeCapability("localStorage", ["localStorage", "memory"]),
    });
    const landed = layered.write(baseIdentity);
    expect(landed).toBe("localStorage");
    expect(cookie.writes).toHaveLength(0);
    expect(local.writes).toHaveLength(1);
  });

  it("reads from the highest-priority layer when it has data", () => {
    const cookie = new FakeStore("cookie", true, { ...baseIdentity, anonymous_id: "anon_c" });
    const local = new FakeStore("localStorage", true, { ...baseIdentity, anonymous_id: "anon_l" });
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, new MemoryStore()],
      capability: makeCapability("cookie", ["cookie", "localStorage", "memory"]),
    });
    const got = layered.read();
    expect(got?.anonymous_id).toBe("anon_c");
  });

  it("promotes a lower-layer record up to the primary when the primary is empty", () => {
    const cookie = new FakeStore("cookie", true, null);
    const local = new FakeStore("localStorage", true, { ...baseIdentity, anonymous_id: "anon_l" });
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, new MemoryStore()],
      capability: makeCapability("cookie", ["cookie", "localStorage", "memory"]),
    });
    const got = layered.read();
    expect(got?.anonymous_id).toBe("anon_l");
    expect(cookie.writes).toHaveLength(1);
    expect(cookie.writes[0]?.storage_layer).toBe("cookie");
    // The lower layer is cleared so the canonical record lives at one layer.
    expect(local.clears).toBe(1);
  });

  it("returns null when no layer has data", () => {
    const cookie = new FakeStore("cookie", true);
    const local = new FakeStore("localStorage", true);
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, new MemoryStore()],
      capability: makeCapability("cookie", ["cookie", "localStorage", "memory"]),
    });
    expect(layered.read()).toBeNull();
  });

  it("clear clears every available layer", () => {
    const cookie = new FakeStore("cookie", true, baseIdentity);
    const local = new FakeStore("localStorage", true, baseIdentity);
    const memory = new MemoryStore();
    memory.write(baseIdentity);
    const layered = new LayeredIdentityStore({
      stores: [cookie, local, memory],
      capability: makeCapability("cookie", ["cookie", "localStorage", "memory"]),
    });
    layered.clear();
    expect(cookie.clears).toBe(1);
    expect(local.clears).toBe(1);
    expect(memory.read()).toBeNull();
  });

  it("throws when constructed without any stores", () => {
    expect(
      () =>
        new LayeredIdentityStore({
          stores: [],
          capability: makeCapability("memory", ["memory"]),
        }),
    ).toThrowError(/at least one/);
  });
});
