/**
 * A dashboard's family picker must offer the families that exist.
 *
 * The three per-project dashboards each carried the same hardcoded list —
 * `raw, identity, enriched, attribution, analytics` — written when those
 * were the five families. `enriched.events` and `analytics.events` were
 * retired by `f9ae3d0`, and `identified`, `resolved`, `profile` and
 * `session` were never added. So the picker offered two families that
 * cannot exist and hid four that carry the entire spine.
 *
 * Nothing could have caught it. `lint-metric-names.mjs` checks that a
 * dashboard names a metric something emits, and says in its own header
 * that it deliberately does not verify LABELS — proving a label VALUE
 * selects real series needs call-site analysis. This is the label-value
 * half, for the one label whose legal values are a checked-in constant.
 *
 * The failure mode is the one that lint was written for and this slipped
 * past: selecting `analytics.events` renders an empty panel, and an empty
 * panel reads as "nothing is happening" rather than "this family was
 * deleted a year ago".
 *
 * `CANONICAL_STREAM_FAMILIES` and not every `STREAM_FAMILY_*`: these are
 * PER-PROJECT dashboards, and that constant is exactly the set that
 * supports per-project isolation. `rejected.events` is deliberately
 * outside it — it has no spine consumer to starve — so its absence from a
 * per-project picker is correct rather than an omission.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The families, read out of `streams.ts` rather than imported.
 *
 * A `scripts/` test importing a workspace package would need that package
 * built to run a check, and a check that needs a build is one that gets
 * skipped — the same argument `lint-manifest-drift.mjs` makes for scanning
 * source textually.
 */
function canonicalFamilies(): readonly string[] {
  const source = readFileSync(join(ROOT, "libs", "bus", "src", "streams.ts"), "utf8");
  const literals = new Map<string, string>();
  for (const match of source.matchAll(/export const (STREAM_FAMILY_[A-Z_]+) = "([a-z.]+)"/g)) {
    literals.set(match[1] as string, match[2] as string);
  }
  const block = /export const CANONICAL_STREAM_FAMILIES = \[([\s\S]*?)\] as const;/.exec(source);
  if (block === null) throw new Error("CANONICAL_STREAM_FAMILIES not found in streams.ts");
  const families = [...(block[1] as string).matchAll(/STREAM_FAMILY_[A-Z_]+/g)].map((m) => {
    const value = literals.get(m[0]);
    if (value === undefined) throw new Error(`no literal for ${m[0]}`);
    return value;
  });
  if (families.length === 0) throw new Error("parsed an empty family list");
  return families;
}

/** Dashboards whose `topic_family` variable this governs. */
const DASHBOARDS = [
  "infra/grafana/dashboards/per-partition-skew.json",
  "infra/grafana/dashboards/per-project-consumer-lag.json",
  "infra/grafana/dashboards/per-project-shared-topic-throughput.json",
];

interface TemplateVariable {
  readonly name?: string;
  readonly query?: string;
  readonly options?: ReadonlyArray<{ readonly value?: string }>;
  readonly current?: { readonly value?: string };
}

function topicFamilyVariable(path: string): TemplateVariable {
  const dashboard = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as {
    templating?: { list?: readonly TemplateVariable[] };
  };
  const variable = dashboard.templating?.list?.find((entry) => entry.name === "topic_family");
  if (variable === undefined) {
    throw new Error(`${relative(ROOT, path)} has no topic_family template variable`);
  }
  return variable;
}

describe("the per-project dashboards' topic_family picker", () => {
  const families = canonicalFamilies();

  it("reads a non-empty family list from streams.ts", () => {
    // Guards the guard: a parse that silently returned [] would make every
    // assertion below vacuously true against any dashboard at all.
    expect(families.length).toBeGreaterThanOrEqual(5);
    expect(families).toContain("resolved.events");
  });

  it.each(DASHBOARDS)("%s offers exactly the canonical families", (path) => {
    const variable = topicFamilyVariable(path);
    const offered = (variable.options ?? []).map((option) => option.value);
    expect([...offered].sort()).toEqual([...families].sort());
  });

  it.each(DASHBOARDS)("%s keeps query and options in agreement", (path) => {
    // Grafana renders the dropdown from `options` and re-derives it from
    // `query` when the dashboard is edited and saved. The two disagreeing
    // means the list silently changes the first time somebody touches it.
    const variable = topicFamilyVariable(path);
    const fromQuery = (variable.query ?? "").split(",").filter((part) => part.length > 0);
    const fromOptions = (variable.options ?? []).map((option) => option.value);
    expect(fromQuery).toEqual(fromOptions);
  });

  it.each(DASHBOARDS)("%s defaults to a family that exists", (path) => {
    const variable = topicFamilyVariable(path);
    expect(families).toContain(variable.current?.value);
  });
});
