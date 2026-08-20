/**
 * The archive's object layout.
 *
 * Pure key arithmetic, no I/O. Two consumers depend on this module being
 * the only place that knows the layout: the archiver writes objects, and
 * the replay source lists and reads them. A layout that lived in the writer
 * and was re-derived by the reader is a layout that drifts, and the failure
 * mode is silent — a replay that finds nothing looks exactly like a window
 * with no events.
 *
 * ## The layout
 *
 *     <prefix>/v1/<project_id>/<environment>/<YYYY-MM-DD>/<stream>/
 *       <first_offset>-<last_offset>.ndjson
 *
 * and one manifest per project/environment/day:
 *
 *     <prefix>/v1/<project_id>/<environment>/<YYYY-MM-DD>/_manifest.ndjson
 *
 * Every element is load-bearing:
 *
 *   - **`v1`** so a future layout can coexist with this one during a
 *     migration. Replaying from an archive is a rare, high-stakes
 *     operation; the version that cannot read old objects is the one that
 *     discovers it during an incident.
 *
 *   - **project before environment** because access control and lifecycle
 *     rules are per project first. An S3 prefix condition on a bucket
 *     policy can then scope a role to one project.
 *
 *   - **the date is `occurred_at`'s**, not the archiver's wall clock. The
 *     replay planner works in event time, so a window of "March 3rd" must
 *     be answerable by listing one prefix. Keying on ingestion time would
 *     make every window read every day's objects to find late arrivals.
 *
 *   - **offsets are zero-padded** to 20 digits. S3 lists lexicographically,
 *     and `10-19.ndjson` sorts before `9.ndjson` without the padding — so
 *     an unpadded layout returns batches out of order and a reader that
 *     stops early stops at the wrong place. Twenty digits holds any
 *     unsigned 64-bit offset.
 *
 * ## Why the manifest exists
 *
 * A day's prefix can hold thousands of objects across streams. The
 * planner needs one question answered cheaply — "does the archive cover
 * this window?" — and answering it by listing every object in a 90-day
 * range is slow enough that operators would skip the check. The manifest
 * is one small NDJSON object per project/environment/day, appended to as
 * batches land, and reading it is one GET.
 */

/** Layout version. Bumped only when the key shape changes. */
const ARCHIVE_LAYOUT_VERSION = "v1" as const;

/** File extension for a batch object. Verbatim envelopes, one per line. */
const ARCHIVE_BATCH_EXTENSION = ".ndjson" as const;

/** Object name of a day's manifest, within the day prefix. */
export const ARCHIVE_MANIFEST_NAME = "_manifest.ndjson" as const;

/**
 * Width offsets are padded to. Twenty digits is the decimal width of
 * 2^64-1, so no real offset ever overflows the padding and sorts wrong.
 */
const ARCHIVE_OFFSET_WIDTH = 20;

/** Identifies one batch object. */
export interface ArchiveBatchKeyInput {
  readonly prefix: string;
  readonly projectId: string;
  readonly environment: string;
  /** `YYYY-MM-DD`, derived from the events' `occurred_at`. */
  readonly date: string;
  /** Source stream the batch was consumed from. */
  readonly stream: string;
  readonly firstOffset: string;
  readonly lastOffset: string;
}

/** Everything a key encodes, recovered from the key. */
export interface ParsedArchiveKey {
  readonly projectId: string;
  readonly environment: string;
  readonly date: string;
  readonly stream: string;
  readonly firstOffset: string;
  readonly lastOffset: string;
}

/**
 * The `YYYY-MM-DD` an ISO timestamp falls on, in UTC.
 *
 * UTC deliberately, and not the project's local timezone: an archive
 * partitioned by local dates would have objects move between prefixes
 * when a project changes timezone, and a replay window expressed in UTC
 * would need the timezone history to know which prefixes to read.
 */
