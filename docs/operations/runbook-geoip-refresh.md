# GeoIP Database Refresh Runbook

Operators use this runbook to provision, refresh, verify and roll back
the MaxMind GeoLite2 database that the enrichment stage reads. It also
answers the question that brings most people here: **why is
`enrichment.geo` empty?**

Binding architecture references:

- [Processors and Replay](../architecture/05-processors-and-replay.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The adapter is
[`sync/enrichment/geoip/v1/src/maxmind.ts`](../../sync/enrichment/geoip/v1/src/maxmind.ts),
composed in-process by
[`sync/enrichment/runtime/v1`](../../sync/enrichment/runtime/v1/). The
fetch job is
[`infra/geoip/refresh-geoip.sh`](../../infra/geoip/refresh-geoip.sh).
The mount contract is in
[`infra/docker/README.md`](../../infra/docker/README.md) "Mounted data";
the variables are in
[`docs/deployment/config-reference.md`](../deployment/config-reference.md).

## The one-paragraph model

The database is a **license-restricted 60 MB file that is never in an
image and never in this repository**. A cron job on the host fetches it
and swaps it into a directory; the enrichment stage mounts that
directory read-only and reads the file **once, at boot**, into memory.
So a refresh does not reach a running process — the process keeps the
snapshot it started with until it restarts, which is exactly what makes
the `source` it stamps on every event (`maxmind:GeoLite2-City:2026-08-01`)
an honest answer to "which database produced this row".

Everything below follows from those two facts: the file moves on the
host, and the process only notices at boot.

## Reading the geo block

`enrichment.geo` is never absent, and it distinguishes three different
facts. Reading them as one is the most common mistake here.

| `geo.source` | What happened | Is it a problem? |
| --- | --- | --- |
| `maxmind:<edition>:<date>` | A database answered | No — and the date says which snapshot |
| `no_ip` | The event carried no usable `context.ip` | No — normal for server-side events |
| `no_lookup` | **No database was wired.** Nothing was consulted | Yes, if you expected geo |
| `null` block with a `maxmind:` source | A database was consulted and had no record for that address | No — a genuine miss |

`no_lookup` on **every** event means the stage is running fail-open: the
mount is missing, the path is wrong, or the file is not a readable mmdb.
That is a supported posture — geo is decoration on the spine, and every
destination sits behind this stage, so a missing city name must never
stall the pipeline — but it is not a silent one. See "Verify" below.

## Signals

| Signal | Where | Says |
| --- | --- | --- |
| `polaris_enrichment_geoip_database_loaded` | `/metrics` | 1 wired, 0 fail-open. Present with no traffic |
| `polaris_enrichment_geoip_database_build_timestamp_seconds` | `/metrics` | When MaxMind built the loaded snapshot |
| `geoip database loaded` / `... could not be opened` | boot log | The path tried, and the reason it failed |
| `polaris_processor_outcome_total{outcome="geo:no_backend"}` | `/metrics` | Per-event confirmation, once traffic flows |

The two gauges are the pair to alert on, and they are deliberately
separate. `geo:no_backend` needs an event to count, so an idle stage
with no database looks identical to an idle stage with one; the gauges
are published whether or not anything flowed. And a database that
loaded and stopped being refreshed raises nothing at all per event — it
answers, it hits, and it is wrong for every address that changed hands
since it was built. Its only witness is the build timestamp.

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisEnrichmentGeoipDatabaseMissing` | warn | `polaris_enrichment_geoip_database_loaded == 0` for 15m |
| `PolarisEnrichmentGeoipDatabaseStale` | warn | loaded snapshot older than 30 days for 1h |

Both are `warn` and neither pages. The stage fails open by design, so
geo being absent or stale degrades a decoration; waking someone for it
would be the wrong trade, and the same argument that keeps this off the
readiness probe keeps it off the pager.

## Provisioning it the first time

### Locally

```bash
# 1. A free licence key: https://www.maxmind.com/en/geolite2/signup
#    (the account is required by the licence even though the data is free)
echo 'POLARIS_GEOIP_LICENSE_KEY=<key>' >> .env.local

# 2. Fetch. Lands in resources/maxmind/ (gitignored).
make geoip-refresh

# 3. Restart the stack — the stage reads the file at boot.
make dev
```

`make dev` needs no further wiring: the enrichment stage's `dev` script
already points `POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH` at that file.
Keeping the database elsewhere means setting **both** ends in
`.env.local` — see `.env.local.example`, which explains why they are two
variables.

Without the key, `make setup` still succeeds and its receipt names what
is missing. It never fetches: an install that failed for want of a
third-party signup would trade a supported posture for a broken one.

### In a deployment

1. Mount a directory — **not the file** — read-only at
   `/etc/polaris/geoip`, and set
   `POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH=/etc/polaris/geoip/GeoLite2-City.mmdb`.
   The refresh replaces the inode with `mv`, and a bind mount of the
   file pins the container to the inode it started with — it would keep
   serving the superseded database after every refresh, and the only
   place that would show is the build date in `source`.
2. Run the fetch on whatever writes that volume — a host cron entry, a
   Kubernetes `CronJob` with the same PVC mounted read-write — with
   `POLARIS_GEOIP_LICENSE_KEY` and `POLARIS_GEOIP_DB_PATH` set.
3. Restart the enrichment pods to pick up the first database.

There is no scheduler in this repository and deliberately so: cadence is
a deployment's decision, and the script is idempotent and safe to run
from cron.

## Cadence

MaxMind republishes GeoLite2 **twice weekly, on Tuesdays and Fridays**.
Fetching daily is harmless — the script is idempotent — and fetching
weekly is enough. What matters more than frequency is that the pods
restart afterwards, because until they do the refresh has changed a file
nobody is reading.

Accuracy decays slowly and continuously as address blocks are
reassigned, so there is no cliff to be late for; the 30-day staleness
alert marks the point where the drift is worth someone's attention, not
a deadline.

## Verify what is actually loaded

The question is always "what does this **process** have", never "what is
on the disk" — they differ for the whole window between a refresh and a
restart.

```bash
# What the running stage loaded, and when MaxMind built it.
curl -s localhost:4015/metrics | grep polaris_enrichment_geoip

#   polaris_enrichment_geoip_database_loaded{source="maxmind:GeoLite2-City:2026-08-01"} 1
#   polaris_enrichment_geoip_database_build_timestamp_seconds{...} 1785542400

# The same fact at boot, with the path it read.
#   {"component":"sync-enrichment.geoip","db_path":"...","source":"maxmind:GeoLite2-City:2026-08-01"}
#   "geoip database loaded"

# End to end: a real event carrying an IP.
./polaris events tail --family resolved.events --project storefront
```

A `loaded 0` line is the stage telling you it is fail-open; the boot log
carries the reason (`ENOENT`, or `not a readable mmdb database`).

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Boot log `ENOENT` on the path | Volume not mounted, or path typo | Fix the mount, restart |
| `not a readable mmdb database` | A truncated download or an HTML error page saved under the `.mmdb` name | Re-run the fetch; it refuses to swap in a file without MaxMind's metadata marker, so a failing fetch leaves yesterday's database in place |
| `download failed` from the job | Bad or expired licence key, wrong edition id | Check the key at maxmind.com; the URL takes both |
| Every event `no_lookup` but the file is there | The pods have not restarted since the mount appeared | Restart the enrichment pods |
| `source` names an old date after a refresh | Same, or the file itself is bind-mounted | Restart; if it recurs, mount the directory instead |
| Geo populated but wrong for a known address | The snapshot predates a reassignment of that block | Check the build date; refresh if stale, otherwise it is the data |

## Rollback

The job keeps the superseded database as `<path>.previous` unless
`POLARIS_GEOIP_KEEP_PREVIOUS=0`. Rolling back is a move and a restart,
and needs nothing from MaxMind:

```bash
mv /srv/polaris/geoip/GeoLite2-City.mmdb.previous \
   /srv/polaris/geoip/GeoLite2-City.mmdb
# then restart the enrichment pods
```

Only one generation is kept, so a rollback is available for exactly one
refresh.

## What this runbook does not cover

- **Events with no IP.** `geo.source: "no_ip"` is the stage reporting
  that the event carried no usable address — nothing to do with the
  database. Server-side events legitimately have none.
- **Backfilling geo onto events already emitted.** Replay is the
  mechanism; see
  [Processors and Replay](../architecture/05-processors-and-replay.md).
  Note that replaying through a newer database produces *different*
  values than the original run, which is what the `source` stamp exists
  to make visible.
- **Geo in ClickHouse.** The warehouse sink carries the `profile` block
  and has no `enrichment` column; `enrichment.geo` reaches destinations
  on the spine event but is not projected into the warehouse.
