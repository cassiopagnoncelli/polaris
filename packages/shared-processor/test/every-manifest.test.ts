/**
 * Every processor manifest in the tree parses against the schema.
 *
 * The loader had thorough tests and every one of them ran against a
 * manifest the test itself had just written to a temp directory. Nothing
 * ever fed it the files actually on disk, so two shipped invalid and
 * stayed that way: `merge-worker` and `archiver` both declared
 * `outputs: []` against a `.min(1)` bound and carried a `required_consent`
 * key the processor schema does not have. `polaris processors list` skips
 * a manifest it cannot parse, so both units were invisible to the CLI and
 * to its activation surface — a processor you cannot see is one you cannot
 * turn off.
 *
 * Per-unit `manifest.test.ts` files exist and would have caught it, for
 * the units that have one. Those two did not, which is the pattern: the
 * check lives next to the thing it checks, so a unit that skips the check
 * also skips the reminder that it should have had one. This test discovers
 * manifests from the filesystem instead, so a new one is covered the day
 * it lands rather than the day somebody remembers to copy a test file.
 *
 * Discovery, not a list. A hardcoded roster here would be a third copy of
 * the pipeline inventory, free to drift from the tree exactly as the
 * manifests drifted from the schema.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { processorManifestSchema } from "../src/manifest.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLANES = ["sync", "async"] as const;
const SKIP = new Set(["node_modules", "dist", "build", "coverage", "test", ".git"]);

/** Every `processor.manifest.yaml` under `sync/` and `async/`. */
function findProcessorManifests(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "processor.manifest.yaml") found.push(full);
    }
  };
  for (const plane of PLANES) walk(join(REPO_ROOT, plane));
  return found.sort();
}

const MANIFESTS = findProcessorManifests();

describe("every processor manifest on disk", () => {
  it("finds the manifests at all", () => {
    // A discovery bug would make every assertion below vacuous — an empty
    // list passes `it.each` silently, and this suite would report green
    // while checking nothing. That failure mode is the reason the checks
    // it replaces were worth writing.
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(MANIFESTS.map((path) => [relative(REPO_ROOT, path), path]))(
    "%s parses against processorManifestSchema",
    (rel, path) => {
      const parsed = processorManifestSchema.safeParse(parseYaml(readFileSync(path, "utf8")));
      // The raw issue list, not a boolean: a failure should say which key
      // and why without a second run.
      const issues = parsed.success
        ? []
        : parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
      expect(issues, `${rel} does not parse`).toEqual([]);
    },
  );

  it.each(MANIFESTS.map((path) => [relative(REPO_ROOT, path), path]))(
    "%s declares the name and version its directory claims",
    (_rel, path) => {
      const manifest = processorManifestSchema.parse(parseYaml(readFileSync(path, "utf8")));
      // `<plane>/<stage>/<unit>/<version>/processor.manifest.yaml`. The
      // unit directory is a convention and the loader matches on the body,
      // so only the version segment is load-bearing — but a manifest whose
      // version disagrees with its directory is the sessionizer-v2 test
      // bug in a different file, and it costs one line to refuse.
      expect(manifest.version).toBe(dirname(path).split("/").pop());
    },
  );
});
