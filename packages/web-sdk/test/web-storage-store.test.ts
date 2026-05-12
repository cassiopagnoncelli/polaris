// @vitest-environment happy-dom
/**
 * `localStorage` / `sessionStorage` identity persistence.
 *
 * Verifies the storage round-trip, the rejection behaviour when
 * `setItem` throws (Safari private-browsing pattern), and that the two
 * variants share a single implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalStorageStore,
  SessionStorageStore,
  WebStorageStore,
} from "../src/identity/web-storage-store.js";
import type { PersistedIdentity } from "../src/types.js";

function makeIdentity(): PersistedIdentity {
  return {
    anonymous_id: "anon_storage",
    session_id: "sess_storage",
    customer_id: null,
    last_activity_at: 1_700_000_000_000,
    storage_layer: "localStorage",
  };
}

/**
 * A `Storage`-shaped stub that throws on `setItem` — mirrors Safari's
 * QuotaExceededError when the user has Block All Cookies enabled and
 * iOS private-browsing's failure mode.
 */
function makeFailingStorage(): Storage {
  const stub: Storage = {
    length: 0,
    clear: () => {
      throw new Error("blocked");
    },
    getItem: () => null,
    key: () => null,
    removeItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  return stub;
}

describe("LocalStorageStore", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("reports as available when window.localStorage works", () => {
    const store = new LocalStorageStore({ storage: window.localStorage });
    expect(store.isAvailable()).toBe(true);
  });

  it("round-trips a write and a read", () => {
    const store = new LocalStorageStore({ storage: window.localStorage });
    expect(store.write(makeIdentity())).toBe(true);
    const got = store.read();
    expect(got?.anonymous_id).toBe("anon_storage");
  });

  it("returns null on malformed payload", () => {
    window.localStorage.setItem("polaris_id", "not-json");
    const store = new LocalStorageStore({ storage: window.localStorage });
    expect(store.read()).toBeNull();
  });

  it("returns false on writes when the storage throws", () => {
    const store = new LocalStorageStore({ storage: makeFailingStorage() });
    expect(store.isAvailable()).toBe(false);
    expect(store.write(makeIdentity())).toBe(false);
  });

  it("clears the storage entry", () => {
    const store = new LocalStorageStore({ storage: window.localStorage });
    store.write(makeIdentity());
    expect(store.clear()).toBe(true);
    expect(store.read()).toBeNull();
  });

  it("uses the configured key", () => {
    const store = new LocalStorageStore({ storage: window.localStorage, key: "polaris_alt" });
    store.write(makeIdentity());
    expect(window.localStorage.getItem("polaris_alt")).not.toBeNull();
    expect(window.localStorage.getItem("polaris_id")).toBeNull();
  });
});

describe("SessionStorageStore", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("layer is sessionStorage", () => {
    const store = new SessionStorageStore({ storage: window.sessionStorage });
    expect(store.layer).toBe("sessionStorage");
  });

  it("round-trips a write and a read", () => {
    const store = new SessionStorageStore({ storage: window.sessionStorage });
    expect(store.write({ ...makeIdentity(), storage_layer: "sessionStorage" })).toBe(true);
    expect(store.read()?.anonymous_id).toBe("anon_storage");
  });
});

describe("WebStorageStore (shared)", () => {
  it("returns null read when no storage is configured", () => {
    const store = new WebStorageStore({ storage: undefined, layer: "localStorage" });
    expect(store.isAvailable()).toBe(false);
    expect(store.read()).toBeNull();
    expect(store.write(makeIdentity())).toBe(false);
    expect(store.clear()).toBe(false);
  });
});
