/**
 * Test doubles for the enrichment stage.
 *
 * The profile reader is an in-memory map rather than a Postgres double,
 * because the interesting behaviour here is not SQL: it is what the
 * stage does with a hit, a miss, an empty profile and an over-size one.
 * The Kysely reader's own query is a single point read on the primary
 * key, verified against the real schema by the R1A migration probes.
 */

import type { Logger } from "@polaris/observability-logger";
import type { ProfileReader, ProfileSnapshot } from "@polaris/sync-enrichment-traits-v1";

/**
 * In-memory profile store, read-only.
 *
 * `reads` records every id looked up, which is how the suite proves the
 * stage does NOT query for events carrying no profile — a query per
 * unidentifiable event is pure load, and the absence is easy to
 * regress.
 */
export class InMemoryProfileReader implements ProfileReader {
  public readonly reads: string[] = [];
  private readonly profiles = new Map<string, ProfileSnapshot>();

  public set(profileId: string, snapshot: ProfileSnapshot): void {
    this.profiles.set(profileId, snapshot);
  }

  public async readProfile(profileId: string): Promise<ProfileSnapshot | null> {
    this.reads.push(profileId);
    return this.profiles.get(profileId) ?? null;
  }
}

/** Records every publish so tests can assert on families and payloads. */
export class RecordingProducer {
  public readonly published: Array<{
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }> = [];

  public async publishEvent(input: {
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }): Promise<unknown> {
    this.published.push(input);
    return undefined;
  }

  public eventsOn(family: string): Array<Record<string, unknown>> {
    return this.published.filter((p) => p.family === family).map((p) => p.event);
  }
}

export const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;
