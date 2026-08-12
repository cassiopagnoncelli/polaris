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
    expect(parseTouchpointStoreKey("checkout::production::anonymous_id:anon_X")).toEqual({
      project_id: "checkout",
      environment: "production",
      primary_identifier_kind: "anonymous_id",
      primary_identifier_value: "anon_X",
    });
  });

  it("keeps colons inside the identifier value", () => {
    // A namespaced customer id is legitimate; only the first colon after
    // the environment separates kind from value.
    const parsed = parseTouchpointStoreKey("checkout::production::customer_id:crm:acct:9");
    expect(parsed?.primary_identifier_kind).toBe("customer_id");
    expect(parsed?.primary_identifier_value).toBe("crm:acct:9");
  });

  it("round-trips the key shape the runtime builds", () => {
    // buildTouchpointStoreKey joins with `::` and a single `:`.
    const key = "storefront::staging::session_id:sess_123";
    const parsed = parseTouchpointStoreKey(key);
    expect(
      `${parsed?.project_id}::${parsed?.environment}::${parsed?.primary_identifier_kind}:${parsed?.primary_identifier_value}`,
    ).toBe(key);
  });

  it.each([
    ["", "empty"],
    ["checkout::production", "missing identifier segment"],
    ["checkout::production::anonymous_id", "no kind/value colon"],
    ["checkout::production::anonymous_id:", "empty value"],
    ["checkout::production:::anon_X", "empty kind"],
    ["::production::anonymous_id:anon_X", "empty project"],
    ["checkout::::anonymous_id:anon_X", "empty environment"],
    ["a::b::c::anonymous_id:anon_X", "too many segments"],
  ])("rejects %j (%s)", (key) => {
    expect(parseTouchpointStoreKey(key)).toBeUndefined();
  });
});
