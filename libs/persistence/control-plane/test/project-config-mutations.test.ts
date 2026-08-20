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

import { MappingSemanticsError, SECRET_MASK } from "@polaris/tenancy-control-plane";
import { describe, expect, it } from "vitest";
import type { AuditContext } from "../src/mutations/audited.js";
import {
  MaskedSecretWriteError,
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
          isSecret: false,
        }),
      ).rejects.toBeInstanceOf(MappingSemanticsError);
    }
  });
});

describe("masked-value gate", () => {
  const base = {
    projectId: "storefront",
    environment: "production" as const,
    namespace: "meta-capi",
    configKey: "access_token",
    isSecret: true,
  };

  it("refuses the redaction placeholder as a value, before any DB access", async () => {
    // The round-trip hazard. Every read path returns `[redacted]` for a
    // secret, so a form pre-filled from a list — or a script piping
    // `config list` back into `config set` — would store that literal string
    // as the credential. The vendor then rejects it at delivery time with an
    // auth error that points nowhere near the cause.
    await expect(
      setProjectConfigValueWithAudit(explodingDb(), AUDIT, { ...base, value: SECRET_MASK }),
    ).rejects.toBeInstanceOf(MaskedSecretWriteError);
  });

  it("refuses it on a non-secret key too", async () => {
    // Sensitivity is not what makes this wrong. A masked read submitted back
    // as a plain value is just as much a lost value, and a caller that has
    // flipped a key from secret to non-secret in the same edit would slip
    // past a gate that only fired on `isSecret`.
    await expect(
      setProjectConfigValueWithAudit(explodingDb(), AUDIT, {
        ...base,
        isSecret: false,
        value: SECRET_MASK,
      }),
    ).rejects.toBeInstanceOf(MaskedSecretWriteError);
  });

  it("allows a real credential through — plaintext is the expected input now", async () => {
    // The inverse of the gate this replaced, which refused anything that was
    // not a `<provider>:<ref>` pointer. `explodingDb` proves the value got
    // past every pre-write check by the fact that it reached the database.
    await expect(
      setProjectConfigValueWithAudit(explodingDb(), AUDIT, {
        ...base,
        value: "sk-live-actual-credential",
      }),
    ).rejects.toThrow(/database was touched/);
  });

  it("names the key and the likely cause, so the refusal is actionable", async () => {
    // This gate fires on input an operator did not knowingly type — they
    // submitted a form or re-ran a script. A bare "invalid value" would send
    // them looking at the credential they never touched, so the message has
    // to name the key and say where `[redacted]` came from.
    try {
      await setProjectConfigValueWithAudit(explodingDb(), AUDIT, {
        ...base,
        configKey: "access_token",
        value: SECRET_MASK,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("access_token");
      expect(message).toContain("masked read");
    }
  });
});
