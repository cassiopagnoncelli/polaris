import { describe, expect, it } from "vitest";

import { ACTOR_SOURCES, isActorSource } from "../src/index.js";

describe("ACTOR_SOURCES closed set", () => {
  it("mirrors the audit_records CHECK constraint exactly", () => {
    // Order and membership must match
    // db/migrations/20260812000002_add_operator_token_actor_source.sql.
    expect([...ACTOR_SOURCES]).toEqual([
      "declared",
      "operator_token",
      "cli",
      "migration",
      "system",
    ]);
  });
});

describe("isActorSource", () => {
  it("accepts every value in the closed set", () => {
    for (const v of ACTOR_SOURCES) expect(isActorSource(v)).toBe(true);
  });

  it("rejects values outside the set (including the deprecated cli_token / cli_oidc names)", () => {
    // Earlier drafts of the doc used these names; the v1 closed set
    // collapsed them. This assertion is here so a future doc revert that
    // tries to widen the source set has to explicitly update the
    // migration's CHECK constraint as well.
    expect(isActorSource("cli_token")).toBe(false);
    expect(isActorSource("cli_oidc")).toBe(false);
    expect(isActorSource("authenticated")).toBe(false);
    expect(isActorSource("")).toBe(false);
    expect(isActorSource(undefined)).toBe(false);
    expect(isActorSource({})).toBe(false);
  });
});
