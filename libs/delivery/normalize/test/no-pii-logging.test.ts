import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashEmailLower,
  hashExternalId,
  hashPhoneE164,
  normalizeForDestination,
  prepareIdentity,
} from "../src/index.js";
import { buildEnvelope } from "./fixtures.js";

/**
 * Per `docs/architecture/06-destinations.md` ("Normalization"):
 *   - Normalization runs **before logging**. No structured log line emits
 *     the un-normalized PII.
 *
 * And the acceptance criteria for P9-000:
 *   - Tests verify no raw PII is logged.
 *
 * This package does not import any logger and does not use `console.*`.
 * That is a structural property: a producer leak of PII through this layer
 * would require introducing a logger import. The tests below pin the
 * property by spying on the global console methods and asserting they are
 * never called from any helper, even for inputs that explicitly carry raw
 * PII.
 */

describe("no raw PII is logged from this package", () => {
  // We intercept the four console surfaces a typical Node logger writes
  // through (`console.log/info/warn/error`) plus `process.stdout.write`
  // and `process.stderr.write`. The package must use none of them.
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("hashing helpers do not write any log output", () => {
    hashEmailLower("alice@example.com");
    hashPhoneE164("+15555550123");
    hashExternalId("cus_001");
    expectNoLogging();
  });

  it("prepareIdentity does not log even when inputs carry raw PII", () => {
    prepareIdentity({
      user_id: "cus_001",
      anonymous_id: "anon_xyz",
      email: "alice@example.com",
      phone: "+15555550123",
    });
    expectNoLogging();
  });

  it("normalizeForDestination does not log a normalized event", () => {
    const envelope = buildEnvelope({
      identity: {
        anonymous_id: "anon_xyz",
        session_id: null,
        customer_id: "cus_001",
        device_id: null,
      },
    });
    normalizeForDestination(envelope, {
      destinationId: "polaris_dst_test",
      requiredConsent: {},
      identityFromProperties: () => ({
        email: "alice@example.com",
        phone: "+15555550123",
      }),
    });
    expectNoLogging();
  });

  it("normalizeForDestination does not log on a drop outcome", () => {
    const envelope = buildEnvelope({
      consent: { marketing: false },
    });
    const outcome = normalizeForDestination(envelope, {
      destinationId: "polaris_dst_test",
      requiredConsent: { marketing: true },
    });
    expect(outcome.kind).toBe("drop");
    expectNoLogging();
  });

  function expectNoLogging(): void {
    expect(logSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  }
});
