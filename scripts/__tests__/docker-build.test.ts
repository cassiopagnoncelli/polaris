/**
 * The build target list, the components list, and the filesystem are three
 * places holding one fact: which services ship as images.
 *
 * Both directions have already gone wrong. `merge-worker` sat in
 * `POLARIS_COMPONENTS` with a Dockerfile on disk and no build target, so
 * `pnpm docker:build` quietly produced no image for it. And retiring the
 * fan-out left three targets pointing at deleted Dockerfiles, which would
 * have failed the build at the first `docker build` invocation rather than
 * at review.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { POLARIS_COMPONENTS } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import { services } from "../docker-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Destination components are named for the vendor; processors for the service. */
function hasTarget(component: string): boolean {
  return services.some(
    (s: { name: string }) => s.name === component || s.name.startsWith(`${component}-`),
  );
}

describe("docker build targets", () => {
  it("points every target at a Dockerfile that exists", () => {
    const missing = services
      .filter((s: { dockerfile: string }) => !existsSync(join(ROOT, s.dockerfile)))
      .map((s: { name: string }) => s.name);

    expect(missing).toEqual([]);
  });

  it("can build every component the topology declares", () => {
    const unbuildable = [...POLARIS_COMPONENTS].filter((c) => !hasTarget(c));

    expect(unbuildable).toEqual([]);
  });

  it("reads a non-empty list, so neither check passes vacuously", () => {
    expect(services.length).toBeGreaterThan(0);
    expect(POLARIS_COMPONENTS.length).toBeGreaterThan(0);
  });
});
