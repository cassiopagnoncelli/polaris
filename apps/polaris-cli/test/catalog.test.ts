import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadCatalog,
  planProjectsSync,
  planSourcesSync,
  resolveCatalogRoot,
  UsageError,
} from "../src/index.js";

function writeYaml(path: string, contents: string): void {
  mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, contents);
}

function seedCatalog(root: string): void {
  writeYaml(
    join(root, "definitions/projects/storefront.yaml"),
    [
      "project_id: storefront",
      "display_name: Storefront",
      "owner: storefront-platform",
      "description: e-commerce storefront",
      "status: active",
    ].join("\n"),
  );
  writeYaml(
    join(root, "definitions/projects/internal.yaml"),
    [
      "project_id: internal",
      "display_name: Internal Tools",
      "owner: platform-eng",
      "description: internal-only tooling project",
    ].join("\n"),
  );
  writeYaml(
    join(root, "definitions/sources/storefront/storefront-web.yaml"),
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
    ].join("\n"),
  );
}

describe("loadCatalog", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "polaris-catalog-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads projects and sources from disk", () => {
    seedCatalog(tmp);
    const catalog = loadCatalog({ root: tmp });
    expect(catalog.projects.map((p) => p.project_id)).toEqual(["internal", "storefront"]);
    expect(catalog.sources.map((s) => `${s.project_id}/${s.source_id}`)).toEqual([
      "storefront/storefront-web",
    ]);
    const source = catalog.sources[0];
    expect(source?.allowed_environments).toEqual(["development", "staging", "production"]);
    expect(source?.runtime).toBe("active");
  });

  it("defaults status to active and runtime to active when omitted", () => {
    writeYaml(
      join(tmp, "definitions/projects/internal.yaml"),
      [
        "project_id: internal",
        "display_name: Internal",
        "owner: platform-eng",
        "description: internal-only project",
      ].join("\n"),
    );
    const catalog = loadCatalog({ root: tmp });
    expect(catalog.projects[0]?.status).toBe("active");
  });

  it("rejects a project file whose filename does not match project_id", () => {
    writeYaml(
      join(tmp, "definitions/projects/storefront.yaml"),
      [
        "project_id: not-matching",
        "display_name: Mismatch",
        "owner: platform-eng",
        "description: mismatched",
      ].join("\n"),
    );
    expect(() => loadCatalog({ root: tmp })).toThrow(UsageError);
  });

  it("rejects a source under the wrong project directory", () => {
    seedCatalog(tmp);
    writeYaml(
      join(tmp, "definitions/sources/storefront/wrong-project.yaml"),
      [
        "project_id: internal",
        "source_id: wrong-project",
        "source_type: backend",
        "owner: x",
        "description: y",
        "allowed_environments:",
        "  - production",
      ].join("\n"),
    );
    expect(() => loadCatalog({ root: tmp })).toThrow(/parent directory/);
  });

  it("rejects a source under an unknown project", () => {
    seedCatalog(tmp);
    writeYaml(
      join(tmp, "definitions/sources/unknown-project/x.yaml"),
      [
        "project_id: unknown-project",
        "source_id: x",
        "source_type: backend",
        "owner: o",
        "description: d",
        "allowed_environments:",
        "  - production",
      ].join("\n"),
    );
    expect(() => loadCatalog({ root: tmp })).toThrow(/is not declared/);
  });

  it("rejects unknown source_type values", () => {
    seedCatalog(tmp);
    writeYaml(
      join(tmp, "definitions/sources/storefront/oddball.yaml"),
      [
        "project_id: storefront",
        "source_id: oddball",
        "source_type: bizarre",
        "owner: o",
        "description: d",
        "allowed_environments:",
        "  - production",
      ].join("\n"),
    );
    expect(() => loadCatalog({ root: tmp })).toThrow(/failed validation/);
  });

  it("rejects duplicate environments in allowed_environments", () => {
    seedCatalog(tmp);
    writeYaml(
      join(tmp, "definitions/sources/storefront/dup.yaml"),
      [
        "project_id: storefront",
        "source_id: dup",
        "source_type: backend",
        "owner: o",
        "description: d",
        "allowed_environments:",
        "  - production",
        "  - production",
      ].join("\n"),
    );
    expect(() => loadCatalog({ root: tmp })).toThrow(/duplicate environment/);
  });

  it("rejects empty allowed_environments", () => {
    seedCatalog(tmp);
    writeYaml(
      join(tmp, "definitions/sources/storefront/empty.yaml"),
      [
        "project_id: storefront",
        "source_id: empty",
        "source_type: backend",
        "owner: o",
        "description: d",
        "allowed_environments: []",
      ].join("\n"),
    );
    expect(() => loadCatalog({ root: tmp })).toThrow(/failed validation/);
  });
});

