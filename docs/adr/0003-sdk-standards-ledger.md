---
id: 0003
title: SDK standards decisions ledger
status: Accepted
date: 2026-05-12
deciders: legacy
supersedes:
superseded_by:
---

## Context and Problem Statement

Polaris ships two first-party SDKs (Web and Node) plus future targets that will be pulled into the same shape. SDK behavior — surface area, identity, queueing, retry, lifecycle — has to be settled before any SDK code lands so the first SDK doesn't quietly set policy for the rest.

This ADR is the legacy SDK decision ledger from the first SDK pass, transplanted from `docs/adr/0003-sdk-decisions.md` into MADR shape. The SDK standards handbook (`docs/architecture/10-sdk-standards.md`) and the SDK reference docs (`docs/sdk/`) are the prose source of truth for how each decision plays out.

Maturity tier assumed: SMB.

## Decision Drivers

- SDKs must stay thin: transport, identity/session, delivery reliability, developer clarity. No enrichment, attribution, vendor logic, or schema governance in the SDK.
- SDK behavior is part of the data contract — once shipped to consumer apps, behavior changes are expensive.
- Identity persistence in the SDK becomes evidence quality for downstream identity resolution, so the storage layer is not just an implementation detail.
- Privacy posture (no third-party cookies, no fingerprinting) is a non-technical constraint that must hold across SDKs.

## Considered Options

- A single SDK ledger (this file) — many decisions per ADR, handbook alongside
- One MADR per SDK choice (~35 files) — full per-decision drivers/options
- No ledger; defer to per-SDK README

## Decision Outcome

Chosen: **SDK standards ledger transplanted as a single MADR**, preserving the original numbered list. The handbook and per-SDK reference docs explain the surface; this ADR is the citation surface for behavioral commitments.

The numbered SDK decisions:

1. Build Web SDK and Node SDK first.
2. Defer React, Ruby, and mobile SDKs.
3. SDK v1 exposes `track`, `identify`, `reset`, and `flush`.
4. `track()` works before `identify()` using anonymous/session identity.
5. No automatic page tracking by default.
6. Page views are explicit events, such as `page.viewed`.
7. Browser identity uses layered persistence: first-party cookie, localStorage mirror, sessionStorage fallback, memory fallback.
8. No third-party cookies.
9. No fingerprinting.
10. WebView and in-app browser support is important but best-effort.
11. SDK storage layer becomes identity evidence quality for downstream identity resolution.
12. Authoritative identity links require explicit overlap such as `anonymous_id + customer_id`.
13. Web SDK sessions rotate after 30 minutes of inactivity.
14. Campaign/click changes are captured as context and do not rotate sessions in the SDK.
15. SDKs validate basic envelope/client constraints only.
16. The ingester remains authoritative for event-specific schema validation.
17. Web SDK uses an offline-first lifecycle-aware event queue.
18. Web queue storage prefers IndexedDB, then localStorage, then memory.
19. First 15 seconds after SDK init use eager flush mode.
20. Steady mode flushes every 5 seconds by default.
21. Page-exit flush uses `sendBeacon` or `fetch` keepalive where appropriate.
22. Event IDs are preserved across retries.
23. Queue priority supports `low`, `normal`, and `high`; default is `normal`.
24. Queue overflow drops oldest low-priority events first, then normal, then high.
25. SDK diagnostics use callbacks and debug logging, not automatic diagnostic events in v1.
26. Web SDK supports modern evergreen browsers plus extended best-effort WebViews.
27. Web SDK ships as ESM npm package and script-tag browser bundle.
28. Script-tag installation uses an async loader with a pre-init command queue.
29. Node SDK uses memory queue by default.
30. Node SDK supports pluggable durable queue adapters.
31. Node SDK uses explicit `flush()`/`close()` lifecycle.
32. Node SDK does not register shutdown hooks unless explicitly configured.
33. `reset()` defaults to clearing `customer_id`, rotating `session_id`, and rotating `anonymous_id`.
34. `reset({ anonymous: false })` keeps anonymous identity while clearing customer and rotating session.
35. SDKs ship with a full SDK handbook from day one.

### Review Rule

SDKs must stay thin. Add ergonomics only when they improve transport, identity/session handling, delivery reliability, or developer clarity without moving enrichment, attribution, vendor logic, or schema governance into the SDK.

## Consequences

- Positive: SDK behavior is committed in writing before code lands, so the first SDK doesn't quietly set policy for the rest.
- Positive: identity, queueing, and lifecycle decisions are citeable when reviewing per-SDK PRs.
- Negative: each new SDK target (React, Ruby, mobile) must consciously adopt or supersede individual lines from this ledger; "follow the Web SDK" is not a complete spec.
- Follow-up: when a target SDK adopts a different default (e.g. mobile session rotation), open a per-decision MADR that supersedes the relevant line.
- Revisit if: the SDK surface gains a new verb (e.g. `group()`, `alias()`), or a privacy posture changes (e.g. browser deprecates a storage layer).

## Pros and Cons of the Options

_n/a_
