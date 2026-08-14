/**
 * Golden-fixture replay.
 *
 * The manifest declares this fixture pair and `manifest.test.ts` proves
 * the files resolve on disk — which says nothing about whether they
 * still describe what the code does. This suite runs the input through
 * the real decision and emission path on every build and compares.
 *
 * That is the semantic-immutability rule with teeth: a change that
 * alters emitted output for a released version fails here with a
 * concrete before/after diff, and whoever made it has to decide whether
 * it needs a new processor version. The v1 chassis never had this, and
 * the v2 copy inherited the gap; R1B and R1C set the bar.
 *
 * The `session_id` in the recorded output is the one place a silent
 * change would be most costly: it is deterministic by design so replays
 * reproduce it, and it is domain-separated from v1 so the two versions
 * running side by side never mint the same id for windows that mean
 * different things.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSessionStartedEnvelope } from "../src/emit.js";
import { decideSession } from "../src/transform.js";
import type { RawEventEnvelope } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "golden");

/** Frozen so the recorded output cannot drift with the wall clock. */
const NOW = new Date("2026-05-12T12:00:00.600Z");
const FIXTURE_EVENT_ID = "018f1b9e-7b50-7b12-cccc-000000000001";
const RUN_ID = "run_fixture";

const SCENARIOS = ["session-started-for-a-profile"] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("golden fixtures", () => {
  for (const name of SCENARIOS) {
    it(`${name} reproduces its recorded output`, () => {
      const raw = readJson(resolve(GOLDEN, `${name}.input.json`)) as RawEventEnvelope;
      const expected = readJson(resolve(GOLDEN, `${name}.output.json`));

      const decision = decideSession({ raw, prior: undefined });
      if (decision.kind !== "start") {
        throw new Error(`expected a session start, got "${decision.kind}"`);
      }

      const actual = buildSessionStartedEnvelope({
        raw,
        eventId: FIXTURE_EVENT_ID,
        now: () => NOW,
        run_id: RUN_ID,
        // Exactly what `runtime.ts` builds for a start, so the fixture
        // records the production emission rather than a near-miss the
        // runtime never produces.
        properties: {
          session_id: decision.session_id,
          primary_identifier_kind: decision.primary.kind,
          primary_identifier_value: decision.primary.value,
          started_at: decision.started_at,
          source_event_id: raw.event_id,
          run_id: RUN_ID,
        },
      });

      expect(actual).toEqual(expected);
    });
  }

  it("keys the recorded window on the person, not on an identifier", () => {
    // The whole reason for the major version. The input deliberately
    // carries an `anonymous_id` and NO `customer_id`: v1 would have keyed
    // on the anonymous id and re-keyed the moment a customer id appeared,
    // ending one session and orphaning it.
    const raw = readJson(
      resolve(GOLDEN, "session-started-for-a-profile.input.json"),
    ) as RawEventEnvelope;
    const decision = decideSession({ raw, prior: undefined });
    if (decision.kind !== "start") throw new Error("expected a session start");

    expect(decision.primary.kind).toBe("profile_id");
    expect(decision.primary.value).toBe(raw.profile?.profile_id);
    expect(decision.store_key).toBe(
      `${raw.project_id}::${raw.environment}::${raw.profile?.profile_id}`,
    );
  });

  it("derives a session_id that a replay reproduces byte for byte", () => {
    const raw = readJson(
      resolve(GOLDEN, "session-started-for-a-profile.input.json"),
    ) as RawEventEnvelope;
    const recorded = readJson(resolve(GOLDEN, "session-started-for-a-profile.output.json")) as {
      properties: { session_id: string };
    };

    const first = decideSession({ raw, prior: undefined });
    const second = decideSession({ raw, prior: undefined });
    if (first.kind !== "start" || second.kind !== "start") {
      throw new Error("expected session starts");
    }

    expect(first.session_id).toBe(second.session_id);
    expect(first.session_id).toBe(recorded.properties.session_id);
  });
});
