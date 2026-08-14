/**
 * Unit tests for the project-config key check.
 *
 * The check's whole job is to notice a key that LOOKS wired — declared,
 * generated into a JSON Schema, rendered in the admin panel with a typed
 * input, settable and listable from the CLI — and that no component code
 * reads. meta-capi shipped exactly one of those (`allow_replay`), so the
 * cases below are written against that shape rather than against synthetic
 * ones.
 *
 * The pure helpers are tested directly; `main()` is not, because it walks the
 * real repository and the interesting behaviour is entirely in the helpers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { declaredKeys, sourceDirForDistEntry, unreadKeys } from "../lint-project-config-keys.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "polaris-pck-"));
  roots.push(root);
  const paths: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
    paths.push(full);
  }
  return paths;
}

describe("sourceDirForDistEntry", () => {
  it("maps a built entry back to its source directory", () => {
    expect(sourceDirForDistEntry("consumers/ga4/v1/dist/project-config.js")).toBe(
      "consumers/ga4/v1/src",
    );
    expect(sourceDirForDistEntry("apps/ingester-api/dist/project-config.js")).toBe(
      "apps/ingester-api/src",
    );
  });

  it("returns null when there is no dist segment to swap", () => {
    // A registry entry the check cannot locate must be reported, not silently
    // skipped — a namespace nobody checks is the state this lint exists to end.
    expect(sourceDirForDistEntry("consumers/ga4/v1/project-config.js")).toBeNull();
  });

  it("uses the LAST dist segment", () => {
    expect(sourceDirForDistEntry("vendor/dist-tools/x/dist/project-config.js")).toBe(
      "vendor/dist-tools/x/src",
    );
  });
});

describe("declaredKeys", () => {
  it("reads and sorts the schema's property names", () => {
    expect(declaredKeys({ properties: { request_timeout_ms: {}, api_host: {} } })).toEqual([
      "api_host",
      "request_timeout_ms",
    ]);
  });

  it("treats a schema with no properties as declaring nothing", () => {
    expect(declaredKeys({ type: "object" })).toEqual([]);
    expect(declaredKeys({ properties: null })).toEqual([]);
    expect(declaredKeys(undefined)).toEqual([]);
  });
});

describe("unreadKeys", () => {
  it("passes a key the component reads", () => {
    const files = fixture({
      "project-config.ts": "export const schema = { api_host: 1 };",
      "deliverer.ts": "const host = projectConfig.api_host ?? defaultHost;",
    });
    expect(unreadKeys(["api_host"], files)).toEqual([]);
  });

  it("FAILS a key only the declaration module mentions", () => {
    // The regression: `allow_replay` was declared, generated, rendered and
    // settable, and the only file in the repository that named it was the
    // module declaring it.
    const files = fixture({
      "project-config.ts": "export const schema = { allow_replay: 1 };",
      "deliverer.ts": "const host = projectConfig.api_host ?? defaultHost;",
    });
    expect(unreadKeys(["allow_replay"], files)).toEqual(["allow_replay"]);
  });

  it("accepts a destructured read", () => {
    // Substring matching rather than property-access parsing, precisely so
    // that the legitimate ways to read a key all count.
    const files = fixture({
      "project-config.ts": "export const schema = { request_timeout_ms: 1 };",
      "deliverer.ts": "const { request_timeout_ms } = parse(context.projectConfig);",
    });
    expect(unreadKeys(["request_timeout_ms"], files)).toEqual([]);
  });

  it("accepts an index read", () => {
    const files = fixture({
      "project-config.ts": "export const schema = { api_host: 1 };",
      "deliverer.ts": 'const host = values["api_host"];',
    });
    expect(unreadKeys(["api_host"], files)).toEqual([]);
  });

  it("reports every unread key, not just the first", () => {
    const files = fixture({
      "project-config.ts": "export const schema = { a_key: 1, b_key: 2, c_key: 3 };",
      "deliverer.ts": "const v = cfg.b_key;",
    });
    expect(unreadKeys(["a_key", "b_key", "c_key"], files)).toEqual(["a_key", "c_key"]);
  });

  it("fails a key when the component has no source beyond its declaration", () => {
    const files = fixture({ "project-config.ts": "export const schema = { api_host: 1 };" });
    expect(unreadKeys(["api_host"], files)).toEqual(["api_host"]);
  });
});
