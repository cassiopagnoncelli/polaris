/**
 * Golden-fixture replay.
 *
 * Shipped WITH the version rather than added later. v1 and v2 both
 * declared fixtures that only `manifest.test.ts` looked at — it proved
 * the files resolved on disk, which says nothing about whether they
 * still describe what the code does. The sessionizer v2 copy inherited
 * the same gap and, when the replay was finally written, the fixture
 * turned out to record an emission the runtime never produces.
 *
 * So: the input goes through the real decision and emission path on
 * every build, and the recorded output has to match.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildTouchpointCapturedEnvelope } from "../src/emit.js";
import { decideAttribution } from "../src/transform.js";
import type { AnalyticsEventEnvelope } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "golden");

/** Frozen, so the recorded output cannot drift with the wall clock. */
const NOW = new Date("2026-05-14T12:00:02.000Z");
const FIXTURE_EVENT_ID = "018f1b9e-7b50-7b12-dddd-000000000001";
const RUN_ID = "run_fixture";

const SCENARIOS = ["first-touch-for-a-profile"] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadInput(name: string): AnalyticsEventEnvelope {
  return readJson(resolve(GOLDEN, `${name}.input.json`)) as AnalyticsEventEnvelope;
}

describe("golden fixtures", () => {
  for (const name of SCENARIOS) {
    it(`${name} reproduces its recorded output`, () => {
      const raw = loadInput(name);
      const expected = readJson(resolve(GOLDEN, `${name}.output.json`));

      const decision = decideAttribution({ raw, prior: undefined });
      if (decision.kind !== "first_observation") {
        throw new Error(`expected a first observation, got "${decision.kind}"`);
      }

      // Exactly the payload `runtime.ts` builds for the first event of
      // the burst, so the fixture records the production emission rather
      // than a near-miss the runtime never produces.
      const actual = buildTouchpointCapturedEnvelope({
        raw,
        eventId: FIXTURE_EVENT_ID,
        now: () => NOW,
        run_id: RUN_ID,
        properties: {
          touchpoint_id: decision.touchpoint_id,
          primary_identifier_kind: decision.primary.kind,
          primary_identifier_value: decision.primary.value,
          campaign: decision.campaign,
          source_event_id: raw.event_id,
          observed_at: raw.occurred_at,
          run_id: RUN_ID,
        },
      });

      expect(actual).toEqual(expected);
    });
  }

  it("keys the chain on the person, not on an identifier", () => {
    // The reason for the major version. The input carries an
    // `anonymous_id` and NO `customer_id`: under v1/v2 this touchpoint
    // keyed on the anonymous id while the post-login conversion keyed on
    // the customer id, so first-touch sat on a chain the purchase never
    // joined and the paid channel that earned it got no credit.
    const raw = loadInput("first-touch-for-a-profile");
    const decision = decideAttribution({ raw, prior: undefined });
    if (decision.kind !== "first_observation") throw new Error("expected a first observation");

    expect(raw.identity.customer_id).toBeNull();
    expect(decision.primary.kind).toBe("profile_id");
    expect(decision.primary.value).toBe(raw.profile?.profile_id);
    expect(decision.store_key).toBe(
      `${raw.project_id}::${raw.environment}::${raw.profile?.profile_id}`,
    );
  });

  it("derives a touchpoint_id a replay reproduces byte for byte", () => {
    // At-least-once delivery means the same event arrives twice; a
    // random id would double-count the touchpoint downstream.
    const raw = loadInput("first-touch-for-a-profile");
    const recorded = readJson(resolve(GOLDEN, "first-touch-for-a-profile.output.json")) as {
      properties: { touchpoint_id: string };
    };

    const first = decideAttribution({ raw, prior: undefined });
    const second = decideAttribution({ raw, prior: undefined });
    if (first.kind !== "first_observation" || second.kind !== "first_observation") {
      throw new Error("expected first observations");
    }

    expect(first.touchpoint_id).toBe(second.touchpoint_id);
    expect(first.touchpoint_id).toBe(recorded.properties.touchpoint_id);
  });
});
