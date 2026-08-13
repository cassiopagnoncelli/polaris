/**
 * `polaris config set` — the schema-driven secret gate.
 *
 * The generated registry currently declares no secret keys (ingest has none),
 * so the branch under test is dormant against the real artifact and the
 * schemas module is mocked with a namespace that has one. The mock mirrors
 * the artifact's real shape (`secretKeys.project`), so when meta-capi's
 * schema lands the real thing exercises the same path.
 *
 * NOTE: this file starts the `polaris config` verbs' own test coverage —
 * VCJ896JN shipped the verbs with mutation-layer tests but none at the runner
 * level. Worth extending when the verbs next change.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/project-config-schemas", () => ({
  PROJECT_CONFIG_SCHEMAS: {
    "meta-capi": {
      project: {
        type: "object",
        properties: {
          access_token: { type: "string", secret: true },
          graph_host: { type: "string" },
        },
      },
      secretKeys: { project: ["access_token"], instance: [] },
    },
  },
}));

import type { CommandContext } from "../src/command.js";
import type { ConfigStore } from "../src/commands/config/index.js";
import { buildConfigSetRunner } from "../src/commands/config/index.js";
import { UsageError } from "../src/errors.js";

function makeContext(): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: "human",
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: { ...noopLogger, child: () => noopLogger } as CommandContext["logger"],
    output: { writeOut: () => {}, writeErr: () => {} } as unknown as CommandContext["output"],
    meta: { version: "test" } as CommandContext["meta"],
    actor: { source: "cli", label: "cli" },
    env: {},
  } as unknown as CommandContext;
}

function recordingStore(): { store: ConfigStore; calls: unknown[] } {
  const calls: unknown[] = [];
  const store: ConfigStore = {
    list: async () => [],
    version: async () => 0n,
    set: async (input, audit) => {
      calls.push({ input, audit });
      return { applied: true, auditId: audit.auditId };
    },
    unset: async () => ({ applied: false, auditId: null }),
    invalidate: async () => ({ applied: true, auditId: "polaris_aud_x" }),
    close: async () => undefined,
  };
  return { store, calls };
}

const BASE_ARGS = {
  project: "storefront",
  env: "production",
  namespace: "meta-capi",
  reason: "rotating credentials",
};

describe("config set — schema-declared secret keys", () => {
  it("refuses a secret-typed key without --secret-ref, before touching the store", async () => {
    // The failure this prevents: an operator omits the flag and a live
    // credential lands in PostgreSQL as ordinary jsonb, past every gate that
    // only fires when is_secret_ref is set.
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await expect(
      runner({ ...BASE_ARGS, key: "access_token", value: "sk-live-oops" }, makeContext()),
    ).rejects.toThrow(UsageError);
    await expect(
      runner({ ...BASE_ARGS, key: "access_token", value: "sk-live-oops" }, makeContext()),
    ).rejects.toThrow(/secret-typed key/);
    expect(calls).toHaveLength(0);
  });

  it("accepts the same key with --secret-ref and a reference", async () => {
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await runner(
      {
        ...BASE_ARGS,
        key: "access_token",
        value: "vault:polaris/production/storefront/meta-capi",
        secretRef: true,
      },
      makeContext(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: { isSecretRef: true, value: "vault:polaris/production/storefront/meta-capi" },
    });
  });

  it("leaves non-secret keys of the same namespace alone", async () => {
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await runner({ ...BASE_ARGS, key: "graph_host", value: "graph.facebook.com" }, makeContext());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { isSecretRef: false } });
  });
});
