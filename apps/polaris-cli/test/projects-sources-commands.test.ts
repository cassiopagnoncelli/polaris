/**
 * End-to-end command tests that exercise the projects/sources surface
 * through the same `run` entry point as production. Tests use the
 * `--from-catalog` flag and `POLARIS_CATALOG_ROOT` so they do not touch
 * PostgreSQL, keeping the suite hermetic on developer laptops and CI.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode, type OutputStreams, type PackageMeta, run } from "../src/index.js";

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  nodeVersion: "v22.0.0",
};

function baseEnv(catalogRoot: string): NodeJS.ProcessEnv {
  return {
    POLARIS_API_URL: "https://polaris.example.internal",
    POLARIS_TOKEN: "polaris_ot_test",
    POLARIS_CATALOG_ROOT: catalogRoot,
  };
}

function seedSampleCatalog(root: string): void {
  mkdirSync(join(root, "catalog/projects"), { recursive: true });
  mkdirSync(join(root, "catalog/sources/storefront"), { recursive: true });
  writeFileSync(
    join(root, "catalog/projects/storefront.yaml"),
    [
      "project_id: storefront",
      "display_name: Storefront",
      "owner: storefront-platform",
      "description: e-commerce storefront",
      "status: active",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "catalog/sources/storefront/storefront-web.yaml"),
    [
      "project_id: storefront",
      "source_id: storefront-web",
      "source_type: web",
      "owner: storefront-platform",
      "description: browser SDK",
      "runtime: active",
      "allowed_environments:",
      "  - development",
      "  - staging",
      "  - production",
      "status: active",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "catalog/sources/storefront/payments-api.yaml"),
    [
      "project_id: storefront",
      "source_id: payments-api",
      "source_type: backend",
      "owner: payments",
      "description: server-side payments",
      "runtime: active",
      "allowed_environments:",
      "  - production",
      "status: active",
      "",
    ].join("\n"),
  );
}

describe("projects/sources commands (catalog-only path)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "polaris-cmds-"));
    seedSampleCatalog(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("projects list --from-catalog emits the seeded project in human mode", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["projects", "list", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const out = capture.stdout.join("");
    expect(out).toContain("source=catalog count=1");
    expect(out).toContain("storefront");
  });

  it("projects list --from-catalog --output json emits structured JSON", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["--output", "json", "projects", "list", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.source).toBe("catalog");
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0]).toMatchObject({
      project_id: "storefront",
      display_name: "Storefront",
      owner: "storefront-platform",
      status: "active",
    });
  });

  it("projects show <id> --from-catalog renders the project", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["projects", "show", "storefront", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(capture.stdout.join("")).toContain("project_id   storefront");
  });

  it("projects show <id> --from-catalog returns usage error for missing IDs", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["projects", "show", "nope", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.UsageError);
    expect(capture.stderr.join("")).toContain("not declared");
  });

  it("sources list --from-catalog lists every source", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["sources", "list", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const out = capture.stdout.join("");
    expect(out).toContain("storefront/payments-api");
    expect(out).toContain("storefront/storefront-web");
  });

  it("sources list --from-catalog --project filters the result", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["--output", "json", "sources", "list", "--from-catalog", "--project", "storefront"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.filter).toEqual({ project_id: "storefront" });
    expect(parsed.rows.length).toBe(2);
  });

  it("sources show <id> --from-catalog renders the single matching source", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["sources", "show", "storefront-web", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const out = capture.stdout.join("");
    expect(out).toContain("source_id            storefront-web");
    expect(out).toContain("source_type          web");
  });

  it("sources show <id> --from-catalog returns usage error for missing IDs", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["sources", "show", "missing", "--from-catalog"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.UsageError);
    expect(capture.stderr.join("")).toContain("not declared");
  });

  it("projects list (no --from-catalog) fails with config error when no DATABASE_URL is set", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["projects", "list"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.ConfigError);
    expect(capture.stderr.join("")).toContain("DATABASE_URL");
  });

  it("registers `projects sync` and `sources sync` with mutates: true", async () => {
    // Smoke test through --help so we don't need a DB. The commands appear
    // in the help text, proving they are wired into the dispatcher.
    const capture = captureOutput();
    const code = await run({
      argv: ["projects", "--help"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("list");
    expect(help).toContain("show");
    expect(help).toContain("sync");
  });

  it("`polaris sources --help` lists list, show, sync", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["sources", "--help"],
      env: baseEnv(tmp),
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("list");
    expect(help).toContain("show");
    expect(help).toContain("sync");
  });
});

describe("command surface mutates flags", () => {
  it("projects.sync and sources.sync carry mutates: true; others mutate: false", async () => {
    const mod = await import("../src/index.js");
    expect(mod.projectsListCommand.mutates).toBe(false);
    expect(mod.projectsShowCommand.mutates).toBe(false);
    expect(mod.projectsSyncCommand.mutates).toBe(true);
    expect(mod.sourcesListCommand.mutates).toBe(false);
    expect(mod.sourcesShowCommand.mutates).toBe(false);
    expect(mod.sourcesSyncCommand.mutates).toBe(true);
  });
});
