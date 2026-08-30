<div align="center">

# Altitude

**Open-source, self-hosted wealth tracking.**

A Finary alternative: bank accounts, brokerage, tax-advantaged wrappers, crypto,
real estate and liabilities - on your server, in your database.

[![CI](https://github.com/HugoB07/altitude/actions/workflows/ci.yml/badge.svg)](https://github.com/HugoB07/altitude/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-phase%200-orange.svg)](#roadmap)

</div>

---

> **⚠️ Status: phase 1, the ledger.** Sign in, create a household, manage accounts,
> record and reverse transactions, and read a net worth that internal transfers do not
> inflate. Everything is typed by hand: there is no import, no market data and no
> history yet, so it is a correct ledger rather than a wealth tracker. See the
> [roadmap](#roadmap).

## Why

A wealth tracker sees everything: your accounts, your positions, your property, your
debt. That data does not belong on someone else's server. Altitude is built to run
entirely on your own machine - database included - with a complete, re-importable
export from day one. No lock-in, no telemetry, no outbound call you did not configure.

## Planned features

- **Multi-asset** - cash, securities, crypto, real estate, loans, private equity, valuables.
- **Double-entry ledger** - internal transfers never inflate net worth, and multi-currency is correct by construction.
- **Import first** - CSV, XLSX, OFX, QIF and CAMT.053, with per-bank and per-broker presets.
- **Multi-owner households** - ownership shares, undivided estates, holding companies, and real child portfolios.
- **Named performance** - TWR and MWR shown side by side, never an anonymous percentage.
- **True geographic exposure** - ETF look-through, visualised on a globe.
- **Optional bank sync** - off by default, no credentials ever committed. [Why](docs/plan/parts/07-synchro.html).
- **English and French** - both from the first screen, with dates and amounts formatted to match. [ADR-0010](docs/adr/0010-bilingual-from-the-first-screen.md).

## Stack

Next.js 16 (App Router) · TypeScript 6 · PostgreSQL 17 · Drizzle ORM · pg-boss ·
Better Auth · next-intl · Tailwind v4 · shadcn/ui + Magic UI · Docker Compose.

## Development plan

The full design document (56 pages) lives in [`docs/plan/`](docs/plan): architecture,
data model, calculation engine, bank-synchronisation analysis, security and roadmap.

```bash
cd docs/plan
node build-html.mjs && node build-pdf.mjs
```

## Roadmap

| Phase | Scope                                               | Status      |
| ----- | --------------------------------------------------- | ----------- |
| 0     | Foundations - monorepo, Docker, auth, schema        | done        |
| 1     | Ledger - accounts, transactions, net worth          | done        |
| 2     | Import - CSV/XLSX/OFX, presets, deduplication       | not started |
| 3     | Market data - quotes, FX, positions, TWR/MWR, globe | not started |
| 4     | Household - owners, roles, child portfolios         | not started |
| 5     | Real assets - property, loans, crypto               | not started |
| 6     | v1.0 polish - export, backup, docs                  | not started |

## Contributing

The domain core is open to contributions: `packages/shared` and `packages/core`. Also
useful, and needing no TypeScript: critique of the plan, anonymised bank export samples,
and ETF exposure data. Once the importer lands, the easiest entry point will be adding a
preset for your bank - a JSON file and a test fixture.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, especially the anonymisation checklist
before attaching any export file.

## Security

Found a vulnerability? Do not open a public issue - see [SECURITY.md](SECURITY.md).

## License

[GNU AGPL-3.0-or-later](LICENSE).

In plain terms: you may use, modify and redistribute Altitude freely. If you run a
modified version **as a network service**, you must publish its source. That is what
keeps community work in the community.
