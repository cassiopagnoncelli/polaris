/**
 * The test runner must reach the six-kind tree before anything moves into it.
 *
 * `pnpm-workspace.yaml` was opened to `libs/`, `sdks/`, `connectors/` and
 * `definitions/` by 2XH2V so that each ADR-0007 move is a pure `git mv`. The
 * root `vitest.config.ts` enumerates its roots separately, and stopped at
 * `catalog` (since retired by 0DIPB) — so the first `git mv` would have
 * carried a package out of the
 * only tree the runner looks at. Nothing would have gone red: the moved
 * package's tests would simply stop being collected, and a suite that runs
 * nothing reports success. That is the one failure mode a green gate cannot
 * catch, which is why it is fixed ahead of the moves rather than by them.
 *
 * Asserting the config file CONTAINS certain strings would restate the bug
 * rather than catch it — the question is not what the globs say, it is what
 * vitest does with them. So this seeds a package under every root, runs the
 * real collector over it (`vitest list`, the same code path `pnpm test` uses to
 * decide what to run), and asserts on the file list that comes back.
 *
 * The fixture is a temporary tree rather than the repository, because the roots
 * under test deliberately do not exist yet: on disk, `libs/` is empty until
 * HBXPO lands, and a test that waited for it would be scaffolding checked by
 * nobody at the moment it mattered.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = join(ROOT, "vitest.config.ts");
const VITEST_BIN = join(ROOT, "node_modules", "vitest", "vitest.mjs");

/**
 * One workspace member per root, at both depths `pnpm-workspace.yaml` promises
 * for `libs`: a fixture seeded only at `libs/pipeline` would pass while a glob
 * that stops at two segments silently missed `libs/persistence/postgres`.
 *
 * The old-epoch entries are listed for the same reason the globs still are:
 * both are live until IJ4NN, which deletes them here and there together. A
 * failure in this suite the day a root is retired is the test asking whether
 * the retirement was meant, which is the only moment anyone can answer. It
 * asked once already: `catalog/policy` was seeded here until 0DIPB moved the
 * directory to `definitions/`, and it came out with the glob it existed to
 * prove — `definitions/traits` below is the same claim under the new name.
 *
 * The `.spec.mts` on the SDK is not decoration. The include pattern accepts
 * four extensions and two infixes, and a root added by copying only the
 * `.test.ts` half of it would pass every other assertion here.
 */
const MEMBERS: ReadonlyArray<{ readonly dir: string; readonly test: string }> = [
  // The roots that predate ADR-0007 and were not touched by it.
  { dir: "apps/ingester-api", test: "test/handler.test.ts" },
  { dir: "sync/identity/resolver/v1", test: "test/resolve.test.ts" },
  { dir: "async/computation/sessionizer/v1", test: "test/window.test.ts" },
  // The roots ADR-0007 added. A `packages/shared-schemas` member sat above
  // for the length of the transition, when the old flat root and the new ones
  // were collected at once; IJ4NN emptied it and the entry went with it.
  { dir: "libs/pipeline", test: "test/step.test.ts" },
  { dir: "libs/persistence/postgres", test: "test/pool.test.ts" },
  { dir: "sdks/web", test: "test/client.spec.mts" },
  { dir: "connectors/destinations/braze/v1", test: "test/deliver.test.ts" },
  { dir: "definitions/traits", test: "test/registry.test.ts" },
];

/** The repo-root suites, which are a root of their own rather than a package. */
const ROOT_SUITE = "tests/integration/pipeline.test.ts";

/**
 * Paths that must NOT come back. A config that collected everything would
 * satisfy every positive assertion above and mean nothing.
 *
 * `blueprints/` is the load-bearing one: it is deliberately outside the
 * workspace so a reference app depends on the published SDK the way a customer
 * would, and collecting its tests here would run them against workspace
 * internals no real consumer can see.
 */
const NOT_COLLECTED: readonly string[] = [
  "blueprints/01-storefront/test/checkout.test.ts",
  "libs/pipeline/node_modules/@polaris/dep/test/vendored.test.ts",
  "libs/pipeline/dist/step.test.js",
  "docs/examples/snippet.test.ts",
];

const TEST_BODY =
  'import { expect, it } from "vitest";\n\nit("holds", () => {\n  expect(1).toBe(1);\n});\n';

