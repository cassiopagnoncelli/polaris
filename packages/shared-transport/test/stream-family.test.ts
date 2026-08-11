import { describe, expect, it } from "vitest";

import {
  consumerFamiliesFor,
  resolveStreamFamily,
  resolveStreamFamilySync,
  sharedOnlyIsolationLookup,
  staticIsolationLookup,
} from "../src/stream-family.js";
import { STREAM_FAMILY_RAW_EVENTS } from "../src/streams.js";

describe("sharedOnlyIsolationLookup", () => {
  it("always returns the shared family topic", () => {
    expect(
      resolveStreamFamilySync(STREAM_FAMILY_RAW_EVENTS, "project-alpha", sharedOnlyIsolationLookup),
    ).toBe("raw.events");
  });
});

describe("staticIsolationLookup", () => {
  const lookup = staticIsolationLookup([
    { family: STREAM_FAMILY_RAW_EVENTS, project_id: "project-iso" },
  ]);

  it("returns the dedicated topic when the project is isolated", () => {
    expect(resolveStreamFamilySync(STREAM_FAMILY_RAW_EVENTS, "project-iso", lookup)).toBe(
      "raw.events.project-iso",
    );
  });

  it("returns the shared topic for non-isolated projects", () => {
    expect(resolveStreamFamilySync(STREAM_FAMILY_RAW_EVENTS, "project-shared", lookup)).toBe(
      "raw.events",
    );
  });
});

describe("resolveStreamFamily (async)", () => {
  it("returns the dedicated topic when isolated", async () => {
    const lookup = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async isIsolated() {
        return true;
      },
    };
    expect(await resolveStreamFamily(STREAM_FAMILY_RAW_EVENTS, "project-x", lookup)).toBe(
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
    expect(await resolveStreamFamily(STREAM_FAMILY_RAW_EVENTS, "project-x", lookup)).toBe("raw.events");
  });
});

describe("resolveStreamFamilySync", () => {
  it("rejects non-canonical families", () => {
    expect(() =>
      resolveStreamFamilySync("not.a.family", "project-x", sharedOnlyIsolationLookup),
    ).toThrow();
  });
});

describe("consumerFamiliesFor", () => {
  it("returns the shared topic when no project is isolated", () => {
    expect(consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, [])).toEqual(["raw.events"]);
  });

  it("returns shared + dedicated topics when projects are isolated", () => {
    expect(consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, ["project-a", "project-b"])).toEqual([
      "raw.events",
      "raw.events.project-a",
      "raw.events.project-b",
    ]);
  });

  it("rejects non-canonical families", () => {
    expect(() => consumerFamiliesFor("not.a.family", [])).toThrow();
  });
});
