/**
 * Export-boundary tests.
 *
 * `docs/architecture/02-control-plane.md` gives three reasons the
 * control-plane API should exist, and the first is that audit records are
 * written server-side atomically with the mutation. This package makes that
 * structural rather than aspirational: the only way to mutate control-plane
 * state from outside is through a `*WithAudit` function, which owns the
 * transaction and writes the row inside it.
 *
 * That property lives entirely in what `index.ts` does and does not export,
 * which is exactly the kind of thing a well-meaning "just export it, I need
 * it for one thing" commit erodes. These tests are the tripwire.
 */

import { describe, expect, it } from "vitest";

import * as pkg from "../src/index.js";
import * as progress from "../src/progress.js";

/**
 * Writers that must never be reachable from the package root.
 *
 * Each one has a `*WithAudit` counterpart. Exporting a bare writer would let
 * a caller mutate control-plane state with no audit row and no transaction,
 * which is the whole thing this package exists to prevent.
 */
const FORBIDDEN_AT_ROOT = [
  "insertAuditRecord",
  "insertApiKey",
  "revokeApiKey",
  "insertDestination",
  "enableDestination",
  "disableDestination",
  "enableDestinationReplay",
  "disableDestinationReplay",
  "updateDestinationOps",
  "insertOperatorToken",
  "revokeOperatorToken",
  "enableProcessorActivation",
  "disableProcessorActivation",
  "insertReplayJob",
  "cancelReplayJob",
  "pauseReplayJob",
  "resumeReplayJob",
  "markReplayJobRunning",
  "insertTopicIsolation",
  "deactivateIsolation",
  "insertClickhouseRebuildJob",
  "abortClickhouseRebuildJob",
  "insertProject",
  "updateProject",
  "insertSource",
  "updateSource",
] as const;

describe("package export boundary", () => {
  it.each(FORBIDDEN_AT_ROOT)("does not export the bare writer %s", (name) => {
    expect(Object.keys(pkg)).not.toContain(name);
  });

  it("exports a *WithAudit counterpart for every mutation surface", () => {
    // If a new bare writer is added above with no audited counterpart, this
    // fails and says which one — the fix is to write the mutation, not to
    // shorten the list.
    const audited = Object.keys(pkg).filter((k) => k.endsWith("WithAudit"));
    expect(audited.length).toBeGreaterThanOrEqual(20);
    for (const surface of [
      "Destination",
      "ApiKey",
      "OperatorToken",
      "ProcessorActivation",
      "ReplayJob",
      "Topic",
      "ClickhouseRebuild",
      "Dlq",
    ]) {
      expect(
        audited.some((name) => name.includes(surface)),
        `no *WithAudit mutation covers ${surface}`,
      ).toBe(true);
    }
  });

  it("keeps the progress path to executor bookkeeping only", () => {
    // These are the one category of write with no audit row, because nobody
    // decided them — a running job is reporting where it got to. Anything
    // operator-initiated appearing here is a mistake.
    expect(Object.keys(progress).sort()).toEqual([
      "completeReplayJob",
      "failReplayJob",
      "markClickhouseRebuildJobCompleted",
      "markClickhouseRebuildJobFailed",
      "markClickhouseRebuildJobRunning",
      "recordReplayChunkProgress",
      "touchOperatorTokenLastUsedAt",
    ]);
  });

  it("no longer ships an unaudited escape hatch", async () => {
    // `unaudited.ts` existed while CLI commands still hand-rolled their own
    // transactions. They no longer do, so the door is closed rather than
    // merely unpleasant to open.
    //
    // The specifier is built at runtime on purpose: a literal one would be a
    // static import TypeScript resolves, so this would fail `tsc` rather than
    // the assertion — which is the opposite of what it is for.
    const gone = ["..", "src", "unaudited.js"].join("/");
    await expect(import(/* @vite-ignore */ gone)).rejects.toThrow();
  });
});
