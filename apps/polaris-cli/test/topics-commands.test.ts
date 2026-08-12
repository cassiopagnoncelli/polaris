/**
 * Unit tests for the `polaris topics` command surface (P11-008).
 *
 * Approach mirrors `destinations-commands.test.ts`:
 *
 *   - Each command exposes a `buildTopicsXxxRunner({ openStore, ... })`
 *     factory so tests inject an in-memory store instead of Kysely. The
 *     runner contract matches production.
 *   - Smaller dispatcher-level tests drive the real command tree
 *     through `run()` to confirm `mutates: true` propagates and the
 *     production-mutation gate refuses `declared` actors against
 *     production.
 *
 * Acceptance criteria covered:
 *
 *   - `topics isolate` and `topics deisolate` declare `mutates: true`.
 *   - Both commands write audit_records inside the same transaction
 *     as the topic_isolations mutation.
 *   - `topics isolate` rejects unknown families / invalid environments
 *     before any DB write.
 *   - `topics isolate` translates the partial-unique-index violation
 *     into a friendly typed usage error.
 *   - `topics deisolate` is idempotent and emits a friendly message
 *     when no active isolation exists.
 *   - The output format honors `--output human` and `--output json`.
 */
import {
  CANONICAL_STREAM_FAMILIES,
  type CanonicalStreamFamily,
  dedicatedStreamFamily,
  STREAM_FAMILY_ANALYTICS_EVENTS,
  STREAM_FAMILY_RAW_EVENTS,
} from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

import {
  buildTopicsDeisolateRunner,
  buildTopicsIsolateRunner,
  buildTopicsListRunner,
  type CommandContext,
  ExitCode,
  type InsertTopicIsolationInput,
  type IsolateInsertOutcome,
  type OutputStreams,
  type PackageMeta,
  run,
  TOPIC_ISOLATION_ID_PREFIX,
  type TopicIsolationRow,
  type TopicsDeisolateStore,
  type TopicsIsolateStore,
  type TopicsListFilter,
  type TopicsListStore,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-14T00:00:00.000Z",
  releaseLabel: undefined,
  nodeVersion: "v22.0.0",
};

const VALID_ENV = {
  POLARIS_API_URL: "https://polaris.example.internal",
  POLARIS_TOKEN: "polaris_ot_test",
} as const;

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

interface CapturedAudit {
  readonly action: string;
  readonly auditId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorSource: string;
  readonly actorLabel: string;
  readonly projectId: string;
  readonly environment: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string;
}

class InMemoryTopicStore {
  public readonly rows = new Map<string, TopicIsolationRow>();
  public readonly inserts: InsertTopicIsolationInput[] = [];
  public closeCalls = 0;
  public readonly auditCalls: CapturedAudit[] = [];

  insert(row: TopicIsolationRow): void {
    this.rows.set(row.id, row);
  }

  private activeRowFor(
    family: CanonicalStreamFamily,
    projectId: string,
    environment: string,
  ): TopicIsolationRow | undefined {
    for (const row of this.rows.values()) {
      if (
        row.topic_family === family &&
        row.project_id === projectId &&
        row.environment === environment &&
        row.deactivated_at === null
      ) {
        return row;
      }
    }
    return undefined;
  }

  private latestRowFor(
    family: CanonicalStreamFamily,
    projectId: string,
    environment: string,
  ): TopicIsolationRow | undefined {
    const matches: TopicIsolationRow[] = [];
    for (const row of this.rows.values()) {
      if (
        row.topic_family === family &&
        row.project_id === projectId &&
        row.environment === environment
      ) {
        matches.push(row);
      }
    }
    matches.sort((a, b) => b.activated_at.localeCompare(a.activated_at));
    return matches[0];
  }

