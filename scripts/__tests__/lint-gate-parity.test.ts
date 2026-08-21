/**
 * The gate a group runs before it lands and the gate CI runs after it lands
 * were allowed to differ, and the difference was `pnpm format:check`.
 *
 * Nothing was broken in a way anyone could see. The T0 group's verify command
 * ran four gates, `ci.yml` ran five, every card in the group went green, the
 * group landed, and `main` turned red on the push — on thirty-four files whose
 * imports had gone past biome's print width when `IJ4NN` lengthened the
 * package names.
 *
 * So the case that matters most here is the first one: CI runs a gate that
 * `pnpm verify` does not. It is the historical fault, and a check that
 * reported everything else and stayed quiet about that one would be decorative.
 * The mirror case is tested too, because a gate only `verify` runs is enforced
 * by nobody once the change is on `main`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NEEDS_MORE_THAN_A_CHECKOUT,
  VERIFY_SCRIPT,
  WORKFLOWS_DIR,
  findProblems,
  isPullRequestGate,
  parseGateChain,
  readWorkflowGates,
} from "../lint-gate-parity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPTS = new Set(["build", "typecheck", "lint", "format:check", "test", "verify:gates"]);

describe("reading the pnpm scripts out of a command", () => {
  it("reads a gate chain in order", () => {
    expect(parseGateChain("pnpm build && pnpm typecheck && pnpm lint", SCRIPTS)).toEqual([
      "build",
      "typecheck",
      "lint",
    ]);
  });

  it("does not count `pnpm install` as a gate", () => {
    // Every job installs. Installing is setup, and `install` is pnpm's own
    // verb rather than a script this repository defines — which is exactly
    // what keeps it out, with no list of exceptions to maintain.
    expect(parseGateChain("pnpm install --frozen-lockfile", SCRIPTS)).toEqual([]);
  });

  it("reads the explicit `run` form", () => {
    expect(parseGateChain("pnpm run test", SCRIPTS)).toEqual(["test"]);
  });

  it("does not read a filtered package name as the script", () => {
    // `--filter` takes a value. Dropping the flag without it once made
    // `@polaris/x` the script name, and the gate beside it went uncounted.
    expect(parseGateChain("pnpm --filter @polaris/x build", SCRIPTS)).toEqual(["build"]);
  });

  it("ignores commands that are not pnpm, and scripts that do not exist", () => {
    expect(parseGateChain("node scripts/docker-build.mjs", SCRIPTS)).toEqual([]);
    expect(parseGateChain("pnpm no-such-script", SCRIPTS)).toEqual([]);
  });

  it("splits a multi-line run block", () => {
    expect(parseGateChain("pnpm build\npnpm test\n", SCRIPTS)).toEqual(["build", "test"]);
  });
});

describe("deciding which workflows gate a change", () => {
  it("counts pull_request and push", () => {
    expect(isPullRequestGate({ on: { pull_request: {} } })).toBe(true);
    expect(isPullRequestGate({ on: { push: { branches: ["main"] } } })).toBe(true);
  });

  it("does not count a workflow that only runs on a schedule", () => {
    expect(isPullRequestGate({ on: { schedule: [], workflow_dispatch: null } })).toBe(false);
  });

  it("survives YAML 1.1 reading `on:` as the boolean true", () => {
    // A parser that does this puts the triggers under `true` instead of `on`,
    // and a check that only looked at `on` would compare `pnpm verify`
    // against an empty set and call that agreement.
    expect(isPullRequestGate({ true: { push: {} } })).toBe(true);
  });

  it("survives a workflow with no triggers at all", () => {
    expect(isPullRequestGate({})).toBe(false);
    expect(isPullRequestGate(null)).toBe(false);
  });
});

describe("reading the gates out of a workflow", () => {
  const workflow = (jobs: string) => `on:\n  push:\n    branches: [main]\njobs:\n${jobs}`;

  it("collects the pnpm gates of every job", () => {
    const gates = readWorkflowGates(
      workflow(
        "  static:\n    steps:\n      - run: pnpm install --frozen-lockfile\n" +
          "      - run: pnpm lint\n  unit:\n    steps:\n      - run: pnpm test\n",
      ),
      SCRIPTS,
    );
    expect([...gates.keys()].sort()).toEqual(["lint", "test"]);
    expect(gates.get("lint")).toEqual(["static"]);
  });

  it("skips a job that needs a live service", () => {
    // `ci.yml`'s migrations job runs `pnpm db:migrate` against a PostgreSQL
    // service container. A group worktree has no such thing, so requiring
    // `pnpm verify` to run it would make the check unsatisfiable.
    const gates = readWorkflowGates(
      workflow(
        "  migrations:\n    services:\n      postgres:\n        image: postgres:17-alpine\n" +
          "    steps:\n      - run: pnpm test\n",
      ),
      SCRIPTS,
    );
    expect([...gates.keys()]).toEqual([]);
  });

  it("ignores a workflow that gates nothing", () => {
    const gates = readWorkflowGates(
      "on:\n  schedule: []\njobs:\n  n:\n    steps:\n" + "      - run: pnpm test\n",
      SCRIPTS,
    );
    expect([...gates.keys()]).toEqual([]);
  });

  it("survives a file that is not YAML at all", () => {
    expect([...readWorkflowGates("\t- [unclosed\n", SCRIPTS).keys()]).toEqual([]);
  });
});

describe("comparing the two gate sets", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-gate-parity-"));
    mkdirSync(join(dir, WORKFLOWS_DIR), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fixture repository: a verify chain, and a CI workflow that runs gates. */
  function repo(verify: string | null, ciGates: string[]): void {
    const scripts: Record<string, string> = {
      build: "tsc",
      typecheck: "tsc --noEmit",
      lint: "biome lint .",
      "format:check": "biome format .",
      test: "vitest run",
    };
    if (verify !== null) scripts[VERIFY_SCRIPT] = verify;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
    writeFileSync(
      join(dir, WORKFLOWS_DIR, "ci.yml"),
      "on:\n  pull_request:\n    branches: [main]\njobs:\n  static:\n    steps:\n" +
        "      - run: pnpm install --frozen-lockfile\n" +
        ciGates.map((gate) => `      - run: pnpm ${gate}\n`).join(""),
    );
  }

  it("is quiet when the two sets agree", () => {
    repo("pnpm build && pnpm lint", ["build", "lint"]);
    expect(findProblems(dir)).toEqual([]);
  });

  it("catches the fault this check was written for", () => {
    // Verbatim T0: the group gate ran four of CI's five, the missing one was
    // `format:check`, and the group landed green onto a red `main`.
    repo("pnpm build && pnpm typecheck && pnpm lint && pnpm test", [
      "build",
      "typecheck",
      "lint",
      "format:check",
      "test",
    ]);
    const problems = findProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("CI runs `pnpm format:check` and `pnpm verify` does not");
    expect(problems[0]).toContain("ci.yml (static)");
  });

  it("catches the mirror: a gate only the group runs", () => {
    repo("pnpm build && pnpm test", ["build"]);
    const problems = findProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`pnpm verify` runs `pnpm test` and no workflow does");
  });

  it("reports a missing verify script rather than passing vacuously", () => {
    repo(null, ["build"]);
    const problems = findProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no `verify` script");
  });

  it("refuses to compare against nothing", () => {
    // A workflow directory that yields no gates would otherwise make every
    // set trivially equal — green for having read nothing, which is the
    // failure mode this whole family of checks exists to refuse.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { verify: "pnpm build" } }));
    rmSync(join(dir, WORKFLOWS_DIR), { recursive: true, force: true });
    expect(findProblems(dir)[0]).toContain("comparing");
  });

  it("does not demand gates from a workflow that needs more than a checkout", () => {
    repo("pnpm build", ["build"]);
    writeFileSync(
      join(dir, WORKFLOWS_DIR, "integration.yml"),
      "on:\n  pull_request:\n    types: [labeled]\njobs:\n  slice:\n    steps:\n" +
        "      - run: pnpm test\n",
    );
    expect(Object.keys(NEEDS_MORE_THAN_A_CHECKOUT)).toContain("integration.yml");
    expect(findProblems(dir)).toEqual([]);
  });

  it("names what each excluded workflow needs", () => {
    // The exclusion list is the part of this check that rots the same way the
    // missing `format:check` did. A reason is what makes a stale entry
    // arguable instead of invisible.
    for (const reason of Object.values(NEEDS_MORE_THAN_A_CHECKOUT)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe("the repository itself", () => {
  it("is clean, so the check is not passing on a tree it never read", () => {
    expect(findProblems(ROOT)).toEqual([]);
  });
});
