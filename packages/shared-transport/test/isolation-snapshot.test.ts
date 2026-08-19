/**
 * The snapshot is what makes topic isolation operational, so its failure
 * behaviour matters more than its happy path.
 *
 * `StreamIsolationCache` was correct and constructed by nothing for months,
 * because it answers one triple asynchronously and neither half fits where
 * the answer is needed: producers resolve a family synchronously on every
 * publish, and consumers need an enumerable list once at subscribe time.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type ActiveIsolation,
  type CreateIsolationSnapshotOptions,
  consumerFamiliesFor,
  createIsolationSnapshot,
  type IsolationSnapshotReader,
  STREAM_FAMILY_RAW_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
} from "../src/index.js";

function readerOf(...batches: ReadonlyArray<ReadonlyArray<ActiveIsolation> | Error>) {
  let call = 0;
  const calls: string[] = [];
  const reader: IsolationSnapshotReader = {
    async listActive(environment) {
      calls.push(environment);
      const batch = batches[Math.min(call, batches.length - 1)];
      call += 1;
      if (batch instanceof Error) throw batch;
      return batch ?? [];
    },
  };
  return { reader, calls };
}

const RAW = { family: STREAM_FAMILY_RAW_EVENTS, project_id: "acme" };

describe("isolation snapshot", () => {
  it("answers the producer synchronously after a refresh", async () => {
    const { reader } = readerOf([RAW]);
    const snap = createIsolationSnapshot({ reader, environment: "production" });

    // Before any refresh, nothing is isolated — the safe default, and the
    // one that keeps a service bootable when the control plane is down.
    expect(snap.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "acme")).toBe(false);

    await snap.refresh();

    expect(snap.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "acme")).toBe(true);
    expect(snap.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "other")).toBe(false);
    expect(snap.lookup.isIsolated(STREAM_FAMILY_RESOLVED_EVENTS, "acme")).toBe(false);
  });

  it("feeds consumerFamiliesFor the list it needs", async () => {
    const { reader } = readerOf([RAW, { family: STREAM_FAMILY_RAW_EVENTS, project_id: "globex" }]);
    const snap = createIsolationSnapshot({ reader, environment: "production" });
    await snap.refresh();

    const families = consumerFamiliesFor(
      STREAM_FAMILY_RAW_EVENTS,
      snap.isolatedProjects(STREAM_FAMILY_RAW_EVENTS),
    );

    // Shared FIRST, then each dedicated: a consumer subscribes to the union
    // so an in-flight cutover loses nothing in either direction.
    expect(families[0]).toBe("raw.events");
    expect([...families].sort()).toEqual(
      ["raw.events", "raw.events.acme", "raw.events.globex"].sort(),
    );
  });

  it("hands out a copy, so a caller cannot mutate the snapshot", async () => {
    const { reader } = readerOf([RAW]);
    const snap = createIsolationSnapshot({ reader, environment: "production" });
    await snap.refresh();

    (snap.isolatedProjects(STREAM_FAMILY_RAW_EVENTS) as string[]).push("injected");

    expect(snap.isolatedProjects(STREAM_FAMILY_RAW_EVENTS)).toEqual(["acme"]);
  });

  it("keeps the last good snapshot when a refresh fails", async () => {
    // The load-bearing one. Emptying on a database blip would move every
    // isolated project's traffic back onto the shared stream — a routing
    // change caused by a transient error, in a system where the operator
    // believes a cutover is in effect.
    const { reader } = readerOf([RAW], new Error("control plane unreachable"));
    const warn = vi.fn();
    const snap = createIsolationSnapshot({
      reader,
      environment: "production",
      logger: { warn } as unknown as NonNullable<CreateIsolationSnapshotOptions["logger"]>,
    });

    await snap.refresh();
    const firstOk = snap.lastRefreshedAt();
    await snap.refresh();

    expect(snap.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "acme")).toBe(true);
    // And it says so, rather than failing silently.
    expect(warn).toHaveBeenCalledOnce();
    // `lastRefreshedAt` does not advance on a failure, so staleness is
    // observable rather than hidden behind a successful-looking timestamp.
    expect(snap.lastRefreshedAt()).toBe(firstOk);
  });

  it("throws when the FIRST refresh fails, rather than booting empty", async () => {
    // Nothing to fall back to. A service that started with a silently empty
    // snapshot would route an isolated project's traffic onto the shared
    // stream and report itself healthy.
    const { reader } = readerOf(new Error("nope"));
    const snap = createIsolationSnapshot({ reader, environment: "production" });

    await expect(snap.refresh()).rejects.toThrow(/nope/);
    expect(snap.lastRefreshedAt()).toBeNull();
  });

  it("drops rows naming a family this build does not know", async () => {
    // `consumerFamiliesFor` throws on a non-canonical family, so passing one
    // through would take the service down at subscribe time over a row it
    // can do nothing about — a control plane ahead of this binary, or a
    // family retired underneath it.
    const { reader } = readerOf([{ family: "analytics.events", project_id: "acme" }, RAW]);
    const warn = vi.fn();
    const snap = createIsolationSnapshot({
      reader,
      environment: "production",
      logger: { warn } as unknown as NonNullable<CreateIsolationSnapshotOptions["logger"]>,
    });

    await snap.refresh();

    expect(snap.isolatedProjects("analytics.events")).toEqual([]);
    expect(snap.isolatedProjects(STREAM_FAMILY_RAW_EVENTS)).toEqual(["acme"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("scopes the read to one environment", async () => {
    const { reader, calls } = readerOf([RAW]);
    const snap = createIsolationSnapshot({ reader, environment: "staging" });
    await snap.refresh();

    expect(calls).toEqual(["staging"]);
  });

  it("replaces the set wholesale, so a de-isolated project disappears", async () => {
    const { reader } = readerOf([RAW], []);
    const snap = createIsolationSnapshot({ reader, environment: "production" });

    await snap.refresh();
    expect(snap.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "acme")).toBe(true);
    await snap.refresh();
    expect(snap.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, "acme")).toBe(false);
  });

  it("start/stop are idempotent and do not hold the event loop", () => {
    const { reader } = readerOf([RAW]);
    const snap = createIsolationSnapshot({ reader, environment: "production", refreshMs: 10_000 });

    snap.start();
    snap.start();
    snap.stop();
    snap.stop();

    expect(snap.lastRefreshedAt()).toBeNull();
  });
});
