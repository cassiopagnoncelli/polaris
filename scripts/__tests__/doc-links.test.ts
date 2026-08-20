/**
 * Every relative link in the documentation points at something.
 *
 * A dead link in a runbook is worse than no link: the reader has been told
 * where to look, and finds out it is wrong only after following it, usually
 * while doing the thing the runbook is for.
 *
 * ## Why this is a test and not a careful check
 *
 * It was a careful check, once, and the check was wrong. A pass over
 * `docs/` after the R-programme move reported "no dangling relative links
 * remain anywhere under docs/" — and it had only resolved `.md` targets.
 * Every link to a SOURCE file went unexamined, which is where the rot was:
 * `attribution-engine/v1|v2/src/config.ts` deleted with the fan-out,
 * `topic-family.ts` and `topic-isolation-cache.ts` renamed,
 * `apps/polaris-cli/src/db/replay-jobs.ts` moved into
 * `persistence-control-plane`, `processors/` gone entirely, and a README
 * pointing at an implementation kanban that was never written.
 *
 * Seven links, in the operational runbooks and the front page — the two
 * places a reader is least able to shrug it off.
 *
 * So the resolution is over every target, with no extension filter. A
 * directory target counts as resolved: several runbooks deliberately point
 * at a directory rather than a file, because the useful thing is "the code
 * lives over here" and naming one file inside would go stale faster.
 *
 * ## Resolved against git, not against the disk
 *
 * The first version asked `existsSync`, which is the author's machine
 * rather than the repository. It passed locally and failed in CI on six
 * links into `agents/` — the gitignored agent workspace holding the pm
 * board and the architect's decision ledgers. Those files are real, and
 * nobody who clones this repository has them.
 *
 * A reader gets what is IN the repository, so that is the oracle. The same
 * mistake, in the same session, as three unit tests that passed only
 * because a PostgreSQL happened to be running locally: a green that came
 * from the environment rather than from the code.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);

/**
 * Markdown worth checking: the documentation tree, plus the front-page
 * files a newcomer or an agent reads before anything else.
 */
function markdownFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) found.push(full);
    }
  };
  walk(join(ROOT, "docs"));
  for (const name of ["README.md", "AGENTS.md"]) {
    const full = join(ROOT, name);
    if (existsSync(full)) found.push(full);
  }
  return found.sort();
}

/**
 * `[text](target)` where the target is a repository path.
 *
 * External URLs, in-page anchors and `mailto:` are somebody else's problem;
 * an absolute `/path` is a site-root convention this repository does not
 * use, so it is left alone rather than resolved against an arbitrary base.
 */
const RELATIVE_LINK = /\]\((?!https?:|#|mailto:|\/)([^)\s#]+)(?:#[^)]*)?\)/g;

interface DeadLink {
  readonly where: string;
  readonly target: string;
}

/**
 * Every path git tracks, plus every directory implied by one.
 *
 * A link to `apps/polaris-cli/src/commands/replay/` is a link to a
 * directory, which `git ls-files` never lists on its own.
 */
function trackedPaths(): ReadonlySet<string> {
  const out = new Set<string>();
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((line) => line.length > 0);
  for (const file of listed) {
    out.add(file);
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

function deadLinks(): readonly DeadLink[] {
  const tracked = trackedPaths();
  const dead: DeadLink[] = [];
  for (const file of markdownFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RELATIVE_LINK)) {
      const target = (match[1] as string).trim();
      // Directory targets included: a runbook pointing at a directory is
      // deliberate, and both resolve through the tracked set.
      const resolved = relative(ROOT, normalize(join(dirname(file), target)));
      if (tracked.has(resolved)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      dead.push({ where: `${relative(ROOT, file)}:${String(line)}`, target });
    }
  }
  return dead;
}

describe("documentation links", () => {
  const files = markdownFiles();

  it("finds the documentation to check", () => {
    // Guards the guard: an empty file list makes the assertion below pass
    // against any tree at all, which is the shape of the check this
    // replaces.
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files.map((f) => relative(ROOT, f))).toContain("README.md");
  });

  it("finds links to check, including ones to source files", () => {
    // The specific failure this suite exists for: the earlier pass matched
    // only `.md` targets and reported a clean tree while seven links to
    // `.ts` files and directories were dead.
    const targets = markdownFiles().flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(RELATIVE_LINK)].map((m) => m[1] as string),
    );
    expect(targets.length).toBeGreaterThan(100);
    expect(targets.some((t) => t.endsWith(".ts"))).toBe(true);
  });

  it("has none that point at nothing", () => {
    // Reported as the full list rather than a count: fixing these is a
    // sweep, and a sweep wants the whole list on the first run.
    expect(deadLinks()).toEqual([]);
  });
});
