/**
 * Activation gate — the thing that makes `processor_activations` mean
 * something at runtime.
 *
 * Until this existed the table was operator intent with no teeth: the CLI and
 * the admin panel could flip a row to `disabled` and the processor kept
 * consuming, because nothing read it. The panel offered a control it did not
 * have.
 *
 * ## The rule
 *
 * An explicit `disabled` row for `(processor, version, project, environment)`
 * stops that processor from acting on that project's events. Anything else —
 * an `enabled` row, or no row at all — lets the event through.
 *
 * Absence means allowed, deliberately. The alternative (only an `enabled` row
 * lets an event through) turns every new project, and every fresh deployment,
 * into silent data loss until someone remembers to insert five rows. Polaris
 * processors consume shared streams cross-project; a default-deny gate would
 * make the pipeline's behaviour depend on rows nobody has written yet. Disable
 * is the operator action that carries intent, so disable is what the gate
 * enforces. `enable` remains the audited way to undo one.
 *
 * ## Where it applies
 *
 * Per message, not per process. Processors read every project's events off the
 * shared stream, so "should this run?" is only answerable once the envelope's
 * `project_id` and `environment` are known. A skipped message is acknowledged
 * and counted as `polaris_processor_events_skipped_total{reason=
 * "processor_disabled"}` — not retried, not dead-lettered. An operator turning
 * a processor off is not a failure.
 *
 * ## When PostgreSQL is unreachable
 *
 * Fail open, and say so. The gate caches its answers and, on a query error,
 * serves the last known answer or allows the event if it has none. Losing the
 * control plane must not silently stop the event pipeline — the same posture
 * the rest of the platform takes toward the control-plane database.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Configuration"
 * @see db/postgres/migrations/20260512000006_create_processor_activations.sql
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Logger } from "@polaris/observability-logger";
import type { Kysely } from "kysely";

import type { ProcessorIdentity } from "./identity.js";

/** How long an activation answer is trusted before it is re-read. */
export const DEFAULT_ACTIVATION_TTL_MS = 10_000;

/**
 * The gate a runtime consults per message.
 *
 * `isEnabled` never throws and never blocks on a slow database beyond the
 * query itself; a rejected query resolves to the cached answer, or `true`.
 */
export interface ProcessorActivationGate {
  isEnabled(scope: ProcessorActivationScope): Promise<boolean>;
}

export interface ProcessorActivationScope {
  readonly project_id: string;
  readonly environment: string;
}

/**
 * Gate that allows everything.
 *
 * The default for runtimes constructed outside `app.ts` — unit tests driving
 * a handler directly, golden-fixture runs — so a test never needs a database
 * to exercise a transform.
 */
export const ALWAYS_ENABLED_GATE: ProcessorActivationGate = {
  isEnabled: () => Promise.resolve(true),
};

/** Reads one activation row. The seam tests substitute for PostgreSQL. */
export type ActivationStateReader = (scope: ProcessorActivationScope) => Promise<string | null>;

export interface CreateProcessorActivationGateInput {
  readonly identity: ProcessorIdentity;
  /** Reader over `processor_activations`. Built from `db` when omitted. */
  readonly read?: ActivationStateReader | undefined;
  /** Connection used to build the default reader. */
  readonly db?: Kysely<Database> | undefined;
  readonly logger: Logger;
  /** Cache lifetime per (project, environment). Defaults to 10s. */
  readonly ttlMs?: number | undefined;
  /** Test seam for cache expiry. */
  readonly now?: (() => number) | undefined;
}

interface CacheEntry {
  readonly enabled: boolean;
  readonly readAt: number;
}

/**
 * Build the gate a processor's runtime consults.
 *
 * The cache is per `(project_id, environment)` with a short TTL rather than a
 * subscription: a 10-second delay before a disable takes hold is acceptable
 * for an operator action, and it keeps a hot loop from issuing one query per
 * message. Concurrent misses for the same scope share a single in-flight
 * query so a cold cache under load does not stampede.
 */
export function createProcessorActivationGate(
  input: CreateProcessorActivationGateInput,
): ProcessorActivationGate {
  const ttlMs = input.ttlMs ?? DEFAULT_ACTIVATION_TTL_MS;
  const now = input.now ?? (() => Date.now());
  const read = input.read ?? defaultReader(input);

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<boolean>>();

  async function load(key: string, scope: ProcessorActivationScope): Promise<boolean> {
    try {
      const state = await read(scope);
      // Only an explicit `disabled` row closes the gate. See the module head.
      const enabled = state !== "disabled";
      cache.set(key, { enabled, readAt: now() });
      return enabled;
    } catch (err) {
      const stale = cache.get(key);
      input.logger.warn(
        {
          component: "processor.activation-gate",
          processor_name: input.identity.name,
          processor_version: input.identity.version,
          project_id: scope.project_id,
          environment: scope.environment,
          served: stale === undefined ? "allow" : stale.enabled ? "stale-allow" : "stale-deny",
          err: summarize(err),
        },
        "activation lookup failed; failing open rather than stopping the pipeline",
      );
      return stale?.enabled ?? true;
    }
  }

  return {
    async isEnabled(scope: ProcessorActivationScope): Promise<boolean> {
      // NUL separator, written as the `\u0000` escape rather than the
      // byte: a raw NUL makes this file binary to ripgrep, which then skips
      // it silently on any repo-wide search.
      const key = `${scope.project_id}\u0000${scope.environment}`;
      const cached = cache.get(key);
      if (cached !== undefined && now() - cached.readAt < ttlMs) return cached.enabled;

      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;

      const query = load(key, scope).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, query);
      return query;
    },
  };
}

/**
 * Default reader: one indexed lookup on the activation table's primary key.
 *
 * Returns the `enabled_state` string, or `null` when no row exists for the
 * scope — which the gate reads as "allowed".
 */
function defaultReader(input: CreateProcessorActivationGateInput): ActivationStateReader {
  const db = input.db;
  if (db === undefined) {
    throw new Error(
      "createProcessorActivationGate needs either `db` or `read`; neither was supplied.",
    );
  }
  return async (scope) => {
    const row = await db
      .selectFrom("processor_activations")
      .select(["enabled_state"])
      .where("processor_name", "=", input.identity.name)
      .where("processor_version", "=", input.identity.version)
      .where("project_id", "=", scope.project_id)
      .where("environment", "=", scope.environment)
      .executeTakeFirst();
    return row?.enabled_state ?? null;
  };
}

function summarize(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
