/**
 * The runner's exit behaviour.
 *
 * `validateProject` is pure and tested above; what this covers is the part a
 * deploy gate actually depends on — that a missing required key makes the
 * process exit non-zero, and that an unknown key does not. The schemas module
 * is mocked because the real registry declares no required keys, so the
 * failure path cannot be reached through it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/project-config-schemas", () => ({
  PROJECT_CONFIG_SCHEMAS: {
    "meta-capi": {
      project: {
        type: "object",
        required: ["pixel_id"],
        properties: { pixel_id: { type: "string" } },
      },
      secretKeys: { project: [], instance: [] },
    },
  },
}));

import type { CommandContext } from "../src/command.js";
import type { ConfigStore } from "../src/commands/config/index.js";
import { buildConfigValidateRunner } from "../src/commands/config/index.js";
import { CliError } from "../src/errors.js";

function makeContext(): CommandContext {
  const noop = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
    config: { output: "human" },
    logger: { ...noop, child: () => noop } as CommandContext["logger"],
    output: { writeOut: () => {}, writeErr: () => {} } as unknown as CommandContext["output"],
    actor: { source: "cli", label: "cli" },
    env: {},
  } as unknown as CommandContext;
}

function storeWith(rows: unknown[], projectIds: string[] = ["storefront"]): ConfigStore {
  return {
    list: async () => rows as never,
    listProjectIds: async () => projectIds,
    version: async () => 0n,
    set: async () => ({ applied: true, auditId: "x" }),
    unset: async () => ({ applied: false, auditId: null }),
    invalidate: async () => ({ applied: true, auditId: "x" }),
    close: async () => undefined,
  } as ConfigStore;
}

describe("config validate — exit behaviour", () => {
  it("throws with a non-zero exit code when a required key is missing", async () => {
    // The property the pre-deploy gate rests on: this must fail the rollout.
    const runner = buildConfigValidateRunner({ openStore: () => storeWith([]) });
    await expect(runner({ env: "production" }, makeContext())).rejects.toBeInstanceOf(CliError);
    await expect(runner({ env: "production" }, makeContext())).rejects.toThrow(
      /required configuration key\(s\) missing in production/,
    );
  });

  it("succeeds when every required key has a value", async () => {
    const runner = buildConfigValidateRunner({
      openStore: () =>
        storeWith([
          {
            project_id: "storefront",
            environment: "production",
            namespace: "meta-capi",
            config_key: "pixel_id",
            value: "123",
            is_secret: false,
            updated_at: "2026-08-13T12:00:00.000Z",
            updated_by: "x",
          },
        ]),
    });
    await expect(runner({ env: "production" }, makeContext())).resolves.toBeUndefined();
  });

  it("does NOT fail on an unknown key alone", async () => {
    // Free-form keys are a designed capability, not a defect; failing a deploy
    // over one would block a rollout for a variable the platform invited.
    const runner = buildConfigValidateRunner({
      openStore: () =>
        storeWith([
          {
            project_id: "storefront",
            environment: "production",
            namespace: "meta-capi",
            config_key: "pixel_id",
            value: "123",
            is_secret: false,
            updated_at: "2026-08-13T12:00:00.000Z",
            updated_by: "x",
          },
          {
            project_id: "storefront",
            environment: "production",
            namespace: "future",
            config_key: "thing",
            value: "y",
            is_secret: false,
            updated_at: "2026-08-13T12:00:00.000Z",
            updated_by: "x",
          },
        ]),
    });
    await expect(runner({ env: "production" }, makeContext())).resolves.toBeUndefined();
  });

  it("checks every project, not just the first", async () => {
    const runner = buildConfigValidateRunner({
      openStore: () => storeWith([], ["a", "b", "c"]),
    });
    await expect(runner({ env: "production" }, makeContext())).rejects.toThrow(/3 required/);
  });
});
