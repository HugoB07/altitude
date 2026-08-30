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

| #    | Decision                                               | Written when         |
| ---- | ------------------------------------------------------ | -------------------- |
| 0003 | Owners are distinct from users, and members are scoped | phase 4 (household)  |
| 0004 | Bank connectors: external, optional, off by default    | phase 7 (connectors) |
| 0008 | Valued history: materialised daily snapshots           | phase 3 (history)    |

0008 was reserved for phase 1 and has moved to phase 3, deliberately. Phase 1 shipped
without it because a balance derived from the ledger is fast enough on its own: measured
on a million transactions, the dashboard reads in around half a second, and a household
the plan actually sizes for (ADR-0001) is two orders of magnitude smaller than that.

What will force it is history, not the current balance. A net worth chart over a year
means computing that figure at 365 dates, and half a second each is three minutes. That
is the point at which storing balances stops being an optimisation and becomes the only
way the feature exists - and it is also the point at which the shape of what to store is
known. A cache written before its queries is a cache written twice.
