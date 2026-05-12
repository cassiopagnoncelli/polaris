import type { NormalizableEnvelope } from "../src/index.js";

/**
 * Build a canonical-shaped envelope for tests. Callers override
 * sub-sections; defaults are plausible values that pass envelope
 * conformance.
 *
 * The fixture deliberately uses obviously-synthetic identity values so a
 * leak to test logs would not expose anything sensitive.
 */
export function buildEnvelope(overrides: Partial<NormalizableEnvelope> = {}): NormalizableEnvelope {
  return {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "payment.approved",
    schema_version: 1,
    project_id: "checkout",
    environment: "production",
    occurred_at: "2026-05-11T12:00:00.000Z",
    ingested_at: "2026-05-11T12:00:01.120Z",
    source: { type: "backend", id: "payments-api" },
    identity: {
      anonymous_id: null,
      session_id: null,
      customer_id: "cus_test",
      device_id: null,
    },
    context: {
      ip: "203.0.113.10",
      user_agent: "Mozilla/5.0 ...",
      locale: "pt-BR",
      page: null,
      campaign: null,
    },
    consent: { analytics: true, marketing: true, personalization: true },
    properties: {
      amount: 12990,
      currency: "BRL",
    },
    ...overrides,
  };
}
