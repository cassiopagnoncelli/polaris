/**
 * The project-config write path against a real PostgreSQL.
 *
 * The unit suites on both sides of this contract are thorough and neither can
 * prove it holds. `@polaris/shared-project-config` fakes its notification
 * transport, so its tests assert the store reacts correctly to a message it
 * was handed; `@polaris/shared-control-plane-db` asserts the mutation opens
 * one transaction and refuses bad input. Nothing in either suite runs
 * `pg_notify` through an actual `LISTEN` connection, which is where the two
 * halves either agree or silently do not — a payload field renamed on one side,
 * a version serialised as a number and read as a bigint, a notification issued
 * outside its transaction.
 *
 * Every assertion here was verified by mutation while writing it, and the
 * suite runs with the store's sweep interval set to an hour so `NOTIFY` alone
 * has to carry each invalidation. If the sweep were left at its 10s default,
 * a broken notification path would still pass — just late.
 *
 * Skips unless `POLARIS_INTEGRATION=1`, matching the rest of this directory.
 */

import {
  invalidateProjectConfigWithAudit,
  listProjectConfig,
  readProjectConfigVersion,
  setProjectConfigValueWithAudit,
  unsetProjectConfigValueWithAudit,
} from "@polaris/shared-control-plane-db";
import { closeDb, createDb, type Database } from "@polaris/shared-db";
import {
  createPgListenerTransport,
  createProjectConfigStore,
  isSecret,
  type ProjectConfigStore,
  type Secret,
} from "@polaris/shared-project-config";
import { EnvSecretProvider, SecretResolver } from "@polaris/shared-secrets";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjectConfig } from "../helpers/project-config.js";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";

const POSTGRES = {
  host: process.env["POLARIS_POSTGRES_HOST"] ?? "localhost",
  port: Number(process.env["POLARIS_POSTGRES_PORT"] ?? "5432"),
  database: process.env["POLARIS_POSTGRES_DATABASE"] ?? "polaris",
  user: process.env["POLARIS_POSTGRES_USER"] ?? "polaris",
  password: process.env["POLARIS_POSTGRES_PASSWORD"] ?? "polaris",
  ssl: false,
  poolMax: 4,
} as const;

const CONNECTION_STRING =
  `postgres://${POSTGRES.user}:${POSTGRES.password}` +
  `@${POSTGRES.host}:${String(POSTGRES.port)}/${POSTGRES.database}?sslmode=disable`;

const ENVIRONMENT = "development" as const;
const NAMESPACE = "meta-capi";
const SECRET_VALUE = "resolved-secret-for-integration";

/** Long enough that only NOTIFY can explain an invalidation inside a test. */
const SWEEP_DISABLED_MS = 3_600_000;

const noopLogger = {
  warn: () => {},
  info: () => {},
  debug: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child() {
    return this;
  },
};

function audit(seq: number) {
  return {
    auditId: `polaris_aud_it${String(seq)}${String(process.pid)}`,
    actorSource: "operator_token" as const,
    actorLabel: "integration-test",
    reason: "project-config integration test",
    occurredAt: new Date(),
  };
}

/**
 * Give the notification a moment to cross the socket.
 *
 * Polling rather than a flat sleep: a fixed delay either flakes on a loaded
 * machine or wastes time on an idle one.
 */
