/**
 * A package.json may not describe a package other than its own.
 *
 * Two claims, both of which were false somewhere in this workspace and
 * neither of which any tool looked at.
 *
 * **`description`.** `@polaris/processor-traits-v1` carried
 * sessionizer v2's description word for word — Redis inactivity windows,
 * session boundaries, `session.started` / `session.ended` — none of which
 * it does. `pnpm ls`, the workspace graph and any future registry listing
 * all read that field, and a reader looking for the traits runner would
 * have been told it was the sessionizer.
 *
 * **`files`.** Twelve packages listed a `CHANGELOG.md`, `README.md` or
 * `SPEC.md` that does not exist. Every one is `private: true`, so nothing
 * publishes and nothing broke — which is exactly why it went unnoticed for
 * as long as it did. A file list is a claim about what a unit ships, and
 * `polaris processors list` reading a manifest that is not there is the
 * same mistake one layer up.
 *
 * Both are the shape this repository keeps finding: a fact copied to a
 * second place and never revisited. Cheap to state, so stated.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

interface PackageFile {
  readonly dir: string;
  readonly rel: string;
  readonly json: { name?: string; description?: string; files?: readonly string[] };
}

function workspacePackages(): readonly PackageFile[] {
  const found: PackageFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("package.json")) {
      const full = join(dir, "package.json");
      try {
        found.push({
          dir,
          rel: relative(ROOT, full),
          json: JSON.parse(readFileSync(full, "utf8")) as PackageFile["json"],
        });
      } catch {
        /* a package.json that does not parse is another test's problem */
      }
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        /* raced with another session's write */
      }
    }
  };
  walk(ROOT);
  return found;
}

const PACKAGES = workspacePackages();

describe("workspace package.json files", () => {
  it("finds the workspace", () => {
    // Guards the guard: an empty list passes every assertion below.
    expect(PACKAGES.length).toBeGreaterThanOrEqual(20);
  });

  it("gives every package its own description", () => {
    // Copy-paste, caught by the only property that distinguishes it from a
    // coincidence: two packages cannot both be the best description of one
    // thing. Reported as the whole map so a sweep sees every collision at
    // once rather than one per run.
    const byDescription = new Map<string, string[]>();
    for (const pkg of PACKAGES) {
      const description = pkg.json.description?.trim();
      if (description === undefined || description === "") continue;
      const names = byDescription.get(description) ?? [];
      names.push(pkg.json.name ?? pkg.rel);
      byDescription.set(description, names);
    }
    const shared = [...byDescription.values()].filter((names) => names.length > 1);
    expect(shared).toEqual([]);
  });

  it("lists only files it actually ships", () => {
    const missing: Array<{ pkg: string; entry: string }> = [];
    for (const pkg of PACKAGES) {
      for (const entry of pkg.json.files ?? []) {
        // No globbing: every entry in this workspace is a literal path, and
        // resolving a pattern here would let a typo'd glob match nothing
        // and pass.
        if (existsSync(join(pkg.dir, entry))) continue;
        missing.push({ pkg: pkg.rel, entry });
      }
    }
    expect(missing).toEqual([]);
  });
});
