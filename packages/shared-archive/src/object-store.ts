/**
 * The object-storage surface, and the S3 adapter behind it.
 *
 * Four operations, because four is what the archive needs: put a batch,
 * get an object, list a prefix, and list the immediate child prefixes of
 * one. Anything else — versioning, tagging, multipart, lifecycle — is the
 * bucket's business and is configured on the bucket, not called from
 * here.
 *
 * The interface exists so the archiver and the replay source can be
 * tested against an in-memory store. That is not a testing nicety: the
 * crash-safety property this subsystem turns on ("the checkpoint never
 * outruns the archive") is only observable by controlling exactly when a
 * put succeeds, and no real bucket lets you do that.
 *
 * `@aws-sdk/client-s3` is the single new runtime dependency the archive
 * introduces (stack-impact rule, plan SS8.1). It is imported in this file
 * and nowhere else, so a future move to a different object store replaces
 * one adapter.
 */

/** One object returned by a listing. */
export interface ArchiveObjectSummary {
  readonly key: string;
  readonly size: number;
}

export interface ArchiveObjectStore {
  /** Write an object, overwriting any object already at that key. */
  put(input: {
    readonly key: string;
    readonly body: string;
    readonly contentType?: string;
  }): Promise<void>;
  /** Read an object as text, or `null` when it does not exist. */
  get(key: string): Promise<string | null>;
  /** Every object under a prefix, paginated to exhaustion. */
  list(prefix: string): Promise<readonly ArchiveObjectSummary[]>;
  /**
   * The immediate child "directories" of a prefix — an S3 delimiter
   * listing. One call answers "which days does the archive hold for this
   * project?" without listing the objects inside them.
   */
  listChildPrefixes(prefix: string): Promise<readonly string[]>;
}

/**
 * Minimal shape of the S3 client this adapter drives.
 *
 * Declared structurally rather than importing the SDK's types so this
 * package can be typechecked and tested without the SDK present, and so
 * a caller can inject a client it built with its own credential chain.
 */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface S3ArchiveStoreOptions {
  readonly client: S3Like;
  readonly bucket: string;
  /**
   * The SDK's command constructors, injected. Keeping them a parameter is
   * what lets a test drive this adapter's pagination and error handling
   * with fakes; production passes the real ones from `createS3Client`.
   */
  readonly commands: S3Commands;
}

/**
 * The exact inputs this adapter constructs.
 *
 * Spelled out rather than `Record<string, unknown>`: a constructor taking
 * an arbitrary record is not assignable from the SDK's, whose input types
 * REQUIRE `Bucket` and `Key`. Naming the fields makes the real
 * constructors fit and documents the whole S3 surface the archive uses —
 * four fields on a put, two on a get, four on a list.
 */
export interface S3PutInput {
  readonly Bucket: string;
  readonly Key: string;
  readonly Body: string;
  readonly ContentType: string;
}

export interface S3GetInput {
  readonly Bucket: string;
  readonly Key: string;
}

export interface S3ListInput {
  readonly Bucket: string;
  readonly Prefix: string;
  readonly Delimiter?: string;
  readonly ContinuationToken?: string;
}

export interface S3Commands {
  PutObjectCommand: new (input: S3PutInput) => unknown;
  GetObjectCommand: new (input: S3GetInput) => unknown;
  ListObjectsV2Command: new (input: S3ListInput) => unknown;
}

interface ListResponse {
  Contents?: Array<{ Key?: string; Size?: number }>;
  CommonPrefixes?: Array<{ Prefix?: string }>;
  NextContinuationToken?: string;
  IsTruncated?: boolean;
}

interface GetResponse {
  Body?: { transformToString?: () => Promise<string> };
}

/** Build the S3-backed store. */
export function createS3ArchiveStore(options: S3ArchiveStoreOptions): ArchiveObjectStore {
  const { client, bucket, commands } = options;

  return {
    async put({ key, body, contentType }) {
      await client.send(
        new commands.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType ?? "application/x-ndjson",
        }),
      );
    },

    async get(key) {
      try {
        const response = (await client.send(
          new commands.GetObjectCommand({ Bucket: bucket, Key: key }),
        )) as GetResponse;
        const transform = response.Body?.transformToString;
        if (transform === undefined) return null;
        return await transform.call(response.Body);
      } catch (err) {
        // A missing object is an answer, not a fault: the manifest is
        // optional, and a reader that threw on its absence would make an
        // archive written before manifests existed unreadable.
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async list(prefix) {
      const out: ArchiveObjectSummary[] = [];
      let token: string | undefined;
      do {
        const response = (await client.send(
          new commands.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ...(token !== undefined ? { ContinuationToken: token } : {}),
          }),
        )) as ListResponse;
        for (const item of response.Contents ?? []) {
          if (item.Key === undefined) continue;
          out.push({ key: item.Key, size: item.Size ?? 0 });
        }
        token = response.NextContinuationToken;
      } while (token !== undefined);
      // S3 returns keys in lexicographic order, and the layout pads
      // offsets so that order is also offset order. Sorted explicitly
      // anyway: pagination across a truncated listing is only ordered
      // per page by contract.
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },

    async listChildPrefixes(prefix) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const response = (await client.send(
          new commands.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: "/",
            ...(token !== undefined ? { ContinuationToken: token } : {}),
          }),
        )) as ListResponse;
        for (const item of response.CommonPrefixes ?? []) {
          if (item.Prefix !== undefined) out.push(item.Prefix);
        }
        token = response.NextContinuationToken;
      } while (token !== undefined);
      return out.sort();
    },
  };
}

function isNotFound(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  if (candidate.name === "NoSuchKey" || candidate.name === "NotFound") return true;
  if (candidate.Code === "NoSuchKey") return true;
  return candidate.$metadata?.httpStatusCode === 404;
}

/**
 * In-memory store. Exported because both the archiver's tests and the
 * replay source's tests need one, and a third copy would be a third
 * chance to disagree with the real adapter about what `list` returns.
 */
export function createInMemoryArchiveStore(): ArchiveObjectStore & {
  readonly objects: Map<string, string>;
} {
  const objects = new Map<string, string>();
  return {
    objects,
    async put({ key, body }) {
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async list(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: Buffer.byteLength(body, "utf8") }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    async listChildPrefixes(prefix) {
      const children = new Set<string>();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) continue;
        children.add(`${prefix}${rest.slice(0, slash)}/`);
      }
      return [...children].sort();
    },
  };
}
