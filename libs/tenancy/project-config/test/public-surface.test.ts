/**
 * The package's public API is a contract, not an accident: every service will
 * import from the root. This test fails if a symbol is dropped or renamed, and
 * pins the tuning constants so a change to them is deliberate.
 */

import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public surface", () => {
  it("exports the documented symbols", () => {
    const expected = [
      "CONFIG_NOTIFY_CHANNEL",
      "DEFAULT_CACHE_CAPACITY",
      "DEFAULT_SWEEP_INTERVAL_MS",
      "SWEEP_JITTER_RATIO",
      "PinMissingError",
      "ProjectConfigAssemblyError",
      "ProjectConfigError",
      "createPgListenerTransport",
      "parseConfigChangeMessage",
      "isSecret",
      "Secret",
      "createProjectConfigStore",
    ];
    for (const name of expected) {
      expect(Object.keys(api)).toContain(name);
    }
  });

  it("does not leak internals from the root", () => {
    // The LRU and assembly helpers are implementation detail; exporting them
    // would invite a service to reach around the store.
    for (const name of ["BoundedLru", "assembleSnapshot", "readVersions", "snapshotKey"]) {
      expect(Object.keys(api)).not.toContain(name);
    }
  });

  it("pins the tuning constants", () => {
    expect(api.CONFIG_NOTIFY_CHANNEL).toBe("polaris_config_changed");
    expect(api.DEFAULT_CACHE_CAPACITY).toBe(4096);
    expect(api.DEFAULT_SWEEP_INTERVAL_MS).toBe(10_000);
    expect(api.SWEEP_JITTER_RATIO).toBe(0.2);
  });

  it("no longer exports a secret-refresh deadline", () => {
    // Removed with the move from `provider:ref` pointers to stored secrets:
    // a wall-clock re-resolution deadline existed to catch rotations that
    // happened outside the database, and there are none. Asserted rather than
    // simply deleted so re-adding one is a deliberate act with a test to
    // change, not a quiet reintroduction of a periodic no-op refetch.
    expect(Object.keys(api)).not.toContain("SECRET_REFRESH_DEADLINE_MS");
  });
});

describe("parseConfigChangeMessage", () => {
  it("parses a well-formed payload", () => {
    const msg = api.parseConfigChangeMessage(
      JSON.stringify({ project_id: "storefront", environment: "production", version: 12 }),
    );
    expect(msg).toEqual({
      project_id: "storefront",
      environment: "production",
      version: 12n,
    });
  });

  it("accepts a string version without losing precision", () => {
    const big = "9007199254740993";
    expect(
      api.parseConfigChangeMessage(
        JSON.stringify({ project_id: "p", environment: "production", version: big }),
      )?.version,
    ).toBe(BigInt(big));
  });

  it("returns null rather than throwing on malformed input", () => {
    // Any session on the database can NOTIFY the channel, so a bad payload
    // must not take the listener down. The sweep catches what is missed.
    for (const bad of [
      undefined,
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ environment: "production", version: 1 }),
      JSON.stringify({ project_id: "p", version: 1 }),
      JSON.stringify({ project_id: "p", environment: "production" }),
      JSON.stringify({ project_id: "", environment: "production", version: 1 }),
      JSON.stringify({ project_id: "p", environment: "production", version: "abc" }),
    ]) {
      expect(api.parseConfigChangeMessage(bad as string | undefined)).toBeNull();
    }
  });
});
