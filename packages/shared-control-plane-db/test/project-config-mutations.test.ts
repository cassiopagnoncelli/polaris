/**
 * The two write gates, and the transaction contract.
 *
 * The gates are the point of this file. `project_config.value` and
 * `destinations.config` are `jsonb`, so "PostgreSQL has nowhere to put a field
 * map" stopped being structurally true when those columns landed. What
 * replaces it is a key check that runs BEFORE any write — which means the
 * assertion that matters is not just "it threw", but "it threw and the
 * transaction never opened".
 */

import { MappingSemanticsError } from "@polaris/shared-control-plane";
import { describe, expect, it } from "vitest";
import type { AuditContext } from "../src/mutations/audited.js";
import {
  PlaintextSecretError,
  setProjectConfigValueWithAudit,
} from "../src/mutations/project-config.js";

const AUDIT: AuditContext = {
  auditId: "polaris_aud_test",
  actorSource: "operator_token",
  actorLabel: "cassio@example.com",
  reason: "test",
  occurredAt: new Date("2026-08-13T12:00:00.000Z"),
};

/**
 * A database that explodes if anything touches it.
 *
 * Passing this proves the gate ran before the transaction opened, which a
 * simple `expect(...).rejects` against a working fake could not distinguish
 * from "rejected after writing".
 */
function explodingDb(): never {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`database was touched: .${String(prop)}() — the gate did not run first`);
      },
    },
  ) as never;
}

describe("mapping-semantics gate", () => {
  it("refuses every forbidden token as a config key, before any DB access", async () => {
    for (const key of ["field_map", "fieldMap", "event-map", "mapping", "property_map"]) {
      await expect(
        setProjectConfigValueWithAudit(explodingDb(), AUDIT, {
          projectId: "storefront",
          environment: "production",
          namespace: "meta-capi",
          configKey: key,
          value: "anything",
          isSecretRef: false,
        }),
      ).rejects.toBeInstanceOf(MappingSemanticsError);
    }
  });
});

describe("plaintext-secret gate", () => {
  const base = {
    projectId: "storefront",
    environment: "production" as const,
    namespace: "meta-capi",
    configKey: "access_token",
    isSecretRef: true,
  };

  it("refuses a bare credential on a secret-typed key, before any DB access", async () => {
    await expect(
      setProjectConfigValueWithAudit(explodingDb(), AUDIT, {
        ...base,
        value: "sk-live-actual-credential",
      }),
    ).rejects.toThrow(/provider reference/);
  });

  it("refuses a non-string value on a secret-typed key", async () => {
    await expect(
      setProjectConfigValueWithAudit(explodingDb(), AUDIT, { ...base, value: 5000 }),
    ).rejects.toBeInstanceOf(PlaintextSecretError);
  });

  it("does not echo the offending value in the error message", async () => {
    // The whole point of refusing is to keep the credential out of logs. An
    // error that quotes it would defeat that on the way out.
    const secret = "sk-live-NEVER-ECHO-THIS";
    try {
      await setProjectConfigValueWithAudit(explodingDb(), AUDIT, { ...base, value: secret });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});