export function archiveDateOf(occurredAt: string): string | null {
  const ms = Date.parse(occurredAt);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Pad an offset so lexicographic order matches numeric order. */
export function padOffset(offset: string): string {
  const digits = offset.trim();
  if (!/^\d+$/.test(digits)) {
    throw new Error(`archive offset must be decimal digits (got "${offset}")`);
  }
  if (digits.length > ARCHIVE_OFFSET_WIDTH) {
    throw new Error(`archive offset exceeds ${String(ARCHIVE_OFFSET_WIDTH)} digits: ${offset}`);
  }
  return digits.padStart(ARCHIVE_OFFSET_WIDTH, "0");
}

/** Strip the padding an offset was written with. */
export function unpadOffset(padded: string): string {
  const trimmed = padded.replace(/^0+/, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

/** Normalise a configured prefix: no leading or trailing slash. */
function normalisePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Prefix covering one project/environment — the parent of the day
 * prefixes. A delimiter listing here answers "which days does the archive
 * hold?" in one call, which is how coverage is checked.
 */
export function archiveEnvironmentPrefix(input: {
  readonly prefix: string;
  readonly projectId: string;
  readonly environment: string;
}): string {
  const root = normalisePrefix(input.prefix);
  const head = root.length > 0 ? `${root}/` : "";
  return `${head}${ARCHIVE_LAYOUT_VERSION}/${input.projectId}/${input.environment}/`;
}

/** Prefix covering one project/environment/day. */
export function archiveDayPrefix(input: {
  readonly prefix: string;
  readonly projectId: string;
  readonly environment: string;
  readonly date: string;
}): string {
  return `${archiveEnvironmentPrefix(input)}${input.date}/`;
}

/** Key of one batch object. */
export function archiveBatchKey(input: ArchiveBatchKeyInput): string {
  const day = archiveDayPrefix(input);
  return `${day}${input.stream}/${padOffset(input.firstOffset)}-${padOffset(
    input.lastOffset,
  )}${ARCHIVE_BATCH_EXTENSION}`;
}

/**
 * Recover what a batch key encodes, or `null` if it is not one.
 *
 * Returns `null` rather than throwing for anything unrecognised —
 * manifests, objects written by a future layout version, and whatever
 * else shares the bucket. A lister that threw on the first unfamiliar key
 * would make an unrelated object in the bucket break every replay.
 */
export function parseArchiveBatchKey(prefix: string, key: string): ParsedArchiveKey | null {
  const root = normalisePrefix(prefix);
  const head = root.length > 0 ? `${root}/` : "";
  if (!key.startsWith(`${head}${ARCHIVE_LAYOUT_VERSION}/`)) return null;
  if (!key.endsWith(ARCHIVE_BATCH_EXTENSION)) return null;

  const rest = key.slice(head.length + ARCHIVE_LAYOUT_VERSION.length + 1);
  const parts = rest.split("/");
  if (parts.length !== 5) return null;
  const [projectId, environment, date, stream, file] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const range = file.slice(0, -ARCHIVE_BATCH_EXTENSION.length);
  const dash = range.indexOf("-");
  if (dash <= 0) return null;
  const first = range.slice(0, dash);
  const last = range.slice(dash + 1);
  if (!/^\d+$/.test(first) || !/^\d+$/.test(last)) return null;

  return {
    projectId,
    environment,
    date,
    stream,
    firstOffset: unpadOffset(first),
    lastOffset: unpadOffset(last),
  };
}

/**
 * Every `YYYY-MM-DD` a window touches, inclusive at both ends.
 *
 * Inclusive at the upper end because a window ending at 00:00:01 on the
 * 4th genuinely contains events on the 4th. Off-by-one here means a
 * replay silently misses its last second.
 */
export function archiveDatesInWindow(fromIso: string, toIso: string): readonly string[] {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];

  const dates: string[] = [];
  const cursor = new Date(
    Date.UTC(
      new Date(fromMs).getUTCFullYear(),
      new Date(fromMs).getUTCMonth(),
      new Date(fromMs).getUTCDate(),
    ),
  );
  const endDay = new Date(toMs).toISOString().slice(0, 10);
  for (;;) {
    const day = cursor.toISOString().slice(0, 10);
    dates.push(day);
    if (day >= endDay) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // A malformed pair that survived the checks above must not spin
    // forever; 40 years of days is far past any retention policy.
    if (dates.length > 15_000) break;
  }
  return dates;
}
