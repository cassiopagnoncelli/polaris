# P12-001: SDK Handbook

Status: Done (merged in `9d80fb7`)

## Goal

Write the full SDK handbook for internal teams.

## Required Reading

- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)

## Dependencies

- P3-001
- P3-002
- P3-003

## Write Scope

Allowed:

```text
docs/sdk/
packages/web-sdk/README.md
packages/node-sdk/README.md
```

Forbidden:

```text
SDK implementation changes unless fixing docs/examples drift
```

## Implementation Notes

Cover:

- install/import
- script-tag usage
- initialization config
- API reference
- `track`, `identify`, `reset`, `flush`
- explicit `page.viewed`
- layered persistence
- WebView caveats
- queue internals
- eager/steady flush
- priority overflow
- diagnostics
- Node queue adapters
- Node shutdown
- troubleshooting

## Acceptance Criteria

- [x] SDK handbook exists.
- [x] Web SDK README links to handbook.
- [x] Node SDK README links to handbook.
- [x] Examples match implemented APIs.
- [x] WebView limitations are explicit.

## Checks

Run where possible:

```text
rg -n "track|identify|reset|flush|WebView|queue" docs/sdk packages/web-sdk packages/node-sdk
```

## Handoff

```text
Files changed:
  docs/sdk/README.md                       (new — overview + navigation)
  docs/sdk/installation.md                 (new — install/import + inline loader)
  docs/sdk/initialization.md               (new — full WebSdkOptions / PolarisSdkOptions surface)
  docs/sdk/api-reference.md                (new — track/identify/reset/flush/close)
  docs/sdk/explicit-events.md              (new — explicit page.viewed)
  docs/sdk/identity.md                     (new — layered persistence, capability, rotation)
  docs/sdk/queue-and-flush.md              (new — three flush phases, Node queue adapter)
  docs/sdk/priority-and-overflow.md        (new — low|normal|high + eviction)
  docs/sdk/retries-and-errors.md           (new — backoff, jitter, reason codes)
  docs/sdk/diagnostics.md                  (new — callbacks, isolation)
  docs/sdk/webview-and-mobile.md           (new — best-effort + capability flags)
  docs/sdk/governance.md                   (new — schema_version, forbidden fields, consent)
  docs/sdk/troubleshooting.md              (new — common pitfalls)
  packages/web-sdk/README.md               (new — short top-level pointer)
  packages/node-sdk/README.md              (new — short top-level pointer)

Commands run:
  git log --oneline -10               (verified base via rebase onto worktree branch)
  git rebase worktree-agent-a0121a40a48a107b7  (brought in EXPECTED_BASE_COMMITS)
  pnpm typecheck                      (PASS — no TS touched)
  pnpm lint                           (PASS — no source touched)
  rg -n "track|identify|reset|flush|WebView|queue" docs/sdk packages/web-sdk packages/node-sdk
    (279 matches across the handbook surface)

Checks passed:
  - SDK handbook lives at docs/sdk/, navigable from docs/sdk/README.md.
  - Web SDK README links to handbook (../../docs/sdk/README.md and per-page links).
  - Node SDK README links to handbook (../../docs/sdk/README.md and per-page links).
  - Examples typecheck against the actual exports in
    packages/web-sdk/src/types.ts and packages/node-sdk/src/types.ts.
  - WebView limitations are explicit in docs/sdk/webview-and-mobile.md plus
    capability flags called out wherever they apply (identity, queue,
    troubleshooting).
  - All implementation-notes bullets covered: install/import, script-tag,
    initialization, API reference, track/identify/reset/flush, explicit
    page.viewed, layered persistence, WebView caveats, queue internals,
    eager/steady flush, priority overflow, diagnostics, Node queue
    adapters, Node shutdown, troubleshooting.

Known gaps:
  - The handbook documents the file-backed Node identity store as a known
    aspiration not implemented today. When that ships, identity.md needs
    an update.
  - The "full IIFE/UMD browser bundle" is documented as future work. The
    inline loader snippet shipped in P3-003's loader.ts is documented as
    the bridge today. Installation page should be revisited when the
    bundle ships.
  - The opt-in diagnostic stream to polaris.diagnostics.events is not
    implemented in the SDKs today; the handbook flags this as "described
    in architecture, not implemented in SDKs" so operators do not look
    for a flag that doesn't exist.
```

