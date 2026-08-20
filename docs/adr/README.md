# Architecture Decision Records

The load-bearing choices behind Polaris, one decision per file, in
[MADR](https://adr.github.io/madr/) format. `0000` records the practice
itself; [`TEMPLATE.md`](./TEMPLATE.md) is the starting point for a new one.

These lived in the gitignored `agents/architect/` workspace until
2026-08-19, which meant nobody with a clone of this repository could read
them — see [ADR-0006](./0006-publish-the-decision-records.md).

This index is hand-maintained and is appended in the same commit that
flips an ADR to `Accepted`, `Deprecated` or `Superseded`. It listed only
`0000` while `0001` through `0005` existed, so if you are adding a row,
add it now rather than after.

| ID | Title | Status | Date |
|------|-------|--------|------|
| 0000 | [Record architecture decisions](./0000-record-architecture-decisions.md) | Accepted | 2026-05-15 |
| 0001 | [Platform architecture decisions ledger](./0001-platform-architecture-ledger.md) | Accepted | 2026-05-12 |
| 0002 | [Engineering standards decisions ledger](./0002-engineering-standards-ledger.md) | Accepted | 2026-05-12 |
| 0003 | [SDK standards decisions ledger](./0003-sdk-standards-ledger.md) | Accepted | 2026-05-12 |
| 0004 | [Production readiness decisions ledger](./0004-production-readiness-ledger.md) | Accepted | 2026-05-12 |
| 0005 | [Externalise processor state stores, split by state shape](./0005-externalise-processor-state-stores.md) | Accepted | 2026-08-11 |
| 0006 | [Publish the decision records](./0006-publish-the-decision-records.md) | Accepted | 2026-08-19 |
| 0007 | [Restructure the repository around six object kinds](./0007-restructure-the-repository-around-six-object-kinds.md) | Accepted | 2026-08-20 |
