/**
 * The per-day, per-stream manifest.
 *
 * One NDJSON line per batch object, recording what a reader would
 * otherwise have to download the object to learn: its offset range, its
 * event-time range, how many records it holds, and how big it is.
 *
 * ## Why the time range is the useful part
 *
 * A batch key encodes offsets, and a replay window is expressed in event
 * time. Without the manifest, answering "which objects hold events
 * between 14:00 and 15:00 on the 3rd?" means fetching every object for
 * the 3rd and reading its lines. With it, the reader fetches the ones
 * whose `[min_occurred_at, max_occurred_at]` intersects the window —
 * usually a small fraction of a busy day.
 *
 * ## Why it is per stream, not per day
 *
 * S3 has no append. Adding a line means read-modify-write, and a
 * read-modify-write is only safe with a single writer. A stream partition
 * is consumed by exactly one member of a consumer group at a time, so
 * per-stream gives that single writer for free. A per-day manifest would
 * be written by every partition's handler and would silently lose lines
 * whenever two flushed together.
 *
 * ## A missing manifest is never "no data"
 *
 * Readers fall back to listing the day prefix and reading every object.
 * The manifest is an optimisation, and an optimisation that turns into a
 * silent data loss when absent is not one — an archive written before
 * manifests existed, or a flush that put the batch and died before the
 * manifest, must still replay completely.
 */

import { archiveDayPrefix } from "./layout.js";

/** One line of a manifest. */
export interface ArchiveManifestEntry {
  /** Full object key of the batch this line describes. */
  readonly key: string;
  readonly first_offset: string;
  readonly last_offset: string;
  /** Earliest `occurred_at` in the object, ISO 8601. */
  readonly min_occurred_at: string;
  /** Latest `occurred_at` in the object, ISO 8601. */
  readonly max_occurred_at: string;
  readonly records: number;
  readonly bytes: number;
  /** When the archiver put the object. */
  readonly written_at: string;
}

/** Key of a stream's manifest within a day. */
export function archiveStreamManifestKey(input: {
  readonly prefix: string;
  readonly projectId: string;
  readonly environment: string;
  readonly date: string;
  readonly stream: string;
}): string {
  return `${archiveDayPrefix(input)}_manifest/${input.stream}.ndjson`;
}

/** Render entries as an NDJSON body. */
export function renderManifest(entries: readonly ArchiveManifestEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * Parse a manifest body, skipping lines that do not parse.
 *
 * Skipping rather than throwing: a truncated final line — the shape a
 * crash mid-put leaves — should cost the entries after it, not every
 * entry before it. The reader's fallback covers what a skipped line
 * described.
 */
export function parseManifest(body: string): readonly ArchiveManifestEntry[] {
  const entries: ArchiveManifestEntry[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const entry = parsed as Record<string, unknown>;
    if (
      typeof entry["key"] !== "string" ||
      typeof entry["min_occurred_at"] !== "string" ||
      typeof entry["max_occurred_at"] !== "string"
    ) {
      continue;
    }
    entries.push({
      key: entry["key"],
      first_offset: String(entry["first_offset"] ?? ""),
      last_offset: String(entry["last_offset"] ?? ""),
      min_occurred_at: entry["min_occurred_at"],
      max_occurred_at: entry["max_occurred_at"],
      records: Number(entry["records"] ?? 0),
      bytes: Number(entry["bytes"] ?? 0),
      written_at: String(entry["written_at"] ?? ""),
    });
  }
  return entries;
}

/**
 * Does this object's event-time range intersect `[from, to]`?
 *
 * Inclusive at both ends, matching the planner's chunk bounds. An entry
 * whose timestamps are unparseable is treated as intersecting: the cost
 * is one unnecessary GET, and the alternative is silently skipping data.
 */
export function manifestEntryIntersects(
  entry: ArchiveManifestEntry,
  fromIso: string,
  toIso: string,
): boolean {
  const min = Date.parse(entry.min_occurred_at);
  const max = Date.parse(entry.max_occurred_at);
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return true;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return max >= from && min <= to;
}
