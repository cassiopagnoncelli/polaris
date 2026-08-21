/**
 * The import-direction check is what makes ADR-0007's second law permanent.
 *
 * "The kernel imports nothing" is a sentence in an ADR, and a sentence does
 * not fail a build. Nothing else in this repository has an opinion about
 * layering: a domain library that imports a Postgres pool typechecks, tests
 * green, and reviews as ordinary work — which is how `libs/delivery/host`
 * came to hold seven forbidden edges without anybody deciding it should.
 *
 * So these assertions are about the check being worth trusting, and the shape
 * is deliberate: each rule class is shown REFUSING a violation AND leaving the
 * legal version of the same edge alone. A check that fails everything and a
 * check that fails nothing both report a clean tree, and only the pair of
 * tests can tell them apart.
 *
 * The last describe block pins the two properties the burn-down depends on —
 * that an entry names the edge rather than the file, and that a baselined edge
 * is silent while a fresh one is not.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  blankComments,
  DOMAIN,
  edgeId,
  findViolations,
  INFRASTRUCTURE,
  kindOf,
  RULES,
  readBaseline,
  readImports,
  specifierPackage,
  UNCLASSIFIED,
  unclassifiedLibraries,
} from "../lint-import-direction.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-import-direction-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** A package with one source file, which is all any rule here needs. */
function seedPackage(dir: string, name: string, source = ""): void {
  seed(`${dir}/package.json`, `{ "name": "${name}" }\n`);
  if (source.length > 0) seed(`${dir}/src/index.ts`, source);
}

function imports(name: string): string {
  return `import { thing } from "${name}";\nexport const use = thing;\n`;
}

function rules(): string[] {
  return findViolations(root).map((violation) => violation.rule);
}

function edges(): string[] {
  return findViolations(root).map(edgeId);
}

describe("the matrix, one rule class at a time", () => {
  it("refuses an import out of the kernel, and allows a node builtin", () => {
    seedPackage("libs/spec", "@polaris/spec", 'import { z } from "zod";\nexport const s = z;\n');
    expect(rules()).toEqual(["kernel-imports-nothing"]);

    seed("libs/spec/src/index.ts", 'import { join } from "node:path";\nexport const j = join;\n');
    expect(rules()).toEqual([]);
  });

  it("spares the kernel a type-only devDependency, and only a type-only one", () => {
    // The one carve-out the matrix grants, and it is narrow: a value import of
    // the same package is the violation the rule exists for.
    seed(
      "libs/spec/package.json",
      '{ "name": "@polaris/spec", "devDependencies": { "vitest": "*" } }\n',
    );
    seed("libs/spec/src/index.ts", 'import type { Mock } from "vitest";\nexport type M = Mock;\n');
    expect(rules()).toEqual([]);

    seed("libs/spec/src/index.ts", 'import { vi } from "vitest";\nexport const v = vi;\n');
    expect(rules()).toEqual(["kernel-imports-nothing"]);
  });

  it("lets contracts import spec, and nothing else", () => {
    seedPackage("libs/spec", "@polaris/spec");
    seedPackage("libs/governance", "@polaris/governance");
    seedPackage("libs/contracts", "@polaris/contracts", imports("@polaris/spec"));
    expect(rules()).toEqual([]);

    seed("libs/contracts/src/index.ts", imports("@polaris/governance"));
    expect(rules()).toEqual(["contracts-import-spec-only"]);
  });

  it("refuses a domain lib reaching for infrastructure, and allows another domain lib", () => {
    seedPackage("libs/persistence/postgres", "@polaris/persistence-postgres");
    seedPackage("libs/identity", "@polaris/identity");
    seedPackage("libs/governance", "@polaris/governance", imports("@polaris/identity"));
    expect(rules()).toEqual([]);

    seed("libs/governance/src/index.ts", imports("@polaris/persistence-postgres"));
    expect(rules()).toEqual(["domain-never-infrastructure"]);
  });

  it("refuses an infrastructure lib reaching for domain, and allows another infra lib", () => {
    // The mirror of the rule above, and it has to be tested separately: the
    // two are one prohibition stated from each side, and dropping either
    // leaves a one-way door where the tree claims a wall.
    seedPackage("libs/observability/logger", "@polaris/observability-logger");
    seedPackage("libs/governance", "@polaris/governance");
    seedPackage("libs/bus", "@polaris/bus", imports("@polaris/observability-logger"));
    expect(rules()).toEqual([]);

    seed("libs/bus/src/index.ts", imports("@polaris/governance"));
    expect(rules()).toEqual(["infrastructure-never-domain"]);
  });

  it("refuses anything that imports a unit, including another unit", () => {
    seedPackage("sync/enrichment/geoip/v1", "@polaris/sync-enrichment-geoip-v1");
    seedPackage(
      "libs/governance",
      "@polaris/governance",
      imports("@polaris/sync-enrichment-geoip-v1"),
    );
    expect(rules()).toEqual(["nothing-imports-a-unit"]);

    // A sibling unit is not an exception. `sync-enrichment-runtime-v1` imports
    // two of its siblings today, which is one unit composing two others.
    rmSync(join(root, "libs"), { recursive: true, force: true });
    seedPackage(
      "sync/enrichment/runtime/v1",
      "@polaris/sync-enrichment-runtime-v1",
      imports("@polaris/sync-enrichment-geoip-v1"),
    );
    expect(rules()).toEqual(["nothing-imports-a-unit"]);
  });

  it("lets a unit compose both sides, which is what a unit is for", () => {
    seedPackage("libs/bus", "@polaris/bus");
    seedPackage("libs/governance", "@polaris/governance");
    seed("apps/ingester-api/package.json", '{ "name": "@polaris/ingester-api" }\n');
    seed(
      "apps/ingester-api/src/index.ts",
      `${imports("@polaris/bus")}${imports("@polaris/governance").replace("thing", "other")}`,
    );
    expect(rules()).toEqual([]);
  });

  it("holds a connector to spec and its port, and leaves its vendor SDK alone", () => {
    seedPackage("libs/spec", "@polaris/spec");
    seedPackage("libs/delivery/normalize", "@polaris/delivery-normalize");
    seedPackage("libs/bus", "@polaris/bus");
    seedPackage(
      "connectors/destinations/braze/v1",
      "@polaris/connector-braze-v1",
      `${imports("@polaris/spec")}${imports("@polaris/delivery-normalize").replace("thing", "port")}${imports("braze-sdk").replace("thing", "sdk")}`,
    );
    expect(rules()).toEqual([]);

    seed("connectors/destinations/braze/v1/src/index.ts", imports("@polaris/bus"));
    expect(rules()).toEqual(["connectors-import-spec-and-their-port"]);
  });
});