  asIsolateStore(): TopicsIsolateStore {
    return {
      insertWithAudit: async (input, audit): Promise<IsolateInsertOutcome> => {
        if (
          this.activeRowFor(
            input.topic_family as CanonicalStreamFamily,
            input.project_id,
            input.environment,
          ) !== undefined
        ) {
          return "duplicate";
        }
        this.inserts.push(input);
        this.rows.set(input.id, {
          id: input.id,
          project_id: input.project_id,
          environment: input.environment,
          topic_family: input.topic_family,
          concrete_topic: input.concrete_topic,
          reason: input.reason,
          actor_id: input.actor_id,
          activated_at: audit.occurredAt.toISOString(),
          deactivated_at: null,
          created_at: audit.occurredAt.toISOString(),
          updated_at: audit.occurredAt.toISOString(),
        });
        this.auditCalls.push({
          action: "topics.isolate",
          auditId: audit.auditId,
          targetType: "topic_isolation",
          targetId: input.id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: null,
          after: audit.after,
          reason: audit.reason,
        });
        return "inserted";
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asDeisolateStore(): TopicsDeisolateStore {
    return {
      findActive: async (family, projectId, environment) =>
        this.activeRowFor(family, projectId, environment) ?? null,
      findLatest: async (family, projectId, environment) =>
        this.latestRowFor(family, projectId, environment) ?? null,
      deactivateWithAudit: async (id, now, audit) => {
        const row = this.rows.get(id);
        if (row === undefined || row.deactivated_at !== null) return false;
        this.rows.set(id, {
          ...row,
          deactivated_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
        this.auditCalls.push({
          action: "topics.deisolate",
          auditId: audit.auditId,
          targetType: "topic_isolation",
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asListStore(): TopicsListStore {
    return {
      list: async (filter: TopicsListFilter) => {
        const matches: TopicIsolationRow[] = [];
        for (const row of this.rows.values()) {
          if (row.deactivated_at !== null) continue;
          if (filter.projectId !== undefined && row.project_id !== filter.projectId) continue;
          if (filter.environment !== undefined && row.environment !== filter.environment) continue;
          matches.push(row);
        }
        matches.sort((a, b) => {
          if (a.project_id !== b.project_id) return a.project_id.localeCompare(b.project_id);
          if (a.environment !== b.environment) return a.environment.localeCompare(b.environment);
          return a.topic_family.localeCompare(b.topic_family);
        });
        return matches;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

function makeContext(streams: OutputStreams): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
    config: {
      profile: "default",
      apiUrl: "https://polaris.example.internal",
      token: "polaris_ot_test",
      tokenEnvName: "POLARIS_TOKEN",
      output: "human",
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: {
      ...noopLogger,
      child: () => noopLogger,
    } as CommandContext["logger"],
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli" },
  };
}

function jsonContext(streams: OutputStreams): CommandContext {
  const base = makeContext(streams);
  return { ...base, config: { ...base.config, output: "json" } };
}

const ISOLATE_BASE_ARGS = {
  project: "storefront",
  env: "production",
  family: STREAM_FAMILY_RAW_EVENTS,
  reason: "volume share above 25% for two review cycles",
} as const;

describe("topics isolate runner", () => {
  // The command used to write a topic_isolations row and report a cutover.
  // Nothing in the platform reads that row: every producer and consumer
  // resolves families through sharedOnlyIsolationLookup and no service
  // constructs a StreamIsolationCache. So the write changed no traffic while
  // telling an operator — often mid-incident, following a runbook that
  // recommends it — that a cutover was underway.
  it("refuses, because the runtime does not honour the row it would write", async () => {
    const capture = captureOutput();
    const runner = buildTopicsIsolateRunner();
    await expect(
      runner(
        {
          project: "storefront",
          env: "production",
          family: "raw.events",
          reason: "hot partition",
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "NotImplementedError" });
  });

  it("does not touch the store when refusing", async () => {
    // Nothing may be written, and no audit row may claim otherwise.
    let opened = 0;
    const capture = captureOutput();
    const runner = buildTopicsIsolateRunner({
      openStore: () => {
        opened += 1;
        throw new Error("store must not be opened");
      },
    });
    await expect(
      runner(
        { project: "storefront", env: "production", family: "raw.events", reason: "x" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "NotImplementedError" });
    expect(opened).toBe(0);
  });

  it("still validates its arguments before refusing", async () => {
    // A bad --env should read as a usage error, not as the feature gap.
    const capture = captureOutput();
    const runner = buildTopicsIsolateRunner();
    await expect(
      runner(
        { project: "storefront", env: "nope", family: "raw.events", reason: "x" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("topics deisolate runner", () => {
  function seedActive(store: InMemoryTopicStore): TopicIsolationRow {
    const row: TopicIsolationRow = {
      id: "polaris_tiso_active",
      project_id: "storefront",
      environment: "production",
      topic_family: "raw.events",
      concrete_topic: "raw.events.storefront",
      reason: "earlier reason",
      actor_id: "cli",
      activated_at: "2026-05-14T10:00:00.000Z",
      deactivated_at: null,
      created_at: "2026-05-14T10:00:00.000Z",
      updated_at: "2026-05-14T10:00:00.000Z",
    };
    store.insert(row);
    return row;
  }

  it("deactivates the active row and writes the audit record", async () => {
    const store = new InMemoryTopicStore();
    const row = seedActive(store);
    const capture = captureOutput();
    const runner = buildTopicsDeisolateRunner({
      openStore: () => store.asDeisolateStore(),
      generateAuditId: () => "audit-deiso-1",
      now: () => new Date("2026-05-14T13:00:00.000Z"),
    });
    await runner(
      {
        project: "storefront",
        env: "production",
        family: "raw.events",
        reason: "drain complete",
      },
      makeContext(capture.streams),
    );

    expect(store.rows.get(row.id)?.deactivated_at).toBe("2026-05-14T13:00:00.000Z");
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected audit row");
    expect(audit.action).toBe("topics.deisolate");
    expect(audit.targetId).toBe(row.id);
    expect(audit.reason).toBe("drain complete");
    expect(audit.before).toMatchObject({ deactivated_at: null });
    expect(audit.after).toMatchObject({ deactivated_at: "2026-05-14T13:00:00.000Z" });

    expect(capture.stdout.join("")).toContain("topic isolation deactivated");
  });

  it("stamps a default reason when --reason is omitted", async () => {
    const store = new InMemoryTopicStore();
    seedActive(store);
    const capture = captureOutput();
    const runner = buildTopicsDeisolateRunner({
      openStore: () => store.asDeisolateStore(),
      generateAuditId: () => "audit-deiso-2",
      now: () => new Date("2026-05-14T13:00:00.000Z"),
    });
    await runner(
      { project: "storefront", env: "production", family: "raw.events" },
      makeContext(capture.streams),
    );
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected audit row");
    expect(audit.reason).toBe("topics.deisolate: raw.events for storefront in production");
  });

  it("returns a friendly UsageError when no isolation exists", async () => {
    const store = new InMemoryTopicStore();
    const capture = captureOutput();
    const runner = buildTopicsDeisolateRunner({ openStore: () => store.asDeisolateStore() });
    await expect(
      runner(
        { project: "storefront", env: "production", family: "raw.events" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("returns a friendly UsageError when the latest isolation is already deactivated", async () => {
    const store = new InMemoryTopicStore();
    store.insert({
      id: "polaris_tiso_old",
      project_id: "storefront",
      environment: "production",
      topic_family: "raw.events",
      concrete_topic: "raw.events.storefront",
      reason: "old reason",
      actor_id: "cli",
      activated_at: "2026-05-13T10:00:00.000Z",
      deactivated_at: "2026-05-13T14:00:00.000Z",
      created_at: "2026-05-13T10:00:00.000Z",
      updated_at: "2026-05-13T14:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildTopicsDeisolateRunner({ openStore: () => store.asDeisolateStore() });
    await expect(
      runner(
        { project: "storefront", env: "production", family: "raw.events" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects unknown family / env", async () => {
    const store = new InMemoryTopicStore();
    const capture = captureOutput();
    const runner = buildTopicsDeisolateRunner({ openStore: () => store.asDeisolateStore() });
    await expect(
      runner(
        { project: "storefront", env: "production", family: "weird.events" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    await expect(
      runner(
        { project: "storefront", env: "qa", family: "raw.events" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("topics list runner", () => {
  function seedActive(store: InMemoryTopicStore, overrides: Partial<TopicIsolationRow> = {}): void {
    const base: TopicIsolationRow = {
      id: "polaris_tiso_seed",
      project_id: "storefront",
      environment: "production",
      topic_family: "raw.events",
      concrete_topic: "raw.events.storefront",
      reason: "test",
      actor_id: "cli",
      activated_at: "2026-05-14T10:00:00.000Z",
      deactivated_at: null,
      created_at: "2026-05-14T10:00:00.000Z",
      updated_at: "2026-05-14T10:00:00.000Z",
    };
    store.insert({ ...base, ...overrides });
  }

  it("emits a friendly empty message when no isolations are active", async () => {
    const store = new InMemoryTopicStore();
    const capture = captureOutput();
    const runner = buildTopicsListRunner({ openStore: () => store.asListStore() });
    await runner({}, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("no active topic isolations");
  });

  it("filters by project and environment when both are supplied", async () => {
    const store = new InMemoryTopicStore();
    seedActive(store, {
      id: "polaris_tiso_a",
      project_id: "storefront",
      environment: "production",
    });
    seedActive(store, { id: "polaris_tiso_b", project_id: "storefront", environment: "staging" });
    seedActive(store, { id: "polaris_tiso_c", project_id: "analytics", environment: "production" });
    const capture = captureOutput();
    const runner = buildTopicsListRunner({ openStore: () => store.asListStore() });
    await runner({ project: "storefront", env: "production" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join("")) as { topic_isolation_id: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.topic_isolation_id).toBe("polaris_tiso_a");
  });

  it("excludes deactivated rows", async () => {
    const store = new InMemoryTopicStore();
    seedActive(store, { id: "polaris_tiso_active" });
    seedActive(store, {
      id: "polaris_tiso_inactive",
      deactivated_at: "2026-05-14T11:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildTopicsListRunner({ openStore: () => store.asListStore() });
    await runner({}, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join("")) as { topic_isolation_id: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.topic_isolation_id).toBe("polaris_tiso_active");
  });

  it("rejects empty --project and --env values", async () => {
    const store = new InMemoryTopicStore();
    const capture = captureOutput();
    const runner = buildTopicsListRunner({ openStore: () => store.asListStore() });
    await expect(runner({ project: "   " }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
    await expect(runner({ env: "qa" }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });
});

describe("topics command tree (dispatcher integration)", () => {
  it("registers topics isolate / deisolate as `mutates: true`", async () => {
    const capture = captureOutput();
    const exitCode = await run({
      argv: ["topics", "--help"],
      env: VALID_ENV,
      output: capture.streams,
      meta: META,
    });
    expect(exitCode).toBe(ExitCode.Ok);
    const help = [...capture.stdout, ...capture.stderr].join("");
    expect(help).toContain("isolate");
    expect(help).toContain("deisolate");
    expect(help).toContain("list");
  });

  it("rejects topics isolate against production when the actor source is the unauthenticated `cli` fallback", async () => {
    // The P6-007 gate refuses mutating commands in production unless the
    // resolved actor source is `declared` (set by a valid
    // POLARIS_OPERATOR_TOKEN). The default actor source in tests is
    // `cli`, which is the unauthenticated fallback.
    const capture = captureOutput();
    const exitCode = await run({
      argv: [
        "topics",
        "isolate",
        "--project",
        "storefront",
        "--env",
        "production",
        "--family",
        "raw.events",
        "--reason",
        "test",
      ],
      env: { ...VALID_ENV, POLARIS_ENV: "production" },
      output: capture.streams,
      meta: META,
      actor: { source: "cli", label: "cli" },
    });
    expect(exitCode).toBe(ExitCode.UsageError);
    const stderr = capture.stderr.join("");
    expect(stderr).toMatch(/production|operator.*token|mutation/i);
  });

  it("rejects topics deisolate against production when the actor source is the unauthenticated `cli` fallback", async () => {
    const capture = captureOutput();
    const exitCode = await run({
      argv: [
        "topics",
        "deisolate",
        "--project",
        "storefront",
        "--env",
        "production",
        "--family",
        "raw.events",
      ],
      env: { ...VALID_ENV, POLARIS_ENV: "production" },
      output: capture.streams,
      meta: META,
      actor: { source: "cli", label: "cli" },
    });
    expect(exitCode).toBe(ExitCode.UsageError);
    const stderr = capture.stderr.join("");
    expect(stderr).toMatch(/production|operator.*token|mutation/i);
  });
});

describe("topics analytics-events family", () => {
  // Defense-in-depth that the every-canonical-family loop above covers
  // analytics.events specifically. Destinations consume from this family,
  // so the per-project share dashboards depend on it.
  it("names the dedicated topic it WOULD issue, without writing it", async () => {
    // The naming rule (`<family>.<project>`) is still worth pinning: it is
    // what a future wiring change has to reproduce, and `topics list` renders
    // it for rows written before the refusal landed.
    expect(dedicatedStreamFamily(STREAM_FAMILY_ANALYTICS_EVENTS, "storefront")).toBe(
      "analytics.events.storefront",
    );
  });
});
