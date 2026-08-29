# Architecture Decision Records

One file per decision, written when the decision is made rather than reconstructed
afterwards. Copy [`0000-template.md`](0000-template.md) to start a new one.

An ADR is changed by pull request, never silently. A decision that turns out to be wrong
is not edited - a new ADR supersedes it, and the old one is marked accordingly, so the
reasoning that led there stays readable.

## Accepted

| #                                                   | Decision                                          | Date       |
| --------------------------------------------------- | ------------------------------------------------- | ---------- |
| [0001](0001-postgresql-as-the-only-datastore.md)    | PostgreSQL as the only datastore                  | 2026-08-28 |
| [0002](0002-double-entry-ledger.md)                 | Double-entry ledger, derived positions            | 2026-08-28 |
| [0005](0005-server-actions-and-route-handlers.md)   | Server Actions inside, Route Handlers outside     | 2026-08-30 |
| [0006](0006-no-floating-point-money.md)             | Numeric precision: never a floating-point number  | 2026-08-29 |
| [0007](0007-multi-tenant-isolation-two-barriers.md) | Multi-tenant isolation: two barriers              | 2026-08-30 |
| [0009](0009-next-16-and-typescript-6.md)            | Next.js 16 and TypeScript 6                       | 2026-08-29 |
| [0010](0010-bilingual-from-the-first-screen.md)     | Bilingual from the first screen, no locale in URL | 2026-08-29 |

## Reserved

Numbering follows the development plan (`docs/plan/`, §3), so these numbers are taken
even before the files exist. They are written when the code that depends on them is
about to be built.

| #    | Decision                                            | Written when         |
| ---- | --------------------------------------------------- | -------------------- |
| 0003 | Owners are distinct from users                      | phase 4 (household)  |
| 0004 | Bank connectors: external, optional, off by default | phase 7 (connectors) |
| 0008 | Valued history: materialised daily snapshots        | phase 1              |
