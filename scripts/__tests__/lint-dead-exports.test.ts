import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDeadExports } from "../lint-dead-exports.mjs";

/**
 * The check exists because this repository keeps shipping mechanisms that are
 * built, wired, validated, documented — and called by nothing. Seven so far
 * this session. None was a type error; none failed a test.
 *
 * These tests pin the two properties that decide whether it is useful or
 * noise: a symbol with a real production caller must NOT be reported, and a
 * symbol referenced only by its own tests MUST be.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polaris-dead-export-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function seedPackage(dir: string, name: string): void {
  seed(`${dir}/package.json`, `{ "name": "${name}" }\n`);
}

function names(): string[] {
  return findDeadExports(root).map((entry) => entry.name);
}

describe("findDeadExports", () => {
  it("reports an exported function nothing calls", () => {
    seed(
      "libs/thing/src/helper.ts",
      "export function neverCalled(): number {\n  return 1;\n}\n",
    );
    expect(names()).toEqual(["neverCalled"]);
  });

  it("does not report a symbol a production file in another package uses", () => {
    seed(
      "libs/thing/src/helper.ts",
      "export function isCalled(): number {\n  return 1;\n}\n",
    );
    seed(
      "apps/some-api/src/app.ts",
      'import { isCalled } from "@polaris/thing";\nisCalled();\n',
    );
    expect(names()).toEqual([]);
  });

  it("counts a plain .mjs script as a caller", () => {
    // `scripts/rabbitmq-provision.mjs` is the only caller of
    // `declareSuperStream`, `deleteSuperStream`, `deleteComponentQueues` and
    // `DEFAULT_STREAM_MAX_BYTES` — it provisions every stream on the
    // platform. Scanning references as TypeScript-only reported all four as
    // dead, so the baseline carried eight symbols whose caller the check
    // simply could not see.
    seed(
      "libs/thing/src/topology.ts",
      "export function declareSuperStream(): number {\n  return 1;\n}\n",
    );
    seed(
      "scripts/provision.mjs",
      'import { declareSuperStream } from "@polaris/thing";\ndeclareSuperStream();\n',
    );
    expect(names()).toEqual([]);
  });

  it("still reports a symbol only its own tests use", () => {
    // The exact shape of every mechanism this check was written for: a unit
    // test proves the helper works, and no production code ever calls it.
    seed(
      "libs/thing/src/helper.ts",
      "export function onlyTested(): number {\n  return 1;\n}\n",
    );
    seed(
      "libs/thing/test/helper.test.ts",
      "import { onlyTested } from '../src/helper.js';\nonlyTested();\n",
    );
    expect(names()).toEqual(["onlyTested"]);
  });

  it("does not count a use inside the declaring package as a caller", () => {
    // A package calling itself proves nothing about whether the platform
    // needs the symbol — that is how a whole subsystem stays internally
    // consistent and externally dead.
    seed(
      "libs/thing/src/helper.ts",
      "export function internalOnly(): number {\n  return 1;\n}\n",
    );
    seed(
      "libs/thing/src/other.ts",
      'import { internalOnly } from "./helper.js";\ninternalOnly();\n',
    );
    expect(names()).toEqual(["internalOnly"]);
  });

  it("ignores barrel re-exports, which are plumbing rather than declarations", () => {
    seed("libs/thing/src/index.ts", 'export { thing } from "./helper.js";\n');
    seed("libs/thing/src/helper.ts", "export const thing = 1;\n");
    seed(
      "apps/some-api/src/app.ts",
      'import { thing } from "@polaris/thing";\nconsole.log(thing);\n',
    );
    expect(names()).toEqual([]);
  });

  it("reports types nowhere — only values", () => {
    // A type with no external reference may simply describe an internal
    // shape. An exported FUNCTION nothing calls is missing wiring or dead
    // code, which is the thing worth failing a build over.
    seed(
      "libs/thing/src/types.ts",
      "export interface UnusedShape {\n  readonly a: string;\n}\nexport type Alias = string;\n",
    );
    expect(names()).toEqual([]);
  });

  it("skips allow-listed packages such as the published SDKs", () => {
    seed(
      "sdks/node/src/public.ts",
      "export function publicApi(): number {\n  return 1;\n}\n",
    );
    expect(names()).toEqual([]);
  });
});

/**
 * ADR-0007 sent the flat library root into `libs/` and `sdks/`, and the check
 * had to survive that in both directions: it must still SEE the code once it
 * sits under a new root, and it must still tell two packages apart once their
 * paths are three segments deep instead of two.
 *
 * The second half is the sharper one, because it fails silently in the
 * direction that looks green. `libs/persistence/postgres` and
 * `libs/persistence/clickhouse` are two packages under one grouping directory;
 * keyed on their first two segments they are the same package, so a call from
 * one into the other reads as internal — and the check reports a symbol dead at
 * the exact moment it acquires a caller.
 *
 * A package is therefore the nearest directory holding a package.json, which is
 * what pnpm means by one. These fixtures place them, where the older ones above
 * deliberately do not: two segments remains the fallback for a tree with no
 * package.json at all, and both rules stay load-bearing.
 */
