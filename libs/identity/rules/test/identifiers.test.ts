/**
 * Identifier collection: which values count, in what order, and which are
 * refused before they can merge anything.
 *
 * The ordering assertions look fussy and are not. The resolution
 * transaction takes its locks in the order this function returns, so a
 * change that reorders the output changes which pairs of concurrent
 * events deadlock — and nothing else in the system would notice.
 */

import { describe, expect, it } from "vitest";

import { collectIdentifiers, type IdentityEnvelope, type IdentityPolicy } from "../src/index.js";

const OPEN: IdentityPolicy = {
  denylist: {},
  maxIdentifiersPerKind: 100,
  maxMergesPerWindow: 50,
  mergeWindowSeconds: 3600,
  maxTraitsBytes: 32768,
};

function envelope(identity: IdentityEnvelope["identity"]): IdentityEnvelope {
  return { event: "page.viewed", ...(identity === undefined ? {} : { identity }) };
}

describe("collectIdentifiers", () => {
  it("collects both strong identifiers in canonical order", () => {
    // anonymous_id before customer_id, alphabetically — the order the
    // advisory locks are taken in.
    const outcome = collectIdentifiers(
      envelope({ customer_id: "cust-1", anonymous_id: "anon-1" }),
      OPEN,
    );
    expect(outcome.identifiers.map((i) => i.kind)).toEqual(["anonymous_id", "customer_id"]);
  });

  it("orders identically whichever order the envelope carried them in", () => {
    const a = collectIdentifiers(envelope({ customer_id: "c", anonymous_id: "a" }), OPEN);
    const b = collectIdentifiers(envelope({ anonymous_id: "a", customer_id: "c" }), OPEN);
    expect(a.identifiers).toEqual(b.identifiers);
  });

  it("treats an absent, empty or whitespace value as absent", () => {
    // A producer sending `customer_id: "  "` is not naming anybody, and
    // binding it would give every such event the same person.
    expect(collectIdentifiers(envelope({ customer_id: "" }), OPEN).identifiers).toEqual([]);
    expect(collectIdentifiers(envelope({ customer_id: "   " }), OPEN).identifiers).toEqual([]);
    expect(collectIdentifiers(envelope({ customer_id: null }), OPEN).identifiers).toEqual([]);
    expect(collectIdentifiers(envelope(undefined), OPEN).identifiers).toEqual([]);
  });

  it("refuses a denylisted value and reports it separately", () => {
    // Denylisted values resolve as if absent — but the refusal is a fact,
    // not a silent skip, because it is what an operator watching a merge
    // storm needs to see.
    const policy: IdentityPolicy = { ...OPEN, denylist: { customer_id: new Set(["guest"]) } };
    const outcome = collectIdentifiers(
      envelope({ customer_id: "guest", anonymous_id: "anon-1" }),
      policy,
    );
    expect(outcome.identifiers.map((i) => i.value)).toEqual(["anon-1"]);
    expect(outcome.denylisted).toEqual([{ kind: "customer_id", value: "guest" }]);
  });

  it("scopes the denylist to its kind", () => {
    // The same string may be a real anonymous id and a junk customer id.
    const policy: IdentityPolicy = { ...OPEN, denylist: { customer_id: new Set(["kiosk"]) } };
    const outcome = collectIdentifiers(envelope({ anonymous_id: "kiosk" }), policy);
    expect(outcome.identifiers).toEqual([{ kind: "anonymous_id", value: "kiosk" }]);
    expect(outcome.denylisted).toEqual([]);
  });

  it("binds exactly the two kinds v1 declares, and no others", () => {
    // session_id rotates every 30 minutes and device_id is always null in
    // both SDKs; binding either spends the per-kind cap for no resolution
    // value. Asserted against an envelope carrying all four, so a kind
    // quietly added to the bound set fails here — which is the point,
    // since binding a new kind changes emitted events and therefore takes
    // a new processor version.
    const outcome = collectIdentifiers(
      envelope({
        customer_id: "cust-1",
        anonymous_id: "anon-1",
        session_id: "sess-1",
        device_id: "dev-1",
      }),
      OPEN,
    );
    expect(outcome.identifiers).toEqual([
      { kind: "anonymous_id", value: "anon-1" },
      { kind: "customer_id", value: "cust-1" },
    ]);
  });
});
