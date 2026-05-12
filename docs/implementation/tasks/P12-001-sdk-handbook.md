# P12-001: SDK Handbook

Status: Ready

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

- [ ] SDK handbook exists.
- [ ] Web SDK README links to handbook.
- [ ] Node SDK README links to handbook.
- [ ] Examples match implemented APIs.
- [ ] WebView limitations are explicit.

## Checks

Run where possible:

```text
rg -n "track|identify|reset|flush|WebView|queue" docs/sdk packages/web-sdk packages/node-sdk
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

