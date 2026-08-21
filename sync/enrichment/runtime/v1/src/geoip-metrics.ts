/**
 * What the stage published about its geo database, at boot.
 *
 * Everything else the enrichment stage reports is PER EVENT — consumed,
 * emitted, and the `geo:hit|miss|no_backend|no_ip` outcomes on
 * `polaris_processor_outcome_total`. Those answer "what is happening to
 * traffic", and for two of this file's three failure modes that is
 * enough: no database wired shows up as `geo:no_backend` on every event,
 * and an address the database does not carry shows up as `geo:miss`.
 *
 * The third mode is the one nothing above can see. A database that
 * loaded cleanly and stopped being refreshed answers every lookup, hits
 * on most of them, and is WRONG for every address that changed hands
 * since it was built. There is no per-event signal for that, because
 * from the event's side nothing is wrong. The only witness is the
 * snapshot's build date, and the process holds it from boot to restart
 * (see `MaxmindIPLookup`) — so it is a gauge, published once, read on
 * every scrape.
 *
 * `loaded` is here for the case per-event metrics genuinely cannot
 * cover: a stage with no traffic. `geo:no_backend` needs an event to
 * count, so an idle stage with no database looks exactly like an idle
 * stage with one. A gauge is present whether or not anything flowed.
 *
 * @see docs/operations/runbook-geoip-refresh.md
 */

import type { MetricSample } from "@polaris/observability-metrics";
import {
  type IPLookup,
  MaxmindIPLookup,
  SOURCE_NO_LOOKUP,
} from "@polaris/sync-enrichment-geoip-v1";

/**
 * 1 when a geo database is wired, 0 when the stage is running fail-open.
 *
 * Carries `source` either way, so the 0 series says WHICH nothing it
 * has — `no_lookup` is the only value it takes today, and a second
 * fail-open backend would arrive with its own.
 */
export const METRIC_GEOIP_DATABASE_LOADED = "polaris_enrichment_geoip_database_loaded";

/**
 * When MaxMind built the loaded snapshot, in Unix seconds.
 *
 * Absent — not zero — when no database is loaded or the file carries no
 * build epoch. A zero would read as 1970 and make every staleness
 * expression fire on a stage that simply has no database, which is the
 * condition the gauge above already reports precisely.
 */
export const METRIC_GEOIP_DATABASE_BUILD_TIMESTAMP_SECONDS =
  "polaris_enrichment_geoip_database_build_timestamp_seconds";

/**
 * Who is reporting, in the shape every other Polaris metric uses.
 *
 * `processor_name` / `processor_version` because stages here run side by
 * side across versions during a cutover, and two processes publishing
 * one unlabelled series would be told apart only by scrape `instance` —
 * which is a pod name, not an answer. `environment` because an alert
 * that cannot say whether staging or production lost its geo database
 * has not said anything. Deliberately no `project_id`: one database
 * serves the whole process.
 */
export interface GeoipBackendLabels {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly environment: string;
}

/** The geo backend this process booted with. */
export interface GeoipBackendStatus {
  /** The backend's `id`: `maxmind:GeoLite2-City:2026-08-01`, or `no_lookup`. */
  readonly source: string;
  /** False when the stage fell back to the fail-open no-op. */
  readonly loaded: boolean;
  /** Build epoch of the loaded database; null when there is none to report. */
  readonly buildEpoch: Date | null;
}

/**
 * Describe any `IPLookup`, however it was obtained.
 *
 * One function for the configured path and the injected one. The
 * alternative — deriving the status where the database is opened, and
 * separately where a test or the smoke harness hands in a backend — is
 * two descriptions of the same thing that drift, and the injected side
 * is the one nobody would notice going wrong.
 */
export function describeGeoipBackend(lookup: IPLookup): GeoipBackendStatus {
  return {
    source: lookup.id,
    loaded: lookup.id !== SOURCE_NO_LOOKUP,
    buildEpoch: lookup instanceof MaxmindIPLookup ? lookup.buildEpoch : null,
  };
}

/** The status as Prometheus samples, appended to the registry's own. */
export function geoipBackendSamples(
  status: GeoipBackendStatus,
  identity: GeoipBackendLabels,
): MetricSample[] {
  const labels = { ...identity, source: status.source };
  const samples: MetricSample[] = [
    { name: METRIC_GEOIP_DATABASE_LOADED, labels, value: status.loaded ? 1 : 0 },
  ];
  if (status.buildEpoch !== null) {
    samples.push({
      name: METRIC_GEOIP_DATABASE_BUILD_TIMESTAMP_SECONDS,
      labels,
      value: Math.floor(status.buildEpoch.getTime() / 1000),
    });
  }
  return samples;
}