let fixture = "";
let collected: readonly string[] = [];

function seed(relPath: string, contents: string): void {
  const full = join(fixture, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** What `pnpm test` would run, as fixture-relative POSIX paths. */
function collect(): readonly string[] {
  if (!existsSync(VITEST_BIN)) {
    throw new Error(`no runner at ${VITEST_BIN}: run \`pnpm install\` before this suite`);
  }
  const stdout = execFileSync(
    process.execPath,
    [VITEST_BIN, "list", "--filesOnly", "--json", "--root", fixture, "--config", CONFIG],
    { cwd: ROOT, encoding: "utf8" },
  );
  const listed = JSON.parse(stdout) as ReadonlyArray<{ readonly file: string }>;
  return listed.map((entry) => relative(fixture, entry.file).split(sep).join("/")).sort();
}

beforeAll(() => {
  // `mkdtemp` hands back `/var/...` on macOS while vitest reports the
  // `/private/var/...` it resolves to, so relativising against the unresolved
  // path would produce `../../..`-shaped garbage rather than a failure.
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "polaris-vitest-roots-")));
  writeFileSync(join(fixture, "package.json"), '{ "name": "fixture-root", "private": true }\n');

  for (const { dir, test } of MEMBERS) {
    seed(join(dir, "package.json"), `{ "name": "@polaris/${dir.split("/").join("-")}" }\n`);
    seed(join(dir, test), TEST_BODY);
  }
  seed(ROOT_SUITE, TEST_BODY);
  for (const path of NOT_COLLECTED) seed(path, TEST_BODY);

  collected = collect();
}, 120_000);

afterAll(() => {
  if (fixture !== "") rmSync(fixture, { recursive: true, force: true });
});

describe("root vitest config", () => {
  it("collects a package under every root", () => {
    const uncollected = MEMBERS.filter(
      ({ dir, test }) => !collected.includes(`${dir}/${test}`),
    ).map(({ dir }) => dir);
    expect(uncollected).toEqual([]);
  });

  it("collects the repo-root suites", () => {
    expect(collected).toContain(ROOT_SUITE);
  });

  it("collects nothing outside those roots, or under a build directory", () => {
    expect(NOT_COLLECTED.filter((path) => collected.includes(path))).toEqual([]);
  });

  it("collects exactly that and nothing else", () => {
    // Guards the assertions above: a collector that returned everything, or
    // nothing at all, would satisfy some of them.
    expect(collected).toEqual(
      [...MEMBERS.map(({ dir, test }) => `${dir}/${test}`), ROOT_SUITE].sort(),
    );
  });
});

interface RootConfig {
  readonly test?: {
    readonly include?: readonly string[];
    readonly coverage?: { readonly include?: readonly string[] };
  };
}

/** The first segment of each glob, so that every `libs` pattern is one root. */
function rootsOf(patterns: readonly string[]): readonly string[] {
  return [...new Set(patterns.map((pattern) => pattern.split("/")[0] ?? pattern))].sort();
}

/**
 * `tests/` is repo-root integration and smoke code: it is test code all the way
 * down, so there is no source under it to measure. Every other root carries
 * production code and must be measured, or a moved package reports as covered
 * by having no coverage measured at all.
 */
const COVERAGE_EXEMPT = new Set(["tests"]);

describe("root vitest coverage", () => {
  it("measures every root it collects tests from", async () => {
    const module = (await import(pathToFileURL(CONFIG).href)) as { readonly default: RootConfig };
    const testConfig = module.default.test ?? {};
    const collectedRoots = rootsOf(testConfig.include ?? []);
    const measuredRoots = rootsOf(testConfig.coverage?.include ?? []);

    // Non-vacuity, stated as a fact rather than as a count: `libs` is where
    // the platform's code ends up and it outlives both epochs, so naming it
    // keeps the filter below off an empty list without pinning a number that
    // IJ4NN's deletions would have to chase.
    expect(collectedRoots).toContain("libs");
    expect(measuredRoots).toContain("libs");
    expect(
      collectedRoots.filter((root) => !COVERAGE_EXEMPT.has(root) && !measuredRoots.includes(root)),
    ).toEqual([]);
  });
});
