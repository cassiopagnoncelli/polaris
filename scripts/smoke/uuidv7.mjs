// Polaris vertical-slice smoke — UUIDv7 helper.
//
// The smoke runner mints an `api_key_id` that lives in PostgreSQL forever
// (smoke runs accumulate keys in the table). UUIDv7 is the right shape:
// time-ordered, monotonic-friendly, and matches what the polaris CLI
// generates through the `uuid` package.
//
// We don't import `uuid` directly because scripts/ stays dependency-free:
// the migration runner, ClickHouse query helper, and this smoke runner
// all live without a package.json so a `pnpm install` failure cannot
// block them. The fallback below produces a v7-shaped string using
// node:crypto only.

import { randomBytes } from "node:crypto";

/**
 * Returns a UUIDv7 string `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`.
 *
 * Layout (per RFC 9562 §5.7):
 *   - 48-bit Unix millisecond timestamp (most significant)
 *   - 4-bit version (`0111` / 7)
 *   - 12 bits of random
 *   - 2-bit variant (`10`)
 *   - 62 bits of random
 *
 * Monotonicity within a single millisecond is provided by the random
 * field — adequate for the smoke runner's needs, which only mints one
 * id per invocation.
 */
export function v7() {
  const ms = BigInt(Date.now());
  const rand = randomBytes(10);

  // Pack the 48-bit timestamp into the first 6 bytes (network byte order).
  const bytes = Buffer.alloc(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Bytes 6-15 from CSPRNG, then overwrite the version and variant nibbles.
  rand.copy(bytes, 6, 0, 10);

  // Version 7 (high nibble of byte 6).
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant 10xx (high two bits of byte 8).
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
