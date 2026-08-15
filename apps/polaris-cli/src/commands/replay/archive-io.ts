/**
 * The CLI's window onto the object-storage archive.
 *
 * Two commands need it and must agree: `replay create` has to know how
 * far back a window may reach before it rejects one, and `replay execute`
 * has to know which substrate to read. Two copies of "where is the
 * bucket" is two chances to disagree, and the disagreement is silent —
 * a create that accepts a window an execute cannot read produces a job
 * that runs, finds nothing, and reports success.
 *
 * `null` everywhere means "no archive", which is not an error: most
 * deployments replay inside retention and never configure a bucket. It
 * becomes an error only at the point something actually needs the
 * archive, and there the message names the variable to set.
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  type ArchiveReplaySource,
  createArchiveReplaySource,
  createS3ArchiveStore,
} from "@polaris/shared-archive";

/** Environment variable that decides whether an archive exists at all. */
export const ARCHIVE_BUCKET_ENV = "POLARIS_ARCHIVE_BUCKET";

export interface ArchiveIo {
  readonly source: ArchiveReplaySource;
}

/**
 * Build the archive reader from the environment, or `null` when no bucket
 * is configured.
 *
 * These are read as raw environment keys rather than through a config
 * schema because the archive is optional for the CLI: a schema that
 * required `POLARIS_ARCHIVE_BUCKET` would make every `polaris` invocation
 * on a deployment without an archive fail at config load.
 */
export function buildArchiveIo(env: NodeJS.ProcessEnv | undefined): ArchiveIo | null {
  // A synthesized context may carry no env at all. "No archive" is the
  // right answer then, and it must not be an exception.
  if (env === undefined) return null;
  const bucket = env[ARCHIVE_BUCKET_ENV]?.trim();
  if (bucket === undefined || bucket.length === 0) return null;

  const prefix = env["POLARIS_ARCHIVE_PREFIX"]?.trim() ?? "polaris";
  const region = env["POLARIS_ARCHIVE_S3_REGION"]?.trim() ?? "us-east-1";
  const endpoint = env["POLARIS_ARCHIVE_S3_ENDPOINT"]?.trim();
  const forcePathStyle = env["POLARIS_ARCHIVE_S3_FORCE_PATH_STYLE"]?.trim() === "true";

  const client = new S3Client({
    region,
    ...(endpoint !== undefined && endpoint.length > 0 ? { endpoint } : {}),
    // MinIO addresses buckets by path; real S3 by subdomain.
    forcePathStyle,
  });
  const store = createS3ArchiveStore({
    client,
    bucket,
    commands: { PutObjectCommand, GetObjectCommand, ListObjectsV2Command },
  });
  return { source: createArchiveReplaySource({ store, prefix }) };
}

/**
 * A lookup of "how far back does the archive go for this project?".
 *
 * Injected in tests. `null` means there is no archive, or none that
 * covers this project.
 */
export type ArchiveCoverageLookup = (scope: {
  readonly projectId: string;
  readonly environment: string;
}) => Promise<string | null>;

/**
 * The archive's earliest UTC day for a project, or `null`.
 *
 * A listing failure returns `null` rather than throwing: the archive is
 * an extension of what replay can reach, and an unreachable bucket should
 * degrade to the pre-archive behaviour — a clear `outside_retention_window`
 * rejection — rather than failing a replay that was inside retention all
 * along.
 */
export async function archiveEarliestDate(input: {
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly projectId: string;
  readonly environment: string;
  readonly lookup?: ArchiveCoverageLookup | undefined;
  readonly remember?: ((io: ArchiveIo) => void) | undefined;
}): Promise<string | null> {
  if (input.lookup !== undefined) {
    return input.lookup({ projectId: input.projectId, environment: input.environment });
  }
  const io = buildArchiveIo(input.env);
  if (io === null) return null;
  input.remember?.(io);
  try {
    const dates = await io.source.coveredDates({
      projectId: input.projectId,
      environment: input.environment,
    });
    return dates[0] ?? null;
  } catch {
    return null;
  }
}

/** The instant an archive day starts, for comparison against a window. */
export function archiveFloorInstant(date: string | null): Date | null {
  if (date === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const ms = Date.parse(`${date.trim()}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
