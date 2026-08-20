import { describe, expect, it } from "vitest";

import {
  archiveBatchKey,
  archiveDateOf,
  archiveDatesInWindow,
  archiveDayPrefix,
  archiveEnvironmentPrefix,
  padOffset,
  parseArchiveBatchKey,
  unpadOffset,
} from "../src/layout.js";

const PREFIX = "polaris";

describe("archiveBatchKey", () => {
  it("is deterministic and round-trips through the parser", () => {
    // Writer and reader share this module for exactly this reason: a
    // layout that drifts fails silently, because a replay that finds
    // nothing looks like a window with no events.
    const key = archiveBatchKey({
      prefix: PREFIX,
      projectId: "storefront",
      environment: "production",
      date: "2026-08-15",
      stream: "raw.events-3",
      firstOffset: "1200",
      lastOffset: "1999",
    });

    expect(key).toBe(
      "polaris/v1/storefront/production/2026-08-15/raw.events-3/" +
        "00000000000000001200-00000000000000001999.ndjson",
    );
    expect(parseArchiveBatchKey(PREFIX, key)).toEqual({
      projectId: "storefront",
      environment: "production",
      date: "2026-08-15",
      stream: "raw.events-3",
      firstOffset: "1200",
      lastOffset: "1999",
    });
  });

  it("pads so lexicographic order is offset order", () => {
    // Unpadded, "10" sorts before "9" — so a listing returns batches out
    // of order and a reader that stops early stops at the wrong place.
    const nine = padOffset("9");
    const ten = padOffset("10");
    expect(nine < ten).toBe(true);
    expect(unpadOffset(nine)).toBe("9");
    expect(unpadOffset(padOffset("0"))).toBe("0");
  });

  it("refuses an offset that is not decimal digits", () => {
    expect(() => padOffset("12a")).toThrow(/decimal digits/);
  });

  it("refuses an offset too wide to pad, rather than sorting it wrong", () => {
    expect(() => padOffset("1".repeat(21))).toThrow(/exceeds 20 digits/);
  });
});

describe("parseArchiveBatchKey", () => {
  it("returns null for a manifest rather than throwing", () => {
    // A lister that threw on the first unfamiliar key would let one
    // unrelated object in the bucket break every replay.
    expect(
      parseArchiveBatchKey(PREFIX, "polaris/v1/s/production/2026-08-15/_manifest.ndjson"),
    ).toBeNull();
  });

  it("returns null for a future layout version", () => {
    expect(
      parseArchiveBatchKey(PREFIX, "polaris/v2/s/production/2026-08-15/raw.events-0/1-2.ndjson"),
    ).toBeNull();
  });

  it("returns null for an unrelated object sharing the bucket", () => {
    expect(parseArchiveBatchKey(PREFIX, "some/other/tool/output.ndjson")).toBeNull();
  });

  it("handles an empty prefix", () => {
    const key = archiveBatchKey({
      prefix: "",
      projectId: "s",
      environment: "production",
      date: "2026-08-15",
      stream: "raw.events-0",
      firstOffset: "1",
      lastOffset: "2",
    });
    expect(key.startsWith("v1/")).toBe(true);
    expect(parseArchiveBatchKey("", key)?.firstOffset).toBe("1");
  });

  it("tolerates a prefix written with stray slashes", () => {
    expect(
      archiveDayPrefix({
        prefix: "/polaris/",
        projectId: "s",
        environment: "production",
        date: "2026-08-15",
      }),
    ).toBe("polaris/v1/s/production/2026-08-15/");
  });
});

describe("archiveDateOf", () => {
  it("uses UTC, so a timezone change never moves objects between prefixes", () => {
    expect(archiveDateOf("2026-08-15T23:59:59.999Z")).toBe("2026-08-15");
    expect(archiveDateOf("2026-08-16T00:00:00.000Z")).toBe("2026-08-16");
  });

  it("returns null for an unparseable timestamp", () => {
    expect(archiveDateOf("not-a-date")).toBeNull();
  });
});

describe("archiveDatesInWindow", () => {
  it("includes the day the window ends on", () => {
    // Off-by-one here means a replay silently misses its last second.
    expect(archiveDatesInWindow("2026-08-15T23:00:00Z", "2026-08-16T00:00:01Z")).toEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("returns one day for a window inside a day", () => {
    expect(archiveDatesInWindow("2026-08-15T01:00:00Z", "2026-08-15T02:00:00Z")).toEqual([
      "2026-08-15",
    ]);
  });

  it("spans a month boundary", () => {
    expect(archiveDatesInWindow("2026-08-31T23:00:00Z", "2026-09-01T01:00:00Z")).toEqual([
      "2026-08-31",
      "2026-09-01",
    ]);
  });

  it("returns nothing for an inverted or unparseable window", () => {
    expect(archiveDatesInWindow("2026-08-16T00:00:00Z", "2026-08-15T00:00:00Z")).toEqual([]);
    expect(archiveDatesInWindow("nope", "2026-08-15T00:00:00Z")).toEqual([]);
  });
});

describe("archiveEnvironmentPrefix", () => {
  it("is the parent of the day prefixes, with no empty segment", () => {
    // A delimiter listing here is how coverage is answered; a stray
    // double slash would make every child prefix unparseable.
    const base = archiveEnvironmentPrefix({
      prefix: PREFIX,
      projectId: "s",
      environment: "production",
    });
    expect(base).toBe("polaris/v1/s/production/");
    expect(
      archiveDayPrefix({
        prefix: PREFIX,
        projectId: "s",
        environment: "production",
        date: "2026-08-15",
      }),
    ).toBe(`${base}2026-08-15/`);
  });
});