describe("what the check refuses to guess", () => {
  it("stops on a library in no layer rather than passing it", () => {
    // The failure mode this repository keeps producing: an enumeration that
    // ignores what it does not recognise reports nothing about it, and reads
    // as clean. A new `libs/<domain>` must cost one line, now, not a silent
    // exemption forever.
    seedPackage("libs/telepathy", "@polaris/telepathy", imports("@polaris/bus"));
    expect(unclassifiedLibraries(root)).toEqual([{ dir: "libs/telepathy", domain: "telepathy" }]);
  });

  it("says nothing about the three libraries the matrix does not place", () => {
    // Stated as a test because it is a hole, and a hole nobody has written
    // down is indistinguishable from a rule. `libs/pipeline` importing a
    // domain library passes here, deliberately.
    seedPackage("libs/governance", "@polaris/governance");
    seedPackage("libs/pipeline", "@polaris/pipeline", imports("@polaris/governance"));
    expect(rules()).toEqual([]);
    expect(unclassifiedLibraries(root)).toEqual([]);
  });

  it("gives every unplaced library a reason", () => {
    for (const [domain, reason] of UNCLASSIFIED) {
      expect(reason, `libs/${domain} has no reason`).toBeTruthy();
      expect(reason.length, `libs/${domain}`).toBeGreaterThan(30);
    }
  });

  it("keeps the three layers disjoint, so a domain cannot be both", () => {
    for (const domain of DOMAIN) {
      expect(INFRASTRUCTURE, domain).not.toContain(domain);
      expect(UNCLASSIFIED.has(domain), domain).toBe(false);
    }
    for (const domain of INFRASTRUCTURE) {
      expect(UNCLASSIFIED.has(domain), domain).toBe(false);
    }
  });

  it("classifies by path, not by name", () => {
    // `lint-package-name-congruence` is what keeps the two agreeing. Reading
    // the layer off the package name would make this check agree with a
    // misnamed package instead of disagreeing with it.
    expect(kindOf("libs/spec").kind).toBe("spec");
    expect(kindOf("libs/persistence/postgres").kind).toBe("infrastructure");
    expect(kindOf("libs/delivery/host").kind).toBe("domain");
    expect(kindOf("async/computation/sessionizer/v1").kind).toBe("unit");
    expect(kindOf("connectors/destinations/braze/v1").kind).toBe("connector");
    expect(kindOf("sdks/web").kind).toBe("sdk");
  });
});

