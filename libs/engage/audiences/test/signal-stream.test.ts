/**
 * Fixture-stream determinism for audience signals.
 *
 * The recorded output was produced by the PRE-CARVE runner —
 * `async/computation/audiences/v1/src/runner.ts` as it stood before Q7COB
 * moved the evaluator into this library — driven over
 * `audience-signal-stream.input.json` with in-memory doubles. So a passing
 * run here is evidence the carve moved code and changed nothing, which is
 * the one claim a refactor makes and the one a type-checker cannot check.
 *
 * It keeps earning its place afterwards, for a different reason. Audience
 * transitions are consumed as CHANGES: `audience.entered` reaches a vendor
 * and a journey triggers on it. A population that reordered itself, or a
 * silent run that started re-announcing its members, is not a test failure
 * anywhere else in this repository — every unit assertion would still pass
 * while the stream downstream of them turned into noise.
 *
 * ## The replay is pure, and that is the assertion
 *
 * The runtime writes membership and publishes events; this threads a ledger
 * in memory instead. Everything between the input and the trace —
 * `membersMatching`, `planAudience`, and the write-then-emit ORDER — is
 * library code, so the trace is a function of the fixture alone. No store,
 * no broker, no clock.
 *
 * ## Byte-identical, after one normalisation and only one
 *
 * The comparison serialises both sides with the same `JSON.stringify` and
 * compares the strings, so it catches a changed value, a changed order of
 * signals, and a changed order of KEYS within one — all three of which are
 * a different stream to something parsing it. It does not catch whitespace,
 * because `biome format` owns every JSON file in this repository and
 * reformats the recorded one; asserting on the file's own bytes would make
 * this test fail whenever the formatter ran.
 *
 * ## Regenerating it
 *
 * Don't, unless the change to audience semantics is the point of the card
 * you are on. A diff here is a change in what the platform tells its
 * destinations, and it belongs in the card's Acceptance Criteria rather
 * than in a re-record. When it IS the point, the recorded file is
 * `replay(input)` as JSON, with `pnpm format` run over it afterwards.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type AudienceDefinition, audienceDefinitionSchema } from "@polaris/audience-catalog";
import { traitsReferenced } from "@polaris/audience-catalog";
import { describe, expect, it } from "vitest";

import {
  type AudienceSummary,
  membersMatching,
  planAudience,
  type ProfileTraits,
  type StampedMembership,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, "golden");

interface FixtureRun {
  readonly runId: string;
  readonly at: string;
  readonly audiences: readonly unknown[];
  readonly profiles: readonly ProfileTraits[];
  readonly projection: ReadonlyArray<{ readonly profile_id: string }>;
}

interface Fixture {
  readonly projectId: string;
  readonly environment: string;
  readonly runs: readonly FixtureRun[];
}

interface Replay {
  readonly trace: readonly unknown[];
  readonly perRun: ReadonlyArray<{
    readonly runId: string;
    readonly perAudience: readonly AudienceSummary[];
    readonly transitions: number;
  }>;
}

/**
 * The membership ledger, as the store would hold it.
 *
 * A row survives its exit — that is what lets the diff tell a re-entry from
 * a first entry — so nothing is ever deleted here either.
 */
type Ledger = Map<string, Map<string, StampedMembership>>;

/**
 * Which profiles the runtime's trait read would have returned.
 *
 * The store fetches profiles carrying a value for any key the predicate
 * names, so the fixture's whole population is narrowed the same way before
 * the predicate sees it. Reading it as "every profile" would hide the
 * narrowing, which is the thing that bounds a trait audience.
 */
function readProfiles(run: FixtureRun, keys: readonly string[]): readonly ProfileTraits[] {
  return run.profiles.filter((profile) => keys.some((key) => Object.hasOwn(profile.traits, key)));
}

function replay(fixture: Fixture): Replay {
  const ledger: Ledger = new Map();
  const trace: unknown[] = [];
  const perRun: Replay["perRun"][number][] = [];

  for (const run of fixture.runs) {
    const at = new Date(run.at);
    const perAudience: AudienceSummary[] = [];
    let transitions = 0;

    for (const raw of run.audiences) {
      const definition = audienceDefinitionSchema.parse(raw) as AudienceDefinition;
      const rows = ledger.get(definition.key) ?? new Map<string, StampedMembership>();
      ledger.set(definition.key, rows);

      const desired =
        definition.source === "projection"
          ? new Set(run.projection.map((row) => row.profile_id))
          : membersMatching(
              definition.predicate,
              readProfiles(run, traitsReferenced(definition.predicate)),
            );

      const plan = planAudience({ definition, desired, stored: [...rows.values()] });

      // Write, then announce — the runtime's order, and the reason a
      // crash between the two loses a signal instead of inventing one.
      for (const transition of plan.transitions) {
        if (transition.kind === "entered") {
          trace.push({
            step: "write",
            op: "enter",
            audience: definition.key,
            profileId: transition.profileId,
          });
          rows.set(transition.profileId, {
            profileId: transition.profileId,
            enteredAt: at,
            exitedAt: null,
            audienceVersion: definition.version,
          });
          trace.push({
            step: "emit",
            event: "audience.entered",
            audience: definition.key,
            audience_version: definition.version,
            profile_id: transition.profileId,
            re_entry: transition.reEntry,
            run_id: run.runId,
          });
          continue;
        }

        trace.push({
          step: "write",
          op: "exit",
          audience: definition.key,
          profileId: transition.profileId,
        });
        const existing = rows.get(transition.profileId);
        if (existing !== undefined) {
          rows.set(transition.profileId, {
            ...existing,
            exitedAt: at,
            audienceVersion: definition.version,
          });
        }
        trace.push({
          step: "emit",
          event: "audience.exited",
          audience: definition.key,
          audience_version: definition.version,
          profile_id: transition.profileId,
          entered_at: transition.enteredAt.toISOString(),
          run_id: run.runId,
        });
      }

      if (plan.restamp.length > 0) {
        trace.push({
          step: "write",
          op: "restamp",
          audience: definition.key,
          profileIds: [...plan.restamp],
        });
        for (const profileId of plan.restamp) {
          const existing = rows.get(profileId);
          if (existing !== undefined) {
            rows.set(profileId, { ...existing, audienceVersion: definition.version });
          }
        }
      }

      transitions += plan.transitions.length;
      perAudience.push(plan.summary);
    }

    perRun.push({ runId: run.runId, perAudience, transitions });
  }

  return { trace, perRun };
}

describe("the audience signal stream", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(GOLDEN, "audience-signal-stream.input.json"), "utf8"),
  ) as Fixture;
  const recorded = JSON.parse(
    readFileSync(resolve(GOLDEN, "audience-signal-stream.output.json"), "utf8"),
  ) as Replay;

  it("reproduces the pre-carve runner's trace exactly", () => {
    expect(JSON.stringify(replay(fixture))).toBe(JSON.stringify(recorded));
  });

  it("is a function of the fixture alone, so a second pass is identical", () => {
    expect(JSON.stringify(replay(fixture))).toBe(JSON.stringify(replay(fixture)));
  });

  it("says nothing at all about a run whose population did not move", () => {
    const quiet = recorded.perRun.find((run) => run.runId === "run_2");
    expect(quiet?.transitions).toBe(0);
    expect(quiet?.perAudience.every((summary) => summary.restamped === 0)).toBe(true);
  });
});
