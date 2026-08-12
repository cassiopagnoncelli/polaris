#!/usr/bin/env node
// Polaris Redis local teardown — delete every key Polaris owns, and no others.
//
// Deliberately NOT `FLUSHDB`. A localhost Redis on db 0 is the most shared
// database on a developer's machine: the same server is very often backing
// something else entirely. Every Polaris key is already namespaced —
// `polaris:ingest:dedupe:*` and `polaris:ingest:rl:*`, both configurable via
// POLARIS_INGEST_REDIS_KEY_PREFIX / POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX (see
// apps/ingester-api/src/config.ts) — so deleting by prefix is exactly as
// complete and cannot reach anything that is not ours.
//
// That keeps destroy symmetric across all four stores: PostgreSQL and
// ClickHouse drop a named database, RabbitMQ deletes named queues and
// exchanges, Redis deletes named prefixes. Nothing is destroyed that cannot
// be named.
//
// Why leftover keys matter at all: the dedupe entries from a previous run
// suppress the very events a fresh install replays, so a machine that kept
// them behaves differently from one that never had them. That is the
// difference this script exists to erase.
//
// Speaks RESP over a raw socket rather than pulling in a client library:
// `ioredis` is a dependency of apps/ingester-api, not of the workspace root,
// and SCAN + UNLINK is a dozen lines of protocol.
//
// Usage:
//   node scripts/redis-destroy-local.mjs
//
// Env vars (same names the services use):
//   POLARIS_REDIS_HOST                    default localhost
//   POLARIS_REDIS_PORT                    default 6379
//   POLARIS_INGEST_REDIS_KEY_PREFIX       default polaris:ingest:dedupe
//   POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX   default polaris:ingest:rl

import { createConnection } from "node:net";

const HOST = envOr("POLARIS_REDIS_HOST", "localhost");
const PORT = Number(envOr("POLARIS_REDIS_PORT", "6379"));

/**
 * The prefixes to erase.
 *
 * Both defaults share a `polaris:` root, so one pattern would do today. They
 * are listed separately because each is independently configurable, and a
 * developer who overrode one to something outside that root would otherwise
 * be left with keys this script silently missed.
 */
const PREFIXES = [
  envOr("POLARIS_INGEST_REDIS_KEY_PREFIX", "polaris:ingest:dedupe"),
  envOr("POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX", "polaris:ingest:rl"),
];

/** Keys per SCAN round. A hint to Redis, not a guarantee. */
const SCAN_COUNT = 500;

function envOr(key, fallback) {
  const value = process.env[key];
  return value !== undefined && value !== "" ? value : fallback;
}

/** Encode a command as a RESP array of bulk strings. */
function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const value = String(arg);
    out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }
  return out;
}

/**
 * Parse one RESP reply from `buffer` at `offset`.
 *
 * Returns `{ value, next }`, or `undefined` when the buffer holds only part
 * of a reply and more bytes are needed. Recursive for arrays, which is all
 * SCAN needs — it answers with `[cursor, [key, ...]]`.
 */
function parse(buffer, offset) {
  const end = buffer.indexOf("\r\n", offset);
  if (end === -1) return undefined;

  const type = buffer[offset];
  const head = buffer.slice(offset + 1, end);
  const next = end + 2;

  if (type === "+" || type === ":") return { value: head, next };
  if (type === "-") throw new Error(`redis replied: ${head}`);

  if (type === "$") {
    const length = Number(head);
    if (length === -1) return { value: null, next };
    if (buffer.length < next + length + 2) return undefined;
    return { value: buffer.slice(next, next + length), next: next + length + 2 };
  }

  if (type === "*") {
    const count = Number(head);
    if (count === -1) return { value: null, next };
    const items = [];
    let cursor = next;
    for (let i = 0; i < count; i += 1) {
      const item = parse(buffer, cursor);
      if (item === undefined) return undefined;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }

  throw new Error(`unrecognised RESP type ${JSON.stringify(type)}`);
}

/**
 * A single Redis connection that sends commands and resolves replies in
 * order. Redis answers pipelined commands in the order it received them, so
 * a FIFO of pending resolvers is all the bookkeeping this needs.
 */
function connectRedis() {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = createConnection({ host: HOST, port: PORT });
    const pending = [];
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        let reply;
        try {
          reply = parse(buffer, 0);
        } catch (err) {
          pending.shift()?.reject(err);
          buffer = "";
          return;
        }
        if (reply === undefined) return;
        buffer = buffer.slice(reply.next);
        pending.shift()?.resolve(reply.value);
      }
    });
    socket.on("error", (err) => {
      while (pending.length > 0) pending.shift().reject(err);
      rejectConnection(err);
    });
    socket.on("connect", () => {
      resolveConnection({
        send(...args) {
          return new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
            socket.write(encode(args));
          });
        },
        close() {
          socket.end();
        },
      });
    });
  });
}

/**
 * Delete every key matching `<prefix>:*` and the bare prefix itself.
 *
 * SCAN rather than KEYS: KEYS blocks the server for the whole sweep, and
 * while that is survivable on a dev box it is a habit worth not forming.
 * UNLINK rather than DEL: it reclaims memory on a background thread, so a
 * large dedupe set does not stall the server mid-teardown.
 *
 * SCAN offers no delivery guarantee for keys that change during the sweep,
 * which is why `bin/setup` stops the stack first — with nothing writing,
 * one pass is complete.
 */
async function deletePrefix(redis, prefix) {
  let cursor = "0";
  let deleted = 0;
  do {
    const [next, keys] = await redis.send(
      "SCAN",
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      SCAN_COUNT,
    );
    cursor = next;
    if (keys.length > 0) {
      await redis.send("UNLINK", ...keys);
      deleted += keys.length;
    }
  } while (cursor !== "0");
  return deleted;
}

async function main() {
  let redis;
  try {
    redis = await connectRedis();
  } catch (err) {
    throw new Error(
      `[redis-destroy-local] could not connect to ${HOST}:${PORT}: ${err.message}\n` +
        "  Bare-metal setup expects Redis reachable at the default endpoint.",
    );
  }

  try {
    let total = 0;
    for (const prefix of PREFIXES) {
      const deleted = await deletePrefix(redis, prefix);
      total += deleted;
      console.log(`[redis-destroy-local] ${prefix}* — ${deleted} key(s)`);
    }
    console.log(`[redis-destroy-local] deleted ${total} key(s) at ${HOST}:${PORT}`);
  } finally {
    redis.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