async function until(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!ENABLED)("project config: write path → NOTIFY → read store", () => {
  let db: Kysely<Database>;
  let store: ProjectConfigStore;
  let projectId: string;
  let key: { projectId: string; environment: typeof ENVIRONMENT; namespace: string };

  beforeAll(async () => {
    db = createDb({ postgres: POSTGRES });
    projectId = `it-cfg-${String(process.pid)}`;
    key = { projectId, environment: ENVIRONMENT, namespace: NAMESPACE };

    await db
      .insertInto("projects")
      .values({
        project_id: projectId,
        display_name: "Integration Test",
        owner: "integration",
        description: "temporary row created by tests/integration/project-config.test.ts",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    store = createProjectConfigStore({
      db,
      secrets: new SecretResolver({
        adapters: { env: new EnvSecretProvider({ source: { IT_TOKEN: SECRET_VALUE } }) },
      }),
      listener: createPgListenerTransport({
        connectionString: CONNECTION_STRING,
        logger: noopLogger as never,
      }),
      logger: noopLogger as never,
      sweepIntervalMs: SWEEP_DISABLED_MS,
    });
    await store.start();
  });

  afterAll(async () => {
    await store.close();
    await cleanupProjectConfig({ db, projectId, environment: ENVIRONMENT });
    await db.deleteFrom("projects").where("project_id", "=", projectId).execute();
    await closeDb(db);
  });

  it("an unwritten scope reads as version 0 with no values", async () => {
    const snapshot = await store.get(key);
    expect(snapshot.version).toBe(0n);
    expect(Object.keys(snapshot.values)).toHaveLength(0);
  });

  it("a set becomes visible to a running store without a restart", async () => {
    await setProjectConfigValueWithAudit(db, audit(1), {
      projectId,
      environment: ENVIRONMENT,
      namespace: NAMESPACE,
      configKey: "pixel_id",
      value: "1234567890",
      isSecretRef: false,
    });

    // Only NOTIFY can deliver this: the sweep is an hour away.
    await until(async () => (await store.get(key)).values["pixel_id"] === "1234567890");
    expect((await store.get(key)).version).toBeGreaterThan(0n);
  });

  it("stores a secret as a reference and hands the consumer a redacting box", async () => {
    await setProjectConfigValueWithAudit(db, audit(2), {
      projectId,
      environment: ENVIRONMENT,
      namespace: NAMESPACE,
      configKey: "access_token",
      value: "env:IT_TOKEN",
      isSecretRef: true,
    });
    await until(async () => (await store.get(key)).values["access_token"] !== undefined);

    const snapshot = await store.get(key);
    const token = snapshot.values["access_token"];
    expect(isSecret(token)).toBe(true);
    expect((token as Secret<string>).expose()).toBe(SECRET_VALUE);

    // The row holds the pointer, never the plaintext.
    const rows = await listProjectConfig(db, { projectId, environment: ENVIRONMENT });
    expect(rows.find((r) => r.config_key === "access_token")?.value).toBe("env:IT_TOKEN");

    // And serialising the snapshot cannot leak it.
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_VALUE);
  });

  it("bumps the version by exactly one per applied write", async () => {
    const before = await readProjectConfigVersion(db, projectId, ENVIRONMENT);
    await setProjectConfigValueWithAudit(db, audit(3), {
      projectId,
      environment: ENVIRONMENT,
      namespace: NAMESPACE,
      configKey: "graph_host",
      value: "graph.facebook.com",
      isSecretRef: false,
    });
    expect(await readProjectConfigVersion(db, projectId, ENVIRONMENT)).toBe(before + 1n);
  });

  it("an unset removes the key from a running store", async () => {
    // Assert the key is PRESENT first. Without this the test passes
    // vacuously whenever the preceding set never reached the store — which
    // is precisely the failure mode being guarded, so "still absent" would
    // be indistinguishable from "became absent". Verified by mutation: with
    // a broken notify payload this line fails, where the bare
    // absence-assertion below did not.
    await until(async () => (await store.get(key)).values["graph_host"] === "graph.facebook.com");

    await unsetProjectConfigValueWithAudit(db, audit(4), {
      projectId,
      environment: ENVIRONMENT,
      namespace: NAMESPACE,
      configKey: "graph_host",
    });
    await until(async () => (await store.get(key)).values["graph_host"] === undefined);
  });

  it("unsetting an absent key applies nothing and writes no audit row", async () => {
    const outcome = await unsetProjectConfigValueWithAudit(db, audit(5), {
      projectId,
      environment: ENVIRONMENT,
      namespace: NAMESPACE,
      configKey: "never_existed",
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.auditId).toBeNull();
  });

  it("invalidate drops the cache without changing any value", async () => {
    const before = await store.get(key);
    const versionBefore = await readProjectConfigVersion(db, projectId, ENVIRONMENT);

    await invalidateProjectConfigWithAudit(db, audit(6), {
      projectId,
      environment: ENVIRONMENT,
    });

    // The observable effect is a NEW snapshot object — the cached one was
    // dropped and reassembled — carrying identical values.
    await until(async () => (await store.get(key)) !== before);
    const after = await store.get(key);
    expect(await readProjectConfigVersion(db, projectId, ENVIRONMENT)).toBeGreaterThan(
      versionBefore,
    );
    expect(after.values["pixel_id"]).toBe(before.values["pixel_id"]);
  });

  it("a config change reaches a peek-only reader without any get()", async () => {
    // The ingester's actual read pattern: peek() on every batch, get() only on
    // a cold miss. This loop is exactly "polaris config set, then watch a
    // running ingester pick it up" — the capability the cutover shipped. The
    // first implementation of peek() served the stale snapshot forever and
    // this test is what pins the fix at the system level.
    await until(async () => store.peek(key) !== undefined);

    await setProjectConfigValueWithAudit(db, audit(7), {
      projectId,
      environment: ENVIRONMENT,
      namespace: NAMESPACE,
      configKey: "pixel_id",
      value: "peeked-fresh-value",
      isSecretRef: false,
    });

    // Only peek() from here on. NOTIFY marks the entry stale; peek must both
    // serve and self-refresh, so within the poll window the new value appears
    // with no explicit get() anywhere in the loop.
    await until(async () => store.peek(key)?.values["pixel_id"] === "peeked-fresh-value");
  });

  it("records one audit row per applied mutation", async () => {
    const rows = await db
      .selectFrom("audit_records")
      .select(["action"])
      .where("project_id", "=", projectId)
      .execute();
    const actions = rows.map((r) => r.action);
    expect(actions.filter((a) => a === "config.set")).toHaveLength(4);
    expect(actions.filter((a) => a === "config.unset")).toHaveLength(1);
    expect(actions.filter((a) => a === "config.invalidate")).toHaveLength(1);
  });
});
