# Architecture Decision Records

One file per decision, written when the decision is made rather than reconstructed
afterwards. Copy [`0000-template.md`](0000-template.md) to start a new one.

An ADR is changed by pull request, never silently. A decision that turns out to be wrong
is not edited — a new ADR supersedes it, and the old one is marked accordingly, so the
reasoning that led there stays readable.

## Accepted

| #                                                | Decision                               | Date       |
| ------------------------------------------------ | -------------------------------------- | ---------- |
| [0001](0001-postgresql-as-the-only-datastore.md) | PostgreSQL as the only datastore       | 2026-08-28 |
| [0002](0002-double-entry-ledger.md)              | Double-entry ledger, derived positions | 2026-08-28 |

## Reserved

Numbering follows the development plan (`docs/plan/`, §3), so these numbers are taken
even before the files exist. They are written when the code that depends on them is
about to be built.

| #    | Decision                                                          | Written when         |
| ---- | ----------------------------------------------------------------- | -------------------- |
| 0003 | Owners are distinct from users                                    | phase 4 (household)  |
| 0004 | Bank connectors: external, optional, off by default               | phase 7 (connectors) |
| 0005 | Server Actions for internal mutations, Route Handlers for the API | phase 0, day 4       |
| 0006 | Numeric precision: never a floating-point number                  | phase 0, day 2       |
| 0007 | Multi-tenant isolation: two barriers                              | phase 0, day 3       |
| 0008 | Valued history: materialised daily snapshots                      | phase 1              |
