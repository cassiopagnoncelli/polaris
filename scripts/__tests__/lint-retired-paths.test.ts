/**
 * The retired-path check finds what a careful sweep did not.
 *
 * The R-programme move deleted `processors/` and `consumers/` and replaced
 * the fan-out with a chained spine. A docs pass followed and edited the
 * files somebody remembered; an audit weeks later found ninety more
 * references, including `polaris destinations --help` telling an operator
 * where mapper code lives and naming a directory that no longer existed.
 *
 * The sweep was not the fix — this check is. So the check itself has to be
 * worth trusting, which is what these assertions are for: each rule is
 * shown finding a real violation AND leaving a correct line alone, because
 * a pattern that matches everything and a pattern that matches nothing both
 * report a clean tree.
 *
 * The `PAST_TENSE` cases are the ones worth reading. A test asserting
 * `isCanonicalStreamFamily("enriched.events")` is `false` must NAME the
 * retired family to say anything about it, and a check that refused those
 * would push every such line into an exception list until nobody read it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findRetiredPaths, HISTORICAL, RETIRED } from "../lint-retired-paths.mjs";

describe("the rule set", () => {
  it("has a hint on every rule", () => {
    // The hint is the point: a failure should not send anybody to `git log`
    // to find out what the path became.
    for (const rule of RETIRED) {
      expect(rule.hint, `${rule.id} has no hint`).toBeTruthy();
      expect(rule.hint.length).toBeGreaterThan(20);
    }
  });

  it("keeps the historical exception list short", () => {
    // Not a style rule. Every entry is a claim that a file is about the
    // past on purpose, and a list long enough to skim is one nobody reads.
    expect(HISTORICAL.size).toBeLessThanOrEqual(8);
  });
});

describe("scanning a tree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-retired-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  function scan(): ReturnType<typeof findRetiredPaths> {
    return findRetiredPaths(root);
  }

  it("finds a retired processor directory", () => {
    write("docs/x.md", "Manifests live at `processors/<name>/v<n>/processor.manifest.yaml`.\n");
    expect(scan().map((p) => p.rule)).toContain("processors-dir");
  });

  it("finds a retired consumer directory", () => {
    write("apps/y.ts", "// mappers live in consumers/<vendor>/v<n>/mappers/\n");
    expect(scan().map((p) => p.rule)).toContain("consumers-dir");
  });

  it("finds the fan-out sentence", () => {
    write("docs/z.md", "Processors fan out from `raw.events` rather than chaining.\n");
    expect(scan().map((p) => p.rule)).toContain("fan-out-model");
  });

  it("finds the retired family", () => {
    write("packages/a/src/b.ts", "/** routes enriched.events to the processed queue */\n");
    expect(scan().map((p) => p.rule)).toContain("enriched-events-family");
  });

  it("reports the file and line, not just a count", () => {
    write("docs/x.md", "ok\nok\nSee `processors/<name>/v1/`.\n");
    const [problem] = scan();
    expect(problem?.file).toBe("docs/x.md");
    expect(problem?.line).toBe(3);
  });

  it("leaves the current layout alone", () => {
    write(
      "docs/ok.md",
      [
        "Units live at `{sync,async}/<stage>/<name>/<version>/`.",
        "Destinations are `sync/destinations/<vendor>/<version>/`.",
        "The spine chains: raw.events -> identified.events -> resolved.events.",
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });

  it("leaves a line that says the thing is GONE alone", () => {
    // The case that keeps the exception list short. Each of these has to
    // name the retired thing in order to say anything true about it.
    write(
      "packages/a/test/b.test.ts",
      [
        'expect(isCanonicalStreamFamily("enriched.events")).toBe(false);',
        "// `enriched.events` was retired with the fan-out.",
        "// The enriched family is no longer provisioned.",
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });

  it("skips applied migrations, which are a record and not a claim", () => {
    // Editing one to satisfy a lint would falsify the history it exists to
    // keep -- `20260818000001_retire_fan_out_topic_families.sql` names the
    // families because deleting them is its subject.
    write("db/migrations/20260818000001_retire.sql", "-- drops enriched.events\n");
    expect(scan()).toEqual([]);
  });

  it("does not scan generated or vendored output", () => {
    write("packages/a/dist/b.js", "// consumers/<vendor>/v<n>/mappers/\n");
    write("packages/a/node_modules/c/d.ts", "// processors/<name>/v1/\n");
    expect(scan()).toEqual([]);
  });
});
