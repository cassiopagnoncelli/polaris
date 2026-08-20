/**
 * The drift check's own correctness.
 *
 * Its first version parsed only `- family: X` and reported all five
 * destinations as drifted — they use the bare `- resolved.events` shape.
 * Six false positives, which is how a check teaches people to ignore it,
 * so both shapes are pinned here.
 */

import { describe, expect, it } from "vitest";

import {
  declaredFamilies,
  declaredStores,
  familyFromConstant,
  findDrift,
  usesRedis,
  wiredFamilies,
} from "../lint-manifest-drift.mjs";

describe("familyFromConstant", () => {
  it("turns a constant name into the family it names", () => {
    expect(familyFromConstant("STREAM_FAMILY_RAW_EVENTS")).toBe("raw.events");
    expect(familyFromConstant("STREAM_FAMILY_PROFILE_EVENTS")).toBe("profile.events");
    expect(familyFromConstant("STREAM_FAMILY_REJECTED_EVENTS")).toBe("rejected.events");
  });
});

describe("declaredFamilies", () => {
  it("reads the keyed shape processors use", () => {
    const declared = declaredFamilies(
      'inputs:\n  - family: raw.events\n    schema_versions: "*"\noutputs:\n  - family: session.events\n',
    );
    expect([...declared.inputs]).toEqual(["raw.events"]);
    expect([...declared.outputs]).toEqual(["session.events"]);
  });

  it("reads the bare shape destinations use", () => {
    // The shape the first version missed.
    const declared = declaredFamilies("inputs:\n  - resolved.events\n  - profile.events\n");
    expect([...declared.inputs].sort()).toEqual(["profile.events", "resolved.events"]);
  });

  it("stops at the next top-level key, so a later list is not absorbed", () => {
    const declared = declaredFamilies(
      "inputs:\n  - raw.events\nstate_stores:\n  - redis:sessions\n",
    );
    expect([...declared.inputs]).toEqual(["raw.events"]);
  });
});

describe("wiredFamilies", () => {
  it("reads a subscription as an input and a publish as an output", () => {
    const { inputs, outputs } = wiredFamilies(`
      const families = consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, isolated);
      await producer.publishEvent({ family: STREAM_FAMILY_SESSION_EVENTS, event });
    `);
    expect([...inputs]).toEqual(["raw.events"]);
    expect([...outputs]).toEqual(["session.events"]);
  });

  it("reads a list-valued inputFamily as several inputs", () => {
    const { inputs } = wiredFamilies(
      "inputFamily: [STREAM_FAMILY_RESOLVED_EVENTS, STREAM_FAMILY_PROFILE_EVENTS],",
    );
    expect([...inputs].sort()).toEqual(["profile.events", "resolved.events"]);
  });

  it("ignores a family named only in an import or a comment", () => {
    // Otherwise every unit would appear to wire everything it imports,
    // and the check would have nothing to say.
    const { inputs, outputs } = wiredFamilies(`
      import { STREAM_FAMILY_RAW_EVENTS } from "@polaris/bus";
      // Mentions STREAM_FAMILY_PROFILE_EVENTS in prose.
      /* And STREAM_FAMILY_IDENTITY_EVENTS in a block. */
    `);
    expect([...inputs]).toEqual([]);
    expect([...outputs]).toEqual([]);
  });

  it("counts a family that is both consumed and produced as an input", () => {
    // `subscribe({ families: [...] })` matches the output pattern too.
    const { inputs, outputs } = wiredFamilies(`
      consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, []);
      subscribe({ families: [STREAM_FAMILY_RAW_EVENTS] });
    `);
    expect([...inputs]).toEqual(["raw.events"]);
    expect([...outputs]).toEqual([]);
  });
});

describe("state stores", () => {
  it("reads declared stores", () => {
    expect([...declaredStores("state_stores:\n  - redis:sessions\n")]).toEqual(["redis:sessions"]);
  });

  it("detects Redis through the config schema, not through the word", () => {
    // A comment mentioning Redis is not a dependency.
    expect(usesRedis("// sessions live in Redis\nconst x = 1;")).toBe(false);
    expect(usesRedis("redis: redisEnvSchema,")).toBe(true);
  });
});

describe("the repository", () => {
  it("has no manifest drift", () => {
    // The gate. Running it here as well as in `pnpm lint` means a drift
    // fails the unit suite too, which is what most contributors run.
    expect(findDrift()).toEqual([]);
  });
});

describe("manifest tests load their own version", () => {
  it("is asserted by findDrift, which the repository check above covers", () => {
    // The escape this catches: sessionizer v2's test was copied from v1
    // and kept `version: "v1"`, so it asserted v1's manifest twice while
    // sitting in v2's directory. Its claims about `raw.events` and
    // `memory:sessions` were true — of the file it was really reading.
    //
    // Asserted through the real repository rather than a fixture: the
    // fixture would prove the regex works, and what matters is that no
    // unit in the tree has the mismatch.
    expect(findDrift().filter((p) => p.reason.includes("while living in"))).toEqual([]);
  });
});