describe("reading imports out of a file", () => {
  it("does not mistake a comment for an import", () => {
    // The reason this matters is in front of you: this check's own header
    // names forbidden edges in prose, and three libraries carry doc comments
    // pointing at `@polaris/archive-replay`. A scan that took any mention as
    // an import reported all three as violations.
    seedPackage("libs/governance", "@polaris/governance");
    seed("libs/bus/package.json", '{ "name": "@polaris/bus" }\n');
    seed(
      "libs/bus/src/index.ts",
      '// Counterpart to `@polaris/governance`.\n/* import { x } from "@polaris/governance"; */\nexport const a = 1;\n',
    );
    expect(rules()).toEqual([]);
  });

  it("keeps the specifier, which lives inside a string", () => {
    expect(readImports('import { a } from "pkg";').map((i) => i.specifier)).toEqual(["pkg"]);
    expect(readImports("export * from 'pkg';").map((i) => i.specifier)).toEqual(["pkg"]);
    expect(readImports('await import("pkg");').map((i) => i.specifier)).toEqual(["pkg"]);
    expect(readImports('require("pkg");').map((i) => i.specifier)).toEqual(["pkg"]);
    expect(readImports('import "pkg/side-effect";').map((i) => i.specifier)).toEqual([
      "pkg/side-effect",
    ]);
  });

  it("reads type-only in both spellings", () => {
    expect(readImports('import type { A } from "pkg";')[0]?.typeOnly).toBe(true);
    expect(readImports('import { type A, type B } from "pkg";')[0]?.typeOnly).toBe(true);
    expect(readImports('import { type A, b } from "pkg";')[0]?.typeOnly).toBe(false);
    expect(readImports('import { a } from "pkg";')[0]?.typeOnly).toBe(false);
  });

  it("does not let one statement's clause reach the next statement's specifier", () => {
    const found = readImports('import { a } from "first";\nimport { b } from "second";\n');
    expect(found.map((i) => i.specifier)).toEqual(["first", "second"]);
  });

  it("blanks comments without moving anything else", () => {
    const source = 'const a = 1; // note\nconst b = "//not a comment";\n';
    const blanked = blankComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split("\n")).toHaveLength(source.split("\n").length);
    expect(blanked).toContain('"//not a comment"');
    expect(blanked).not.toContain("note");
  });

  it("reduces a subpath specifier to the package that owns it", () => {
    expect(specifierPackage("@polaris/bus/topology")).toBe("@polaris/bus");
    expect(specifierPackage("@polaris/bus")).toBe("@polaris/bus");
    expect(specifierPackage("yaml/dist/parse")).toBe("yaml");
  });

  it("ignores a package's own tooling config and its tests", () => {
    // Every package in the tree has a `vitest.config.ts` that imports vitest.
    // Counting those put twenty identical, unclearable entries in a file whose
    // whole claim is that its entries clear.
    seed("libs/spec/package.json", '{ "name": "@polaris/spec" }\n');
    seed("libs/spec/vitest.config.ts", 'import { defineConfig } from "vitest/config";\n');
    seed("libs/spec/src/thing.test.ts", 'import { describe } from "vitest";\n');
    seed("libs/spec/test/other.ts", 'import { z } from "zod";\n');
    expect(rules()).toEqual([]);
  });
});

describe("the burn-down", () => {
  it("names the edge rather than the file, so clearing it is verifiable", () => {
    // Two files drawing one forbidden edge are one entry. The entry goes away
    // when the edge does, which is a unit of work somebody can finish; a
    // per-file entry would also churn on every rename.
    seedPackage("libs/persistence/postgres", "@polaris/persistence-postgres");
    seedPackage("libs/governance", "@polaris/governance", imports("@polaris/persistence-postgres"));
    seed("libs/governance/src/other.ts", imports("@polaris/persistence-postgres"));

    const violations = findViolations(root);
    expect(edges()).toEqual(["@polaris/governance -> @polaris/persistence-postgres"]);
    expect(violations[0]?.files).toHaveLength(2);
  });

  it("keys on package names, so a directory move does not reset the debt", () => {
    // pnpm resolves imports by name, and this check was blocked until IJ4NN
    // settled them. A path-keyed baseline would have gone stale on the next
    // `git mv` and reported the moved package's debt as brand new.
    seedPackage("libs/persistence/postgres", "@polaris/persistence-postgres");
    seedPackage("libs/governance", "@polaris/governance", imports("@polaris/persistence-postgres"));
    for (const id of edges()) expect(id).not.toContain("libs/");
  });

  it("reports a self-import as nothing at all", () => {
    seedPackage("libs/governance", "@polaris/governance", imports("@polaris/governance"));
    expect(rules()).toEqual([]);
  });

  it("states a rule for every violation it can produce", () => {
    // A violation whose rule has no sentence prints `undefined` at the point
    // somebody most needs to know what they broke.
    for (const [rule, sentence] of Object.entries(RULES)) {
      expect(sentence.length, rule).toBeGreaterThan(20);
    }
  });
});

describe("the repository as it stands", () => {
  it("has every library placed in a layer", () => {
    expect(unclassifiedLibraries(REPO_ROOT)).toEqual([]);
  });

  it("passes with the baseline, and the baseline is exactly today's edges", () => {
    // Both halves matter. Green proves the gate can ship; the second
    // assertion proves it is green because the debt is recorded rather than
    // because the scan found nothing — the two look identical from the
    // outside, and this repository has shipped the second kind.
    const current = findViolations(REPO_ROOT).map(edgeId);
    const baseline = readBaseline();
    expect(current.length).toBeGreaterThan(0);
    expect(current.filter((id) => !baseline.has(id))).toEqual([]);
    expect([...baseline].filter((id) => !current.includes(id))).toEqual([]);
  });

  it("writes down what each cluster of debt is waiting on", () => {
    // The note is the only thing that makes the file read as debt rather than
    // as a list, and `lint-dead-exports` had its note silently regenerated
    // away once already.
    const note = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "scripts/import-direction-baseline.json"), "utf8"),
    ).note;
    expect(note.length).toBeGreaterThan(400);
  });
});
