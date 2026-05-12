import type { EventInput } from "../src/index.js";

/**
 * Build a canonical envelope-shaped event for tests. Callers override
 * `properties` (the most common per-test variant); the envelope sections
 * default to plausible values so the evaluator walks a realistic shape.
 *
 * The fixtures never embed real payment data or real secrets. Values are
 * either obviously synthetic (`"test"`, `"sample-..."`) or constructed by
 * helpers like `syntheticLuhn()` so a leak into a test log would not
 * expose anything sensitive.
 */
export function buildEvent(overrides: Partial<EventInput> = {}): EventInput {
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
      ip: null,
      user_agent: null,
      locale: "pt-BR",
      page: null,
      campaign: null,
    },
    properties: {
      amount: 12990,
      currency: "BRL",
    },
    ...overrides,
  };
}

/**
 * Construct a Luhn-valid sequence of `length` digits. Used for PAN
 * pattern tests so we exercise the Luhn checksum without checking in a
 * real card number. The first 15 digits are filled with `4111111111111`
 * style padding; the final digit is computed.
 */
export function syntheticLuhn(length: number): string {
  if (length < 13 || length > 19) throw new Error("length out of range");
  // Use a known issuer-ish prefix to look plausible without being real.
  const base = "424242424242424242".slice(0, length - 1);
  const checkDigit = computeLuhnCheckDigit(base);
  return base + String(checkDigit);
}

function computeLuhnCheckDigit(digits: string): number {
  let sum = 0;
  let alt = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i) - 48;
    let n = ch;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Capture stream that buffers any written log lines for assertions.
 * Mirrors the helper used in `@polaris/shared-logger` tests but kept
 * local here so the policy tests do not depend on logger internals.
 */
export class CapturingStream {
  readonly chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.chunks.push(text);
    return true;
  }
  end(): void {}
  text(): string {
    return this.chunks.join("");
  }
  /** Parse each line as JSON, ignoring empty lines. */
  lines(): unknown[] {
    return this.text()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }
}
