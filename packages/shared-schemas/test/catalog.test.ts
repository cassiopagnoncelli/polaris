import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  catalogEntryFileSchema,
  defaultSchemaBindings,
  loadCatalogFromDir,
  loadCatalogYamlFromDir,
} from "../src/catalog/index.js";
import { pageViewedV2PropertiesSchema } from "../src/events/page/viewed.v2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = resolve(__dirname, "..", "..", "..", "definitions", "events");

describe("loadCatalogYamlFromDir", () => {
  it("loads every YAML entry under definitions/events/", () => {
    const entries = loadCatalogYamlFromDir(CATALOG_ROOT);
    const names = entries.map((entry) => `${entry.name}@${entry.schema_version}`).sort();
    // Worktree must ship at least page.viewed v1+v2 and checkout.started v1
    // for the version-coexistence demonstration the task requires.
    expect(names).toEqual(
      expect.arrayContaining(["page.viewed@1", "page.viewed@2", "checkout.started@1"]),
    );
  });

  it("rejects YAML entries with active + sunset_at (rule check)", () => {
    // We can't easily produce a real on-disk failure here without writing
    // a file, so verify the rule by parsing through the entry schema
    // directly. The loader composes that schema.
    const result = catalogEntryFileSchema.safeParse({
      name: "page.viewed",
      schema_version: 1,
      domain: "page",
      owner: "web-platform",
      description: "x",
      lifecycle: "active",
      sunset_at: "2026-08-10T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("EventCatalog (built from YAML + bindings)", () => {
  const catalog = loadCatalogFromDir(CATALOG_ROOT, defaultSchemaBindings);

  it("exposes the union of versions for an event", () => {
    const versions = catalog.getVersions("page.viewed").map((v) => v.schema_version);
    expect(versions).toEqual([1, 2]);
  });

  it("marks v1 deprecated and v2 active", () => {
    expect(catalog.getEntry("page.viewed", 1)?.lifecycle).toBe("deprecated");
    expect(catalog.getEntry("page.viewed", 2)?.lifecycle).toBe("active");
  });

  it("returns only active versions from getActiveVersions", () => {
    const active = catalog.getActiveVersions("page.viewed");
    expect(active).toHaveLength(1);
    expect(active[0]?.schema_version).toBe(2);
  });

  it("isSunset returns true after the sunset_at moment", () => {
    // page.viewed v1 has sunset_at "2026-08-10T00:00:00Z" in YAML.
    const before = new Date("2026-08-09T23:59:59Z");
    const after = new Date("2026-08-10T00:00:01Z");
    expect(catalog.isSunset("page.viewed", 1, before)).toBe(false);
    expect(catalog.isSunset("page.viewed", 1, after)).toBe(true);
  });

  it("isUnknownVersion is true for versions the catalog has no entry for", () => {
    expect(catalog.isUnknownVersion("page.viewed", 99)).toBe(true);
    expect(catalog.isUnknownVersion("page.viewed", 2)).toBe(false);
  });

  it("listEventNames is unique and sorted", () => {
    expect(catalog.listEventNames()).toEqual([
      "attribution.first_touch_assigned",
      "attribution.last_touch_assigned",
      "attribution.touchpoint_captured",
      "audience.entered",
      "audience.exited",
      "checkout.started",
      "enriched.geoip",
      "identity.link_rejected",
      "identity.linked",
      "identity.merge_suspended",
      "identity.merged",
      "identity.rotated",
      "journey.entered",
      "journey.exited",
      "journey.step_advanced",
      "page.viewed",
      "payment.approved",
      "profile.updated",
      "session.ended",
      "session.started",
      "signup.completed",
      "subscription.renewed",
      "trait.computed",
      "user.identified",
    ]);
  });

  it("propertiesSchema is bound on each entry", () => {
    const v2 = catalog.getEntry("page.viewed", 2);
    expect(v2?.propertiesSchema).toBe(pageViewedV2PropertiesSchema);
  });
});

describe("buildCatalog binding integrity", () => {
  it("throws when a YAML entry has no matching schema binding", () => {
    expect(() =>
      buildCatalog(
        [
          {
            name: "page.viewed",
            schema_version: 1,
            domain: "page",
            owner: "web",
            description: "x",
            lifecycle: "active",
          },
        ],
        [],
      ),
    ).toThrow(/no Zod schema binding/);
  });

  it("throws when a schema binding has no matching YAML entry", () => {
    expect(() =>
      buildCatalog(
        [],
        [
          {
            event: "page.viewed",
            schema_version: 2,
            propertiesSchema: pageViewedV2PropertiesSchema,
          },
        ],
      ),
    ).toThrow(/no catalog YAML entry/);
  });

  it("throws on duplicate (event, schema_version) entries", () => {
    expect(() =>
      buildCatalog(
        [
          {
            name: "page.viewed",
            schema_version: 2,
            domain: "page",
            owner: "web",
            description: "x",
            lifecycle: "active",
          },
          {
            name: "page.viewed",
            schema_version: 2,
            domain: "page",
            owner: "web",
            description: "y",
            lifecycle: "active",
          },
        ],
        [
          {
            event: "page.viewed",
            schema_version: 2,
            propertiesSchema: pageViewedV2PropertiesSchema,
          },
        ],
      ),
    ).toThrow(/Duplicate catalog entry/);
  });
});
