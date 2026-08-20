/**
 * Smoke tests pinning the origin allow-list guard's public surface.
 *
 * P11-006's broader scope (rate limits, HSTS, body-size limit, app.ts
 * integration) is deferred to a follow-up task; this test surface keeps
 * the origin module honest as the foundation pieces land in main.
 *
 * @see docs/implementation/tasks/P11-006-security-hardening.md
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AllowedOriginsCache,
  type AllowedOriginsRepository,
  createOriginGuardPreHandler,
  createPostgresAllowedOriginsRepository,
  ORIGIN_NOT_ALLOWED_CODE,
  registerCorsPreflightRoute,
} from "../../src/origin/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(
  here,
  "../../../../db/postgres/migrations/20260512000013_create_source_allowed_origins.sql",
);

describe("origin guard public surface", () => {
  it("exports the reason code used by the 403 Problem response", () => {
    expect(ORIGIN_NOT_ALLOWED_CODE).toBe("origin_not_allowed");
  });

  it("exposes the cache + guard + repository + preflight factories", () => {
    expect(typeof createOriginGuardPreHandler).toBe("function");
    expect(typeof registerCorsPreflightRoute).toBe("function");
    expect(typeof createPostgresAllowedOriginsRepository).toBe("function");
    expect(AllowedOriginsCache).toBeDefined();
  });

  it("AllowedOriginsCache is instantiable with the documented options", () => {
    const repo: AllowedOriginsRepository = {
      async findFor() {
        return Object.freeze([]);
      },
    };
    const cache = new AllowedOriginsCache({ repository: repo, ttlMs: 1000 });
    expect(cache).toBeDefined();
  });
});

describe("source_allowed_origins migration schema invariant", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("creates the source_allowed_origins table", () => {
    expect(sql).toMatch(/CREATE TABLE source_allowed_origins/);
  });

  it("scopes by (project_id, source_id, environment, origin)", () => {
    expect(executable).toContain("project_id");
    expect(executable).toContain("source_id");
    expect(executable).toContain("environment");
    expect(executable).toContain("origin");
  });

  it("encodes the closed environment set CHECK", () => {
    expect(executable).toMatch(/development/);
    expect(executable).toMatch(/staging/);
    expect(executable).toMatch(/production/);
  });

  it("has migrate:up and migrate:down sections", () => {
    expect(sql).toMatch(/-- migrate:up/);
    expect(sql).toMatch(/-- migrate:down/);
  });
});
