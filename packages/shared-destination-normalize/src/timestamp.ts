/**
 * Timestamp normalization helpers shared across destination consumers.
 *
 * Polaris stamps `occurred_at` (and `ingested_at`) as ISO 8601 UTC strings
 * per `docs/architecture/01-event-contract.md`. Vendors diverge on which
 * shape they want:
 *
 *   - Meta CAPI            `event_time` in **Unix epoch seconds**
 *   - TikTok Events        `event_time` in **Unix epoch seconds**
 *   - Reddit Conversions   `event_at` in **Unix epoch seconds**
 *   - Snap Conversion API  `event_time` in **Unix epoch milliseconds**
 *   - GA4 Measurement API  `timestamp_micros` in **Unix epoch microseconds**
 *
 * Each `normalizeForDestination` call returns both the ISO 8601 string and
 * the Unix-epoch milliseconds. Consumers pick the conversion they need at
 * the mapper layer — no destination needs to parse the ISO string again.
 *
 * All helpers are deterministic and stateless.
 */

/**
 * Parse an ISO 8601 UTC string into Unix epoch milliseconds. Throws when
 * the input is not a valid date string the JavaScript runtime can parse,
 * or when the parsed value is not finite.
 *
 * The envelope schema in `@polaris/shared-schemas` already validates the
 * ISO shape at the ingester boundary, so callers in production rarely see
 * the throw — it is defensive for replay/test paths where an upstream
 * stage may produce a malformed value.
 */
export function isoToEpochMs(iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`timestamp: input "${iso}" is not a parseable ISO 8601 UTC string`);
  }
  return parsed;
}

/**
 * Parse an ISO 8601 UTC string into Unix epoch seconds (Meta / TikTok /
 * Reddit shape). Truncates fractional seconds toward zero — Meta and
 * TikTok both document second-resolution `event_time`.
 */
export function isoToEpochSeconds(iso: string): number {
  return Math.trunc(isoToEpochMs(iso) / 1000);
}

/**
 * Parse an ISO 8601 UTC string into Unix epoch microseconds (GA4
 * Measurement Protocol `timestamp_micros` shape). Returns an integer.
 *
 * The base ISO string carries millisecond precision; the conversion
 * therefore multiplies by 1000 and exposes 0-padded microseconds. GA4
 * accepts that shape — the documentation only constrains the range, not
 * the precision.
 */
export function isoToEpochMicros(iso: string): number {
  return isoToEpochMs(iso) * 1000;
}