describe("findDeadExports under the six-kind tree", () => {
  it("scans a library at its six-kind path", () => {
    seedPackage("libs/pipeline", "@polaris/pipeline");
    seed("libs/pipeline/src/step.ts", "export function neverCalled(): number {\n  return 1;\n}\n");
    expect(names()).toEqual(["neverCalled"]);
  });

  it("scans the promoted SDKs, and allow-lists only the one that was", () => {
    // `sdks/node` was allow-listed and `sdks/web` was not, and
    // ZXBDY's move changed neither verdict. `sdks/web` deliberately has no ALLOW
    // entry: the stale `browser-sdk` key named a directory that never
    // existed, so mirroring it into the new epoch would have allow-listed a
    // scanned package under cover of a `git mv`. The key was deleted instead.
    seedPackage("sdks/node", "@polaris/node-sdk");
    seed("sdks/node/src/public.ts", "export function publicApi(): number {\n  return 1;\n}\n");
    seedPackage("sdks/web", "@polaris/web-sdk");
    seed("sdks/web/src/browser.ts", "export function trackPage(): number {\n  return 1;\n}\n");
    expect(names()).toEqual(["trackPage"]);
  });

  it("tells two packages under one grouping directory apart", () => {
    seedPackage("libs/persistence/postgres", "@polaris/persistence-postgres");
    seed(
      "libs/persistence/postgres/src/pool.ts",
      "export function acquirePool(): number {\n  return 1;\n}\n",
    );
    seedPackage("libs/persistence/clickhouse", "@polaris/persistence-clickhouse");
    seed(
      "libs/persistence/clickhouse/src/client.ts",
      'import { acquirePool } from "@polaris/persistence-postgres";\nacquirePool();\n',
    );
    expect(names()).toEqual([]);
  });

  it("still counts a three-segment package's own calls as internal", () => {
    // The converse of the case above, and the reason the fix is a better key
    // rather than a looser comparison: dropping the same-package rule would
    // satisfy that test and quietly retire the property it was written for.
    seedPackage("libs/persistence/postgres", "@polaris/persistence-postgres");
    seed(
      "libs/persistence/postgres/src/pool.ts",
      "export function acquirePool(): number {\n  return 1;\n}\n",
    );
    seed(
      "libs/persistence/postgres/src/session.ts",
      'import { acquirePool } from "./pool.js";\nacquirePool();\n',
    );
    expect(names()).toEqual(["acquirePool"]);
  });

  it("resolves an ALLOW key three segments deep", () => {
    // Two-segment keying could not express this entry at all: the key it
    // produced, `libs/tenancy`, names the grouping directory and would have
    // allow-listed every package under it or none.
    seedPackage("libs/tenancy/config-schemas", "@polaris/tenancy-config-schemas");
    seed(
      "libs/tenancy/config-schemas/src/generated.ts",
      "export const projectConfigSchema = {};\n",
    );
    expect(names()).toEqual([]);
  });

  it("counts a call site under a root that declares nothing", () => {
    // `connectors/` is a consumer root and not a declaration root; a vendor
    // adapter reaching for a library symbol makes it live all the same.
    seedPackage("libs/bus", "@polaris/bus");
    seed("libs/bus/src/topology.ts", "export function declareStream(): number {\n  return 1;\n}\n");
    seedPackage("connectors/destinations/braze/v1", "@polaris/connector-braze-v1");
    seed(
      "connectors/destinations/braze/v1/src/deliver.ts",
      'import { declareStream } from "@polaris/bus";\ndeclareStream();\n',
    );
    expect(names()).toEqual([]);
  });

  it("does not report a connector's own exports, which the engine loads by name", () => {
    // Nothing imports `deliver` — the delivery engine resolves it from the
    // registry at runtime. Scanning `connectors/` for declarations would report
    // every adapter in the tree dead, which is why it is not a declaration
    // root; `definitions/` is absent for the milder reason that `catalog/`,
    // the directory it receives, has never been scanned either.
    seedPackage("connectors/destinations/braze/v1", "@polaris/connector-braze-v1");
    seed(
      "connectors/destinations/braze/v1/src/deliver.ts",
      "export function deliver(): number {\n  return 1;\n}\n",
    );
    expect(names()).toEqual([]);
  });
});
