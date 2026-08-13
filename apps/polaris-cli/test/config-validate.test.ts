/**
 * The pre-deploy gate's decision logic.
 *
 * `validateProject` takes its schemas as an argument precisely so this can
 * test the case that matters: what happens when a component declares a
 * REQUIRED key. The real registry declares none today (ingest's two keys are
 * both optional), so testing against it would exercise nothing — the gate
 * would pass on an empty database and prove only that it does not crash.
 */

import { describe, expect, it } from "vitest";
import { validateProject } from "../src/commands/config/index.js";
import type { ProjectConfigRow } from "../src/db/index.js";

const SCHEMAS = {
  "meta-capi": {
    project: {
      type: "object",
      required: ["pixel_id", "access_token"],
      properties: {
        pixel_id: { type: "string" },
        access_token: { type: "string", secret: true },
        graph_host: { type: "string", default: "graph.facebook.com" },
        request_timeout_ms: { type: "integer" },
      },
    },
    secretKeys: { project: ["access_token"], instance: [] },
  },
  ingest: {
    project: {
      type: "object",
      properties: { rate_limit_rps: { type: "integer" } },
    },
    secretKeys: { project: [], instance: [] },
  },
} as never;

function row(namespace: string, key: string, value: unknown = "x"): ProjectConfigRow {
  return {
    project_id: "storefront",
    environment: "production",
    namespace,
    config_key: key,
    value,
    is_secret_ref: false,
    updated_at: "2026-08-13T12:00:00.000Z",
    updated_by: "cassio@example.com",
  };
}

describe("validateProject", () => {
  it("reports a required key with no stored value", () => {
    const { missing } = validateProject("storefront", [], SCHEMAS);
    expect(missing).toEqual([
      { projectId: "storefront", namespace: "meta-capi", configKey: "pixel_id" },
      { projectId: "storefront", namespace: "meta-capi", configKey: "access_token" },
    ]);
  });

  it("counts a stored value as satisfying the requirement", () => {
    const { missing } = validateProject(
      "storefront",
      [row("meta-capi", "pixel_id"), row("meta-capi", "access_token")],
      SCHEMAS,
    );
    expect(missing).toEqual([]);
  });

  it("counts a schema DEFAULT as satisfying a required key", () => {
    // graph_host is not in `required`, but the principle is the same one the
    // gate turns on: a key the component can start with is not a deploy
    // blocker. Making it one would make the gate noisy enough to wave through.
    const withDefaultRequired = {
      thing: {
        project: {
          type: "object",
          required: ["has_default"],
          properties: { has_default: { type: "string", default: "fallback" } },
        },
        secretKeys: { project: [], instance: [] },
      },
    } as never;
    expect(validateProject("storefront", [], withDefaultRequired).missing).toEqual([]);
  });

  it("does not report an unset OPTIONAL key", () => {
    // An unset optional key means "use the component default" — exactly what
    // the migrated environment variables meant. It is healthy, not missing.
    const { missing } = validateProject(
      "storefront",
      [row("meta-capi", "pixel_id"), row("meta-capi", "access_token")],
      SCHEMAS,
    );
    expect(missing.map((entry) => entry.configKey)).not.toContain("request_timeout_ms");
  });

  it("reports a stored key no schema declares, without failing on it", () => {
    const { missing, unknown } = validateProject(
      "storefront",
      [row("meta-capi", "pixel_id"), row("meta-capi", "access_token"), row("future", "thing")],
      SCHEMAS,
    );
    expect(missing).toEqual([]);
    expect(unknown).toEqual([{ projectId: "storefront", namespace: "future", configKey: "thing" }]);
  });

  it("narrows to one component when asked", () => {
    const { missing } = validateProject("storefront", [], SCHEMAS, "ingest");
    // ingest declares nothing required, so scoping to it hides meta-capi's gap.
    expect(missing).toEqual([]);
  });

  it("scoping to a component also scopes the unknown-key report", () => {
    const { unknown } = validateProject("storefront", [row("future", "thing")], SCHEMAS, "ingest");
    expect(unknown).toEqual([]);
  });
});
