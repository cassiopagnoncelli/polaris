# attribution-engine v2 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v2 artifact. Anything that changes emitted event
meaning, fields, attribution outcomes (first-touch rule, last-touch rule,
delta detection, identifier preference order), output schema, or the
touchpoint_id derivation requires a new version directory (v3/) — see
`docs/architecture/05-processors-and-replay.md` "Processor Versioning".

## v2.0.0 — bounded attribution window

**The one semantic change from v1: a 90-day inactivity window.**

A touchpoint chain now resets when the gap between an incoming event's
`occurred_at` and the chain's `last_observed_at` exceeds 90 days. The next
touchpoint after that gap opens a new chain and is assigned first touch.
v1 had no window at all: a chain was consulted however old it was, so an
identifier's first campaign held first-touch credit forever.

Everything else is unchanged — identifier preference order, touchpoint
detection, the three emitted event kinds, tuple-delta logic, and the
conservative refusal to define "conversion".

### Why an inactivity gap rather than an absolute chain age

An absolute cap ("a chain dies 90 days after its first touch") resets users
mid-journey: someone touching weekly for a year would get an arbitrary new
first touch every quarter. A gap only fires once the journey has actually
gone quiet, which is what "the earlier campaign no longer deserves credit"
means in practice.

It also collapses retention and semantics into one number. A row idle for
longer than the window can never be consulted again — the next event for that
identifier is guaranteed to reset the chain — so deleting it is provably free
of semantic effect. v1's chain table could not be trimmed for exactly this
reason: with no window, any row might still be read.

### Why 90 days

Polaris holds the superset and lets each destination narrow to its own vendor
window (Meta 7-day click / 1-day view, Google Ads 30-day, GA4 90-day
acquisition). A shorter platform window cannot be widened after the fact — we
cannot serve data already discarded — while a longer one costs only storage.
90 days sits inside `analytics_processed`'s 400-day TTL, so a replay can
rebuild any chain the window dropped.

### No env override, deliberately

The window is a manifest constant. Per the manifest header, PostgreSQL and
env carry runtime configuration and never semantic transformation rules; a
deployment-level knob could silently change which events receive first touch,
which is the drift processor versioning exists to prevent. Changing the
window means a v3.

This was written while the sessionizer's config comment claimed the runtime
"ignores attempts to widen" its inactivity window even though the code passed
the configured value straight through. Rather than copy a documented rule that
was not enforced, v2 declined to offer the knob at all — and the sessionizer
has since been fixed to actually pin its window to the manifest.

### Chain resets replace the first-touch slot

A first observation now writes through `startChain` rather than `set`.

`set` is an upsert whose UPDATE branch never rewrites the `first_*`
columns — first-touch attribution is anchored to the first observation, so
a continuing chain must not move it. In v1 that was free: a first
observation could only happen when no row existed, so the refusal never
fired. The window changed that. v2 resets a chain after a 90-day gap, and
a reset IS a first observation on a row that already exists — routing it
through `set` left the row claiming the expired chain's first touch while
its count said it had restarted.

Found by running v1 and v2 side by side against a real PostgreSQL, which
is the only place it shows: the in-memory adapter cannot reproduce the
SQL refusal. The regression test asserts which store method the runtime
calls, since that is what the assertion can reach.

### Behaviour differences an operator should expect

- **More `first_touch_assigned` events.** Every identifier returning after a
  >90-day gap now produces one. Under v1 they produced none.
- **`touchpoint_id`s differ from v1 for the same input.** The hash material
  is version-scoped, so a dual-run is unambiguous about which engine emitted
  what. Join on the source `event_id` in properties to compare versions over
  the same slice.
- **Chains are stored separately from v1's.** `attribution_touchpoint_chains`
  is keyed by `processor_version`, so enabling both versions for a project —
  the normal state during a cutover — cannot corrupt either. A v1 replay can
  run alongside live v2 traffic.
- **Consumer group is `polaris-attribution-engine-v2`,** so a cutover starts
  from its own offsets rather than inheriting v1's position.

### Replay

The window makes replay MORE faithful than v1's, not less. v1's caveat was
that a replay starting mid-chain emits a spurious `first_touch_assigned`
because it cannot see the earlier touchpoints. That caveat still holds for
gaps shorter than the window, but any replay slice covering more than 90 days
of inactivity now reproduces the same reset the live run performed, because
the decision is made on EVENT time and never on wall-clock.

### Known limitations

- **No per-project window.** One platform-wide 90 days. The architectural
  question this used to raise is now answered — see
  `docs/architecture/05-processors-and-replay.md` "Per-Project Semantic
  Parameters": per-project semantic values are allowed in the project
  CATALOG (versioned, replay-reproducible), never in PostgreSQL, with the
  manifest declaring the default and the upper bound. Reading one is a v3,
  because a version that consults the catalog behaves differently from one
  that does not. The transform already takes `window_seconds` as a
  parameter, so v3 is resolution and plumbing rather than new logic.
- **No view-through / click-through distinction.** Vendors bound those
  differently (Meta: 1-day view, 7-day click). Polaris treats every
  campaign-tagged observation identically; destinations that care apply
  their own rule downstream. v3 would classify a touchpoint by whether its
  campaign tuple carries a `click_id` and apply a window per class — the
  same mechanism as the per-project window, with a second parameter, not a
  second mechanism.
- ~~**Retention is now possible but not implemented.**~~ **Resolved** —
  `polaris processors chains-prune --version v2` deletes rows idle beyond the
  window, and `infra/backups/prune-attribution-chains.sh` schedules it. The
  command refuses v1, which has no window and whose chains therefore cannot be
  pruned without changing output.
