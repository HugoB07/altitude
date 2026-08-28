# ADR-0002 — Double-entry ledger, derived positions

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** @HugoB07

## Context

The obvious data model for a finance app is a flat table: `transactions(account_id, date,
amount, description)`. It survives exactly one account.

Four ordinary situations break it:

1. **Internal transfer.** €300 leaves the current account and arrives in the brokerage
   account. A flat model records two rows and reports either +€300 or −€300 of net worth
   change. The correct answer is zero.
2. **Buying a security.** Cash decreases and a quantity appears. One `amount` column
   cannot represent both sides, so quantity ends up in a parallel table that must be kept
   in sync by application code — and eventually is not.
3. **Foreign dividend.** $120 gross, $18 withheld, $102 credited. Three facts. A flat
   model stores the one the importer happened to see and silently loses the tax.
4. **Loan instalment.** €780 leaves the account, €620 reduces the debt, €160 is an
   expense. Recording only the €780 makes the outstanding principal drift from reality.

Each is patchable with a special-case flag. Together they produce a model where every
report needs to know every flag, and where no single query can be trusted.

## Decision

**Every transaction is a set of entries whose amounts sum to zero, per currency.**

```
transactions (id, booked_on, kind, description, source, …)
entries      (transaction_id, account_id, amount, currency,
              instrument_id?, quantity?, unit_price?, fx_rate_to_base?)
```

Three rules follow, and they are not negotiable:

1. **Balance is enforced by the database**, not by application code — a deferred
   constraint trigger checks `sum(amount) = 0` per currency at `COMMIT`. Deferral is what
   makes it usable: entries are inserted one at a time, and only the completed
   transaction is judged.
2. **The ledger is immutable.** A posted transaction is never edited in place; it is
   reversed by a new transaction linked through `reverses_id`. This is what makes an
   import undoable and an audit trail meaningful.
3. **Positions and balances are derived.** `daily_balances` and `positions` are caches.
   Rebuilding them from the ledger must reproduce identical figures, and a CLI command
   does exactly that.

Users never see any of this. They pick an operation — buy, sell, dividend, transfer — and
a _recipe_ in `packages/core` generates the entries. The double-entry model is an
implementation guarantee, not an interface.

## Alternatives considered

| Option                                                | Why it was rejected                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flat `transactions(amount)` with a `transfer_pair_id` | Handles case 1 only. Cases 2–4 each need another flag, and reports must handle every combination.                                                                                                |
| Flat table + separate `holdings` table                | Splits truth across two tables with no invariant tying them together. They drift, and nothing detects it.                                                                                        |
| Event sourcing                                        | Correct and more general, but heavier: projections, versioning, replay tooling. Double-entry is a 500-year-old event log with a built-in invariant, and accountants already know how to read it. |

## Consequences

**Easier.** Net worth is one `SUM` and is right by construction. Multi-currency works
without special cases, because balance is checked per currency. Fees, taxes and
withholdings are first-class rather than lost. The core invariant is property-testable:
_any_ generated transaction balances, and replaying the ledger reproduces every balance.

**Harder.** Writing an entry is more work than inserting a row — hence the recipes.
Importers must map partial bank data into balanced transactions, which sometimes means
posting the counterpart to a suspense account rather than guessing. Contributors
unfamiliar with double-entry face a learning curve, so `ARCHITECTURE.md` must explain the
model before anything else.

**Accepted.** Roughly one extra week in phase 1 versus a flat model. That is the cheapest
week in the project: reversing this decision after real user data exists would mean
migrating every transaction ever recorded, with no reliable way to reconstruct the
missing sides.

## Revisit if

Nothing foreseeable. This is a foundational decision; if it turns out to be wrong, the
correct response is a new project, not a migration.
