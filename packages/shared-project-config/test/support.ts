/**
 * Hand-rolled fakes for the store's three seams: the database, the secret
 * resolver, and the notification transport.
 *
 * No real PostgreSQL and no Docker — mirroring the stubbing approach in
 * `packages/shared-destinations/test/runtime-behaviors.test.ts`. The fake db
 * counts queries, which is how the single-flight and "reads never touch the
 * database" behaviours are actually asserted rather than assumed.
 */

import type { Database } from "@polaris/shared-db";
import type { SecretResolver } from "@polaris/shared-secrets";
import type { Kysely } from "kysely";
import type { ListenerHandlers, ListenerTransport } from "../src/listener.js";

export interface FakeRow {
  readonly project_id: string;
  readonly environment: string;
  readonly namespace: string;
  readonly config_key: string;
  readonly value: unknown;
  readonly is_secret_ref: boolean;
}

/**
 * Minimal stand-in for the two Kysely query shapes `assemble.ts` builds.
 *
 * It intercepts at `selectFrom`, which keeps the fake small; the cost is that
 * it encodes the shape of those two queries. If `assemble.ts` changes its
 * query structure this fake must change with it — an acceptable trade for
 * avoiding a database in unit tests.
 */
export class FakeDb {
  rows: FakeRow[] = [];
  versions = new Map<string, bigint>();
  valueQueries = 0;
  versionQueries = 0;
  sweepQueries = 0;
  failNext: Error | undefined;
  /**
   * Gate the next VALUES query. Lets a test park an assembly between its
   * version read and its values read — the window where a concurrent commit
   * used to produce a fresh-looking snapshot of stale data.
   */
  holdNextValueQuery: Promise<void> | undefined;

  setVersion(projectId: string, environment: string, version: bigint): void {
    this.versions.set(`${projectId}|${environment}`, version);
  }

  asKysely(): Kysely<Database> {
    // biome-ignore lint/suspicious/noExplicitAny: test double for a query builder
    const self = this as any;
    const builder = (table: string): unknown => {
      if (table === "project_config") {
        let projectId = "";
        let environment = "";
        let namespace = "";
        const chain = {
          select: () => chain,
          where: (col: string, _op: string, val: string) => {
            if (col === "project_id") projectId = val;
            if (col === "environment") environment = val;
            if (col === "namespace") namespace = val;
            return chain;
          },
          execute: async () => {
            if (self.failNext !== undefined) {
              const err = self.failNext;
              self.failNext = undefined;
              throw err;
            }
            if (self.holdNextValueQuery !== undefined) {
              const gate = self.holdNextValueQuery;
              self.holdNextValueQuery = undefined;
              await gate;
            }
            self.valueQueries += 1;
            return self.rows.filter(
              (r: FakeRow) =>
                r.project_id === projectId &&
                r.environment === environment &&
                r.namespace === namespace,
            );
          },
        };
        return chain;
      }

      // project_config_versions — used by both readVersion and readVersions.
      let projectId = "";
      let environment = "";
      let batched = false;
      const chain = {
        select: () => chain,
        where: (colOrCb: unknown, _op?: string, val?: string) => {
          if (typeof colOrCb === "function") {
            batched = true;
            return chain;
          }
          if (colOrCb === "project_id") projectId = val as string;
          if (colOrCb === "environment") environment = val as string;
          return chain;
        },
        executeTakeFirst: async () => {
          self.versionQueries += 1;
          const v = self.versions.get(`${projectId}|${environment}`);
          return v === undefined ? undefined : { version: v.toString() };
        },
        execute: async () => {
          if (batched) self.sweepQueries += 1;
          return [...self.versions.entries()].map(([k, v]) => {
            const [p, e] = k.split("|");
            return { project_id: p, environment: e, version: v.toString() };
          });
        },
      };
      return chain;
    };

    return { selectFrom: builder } as unknown as Kysely<Database>;
  }
}

/** Resolver double: maps refs to values, counts calls, can be made to fail. */
export class FakeSecrets {
  values = new Map<string, string>();
  calls = 0;
  failWith: Error | undefined;

  asResolver(): SecretResolver {
    return {
      resolve: async (ref: unknown): Promise<string> => {
        this.calls += 1;
        if (this.failWith !== undefined) throw this.failWith;
        return this.values.get(String(ref)) ?? `resolved(${String(ref)})`;
      },
    } as unknown as SecretResolver;
  }
}

/** Transport double exposing the handlers so tests can drive notifications. */
export class FakeListener implements ListenerTransport {
  handlers: ListenerHandlers | undefined;
  started = false;
  closed = false;

  async start(handlers: ListenerHandlers): Promise<void> {
    this.handlers = handlers;
    this.started = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  notify(projectId: string, environment: string, version: bigint): void {
    this.handlers?.onMessage({
      project_id: projectId,
      environment,
      version,
    });
  }

  reconnect(): void {
    this.handlers?.onReconnect();
  }
}

/** Silent logger; the store only ever warns. */
export function fakeLogger() {
  const warnings: unknown[] = [];
  const logger = {
    warn: (...args: unknown[]): void => {
      warnings.push(args);
    },
    info: (): void => {},
    debug: (): void => {},
    error: (): void => {},
    fatal: (): void => {},
    trace: (): void => {},
    child: () => logger,
  };
  return { logger, warnings };
}

/** Controllable clock, so deadline and staleness tests are deterministic. */
export class FakeClock {
  constructor(private ms: number = 1_700_000_000_000) {}
  now = (): Date => new Date(this.ms);
  advance(byMs: number): void {
    this.ms += byMs;
  }
}
