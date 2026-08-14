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

describe("config set — routing gate validation", () => {
  // The gate degrades to "unconfigured" on a value it cannot parse, which is
  // right at delivery time — a typo must not mute a destination — but it
  // makes the typo invisible at write time. These pin the refusal.

  it("stores a well-formed routing config", async () => {
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });
    await runner(
      {
        ...BASE_ARGS,
        key: "routing",
        value: JSON.stringify({ subscriptions: { events: ["payment.approved"] } }),
      },
      makeContext(),
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses a filter on a root the gate cannot address", async () => {
    // `identity` is deliberately unfilterable. Accepting this would store a
    // rule that reads as working and silently never matches.
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });
    await expect(
      runner(
        {
          ...BASE_ARGS,
          key: "routing",
          value: JSON.stringify({ filters: [{ path: "identity.email", op: "exists" }] }),
        },
        makeContext(),
      ),
    ).rejects.toThrow(/routing gate configuration/);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown operator and writes nothing", async () => {
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });
    await expect(
      runner(
        {
          ...BASE_ARGS,
          key: "routing",
          value: JSON.stringify({ filters: [{ path: "properties.a", op: "matches", value: "x" }] }),
        },
        makeContext(),
      ),
    ).rejects.toThrow(/routing gate configuration/);
    expect(calls).toHaveLength(0);
  });
});

describe("config set — schema-declared secret keys", () => {
  it("FORCES is_secret on a secret-typed key even when --secret is omitted", async () => {
    // The behaviour changed shape here, and the reason is worth keeping. This
    // used to REFUSE: the flag decided which column semantics applied, and a
    // write without it would have put a credential in a slot documented to
    // hold a `provider:ref` pointer. Every value now lives in the same column,
    // so a forgotten flag is not an unsafe write — it is a value that would be
    // handled carelessly, printed in `config list` and copied into the audit
    // row. Deciding from the schema fixes that without making the operator
    // re-run the command.
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await runner({ ...BASE_ARGS, key: "access_token", value: "EAAB-live-token" }, makeContext());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: { isSecret: true, value: "EAAB-live-token" },
    });
  });

  it("accepts the same key with --secret, storing the credential itself", async () => {
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await runner(
      { ...BASE_ARGS, key: "access_token", value: "EAAB-live-token", secret: true },
      makeContext(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { isSecret: true, value: "EAAB-live-token" } });
  });

  it("leaves non-secret keys of the same namespace alone", async () => {
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await runner({ ...BASE_ARGS, key: "graph_host", value: "graph.facebook.com" }, makeContext());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { isSecret: false } });
  });

  it("--secret can ADD sensitivity to a key no schema declares", async () => {
    // Free-form keys are the reason the flag still exists: the generated
    // schemas know nothing about them, so the server has nothing to decide
    // from and the operator's word is all there is.
    const { store, calls } = recordingStore();
    const runner = buildConfigSetRunner({ openStore: () => store });

    await runner(
      { ...BASE_ARGS, key: "partner_api_key", value: "pk-live-xyz", secret: true },
      makeContext(),
    );
    expect(calls[0]).toMatchObject({ input: { isSecret: true } });
  });
});
