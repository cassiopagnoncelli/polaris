/**
 * Touchpoint-chain repository tests (ADR 0005).
 *
 * The key parser is pure and gets the bulk of the coverage here: it is
 * the piece that turns an opaque runtime key into queryable columns, and
 * its trailing-colon rule is the kind of thing that looks obvious and is
 * wrong under a customer id like `crm:acct:9`.
 *
 * The SQL itself is exercised against a real PostgreSQL in the
 * integration suite rather than mocked here — a hand-rolled Kysely fake
 * would assert that the query builder was called, not that the upsert
 * preserves first-touch, which is the only property worth pinning.
 */

import { describe, expect, it } from "vitest";

import { parseTouchpointStoreKey } from "../src/repository.js";

describe("parseTouchpointStoreKey", () => {
  it("splits the canonical key into queryable parts", () => {
    expect(
      parseTouchpointStoreKey("checkout::production::01a00000-0000-7000-8000-00000000f001"),
    ).toEqual({
      project_id: "checkout",
      environment: "production",
      primary_identifier_kind: "profile_id",
      primary_identifier_value: "01a00000-0000-7000-8000-00000000f001",
    });
  });

  it("treats a colon in the tail as part of the value", () => {
    // v1/v2 encoded `<kind>:<value>` in the tail, so a namespaced
    // customer id needed care about which colon separated them. v3 keys
    // on a profile id and the whole tail IS the value, so a colon in it
    // is simply part of the value rather than a delimiter.
    const parsed = parseTouchpointStoreKey("checkout::production::crm:acct:9");
    expect(parsed?.primary_identifier_kind).toBe("profile_id");
    expect(parsed?.primary_identifier_value).toBe("crm:acct:9");
  });

  it("round-trips the key shape the runtime builds", () => {
    const key = "storefront::staging::01a00000-0000-7000-8000-00000000f001";
    const parsed = parseTouchpointStoreKey(key);
    expect(
      `${parsed?.project_id}::${parsed?.environment}::${parsed?.primary_identifier_value}`,
    ).toBe(key);
  });

  it.each([
    ["", "empty"],
    ["checkout::production", "missing identifier segment"],
    ["checkout::production::", "empty identifier"],
    ["::production::01a00000-0000-7000-8000-00000000f001", "empty project"],
    ["checkout::::01a00000-0000-7000-8000-00000000f001", "empty environment"],
    ["a::b::c::01a00000-0000-7000-8000-00000000f001", "too many segments"],
  ])("rejects %j (%s)", (key) => {
    expect(parseTouchpointStoreKey(key)).toBeUndefined();
  });
});
