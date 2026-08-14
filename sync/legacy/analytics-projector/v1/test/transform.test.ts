/**
 * Golden-fixture tests for the analytics-projector v1 transform.
 *
 * Each fixture pair is a JSON file under `test/golden/`:
 *
 *   <case>.input.json   — canonical raw.events envelope (post-stamp)
 *   <case>.output.json  — expected analytics.events envelope
 *
 * The test pins `ran_at` to a deterministic timestamp so the comparison
 * is exact. Any change to the emitted envelope shape will fail these
 * tests, which is the architectural intent: processor v1 behavior is
 * immutable, so an output diff means "create v2" rather than "patch v1".
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Versioning"
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type AnalyticsEventEnvelope,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  type RawEventEnvelope,
  transformToAnalyticsEvent,
} from "../src/transform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLDEN_DIR = join(__dirname, "golden");

/**
 * Deterministic clock used for every golden run. The exact instant is
 * intentionally distinct from `occurred_at` and `ingested_at` in the
 * fixtures so a regression that accidentally pulls one of those into
 * `ran_at` blows up the equality assertion instead of silently passing.
 */
const RAN_AT_ISO = "2026-05-12T12:00:02.000Z";
const fixedNow = (): Date => new Date(RAN_AT_ISO);

function loadFixture(name: string): { input: RawEventEnvelope; output: AnalyticsEventEnvelope } {
  const input = JSON.parse(
    readFileSync(join(GOLDEN_DIR, `${name}.input.json`), "utf8"),
  ) as RawEventEnvelope;
  const output = JSON.parse(
    readFileSync(join(GOLDEN_DIR, `${name}.output.json`), "utf8"),
  ) as AnalyticsEventEnvelope;
  return { input, output };
}

describe("transformToAnalyticsEvent (v1)", () => {
  it("matches the golden fixture for payment.approved byte-for-byte (structural)", () => {
    const { input, output } = loadFixture("payment-approved");
    const actual = transformToAnalyticsEvent(input, { now: fixedNow });
    expect(actual).toEqual(output);
  });

  it("preserves the canonical envelope verbatim and stamps processor metadata in both shapes", () => {
    const { input } = loadFixture("payment-approved");
    const actual = transformToAnalyticsEvent(input, { now: fixedNow });

    // Envelope fields copied verbatim.
    expect(actual.event_id).toBe(input.event_id);
    expect(actual.event).toBe(input.event);
    expect(actual.schema_version).toBe(input.schema_version);
    expect(actual.project_id).toBe(input.project_id);
    expect(actual.environment).toBe(input.environment);
    expect(actual.occurred_at).toBe(input.occurred_at);
    expect(actual.ingested_at).toBe(input.ingested_at);
    expect(actual.source).toEqual(input.source);
    expect(actual.identity).toEqual(input.identity);
    expect(actual.context).toEqual(input.context);
    expect(actual.properties).toEqual(input.properties);
    expect(actual.consent).toEqual(input.consent);
    expect(actual.privacy).toEqual(input.privacy);

    // Processor stamp — both the nested `processor` object and the flat
    // ClickHouse columns must be present and consistent.
    expect(actual.processor).toEqual({
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
      ran_at: RAN_AT_ISO,
    });
    expect(actual.processor_name).toBe(PROCESSOR_NAME);
    expect(actual.processor_version).toBe(PROCESSOR_VERSION);
  });

  it("omits consent and privacy when the input does not carry them", () => {
    const { input } = loadFixture("payment-approved");
    // Strip the optional metadata so we can validate the transform does
    // not emit `consent: undefined` / `privacy: undefined`, which would
    // serialise to the literal strings in ClickHouse's tolerant
    // JSONEachRow format.
    const { consent: _c, privacy: _p, ...without } = input;
    void _c;
    void _p;
    const actual = transformToAnalyticsEvent(without as RawEventEnvelope, { now: fixedNow });
    expect(actual).not.toHaveProperty("consent");
    expect(actual).not.toHaveProperty("privacy");
    expect(actual.processor).toEqual({
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
      ran_at: RAN_AT_ISO,
    });
  });

  it("uses the provided now() rather than the host wall clock", () => {
    const { input } = loadFixture("payment-approved");
    const fixed = new Date("2099-01-01T00:00:00.000Z");
    const actual = transformToAnalyticsEvent(input, { now: () => fixed });
    expect(actual.processor.ran_at).toBe(fixed.toISOString());
  });

  it("defaults now() to the real clock when omitted", () => {
    const { input } = loadFixture("payment-approved");
    const before = Date.now();
    const actual = transformToAnalyticsEvent(input);
    const after = Date.now();
    const ranAtMs = new Date(actual.processor.ran_at).getTime();
    expect(ranAtMs).toBeGreaterThanOrEqual(before);
    expect(ranAtMs).toBeLessThanOrEqual(after);
  });
});
