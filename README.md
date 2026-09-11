<div align="center">

# Altitude

**Open-source, self-hosted wealth tracking.**

A Finary alternative: bank accounts, brokerage, tax-advantaged wrappers, crypto,
real estate and liabilities - on your server, in your database.

[![CI](https://github.com/HugoB07/altitude/actions/workflows/ci.yml/badge.svg)](https://github.com/HugoB07/altitude/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-phase%202%3A%20import-orange.svg)](#roadmap)

</div>

---

> **⚠️ Status: phase 2, import.** The ledger works: sign in, create a household,
> manage accounts, record and reverse transactions, and read a net worth that an internal
> transfer does not inflate. A statement now imports too - a preset for Trade Republic, any
> bank at all by naming the columns of its CSV or its spreadsheet on screen, and OFX,
> CAMT.053, MT940 or QIF with nothing named, since those four say what every value is -
> with duplicates flagged and the whole run undoable in one press. A PDF statement is
> read too, which several French banks offer and little else: a page of positioned text
> has its table found among the letterhead and the totals around it, and is then named on
> the same screen every CSV goes through.
>
> A bank is described once: the columns you named are kept and found again by the shape of
> the next file, so the following month asks nothing - and that description can be handed
> back as a preset file, which is how a bank described by one person ends up described for
> everybody. Where a statement carries its running balance, the file is read back against
> it - every row has to move the balance by its own amount - and its closing balance is
> compared with what your ledger will hold. Movements are filed by rules you write:
> ordered, readable, and traceable to one line, so "why is this in groceries" has an
> answer. A set of rules for France ships with Altitude and runs under your own, filling
> only what yours left empty, so a first import is not a blank slate. A rule can also name who was on the other side, the shop or the employer, and
> tag what cuts across categories: a week away is restaurants and fuel and a hotel, each
> keeping its own category. All three are filters in the transactions tab.
>
> What is missing from phase 2: a scanned PDF is still unreadable, since its pages are
> images and reading them needs OCR; two banks ship with a preset, because a preset needs a
> real file to test against and no one person has an account everywhere, so a first file
> from anywhere else is described by hand before it is described for good; and the import
> runs inside the request rather than in a worker, so a very large file will outlast its own
> timeout. There is no market data and no history at all - those are phase 3. See the
> [roadmap](#roadmap).

## Why

A wealth tracker sees everything: your accounts, your positions, your property, your
debt. That data does not belong on someone else's server. Altitude is built to run
entirely on your own machine - database included - with a complete, re-importable
export from day one. No lock-in, no telemetry, no outbound call you did not configure.

## Planned features

- **Multi-asset** - cash, securities, crypto, real estate, loans, private equity, valuables.
- **Double-entry ledger** - internal transfers never inflate net worth, and multi-currency is correct by construction.
- **Import first** - CSV, XLSX, PDF, OFX, QIF, CAMT.053 and MT940, with per-bank and per-broker presets.
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
| 2     | Import - CSV/XLSX/PDF/OFX/CAMT, presets, dedup      | in progress |
| 3     | Market data - quotes, FX, positions, TWR/MWR, globe | not started |
| 4     | Household - owners, roles, child portfolios         | not started |
| 5     | Real assets - property, loans, crypto               | not started |
| 6     | v1.0 polish - export, backup, docs                  | not started |

## Contributing

The domain core is open to contributions: `packages/shared` and `packages/core`. Also
useful, and needing no TypeScript: critique of the plan, anonymised bank export samples,
and ETF exposure data.

Adding a bank is the easiest entry point, and it needs no TypeScript. A preset is a JSON
file: import a statement through "Other bank", name its columns, and when the preview
reads correctly press "Contribute this bank". The screen writes the file and says where it
goes. Add an anonymised sample next to it, run the tests once to generate the reading they
assert against, read that reading line by line, and open a pull request.

The step-by-step is in [CONTRIBUTING.md](CONTRIBUTING.md), and so is the anonymisation
checklist. Read it before attaching any export file.

## Security

Found a vulnerability? Do not open a public issue - see [SECURITY.md](SECURITY.md).

## License

[GNU AGPL-3.0-or-later](LICENSE).

In plain terms: you may use, modify and redistribute Altitude freely. If you run a
modified version **as a network service**, you must publish its source. That is what
keeps community work in the community.