describe("resolveCatalogRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "polaris-root-"));
    mkdirSync(join(tmp, "definitions"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the explicit path when it contains a catalog/ subdir", () => {
    expect(resolveCatalogRoot({ explicit: tmp, env: {}, cwd: "/" })).toBe(tmp);
  });

  it("reads POLARIS_CATALOG_ROOT from env", () => {
    expect(resolveCatalogRoot({ env: { POLARIS_CATALOG_ROOT: tmp }, cwd: "/" })).toBe(tmp);
  });

  it("walks up from cwd to find a catalog/ ancestor", () => {
    mkdirSync(join(tmp, "deep", "deeper"), { recursive: true });
    expect(resolveCatalogRoot({ cwd: join(tmp, "deep", "deeper"), env: {} })).toBe(tmp);
  });

  it("throws UsageError when no catalog/ is found", () => {
    expect(() => resolveCatalogRoot({ cwd: tmpdir(), env: { POLARIS_CATALOG_ROOT: "" } })).toThrow(
      UsageError,
    );
  });
});

describe("planProjectsSync", () => {
  it("classifies new, updated, and unchanged rows", () => {
    const plan = planProjectsSync(
      [
        {
          project_id: "internal",
          display_name: "Internal",
          owner: "platform",
          description: "x",
          status: "active",
        },
        {
          project_id: "storefront",
          display_name: "Storefront NEW",
          owner: "platform",
          description: "x",
          status: "active",
        },
        {
          project_id: "fresh",
          display_name: "Fresh",
          owner: "platform",
          description: "x",
          status: "active",
        },
      ],
      [
        {
          project_id: "internal",
          display_name: "Internal",
          owner: "platform",
          description: "x",
          status: "active",
        },
        {
          project_id: "storefront",
          display_name: "Storefront OLD",
          owner: "platform",
          description: "x",
          status: "active",
        },
      ],
    );
    expect(plan.unchanged.map((r) => r.project_id)).toEqual(["internal"]);
    expect(plan.to_update.map((r) => r.project_id)).toEqual(["storefront"]);
    expect(plan.to_create.map((r) => r.project_id)).toEqual(["fresh"]);
  });
});

describe("planSourcesSync", () => {
  it("orders the diff by (project_id, source_id) implicitly via input order", () => {
    const plan = planSourcesSync(
      [
        {
          project_id: "storefront",
          source_id: "web",
          source_type: "web",
          owner: "o",
          description: "d",
          runtime: "active",
          allowed_environments: ["development", "production"],
          status: "active",
        },
      ],
      [],
    );
    expect(plan.to_create).toHaveLength(1);
    expect(plan.to_update).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(0);
  });

  it("treats allowed_environments as an unordered set for equality", () => {
    const plan = planSourcesSync(
      [
        {
          project_id: "storefront",
          source_id: "web",
          source_type: "web",
          owner: "o",
          description: "d",
          runtime: "active",
          allowed_environments: ["development", "production"],
          status: "active",
        },
      ],
      [
        {
          project_id: "storefront",
          source_id: "web",
          source_type: "web",
          owner: "o",
          description: "d",
          runtime: "active",
          allowed_environments: ["production", "development"],
          status: "active",
        },
      ],
    );
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.to_update).toHaveLength(0);
  });

  it("flags an update when source_type changes", () => {
    const plan = planSourcesSync(
      [
        {
          project_id: "storefront",
          source_id: "x",
          source_type: "backend",
          owner: "o",
          description: "d",
          runtime: "active",
          allowed_environments: ["production"],
          status: "active",
        },
      ],
      [
        {
          project_id: "storefront",
          source_id: "x",
          source_type: "web",
          owner: "o",
          description: "d",
          runtime: "active",
          allowed_environments: ["production"],
          status: "active",
        },
      ],
    );
    expect(plan.to_update).toHaveLength(1);
  });
});
