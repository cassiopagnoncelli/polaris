/**
 * Behavioural tests for `getBuildMetadata` and `buildMetadataLogBindings`.
 *
 * @see packages/shared-service-bootstrap/src/bootstrap/build-metadata.ts
 */

import { describe, expect, it } from "vitest";

import { buildMetadataLogBindings, getBuildMetadata } from "../src/index.js";

describe("getBuildMetadata", () => {
  it("resolves all four env-sourced fields when present", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "1.2.3",
      env: {
        POLARIS_GIT_SHA: "abc1234",
        POLARIS_BUILD_TIME: "2026-05-12T10:00:00.000Z",
        POLARIS_RELEASE_LABEL: "2026-q2-r1",
      },
    });
    expect(meta).toEqual({
      serviceName: "ingester-api",
      serviceVersion: "1.2.3",
      gitSha: "abc1234",
      buildTime: "2026-05-12T10:00:00.000Z",
      releaseLabel: "2026-q2-r1",
    });
  });

  it("defaults each env-sourced field to null when absent", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "0.0.0",
      env: {},
    });
    expect(meta).toEqual({
      serviceName: "ingester-api",
      serviceVersion: "0.0.0",
      gitSha: null,
      buildTime: null,
      releaseLabel: null,
    });
  });

  it("treats empty / whitespace env values as null", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "0.0.0",
      env: {
        POLARIS_GIT_SHA: "  ",
        POLARIS_BUILD_TIME: "",
        POLARIS_RELEASE_LABEL: "\t",
      },
    });
    expect(meta.gitSha).toBeNull();
    expect(meta.buildTime).toBeNull();
    expect(meta.releaseLabel).toBeNull();
  });

  it("prefers explicit values over env-sourced ones", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "1.0.0",
      gitSha: "explicit-sha",
      buildTime: "2026-05-15T00:00:00.000Z",
      releaseLabel: "explicit-label",
      env: {
        POLARIS_GIT_SHA: "env-sha",
        POLARIS_BUILD_TIME: "1970-01-01T00:00:00Z",
        POLARIS_RELEASE_LABEL: "env-label",
      },
    });
    expect(meta.gitSha).toBe("explicit-sha");
    expect(meta.buildTime).toBe("2026-05-15T00:00:00.000Z");
    expect(meta.releaseLabel).toBe("explicit-label");
  });

  it("falls back to env when an explicit value is undefined", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "1.0.0",
      gitSha: undefined,
      env: {
        POLARIS_GIT_SHA: "env-sha",
        POLARIS_BUILD_TIME: "2026-05-12T10:00:00.000Z",
      },
    });
    expect(meta.gitSha).toBe("env-sha");
    expect(meta.buildTime).toBe("2026-05-12T10:00:00.000Z");
  });

  it("collapses explicit null to null without consulting env", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "1.0.0",
      gitSha: null,
      env: {
        POLARIS_GIT_SHA: "would-be-leaked",
      },
    });
    expect(meta.gitSha).toBeNull();
  });

  it("trims explicit string values", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "1.0.0",
      gitSha: "  abc  ",
      env: {},
    });
    expect(meta.gitSha).toBe("abc");
  });

  it("collapses whitespace-only explicit values to null", () => {
    const meta = getBuildMetadata({
      serviceName: "ingester-api",
      serviceVersion: "1.0.0",
      gitSha: "   ",
      env: {},
    });
    expect(meta.gitSha).toBeNull();
  });
});

describe("buildMetadataLogBindings", () => {
  it("includes every non-null field with snake_case keys", () => {
    const bindings = buildMetadataLogBindings({
      serviceName: "ingester-api",
      serviceVersion: "1.2.3",
      gitSha: "abc1234",
      buildTime: "2026-05-12T10:00:00.000Z",
      releaseLabel: "2026-q2-r1",
    });
    expect(bindings).toEqual({
      service: "ingester-api",
      version: "1.2.3",
      git_sha: "abc1234",
      build_time: "2026-05-12T10:00:00.000Z",
      release_label: "2026-q2-r1",
    });
  });

  it("omits null fields", () => {
    const bindings = buildMetadataLogBindings({
      serviceName: "ingester-api",
      serviceVersion: "1.2.3",
      gitSha: null,
      buildTime: null,
      releaseLabel: null,
    });
    expect(bindings).toEqual({
      service: "ingester-api",
      version: "1.2.3",
    });
  });
});
