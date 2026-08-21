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
 *
 * Since `5OV81` the list is also a CI roster, which adds a fourth place the
 * fact can go wrong and a new way for it to go quiet. A Dockerfile with no
 * target is no longer merely an image nobody builds by hand — it is an image
 * the nightly job reports green without having built, which is the exact
 * shape of the absence that card exists to close.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { POLARIS_COMPONENTS } from "@polaris/bus";
import { describe, expect, it } from "vitest";

import { REPRESENTATIVE, SETS, services, targets, templates } from "../docker-build.mjs";
import { findDockerfiles } from "../lint-docker-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Target {
  name: string;
  dockerfile: string;
  image: string;
  buildArgs?: Record<string, string>;
}

const all = targets as Target[];

/** Destination components are named for the vendor; processors for the service. */
function hasTarget(component: string): boolean {
  return services.some(
    (s: { name: string }) => s.name === component || s.name.startsWith(`${component}-`),
  );
}

function targetNamed(name: string): Target {
  const match = all.find((t) => t.name === name);
  if (match === undefined) throw new Error(`no build target named '${name}'`);
  return match;
}

describe("docker build targets", () => {
  it("points every target at a Dockerfile that exists", () => {
    const missing = all.filter((t) => !existsSync(join(ROOT, t.dockerfile))).map((t) => t.name);

    expect(missing).toEqual([]);
  });

  it("can build every component the topology declares", () => {
    const unbuildable = [...POLARIS_COMPONENTS].filter((c) => !hasTarget(c));

    expect(unbuildable).toEqual([]);
  });

  /**
   * The other direction, and the one CI now depends on. `--set full` is what
   * the nightly job runs, so a Dockerfile absent from `targets` is an image
   * that never builds and never reports — indistinguishable, in the run log,
   * from one that built fine.
   */
  it("has a target for every Dockerfile on disk", () => {
    const known = new Set(all.map((t) => t.dockerfile));
    const orphaned = findDockerfiles(ROOT).filter((file: string) => !known.has(file));

    expect(orphaned).toEqual([]);
  });

  it("reads a non-empty list, so neither check passes vacuously", () => {
    expect(services.length).toBeGreaterThan(0);
    expect(POLARIS_COMPONENTS.length).toBeGreaterThan(0);
  });
});

describe("the canonical template", () => {
  /**
   * `base.Dockerfile` defaults `SERVICE_FILTER` to `@polaris/EXAMPLE`, which
   * matches nothing. Building it therefore depends on the override in
   * `templates`, and a rename on the other side of that string turns the
   * template build red for a reason that has nothing to do with the template
   * — the failure mode is `pnpm deploy` refusing a filter that matches no
   * package, which is precisely how `attribution-engine-v3` was unbuildable.
   */
  it("builds a package that exists", () => {
    const shipped = new Set(
      services.map((s: { dockerfile: string }) => {
        const manifest = join(ROOT, dirname(s.dockerfile), "package.json");
        return JSON.parse(readFileSync(manifest, "utf8")).name as string;
      }),
    );

    for (const template of templates as Target[]) {
      expect(shipped).toContain(template.buildArgs?.["SERVICE_FILTER"]);
    }
  });

  /**
   * And emits where the template looks for it. The template asserts
   * `test -f /deploy/dist/${SERVICE_ENTRY}` before the runtime stage copies
   * anything, so an entrypoint that disagrees with the real one fails the
   * build with a message about the template rather than about the service.
   */
  it("names the entrypoint that package actually emits", () => {
    for (const template of templates as Target[]) {
      const filter = template.buildArgs?.["SERVICE_FILTER"];
      const unit = services.find((s: { dockerfile: string }) => {
        const manifest = join(ROOT, dirname(s.dockerfile), "package.json");
        return JSON.parse(readFileSync(manifest, "utf8")).name === filter;
      }) as Target | undefined;
      if (unit === undefined) throw new Error(`no unit ships ${String(filter)}`);

      const entry = /test -f \/deploy\/dist\/(\S+)/.exec(
        readFileSync(join(ROOT, unit.dockerfile), "utf8"),
      );

      expect(entry?.[1]).toBe(template.buildArgs?.["SERVICE_ENTRY"]);
    }
  });
});

describe("the representative set", () => {
  it("names only real targets", () => {
    const unknown = REPRESENTATIVE.filter((name: string) => !all.some((t) => t.name === name));

    expect(unknown).toEqual([]);
  });

  /**
   * The shape the decision on `5OV81` chose, held as a test because narrowing
   * it is silent. Dropping the async unit leaves a green tick on every push
   * and a roster that no longer covers the tier — which is the same "gate that
   * reports on work it did not do" the card was written to remove.
   */
  it("covers a sync unit, an async unit and the template", () => {
    const chosen = REPRESENTATIVE.map(targetNamed);

    expect(chosen.filter((t) => t.dockerfile.startsWith("sync/")).length).toBeGreaterThan(0);
    expect(chosen.filter((t) => t.dockerfile.startsWith("async/")).length).toBeGreaterThan(0);
    expect(chosen.filter((t) => t.dockerfile === "infra/docker/base.Dockerfile")).toHaveLength(1);
  });

  it("is a strict subset, so the nightly roster still earns its schedule", () => {
    expect(REPRESENTATIVE.length).toBeGreaterThan(0);
    expect(REPRESENTATIVE.length).toBeLessThan(all.length);
  });
});

describe("named sets", () => {
  it("builds everything under --set full", () => {
    expect([...SETS.full].sort()).toEqual(all.map((t) => t.name).sort());
  });

  it("agrees with the representative roster", () => {
    expect(SETS.representative).toEqual(REPRESENTATIVE);
  });
});
