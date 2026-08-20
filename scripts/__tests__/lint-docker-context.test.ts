/**
 * `.dockerignore` and the Dockerfiles are two files holding one fact: what
 * the build context carries.
 *
 * They disagreed for six days. `definitions` was pruned from the context in
 * May as a local-only ops directory, which it was; in August the identity and
 * enrichment images were taught to read per-project overrides out of
 * `definitions/projects/` and given the COPY that carries them in. Neither
 * edit is wrong on its own and neither author could see the other, so both
 * images were unbuildable from the moment the second one landed, and nothing
 * said so — no CI job builds an image. (It answered to `catalog` throughout
 * that episode; `0DIPB` renamed it. The fixtures below use the current name
 * because they exercise the mechanism, not the incident.)
 *
 * The interesting case is the one that broke, and it is the indirect one:
 * `COPY --from=builder /workspace/definitions/projects`. The path is not a
 * context path at all — it is a path in an earlier stage, which that stage
 * filled with `COPY . .`. A check that only understood a direct
 * `COPY <context-path>` would have called this repository clean while two
 * images could not build, so `traces a --from source back through the
 * builder` is the assertion this whole file exists for.
 *
 * The other half is not over-reporting: `/deploy` is written by a RUN, and a
 * check that flagged it would be turned off within a week.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  contextStatus,
  findDockerfiles,
  findExcludedCopies,
  parseDockerfile,
  parseDockerignore,
} from "../lint-docker-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("reading .dockerignore", () => {
  it("keeps rules in order and marks negations", () => {
    const rules = parseDockerignore("# a comment\n\ndefinitions\n!definitions/projects\n");
    expect(rules.map((r: { pattern: string }) => r.pattern)).toEqual([
      "definitions",
      "definitions/projects",
    ]);
    expect(rules.map((r: { negated: boolean }) => r.negated)).toEqual([false, true]);
    expect(rules[0]?.line).toBe(3);
  });

  it("excludes what an excluded directory contains", () => {
    // The bug in one assertion: nothing names `definitions/projects`, and
    // `definitions/projects` is still not in the context.
    const rules = parseDockerignore("definitions\n");
    expect(contextStatus("definitions/projects", rules).excluded).toBe(true);
    expect(contextStatus("definitions", rules).excluded).toBe(true);
    expect(contextStatus("packages", rules).excluded).toBe(false);
  });

  it("lets a later negation re-include a path under an exclusion", () => {
    const rules = parseDockerignore("definitions\n!definitions/projects\n");
    expect(contextStatus("definitions/projects", rules).excluded).toBe(false);
    expect(contextStatus("definitions/events", rules).excluded).toBe(true);
  });

  it("reports which rule decided, so a failure names the line to edit", () => {
    const rules = parseDockerignore("docs\ndefinitions\n");
    expect(contextStatus("definitions/projects", rules).by?.pattern).toBe("definitions");
    expect(contextStatus("definitions/projects", rules).by?.line).toBe(2);
  });

  it("understands the wildcards docker understands", () => {
    const rules = parseDockerignore("**/node_modules\n*.tsbuildinfo\n**/README.md\n");
    expect(contextStatus("libs/persistence/postgres/node_modules", rules).excluded).toBe(true);
    expect(contextStatus("node_modules", rules).excluded).toBe(true);
    expect(contextStatus("tsconfig.tsbuildinfo", rules).excluded).toBe(true);
    expect(contextStatus("README.md", rules).excluded).toBe(true);
    expect(contextStatus("libs/persistence/postgres/README.md", rules).excluded).toBe(true);
    expect(contextStatus("libs/persistence/postgres/src/index.ts", rules).excluded).toBe(false);
  });
});

describe("reading a Dockerfile", () => {
  it("tracks each stage's WORKDIR and where the context was mounted", () => {
    const stages = parseDockerfile(
      "FROM node:22-alpine AS builder\nWORKDIR /workspace\nCOPY . .\n" +
        "FROM node:22-alpine AS runtime\nWORKDIR /app\n" +
        "COPY --from=builder --chown=polaris:polaris /deploy /app\n",
    );
    expect(stages.map((s: { name: string | null }) => s.name)).toEqual(["builder", "runtime"]);
    expect(stages[0]?.mounts).toEqual([{ stagePath: "/workspace", contextPath: "" }]);
    expect(stages[1]?.copies[0]?.from).toBe("builder");
  });

  it("joins line continuations so a wrapped COPY is still one instruction", () => {
    const stages = parseDockerfile("FROM alpine\nCOPY --chown=1:1 \\\n  sql \\\n  /app/sql\n");
    expect(stages[0]?.copies[0]?.sources).toEqual(["sql"]);
    expect(stages[0]?.copies[0]?.dest).toBe("/app/sql");
  });
});

