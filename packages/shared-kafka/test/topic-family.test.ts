import { describe, expect, it } from "vitest";

import {
  consumerTopicsForFamily,
  resolveTopicName,
  resolveTopicNameSync,
  sharedOnlyIsolationLookup,
  staticIsolationLookup,
} from "../src/topic-family.js";
import { TOPIC_FAMILY_RAW_EVENTS } from "../src/topics.js";

describe("sharedOnlyIsolationLookup", () => {
  it("always returns the shared family topic", () => {
    expect(
      resolveTopicNameSync(TOPIC_FAMILY_RAW_EVENTS, "project-alpha", sharedOnlyIsolationLookup),
    ).toBe("raw.events");
  });
});

describe("staticIsolationLookup", () => {
  const lookup = staticIsolationLookup([
    { family: TOPIC_FAMILY_RAW_EVENTS, project_id: "project-iso" },
  ]);

  it("returns the dedicated topic when the project is isolated", () => {
    expect(resolveTopicNameSync(TOPIC_FAMILY_RAW_EVENTS, "project-iso", lookup)).toBe(
      "raw.events.project-iso",
    );
  });

  it("returns the shared topic for non-isolated projects", () => {
    expect(resolveTopicNameSync(TOPIC_FAMILY_RAW_EVENTS, "project-shared", lookup)).toBe(
      "raw.events",
    );
  });
});

describe("resolveTopicName (async)", () => {
  it("returns the dedicated topic when isolated", async () => {
    const lookup = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async isIsolated() {
        return true;
      },
    };
    expect(await resolveTopicName(TOPIC_FAMILY_RAW_EVENTS, "project-x", lookup)).toBe(
      "raw.events.project-x",
    );
  });

  it("returns the shared topic when not isolated", async () => {
    const lookup = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async isIsolated() {
        return false;
      },
    };
    expect(await resolveTopicName(TOPIC_FAMILY_RAW_EVENTS, "project-x", lookup)).toBe("raw.events");
  });
});

describe("resolveTopicNameSync", () => {
  it("rejects non-canonical families", () => {
    expect(() =>
      resolveTopicNameSync("not.a.family", "project-x", sharedOnlyIsolationLookup),
    ).toThrow();
  });
});

describe("consumerTopicsForFamily", () => {
  it("returns the shared topic when no project is isolated", () => {
    expect(consumerTopicsForFamily(TOPIC_FAMILY_RAW_EVENTS, [])).toEqual(["raw.events"]);
  });

  it("returns shared + dedicated topics when projects are isolated", () => {
    expect(consumerTopicsForFamily(TOPIC_FAMILY_RAW_EVENTS, ["project-a", "project-b"])).toEqual([
      "raw.events",
      "raw.events.project-a",
      "raw.events.project-b",
    ]);
  });

  it("rejects non-canonical families", () => {
    expect(() => consumerTopicsForFamily("not.a.family", [])).toThrow();
  });
});
