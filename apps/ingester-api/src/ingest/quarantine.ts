/**
 * The schema-governance feedback loop.
 *
 * A rejected event never reaches the spine, so without this it leaves no
 * trace beyond a reason code in an HTTP response the producer's own error
 * handling probably swallowed. Nobody could answer "which projects are
 * still sending `cvv`?", "did last Tuesday's SDK release start failing
 * validation?", or "is this spike new?" — the three questions schema
 * governance actually consists of.
 *
 * So every rejection is published, once, onto `rejected.events`.
 *
 * ## Fail-open and fire-and-forget, in that order
 *
 * The quarantine is a diagnostic. An ingester that answered 500 because
 * the QUARANTINE was unavailable would have converted a working rejection
 * into an outage — and the event was being rejected anyway, so nothing is
 * saved by trying harder.
 *
 * Fire-and-forget means the publish is started but never awaited on the
 * request path. The producer's response is already computed by the time
 * this runs; awaiting would add a broker round trip to the latency of a
 * request whose outcome is already decided. A broker that has gone away
 * therefore costs nothing measurable, which is the property the load-test
 * evidence has to show.
 *
 * ## Never the raw payload
 *
 * `buildViolationSample` applies every policy rule — reject, redact-named
 * and pattern — before anything is serialised, which `evaluate` alone
 * cannot do because it short-circuits on the first reject. See
 * `@polaris/governance/violation-sample.ts`; that module's tests are
 * the PII acceptance criterion.
 */

import type { ProjectPolicyOverride } from "@polaris/governance";
import { buildViolationSample, serialiseViolationSample } from "@polaris/governance";
import type { BatchRejectedResult } from "@polaris/spec";
import { VIOLATION_RECORD_VERSION, type ViolationRecord } from "@polaris/spec";
import type { PolarisProducer } from "@polaris/bus";
import { STREAM_FAMILY_REJECTED_EVENTS } from "@polaris/bus";
import { v7 as uuidv7 } from "uuid";

/** One rejection, with the payload that caused it. */
export interface QuarantineCandidate {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly rejected: BatchRejectedResult;
  readonly projectId: string;
  readonly environment: string;
  /** Project override in force, so the sample redacts by the same rules. */
  readonly projectPolicy?: ProjectPolicyOverride | undefined;
}

export interface QuarantinePublisherDeps {
  readonly producer: PolarisProducer;
  readonly now: () => Date;
  /** Counted per published record and per failure. */
  readonly onPublished?: (input: {
    readonly projectId: string;
    readonly environment: string;
    readonly reason: string;
    /**
     * The name VERBATIM off the rejected payload, unbounded and possibly
     * absent. The caller bounds it before it reaches a metric — see
     * `eventLabel` in `../metrics/registry.js`. It is passed raw here
     * because this module has no catalog and should not grow one to
     * decorate a callback.
     */
    readonly event: string | null;
  }) => void;
  readonly onFailed?: (input: { readonly reason: string; readonly err: unknown }) => void;
  readonly generateId?: () => string;
}

export interface QuarantinePublisher {
  /**
   * Publish a batch's rejections. Returns a promise for tests; the request
   * path deliberately does not await it.
   */
  publish(candidates: readonly QuarantineCandidate[]): Promise<void>;
}

export function createQuarantinePublisher(deps: QuarantinePublisherDeps): QuarantinePublisher {
  const generateId = deps.generateId ?? (() => `polaris_vio_${uuidv7()}`);

  return {
    async publish(candidates): Promise<void> {
      for (const candidate of candidates) {
        try {
          const record = buildViolationRecord(candidate, deps.now(), generateId());
          await deps.producer.publish({
            family: STREAM_FAMILY_REJECTED_EVENTS,
            value: Buffer.from(JSON.stringify(record), "utf8"),
            // Keyed by project so one project's violations stay on one
            // partition — which is what makes a per-project rate visible
            // as a partition's rate, and keeps a single misbehaving
            // producer from spreading across every partition.
            partitionKey: `${candidate.projectId}:${candidate.environment}`,
          });
          deps.onPublished?.({
            projectId: candidate.projectId,
            environment: candidate.environment,
            reason: record.reason,
            event: record.event,
          });
        } catch (err) {
          // Swallowed on purpose. The event is already rejected and the
          // producer already has its answer; failing here would turn a
          // diagnostic outage into an ingestion outage.
          deps.onFailed?.({ reason: candidate.rejected.code, err });
        }
      }
    },
  };
}

/**
 * Project a rejection onto the wire record.
 *
 * Exported for its tests: what this function does or does not copy out of
 * the raw payload IS the PII boundary, and it deserves assertions of its
 * own rather than being reachable only through a publisher fake.
 */
export function buildViolationRecord(
  candidate: QuarantineCandidate,
  receivedAt: Date,
  violationId: string,
): ViolationRecord {
  const { sample } = buildViolationSample(candidate.raw, {
    ...(candidate.projectPolicy !== undefined ? { projectPolicy: candidate.projectPolicy } : {}),
  });

  return {
    violation_version: VIOLATION_RECORD_VERSION,
    violation_id: violationId,
    // From the API key tuple, not from the payload. A rejected event's
    // self-reported project is exactly the kind of thing that may be
    // wrong, and a quarantine filed under a project's name by an
    // unrelated producer would be worse than no quarantine.
    project_id: candidate.projectId,
    environment: candidate.environment,
    event: readString(candidate.raw, "event"),
    // The rejection's id when it has one; the payload's hint otherwise.
    // A catalog failure before the envelope parsed may have neither.
    event_id: emptyToNull(candidate.rejected.event_id) ?? readString(candidate.raw, "event_id"),
    schema_version: readInteger(candidate.raw, "schema_version"),
    // The batch response calls it `code`; the quarantine calls it
    // `reason`, matching the ClickHouse column and the CLI filter. One
    // rename, here, rather than a third name downstream.
    reason: candidate.rejected.code,
    paths: readPaths(candidate.rejected),
    redacted_sample: serialiseViolationSample(sample),
    received_at: receivedAt.toISOString(),
  };
}

/**
 * The field paths implicated in the rejection.
 *
 * The batch response already carries them — a policy reject names the
 * forbidden path, a catalog failure names the failing one — and they are
 * paths only, never values, which is the same discipline the response
 * follows. Re-deriving them here would be a second implementation of the
 * same answer with a second chance to disagree.
 */
function readPaths(rejected: BatchRejectedResult): string[] {
  const path = rejected.detail?.path;
  if (path === undefined || path.length === 0) return [];
  return [path.map((segment) => String(segment)).join(".")];
}

function emptyToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readInteger(raw: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