describe("scanning a tree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-dockerctx-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  function scan(): ReturnType<typeof findExcludedCopies> {
    return findExcludedCopies(root);
  }

  it("finds a direct COPY of an excluded path", () => {
    write(".dockerignore", "sql\n");
    write("apps/api/Dockerfile", "FROM alpine\nWORKDIR /app\nCOPY sql /app/sql\n");
    const [problem] = scan();
    expect(problem?.contextPath).toBe("sql");
    expect(problem?.rule).toBe("sql");
    expect(problem?.via).toBeNull();
  });

  it("traces a --from source back through the builder", () => {
    // The shape of the real bug: the COPY names a path in the BUILDER, and
    // the builder got it from the context it never received.
    write(".dockerignore", "docs\ndefinitions\nsql\n");
    write(
      "sync/identity/resolver/v1/Dockerfile",
      "FROM node:22-alpine AS builder\nWORKDIR /workspace\nCOPY . .\n" +
        "FROM node:22-alpine AS runtime\nWORKDIR /app\n" +
        "COPY --from=builder /deploy /app\n" +
        "COPY --from=builder --chown=polaris:polaris /workspace/definitions/projects /app/definitions/projects\n",
    );
    const problems = scan();
    expect(problems).toHaveLength(1);
    expect(problems[0]?.contextPath).toBe("definitions/projects");
    expect(problems[0]?.via).toBe("builder");
    expect(problems[0]?.line).toBe(7);
    expect(problems[0]?.rule).toBe("definitions");
  });

  it("leaves a --from source the build produced alone", () => {
    // `/deploy` is written by `pnpm deploy`, not copied from the context.
    // Nothing about .dockerignore determines whether it exists, so a check
    // that flagged it would be reporting noise.
    write(".dockerignore", "definitions\n");
    write(
      "a/Dockerfile",
      "FROM node:22-alpine AS builder\nWORKDIR /workspace\nCOPY . .\nRUN pnpm deploy /deploy\n" +
        "FROM node:22-alpine\nCOPY --from=builder /deploy /app\n",
    );
    expect(scan()).toEqual([]);
  });

  it("accepts a path a negation re-includes", () => {
    write(".dockerignore", "definitions\n!definitions/projects\n");
    write(
      "a/Dockerfile",
      "FROM node:22-alpine AS builder\nWORKDIR /workspace\nCOPY . .\n" +
        "FROM node:22-alpine\nCOPY --from=builder /workspace/definitions/projects /app/definitions/projects\n",
    );
    expect(scan()).toEqual([]);
  });

  it("does not flag `COPY . .`, which is the context by definition", () => {
    write(".dockerignore", "definitions\n");
    write("a/Dockerfile", "FROM node:22-alpine\nWORKDIR /workspace\nCOPY . .\n");
    expect(scan()).toEqual([]);
  });

  it("flags a glob whose directory is pruned", () => {
    write(".dockerignore", "tests\n");
    write("a/Dockerfile", "FROM alpine\nCOPY tests/*.json /app/\n");
    expect(scan().map((p: { contextPath: string }) => p.contextPath)).toEqual(["tests"]);
  });

  it("says nothing when there is no .dockerignore", () => {
    write("a/Dockerfile", "FROM alpine\nCOPY definitions /app/definitions\n");
    expect(scan()).toEqual([]);
  });
});

describe("this repository", () => {
  it("has Dockerfiles to check", () => {
    // A scanner that finds no files reports a clean tree, which is the one
    // way this gate could pass while meaning nothing.
    expect(findDockerfiles(ROOT).length).toBeGreaterThan(10);
  });

  it("copies nothing the build context prunes", () => {
    expect(findExcludedCopies(ROOT)).toEqual([]);
  });
});
