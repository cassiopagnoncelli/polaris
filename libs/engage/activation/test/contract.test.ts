/**
 * The contract holds today's producer.
 *
 * `src/types.ts` has no runtime, so nothing here can call it. What this
 * asserts instead is the claim the contract makes: that the entered/exited
 * signals `@polaris/engage-audiences` produces today map onto a
 * `MembershipDelta` with nothing lost and nothing invented.
 *
 * It matters because the contract is written BEFORE its consumer. A shape
 * declared in advance and never exercised drifts from the thing it claims
 * to describe, and the drift is found by whoever writes
 * `async/activation/audience-sync` — at which point the argument is about
 * two live shapes rather than about one file. `toDelta` below is a test
 * fixture on purpose: it is the mapping the sync stage will make, written
 * out so a change to either side breaks here first.
 */

import type { AudienceTransition } from "@polaris/engage-audiences";
import { describe, expect, it } from "vitest";

import type { AudienceRef, MembershipChange, MembershipDelta } from "../src/index.js";

const AUDIENCE: AudienceRef = {
  projectId: "storefront",
  environment: "production",
  audience: "recent_purchasers",
  audienceVersion: 2,
  kind: "computed",
};

const ENTERED_AT = new Date("2026-08-01T00:00:00.000Z");

/** The mapping `async/activation/audience-sync` will make. */
function toDelta(transition: AudienceTransition, runId: string): MembershipDelta {
  const change: MembershipChange =
    transition.kind === "entered"
      ? { change: "entered", profileId: transition.profileId, reEntry: transition.reEntry }
      : { change: "exited", profileId: transition.profileId, enteredAt: transition.enteredAt };
  return { ...AUDIENCE, change, runId };
}

describe("the membership-delta contract", () => {
  it("expresses an entry, including whether the profile had been here before", () => {
    const delta = toDelta({ kind: "entered", profileId: "p1", reEntry: true }, "polaris_arun_1");
    expect(delta.change).toEqual({ change: "entered", profileId: "p1", reEntry: true });
    expect(delta.audienceVersion).toBe(2);
    expect(delta.kind).toBe("computed");
  });

  it("expresses an exit, keeping the start of the membership it closes", () => {
    // Dropped here, dwell time is unrecoverable downstream: the vendor
    // learns that somebody left and not how long they had been in.
    const delta = toDelta(
      { kind: "exited", profileId: "p2", enteredAt: ENTERED_AT },
      "polaris_arun_1",
    );
    expect(delta.change).toEqual({ change: "exited", profileId: "p2", enteredAt: ENTERED_AT });
  });

  it("covers every transition the audiences library can produce", () => {
    // A third transition kind added upstream stops compiling here, which is
    // the point of writing the mapping out rather than describing it.
    const kinds: ReadonlyArray<AudienceTransition["kind"]> = ["entered", "exited"];
    const transitions: readonly AudienceTransition[] = [
      { kind: "entered", profileId: "p1", reEntry: false },
      { kind: "exited", profileId: "p2", enteredAt: ENTERED_AT },
    ];
    expect(transitions.map((transition) => transition.kind)).toEqual(kinds);
    expect(transitions.map((transition) => toDelta(transition, "r").change.change)).toEqual(kinds);
  });
});
