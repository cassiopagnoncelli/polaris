import {
  WAREHOUSE_DATASETS,
  type WarehouseExportResult,
  type WarehouseExportTarget,
} from "@polaris/persistence-clickhouse";
import { describe, expect, it } from "vitest";

import {
  buildWarehouseExportRunner,
  type CommandContext,
  type OutputStreams,
  UsageError,
  type WarehouseExportJob,
} from "../src/index.js";

function capture(): { streams: OutputStreams; stdout: string[] } {
  const stdout: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: () => {},
    },
    stdout,
  };
}

function makeContext(streams: OutputStreams, format: "human" | "json" = "json"): CommandContext {
  const noop = () => {};
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: format,
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      fatal: noop,
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
    } as unknown as CommandContext["logger"],
    output: streams,
    env: {},
    actor: { source: "cli", label: "tester" },
  } as unknown as CommandContext;
}

const TARGET: WarehouseExportTarget = { bucketUrl: "https://s3.example.test/polaris-warehouse" };

interface Call {
  readonly dataset: string;
  readonly day: string;
  readonly projectId: string;
}

function storeThat(behaviour: (dataset: string) => WarehouseExportResult | Error) {
  const calls: Call[] = [];
  let closed = 0;
  return {
    calls,
    closedCount: () => closed,
    hooks: {
      target: () => TARGET,
      openStore: () => ({
        exportDataset: async (input: { dataset: string; day: string; projectId: string }) => {
          calls.push({ dataset: input.dataset, day: input.day, projectId: input.projectId });
          const outcome = behaviour(input.dataset);
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
        close: async () => {
          closed += 1;
        },
      }),
      generateJobId: () => "polaris_wxj_1",
    },
  };
}

function ok(dataset: string): WarehouseExportResult {
  return {
    dataset: dataset as WarehouseExportResult["dataset"],
    objectUrl: `${TARGET.bucketUrl}/${dataset}/storefront/production/2026-08-15.parquet`,
    rows: 42,
    bytes: 1024,
  };
}

const ARGS = { project: "storefront", env: "production", day: "2026-08-15" };

describe("polaris warehouse export", () => {
  it("writes every dataset when none is named", async () => {
    // A profiles snapshot without the merge map is one whose keys
    // silently stop resolving, so the default is everything rather than
    // an operator remembering which ones travel together.
    //
    // Asserted against WAREHOUSE_DATASETS rather than a literal list:
    // the three projections were added to that constant and this test
    // would otherwise have been the thing that had to be remembered.
    const store = storeThat(ok);
    const cap = capture();

    await buildWarehouseExportRunner(store.hooks)(ARGS, makeContext(cap.streams));

    expect(store.calls.map((call) => call.dataset)).toEqual([...WAREHOUSE_DATASETS]);
    expect(store.closedCount()).toBe(1);
  });

  it("narrows to one dataset when asked", async () => {
    const store = storeThat(ok);
    const cap = capture();

    await buildWarehouseExportRunner(store.hooks)(
      { ...ARGS, dataset: "profiles" },
      makeContext(cap.streams),
    );

    expect(store.calls.map((call) => call.dataset)).toEqual(["profiles"]);
  });

  it("records a job listing every dataset's outcome", async () => {
    const store = storeThat(ok);
    const cap = capture();
    const jobs: WarehouseExportJob[] = [];

    await buildWarehouseExportRunner({
      ...store.hooks,
      recordJob: (_ctx, job) => jobs.push(job),
    })(ARGS, makeContext(cap.streams));

    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.job_id).toBe("polaris_wxj_1");
    expect(jobs[0]?.datasets).toHaveLength(WAREHOUSE_DATASETS.length);
    expect(jobs[0]?.datasets[0]).toMatchObject({ dataset: "events", status: "written", rows: 42 });
  });

  it("exits non-zero when a dataset fails, so cron sees it", async () => {
    // A nightly export that swallows its failure is a warehouse that
    // silently stops receiving data, and the first person to notice is
    // an analyst asking why last week is missing.
    const store = storeThat((dataset) =>
      dataset === "profiles" ? new Error("s3 credentials rejected") : ok(dataset),
    );
    const cap = capture();

    await expect(
      buildWarehouseExportRunner(store.hooks)(ARGS, makeContext(cap.streams)),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("still exports the remaining datasets after one fails", async () => {
    // An operator triaging a partial night needs to know which slice to
    // re-run; stopping at the first failure would leave that unanswered.
    const store = storeThat((dataset) =>
      dataset === "events" ? new Error("clickhouse timeout") : ok(dataset),
    );
    const cap = capture();

    await expect(
      buildWarehouseExportRunner(store.hooks)(ARGS, makeContext(cap.streams)),
    ).rejects.toThrow(/events \(clickhouse timeout\)/);
    expect(store.calls.map((call) => call.dataset)).toEqual([...WAREHOUSE_DATASETS]);
  });

  it("records the job even when the run fails", async () => {
    // The record is what makes a failed night diagnosable. Writing it
    // only on success would lose exactly the runs worth investigating.
    const store = storeThat((dataset) =>
      dataset === "merge_map" ? new Error("nope") : ok(dataset),
    );
    const cap = capture();
    const jobs: WarehouseExportJob[] = [];

    await expect(
      buildWarehouseExportRunner({ ...store.hooks, recordJob: (_ctx, job) => jobs.push(job) })(
        ARGS,
        makeContext(cap.streams),
      ),
    ).rejects.toBeInstanceOf(UsageError);

    expect(jobs[0]?.status).toBe("failed");
    expect(jobs[0]?.datasets[2]).toMatchObject({ dataset: "merge_map", status: "failed" });
    // The two that DID land are named.
    expect(jobs[0]?.datasets[0]).toMatchObject({ status: "written" });
  });

  it("closes the store even when a dataset throws", async () => {
    const store = storeThat(() => new Error("everything is broken"));
    const cap = capture();

    await expect(
      buildWarehouseExportRunner(store.hooks)(ARGS, makeContext(cap.streams)),
    ).rejects.toBeInstanceOf(UsageError);
    expect(store.closedCount()).toBe(1);
  });

  it("refuses a malformed day rather than exporting the wrong slice", async () => {
    const store = storeThat(ok);
    await expect(
      buildWarehouseExportRunner(store.hooks)(
        { ...ARGS, day: "15/08/2026" },
        makeContext(capture().streams),
      ),
    ).rejects.toThrow(/YYYY-MM-DD/);
    expect(store.calls).toHaveLength(0);
  });

  it("refuses an unknown dataset", async () => {
    const store = storeThat(ok);
    await expect(
      buildWarehouseExportRunner(store.hooks)(
        { ...ARGS, dataset: "everything" },
        makeContext(capture().streams),
      ),
    ).rejects.toThrow(/--dataset must be one of/);
  });

  it("requires the scope flags", async () => {
    const store = storeThat(ok);
    for (const args of [
      { env: "production", day: "2026-08-15" },
      { project: "storefront", day: "2026-08-15" },
      { project: "storefront", env: "production" },
    ]) {
      await expect(
        buildWarehouseExportRunner(store.hooks)(args, makeContext(capture().streams)),
      ).rejects.toBeInstanceOf(UsageError);
    }
  });

  it("passes the operator's day through untouched", async () => {
    // `--day` is the EVENTS' day. A default of "yesterday" reads right in
    // a crontab and wrong in every manual invocation made to fix
    // something, which is why there is no default.
    const store = storeThat(ok);
    await buildWarehouseExportRunner(store.hooks)(
      { ...ARGS, day: "2026-03-01", dataset: "events" },
      makeContext(capture().streams),
    );
    expect(store.calls[0]?.day).toBe("2026-03-01");
  });
});
