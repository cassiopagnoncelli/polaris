import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, pickEnv, readEnv } from "../src/env.js";

describe("readEnv", () => {
  it("returns the value when present", () => {
    expect(readEnv({ FOO: "bar" }, "FOO")).toBe("bar");
  });

  it("returns undefined when missing", () => {
    expect(readEnv({}, "FOO")).toBeUndefined();
  });

  it("treats empty strings as undefined", () => {
    expect(readEnv({ FOO: "" }, "FOO")).toBeUndefined();
  });
});

describe("pickEnv", () => {
  it("returns only defined keys", () => {
    expect(pickEnv({ FOO: "a", BAR: "b", BAZ: undefined }, ["FOO", "BAZ"])).toEqual({
      FOO: "a",
    });
  });

  it("ignores empty values", () => {
    expect(pickEnv({ FOO: "", BAR: "b" }, ["FOO", "BAR"])).toEqual({ BAR: "b" });
  });
});

describe("loadEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns process env when no files are given", () => {
    const env = loadEnv({ processEnv: { FOO: "fromProcess", EMPTY: undefined } });
    expect(env.FOO).toBe("fromProcess");
  });

  it("merges values from .env files with file-precedence highest-to-lowest", () => {
    writeFileSync(join(dir, ".env"), "FROM_BASE=base\nSHARED=base\n");
    writeFileSync(join(dir, ".env.local"), "FROM_LOCAL=local\nSHARED=local\n");

    const env = loadEnv({
      cwd: dir,
      files: [".env.local", ".env"],
      processEnv: {},
    });

    expect(env.FROM_BASE).toBe("base");
    expect(env.FROM_LOCAL).toBe("local");
    expect(env.SHARED).toBe("local");
  });

  it("lets process env override .env files", () => {
    writeFileSync(join(dir, ".env"), "OVERRIDE=fromFile\n");

    const env = loadEnv({
      cwd: dir,
      files: [".env"],
      processEnv: { OVERRIDE: "fromProcess" },
    });

    expect(env.OVERRIDE).toBe("fromProcess");
  });

  it("silently skips missing files", () => {
    const env = loadEnv({
      cwd: dir,
      files: [".env.missing", ".env"],
      processEnv: { KEEP: "value" },
    });
    expect(env.KEEP).toBe("value");
  });

  it("freezes the returned object", () => {
    const env = loadEnv({ processEnv: { FOO: "bar" } });
    expect(Object.isFrozen(env)).toBe(true);
  });
});
