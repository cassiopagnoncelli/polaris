/**
 * `pnpm deploy` is the last instruction of every builder stage in the
 * repository, and whether it runs at all is decided by two files that do not
 * mention it.
 *
 * Both had already gone wrong when this check was written, and both had gone
 * wrong silently, because nothing in CI builds an image: `pnpm-workspace.yaml`
 * did not enable injection, so all seventeen images had been failing at that
 * instruction since the runtime moved to pnpm v10; and
 * `infra/docker/base.Dockerfile` still pinned `pnpm@10.30.0` after `719a9d2`
 * unpinned the seventeen files it is the template for.
 *
 * The case worth its own test is the misspelling, because the tool induces it.
 * pnpm's error names the setting in its `.npmrc` spelling,
 * `inject-workspace-packages`; pasted into `pnpm-workspace.yaml` that is
 * well-formed YAML, an unknown key, and discarded without a warning — so the
 * repair looks applied, `pnpm install` succeeds, and `pnpm deploy` fails with
 * the identical message. It is the first thing a reader will try and the one
 * failure mode a check that greps for the string would share.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findDockerfiles } from "../lint-docker-context.mjs";
import {
  SETTING_CAMEL,
  SETTING_KEBAB,
  blankComments,
  findFilterMismatches,
  findPinnedPnpm,
  findProblems,
  readDeclaration,
} from "../lint-docker-deploy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("reading the injection declaration", () => {
  it("accepts the camelCase key this file wants", () => {
    const read = readDeclaration(`${SETTING_CAMEL}: true\n`);
    expect(read.declared).toBe(true);
    expect(read.value).toBe(true);
    expect(read.misspelled).toBe(false);
  });

  it("reports the .npmrc spelling as a misspelling, not as a declaration", () => {
    // The whole point: this is what pnpm's own error message tells you to
    // write, and in this file it does nothing at all.
    const read = readDeclaration(`${SETTING_KEBAB}: true\n`);
    expect(read.misspelled).toBe(true);
    expect(read.declared).toBe(false);
  });

  it("distinguishes absent from present-and-false", () => {
    expect(readDeclaration("packages:\n  - 'apps/*'\n").declared).toBe(false);
    const explicit = readDeclaration(`${SETTING_CAMEL}: false\n`);
    expect(explicit.declared).toBe(true);
    expect(explicit.value).toBe(false);
  });

  it("survives a file that is not YAML at all", () => {
    expect(readDeclaration("\t- [unclosed\n").declared).toBe(false);
  });
});

describe("finding pinned pnpm versions", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-deploy-lint-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function dockerfile(body: string): void {
    writeFileSync(join(dir, "Dockerfile"), body);
    writeFileSync(join(dir, ".dockerignore"), "");
  }

  it("reports a pinned version at the line it is actually on", () => {
    dockerfile("FROM node:22-alpine\n\n\nRUN npm install --global pnpm@10.30.0\n");
    const found = findPinnedPnpm(dir);
    expect(found).toHaveLength(1);
    expect(found[0]?.spec).toBe("pnpm@10.30.0");
    // Blanking comments rather than dropping them is what keeps this honest;
    // the first draft dropped them and pointed fifty-seven lines high.
    expect(found[0]?.line).toBe(4);
  });

  it("does not read a comment as a pin", () => {
    // The seventeen Dockerfiles carry a comment explaining the absent pin.
    // A check that flagged its own explanation would be turned off.
    dockerfile("FROM node:22-alpine\n# was pnpm@10.30.0, now self-managed\nRUN npm i -g pnpm\n");
    expect(findPinnedPnpm(dir)).toEqual([]);
  });

  it("catches the other ways to write a second copy of the version", () => {
    dockerfile("FROM node:22-alpine\nRUN corepack prepare pnpm@11.21.0 --activate\n");
    expect(findPinnedPnpm(dir)).toHaveLength(1);
  });

  it("passes the unpinned form every Dockerfile in this repo uses", () => {
    dockerfile(
      "FROM node:22-alpine\nRUN apk add --no-cache libc6-compat \\\n    && npm install --global pnpm\n",
    );
    expect(findPinnedPnpm(dir)).toEqual([]);
  });

  it("blanks comments without moving any other line", () => {
    expect(blankComments("a\n# b\nc\n")).toEqual(["a", "", "c", ""]);
  });
});

describe("matching a deploy filter to the package beside it", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-deploy-filter-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function unit(name: string, filter: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    writeFileSync(
      join(dir, "Dockerfile"),
      `FROM node:22-alpine\nRUN pnpm --filter "${filter}" deploy --prod /deploy\n`,
    );
    writeFileSync(join(dir, ".dockerignore"), "");
  }

  it("accepts a filter that names its own package", () => {
    unit("@polaris/processor-sessionizer-v2", "@polaris/processor-sessionizer-v2");
    expect(findFilterMismatches(dir)).toEqual([]);
  });

  it("catches the version a copied Dockerfile forgot to rename", () => {
    // Verbatim the attribution-engine case: v3's Dockerfile was copied from
    // v1's, and `-v1` exists nowhere in the tree, so `pnpm deploy` matched
    // nothing and the image could not be built.
    unit("@polaris/processor-attribution-engine-v3", "@polaris/processor-attribution-engine-v1");
    const found = findFilterMismatches(dir);
    expect(found).toHaveLength(1);
    expect(found[0]?.filter).toBe("@polaris/processor-attribution-engine-v1");
    expect(found[0]?.actual).toBe("@polaris/processor-attribution-engine-v3");
  });

  it("skips a parameterised filter rather than guessing at it", () => {
    // `infra/docker/base.Dockerfile` is a template: its filter is a build arg
    // and there is no package beside it. Reporting it would be noise, and
    // noise is how a check gets switched off.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@polaris/anything" }));
    writeFileSync(
      join(dir, "Dockerfile"),
      // The literal `${` is Dockerfile build-arg syntax, and recognising it is
      // the whole point of this case, so it must stay a plain string.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate literal placeholder
      'FROM node:22-alpine\nRUN pnpm --filter "${SERVICE_FILTER}" deploy --prod /deploy\n',
    );
    writeFileSync(join(dir, ".dockerignore"), "");
    expect(findFilterMismatches(dir)).toEqual([]);
  });

  it("skips a Dockerfile with no package beside it", () => {
    writeFileSync(
      join(dir, "Dockerfile"),
      'FROM node:22-alpine\nRUN pnpm --filter "@polaris/x" deploy --prod /deploy\n',
    );
    writeFileSync(join(dir, ".dockerignore"), "");
    expect(findFilterMismatches(dir)).toEqual([]);
  });
});

describe("the repository itself", () => {
  it("is clean, so the check is not passing on a tree it never read", () => {
    expect(findProblems(ROOT)).toEqual([]);
  });

  it("reads every Dockerfile in the tree, not a subset", () => {
    // 17 units + infra/docker/base.Dockerfile. If a Dockerfile is added and
    // this number is not, that is the conversation this assertion exists to
    // start -- the base template drifted for six days precisely because
    // nothing counted it.
    expect(findDockerfiles(ROOT)).toHaveLength(18);
  });
});
