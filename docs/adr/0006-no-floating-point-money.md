# ADR-0006 - Numeric precision: never a floating-point number

- **Status:** accepted
- **Date:** 2026-08-29
- **Deciders:** @HugoB07

## Context

JavaScript's `number` is an IEEE-754 double. It cannot represent `0.1` exactly, so
`0.1 + 0.2 === 0.30000000000000004`. This was confirmed on the project's own database
rather than taken on trust:

```sql
select 0.1::numeric  + 0.2::numeric  = 0.3::numeric;   -- true
select 0.1::float8   + 0.2::float8   = 0.3::float8;    -- false
```

A single cent of drift is not a rounding curiosity in this product. Altitude reconciles
against bank statements, computes cost basis across thousands of lots, and enforces a
ledger invariant that entries sum to _exactly_ zero (ADR-0002). Under floating point that
invariant is unenforceable: a transaction that should balance would fail by 1e-17.

Crypto makes it worse. A `number` holds about 15-17 significant decimal digits; a wei
amount needs 18 decimal places on top of an integer part.

## Decision

**No floating-point number ever holds a monetary amount, a quantity, a price or a rate.**

| Layer                         | Representation                                         |
| ----------------------------- | ------------------------------------------------------ |
| PostgreSQL - amounts          | `numeric(28,10)`                                       |
| PostgreSQL - quantities       | `numeric(38,18)`                                       |
| PostgreSQL - prices, FX rates | `numeric(24,12)`                                       |
| TypeScript                    | `Decimal` from `decimal.js`, wrapped in a `Money` type |
| JSON, HTTP, forms             | **strings** - never `number`                           |

Three supporting rules:

1. **`Money` carries its currency.** Adding two different currencies is a type error where
   the currencies are statically known, and throws where they are not. There is no
   implicit conversion; crossing currencies requires an explicit, dated rate.
2. **No rounding inside arithmetic.** Full precision is kept throughout the computation;
   rounding happens only at a display or persistence boundary, and the mode is stated
   there. Rounding early and often is how you get results that disagree by a cent
   depending on which order the sums ran.
3. **`decimal.js` is configured once**, in one module, with 40 significant digits and
   half-even rounding. No file may construct its own `Decimal` constructor.

Drizzle already maps `numeric` to `string`, so the boundary is naturally string-shaped.
That is a property to preserve, not to work around: no `parseFloat`, no `Number()`, no
`+value` on anything monetary.

## Alternatives considered

| Option                                  | Why it was rejected                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integer minor units (cents as `bigint`) | Exact and fast, and it works for fiat. It breaks on crypto's 18 decimals and on unit prices like 0.0001234, and every currency needs its own exponent. `Decimal` covers both cases with one representation. |
| `number` with rounding at the edges     | The drift is real before you reach the edge. Summing 10,000 transactions accumulates error faster than any edge rounding can absorb.                                                                        |
| Native `BigInt` with a fixed scale      | Effectively reimplementing decimal arithmetic, including division and rounding modes, with no upside over a library that already does it.                                                                   |
| `dinero.js`                             | Good library, but minor-unit based, so it inherits the crypto limitation above.                                                                                                                             |

## Consequences

**Easier.** The ledger invariant is exactly checkable. Reconciliation against a statement
either matches or does not, with no epsilon comparison. Property-based tests can assert
exact equality rather than approximate.

**Harder.** Arithmetic is method calls, not operators: `a.plus(b)` rather than `a + b`.
Every value crossing a boundary needs a conscious conversion. Contributors will
instinctively reach for `number`, so an ESLint rule and code review have to catch it.
`Decimal` allocates more than a `number` - irrelevant at this scale, and measured before
it becomes a concern rather than assumed.

**Accepted.** Some arithmetic reads more verbosely than it would with operators. That is
the price of numbers that are right.

## Revisit if

The TC39 decimal proposal reaches Stage 4 and ships in Node's baseline. At that point the
`Money` wrapper stays and only its internals change - which is the reason for wrapping
`Decimal` rather than passing it around directly.
