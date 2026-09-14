# Contributing to Altitude

Thanks for looking. This document says what is useful right now, what the conventions
are, and what will not be accepted - so nobody spends an evening on a pull request that
was never going to land.

## Current phase: phase 2, import

The ledger works and it can now fill itself. You can sign in, create a household, manage
accounts, record and reverse transactions, read a net worth that an internal transfer
does not inflate, and import a statement in any of seven formats - delimited text,
spreadsheets, OFX, CAMT.053, MT940, QIF and PDF - with duplicates flagged, categorisation
rules applied, and the whole run undoable in one press. It is in English and French, and
an end-to-end test walks that whole journey on every commit.

What is left of phase 2 is not code anybody can write from here: the import runs inside
the request rather than in a worker, a scanned PDF needs OCR, and the preset list is two
banks long because a preset needs a real file to test against. There is no market data
and no history either; those are phases 3 and after.

Contributions are welcome across the domain packages and the importer. Check the roadmap
in `README.md` before starting anything above them.

### What is useful today

- **Critique of the plan.** Read `docs/plan/` - particularly §5 (data model), §6
  (calculation engine) and §7 (bank synchronisation). If a modelling decision is wrong,
  now is when it is cheap to fix. Open a discussion, not a pull request.
- **Import presets.** The intended entry point, and the one that needs no TypeScript:
  a JSON file, a sample statement, and the application writes most of it for you. See
  [Adding a bank](#adding-a-bank).
- **Anonymised bank and broker export samples.** Every import preset needs a real-world
  file to test against, and no one person has an account at every bank. If you cannot
  write the preset yourself, the sample alone is worth sending. Read the anonymisation
  section below first - it is not optional.
- **ETF exposure data.** Country and sector breakdowns for widely held ETFs, with an
  as-of date and a cited source. This is what makes the geographic globe meaningful.
- **Prior art we have missed.** If an existing project already solved something well,
  say so. Borrowing beats reinventing.
- **Translation review.** The interface ships in English and French
  ([ADR-0010](docs/adr/0010-bilingual-from-the-first-screen.md)). What is checked
  mechanically is narrower than it sounds: `rule-set-messages.test.ts` holds the shipped
  rule sets to having a name in both catalogues, and nothing yet compares the two
  catalogues as a whole. They do agree - 436 keys each - by care rather than by guard.
  Whether the French reads like French is not checked at all. Corrections to
  `apps/web/messages/fr.json` are welcome, and a new language is one file plus one entry
  in `LOCALES`.

### What is useful once phase 2 closes

- Bug fixes, tests, documentation.
- Feature work that is already on the roadmap. Please claim the issue first.

## Ground rules

### Sign your commits off (DCO)

Altitude uses the [Developer Certificate of Origin](https://developercertificate.org/)
rather than a CLA. You keep your copyright; you certify you have the right to submit the
code. Add a sign-off line to every commit:

```bash
git commit -s -m "feat(importers): add preset for Bank X"
```

That appends `Signed-off-by: Your Name <your@email>`. Commits without it will be asked
to amend.

### Licence

Contributions are licensed under **AGPL-3.0-or-later**, like the rest of the project. If
you are contributing on behalf of an employer, make sure they are fine with that before
you start.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(importers): add BoursoBank current-account preset
fix(ledger): keep FX rate frozen when a transaction is edited
docs(plan): correct the PSD2 consent renewal period
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.
Explain **why** in the body when the reason is not obvious from the diff.

### Branches and pull requests

- Branch from `main`: `feat/short-description`, `fix/short-description`.
- One logical change per pull request. A 2,000-line PR touching six concerns will not
  get a useful review.
- Say what you changed and why. If it changes behaviour, say how you verified it.
- Green CI is required. So is one review.

## Anonymising financial data

**This matters more than anything else in this document.**

Import presets need real bank exports to test against, and real bank exports contain
your account number, your balance, your salary, your landlord's name and your grocery
habits. Once attached to an issue, that is public forever and cannot be recalled - a
private repository today can be made public tomorrow.

Before attaching any export file:

- [ ] Replace account numbers and IBANs with obvious fakes (`FR7630001007941234567890185`).
- [ ] Replace all amounts with invented ones. **Keep the format** - the decimal comma, the
      thousands separator, the parentheses for negatives - because the format is exactly
      what the parser is being tested on. The values themselves are irrelevant.
- [ ] Replace counterparty and merchant names, but keep their _shape_: if the bank writes
      `CARTE 12/03 CARREFOUR MARKET 3388`, keep the prefix, the embedded date and the
      trailing digits, because the preset's rules key off that structure.
- [ ] Remove your name, address, phone number, customer number and adviser's name.
- [ ] Cut the file down to 20-50 rows. A preset test does not need three years of history;
      it needs one example of each transaction shape.
- [ ] Keep the original encoding and line endings - CP1252 and CRLF are part of the test.
- [ ] Open the finished file and read it. Every line.

If you would not post it in a public forum, do not attach it. When in doubt, describe the
format in an issue and we will work out the fixture together.

## Adding a bank

A preset is data, not code (plan §8.4). It lives at
`packages/core/src/import/presets/<country>/<id>.json`, and adding one is four files and
no compiler.

1. **Describe your statement.** Import it through **Other bank** and name its columns.
   Most of the answers are filled in already: where the header is, what separates the
   fields, how the dates are written.
2. **Press "Contribute this bank"** once the preview reads correctly, give it a name and a
   two-letter country code, and copy what it shows. That file holds the names of your
   columns and nothing from inside your statement. Save it at the path the dialog names.
3. **Add a sample** at `packages/core/test/presets/<id>.sample.csv`, anonymised against
   the checklist above. Twenty rows is plenty: one of each shape is the point.
4. **Run `pnpm test`.** The first run writes `packages/core/test/presets/<id>.expected.json`,
   which is what your preset reads out of your sample. Read it line by line before you
   commit it: it is the assertion, and a wrong one locks in a wrong reading. The same run
   tells you the single line to add to `FILES` in
   `packages/core/src/import/presets/index.ts`, and refuses anything the loader would
   refuse: an unknown field, an id that is not kebab-case, a mapping with no date column.

A spreadsheet works the same way as a CSV. It is turned into delimited text before
anything reads it, so what you describe and contribute is the columns, not the file format.

So does a PDF, with one step before it. A PDF has no table in it, only text at
coordinates, so the table is reconstructed from where the ink falls - the block of the page
densest in amounts, with the letterhead above it and the totals below it left out. What you
then describe is the columns of that table, exactly as for a CSV. If a statement comes back
with the wrong block or the wrong columns, the useful bug report is an anonymised PDF: the
reconstruction is in `packages/core/src/import/layout.ts` and every rule in it is a
judgement about how statements are set.

A bank that exports OFX, CAMT.053, MT940 or QIF needs no preset at all. Those formats say
what every value is, so the file is read as it arrives and there is nothing to name or to
ship. If yours is one of them, the useful contribution is not a preset but a bug report
with an anonymised sample when something reads wrongly.

A bank whose export is not one row per movement needs more than a mapping. A broker that
splits one transfer across two rows, or carries an ISIN and a quantity, needs a reader in
`packages/core/src/import/`, and its preset names that reader instead of describing
columns. Open a discussion first: that half is not a drop-in file.

## Adding rules for a country

The same shape as a preset, and the second thing that needs no TypeScript. A country's
rule set is one file at `packages/core/src/categories/sets/<country>.json`, listing
patterns and what they file under.

The rules run after each household's own and only fill what those left empty, so nothing
in a set can overrule what somebody wrote about their own statements. They also cannot be
edited by the people who use them, only covered or switched off - which is why the bar is
higher here than for a rule you write for yourself. A rule you get wrong is wrong for one
person; a rule here is wrong for everybody at once, and none of them chose it.

What that means in practice:

- Anchor patterns on word boundaries. `TOTAL` matches "total des operations", and `FREE`
  matches an English sentence.
- Say what two rules would both claim, and order them. `UBER EATS` is a meal and `UBER` is
  a ride; the A7 toll is at Orange and the telephone company is not.
- Prefer naming a shop and filing nothing to filing it under a guess. A payment to a
  supermarket's bank is a loan for one household and an insurance premium for the next.
- Add both cases to `packages/core/test/sets.test.ts`: what the rule should claim, and the
  label it must leave alone. The second half is the one that catches an eager pattern.

Categories are named by key, from the closed list in `sets/schema.ts`, because the name is
written in the reader's language on the other side of the boundary. Adding a key means a
line there and a line in each message catalogue.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your version, and
your deployment method. Redact amounts and account identifiers - a screenshot with the
privacy mode enabled (`Ctrl/⌘ + Shift + H`) is usually enough.

**Security bugs do not go in the issue tracker.** See `SECURITY.md`.

## What will not be accepted

Saying this plainly saves everyone time. These are not judgements about the ideas; they
are consequences of what Altitude is, and the reasoning for each is in `docs/plan/`.

- **Bank scraping in the core.** No `woob` bridge, no headless-browser login, no storing
  bank passwords. It breaches bank terms of service, it breaks constantly, and it exposes
  users in a fraud dispute. The `Connector` interface is public: publish a scraper as a
  separate package if you want one. Reasoning in §7.5.
- **Bundled API credentials.** No aggregator or price-provider key ever enters the
  repository, not even a free-tier one, and not even in an example file.
- **Telemetry, analytics, or a phone-home update check enabled by default.** §13.2.
- **Third-party assets loaded at runtime** - CDN scripts, remote fonts, hosted icons. A
  disconnected instance must render perfectly.
- **Payment initiation.** Altitude reads; it never moves money.
- **Investment advice.** Projections are simulations and are labelled as such. Tax
  modules produce filing-assistance figures, never recommendations. No "you should buy"
  features, however they are framed.
- **Floating-point money.** `numeric` in the database, `decimal.js` in TypeScript, strings
  at JSON boundaries. A pull request introducing a `number` for an amount will be asked to
  change it. §ADR-006.
- **Business logic in a Server Action or a Route Handler.** Both call
  `packages/core/services`; neither implements anything. §ADR-005.
- **A default value for a secret.** No `process.env.X ?? 'something'`, in any form. A
  missing secret must throw and say which one. A test enforces this across the workspace.
- **User-visible English in `packages/shared` or `packages/core`.** Those packages return
  codes and identifiers; `apps/web` turns them into text. ADR-0010.
- **A dependency added without justification.** Especially in `packages/core`, which must
  keep working with no browser, no server and no network.

## Development setup

Requires Node 22 or later and Docker. pnpm arrives through corepack, so you do not
install it yourself:

```bash
corepack enable
pnpm install
cp .env.example .env.local                     # then fill in the secrets it asks for
pnpm db:up                                     # PostgreSQL 17 on 127.0.0.1:55432
pnpm --filter @altitude/db migrate
```

No variable that decides where the application connects or what it can decrypt has a
fallback value in the code. A missing one raises `MissingConfigurationError` at startup
and names itself, rather than quietly running with a default that would be wrong in
production. A setting with a genuine, non-secret default reads through `optionalEnv`
instead - there is one, the currency the first-run wizard offers. Which of the two a
variable is, `packages/shared/test/env.test.ts` enforces by walking the source.

Then the checks CI runs, which should all pass on a clean clone:

```bash
pnpm format:check   # prettier
pnpm lint           # boundaries (dependency-cruiser) and ESLint
pnpm db:check       # migration collisions
pnpm typecheck      # tsc --noEmit across every package
pnpm test           # vitest, including the property-based tests
pnpm build          # next build
pnpm test:e2e       # playwright, in a browser, against a real database
```

`pnpm test:e2e` builds the application, starts it on port 3100 so it never
fights a dev server on 3000, and runs one journey through it: sign up, create a
household, add an account, move money, read the number back. It needs Chromium
once (`pnpm --filter @altitude/web exec playwright install chromium`) and
`E2E_ADMIN_DATABASE_URL` from `.env.example` - a role that may CREATE DATABASE,
since it builds `altitude_e2e` from the migrations on every run and drops it
first. Your development database is never touched.

It exists because a function passed from a server component to a client one
compiled, typechecked, linted and built, then threw on the first render. Every
other check above passed it.

`pnpm lint` runs two different questions and reports them separately in CI:
`lint:boundaries` asks whether the architecture moved, `lint:code` whether the
code did. ESLint runs with `--max-warnings 0`, so a warning is a failure - an
unused local is a bug in the making, and `tsconfig.base.json` already takes the
same position.

`pnpm test:coverage` is `pnpm test:unit` with the thresholds turned on. They are
deliberately strict on `packages/core`: a gap in its coverage is a gap in the ledger
guarantee.

It is defined in terms of `test:unit` rather than repeating its list of paths, because
CI runs `test:coverage` and `test:db` rather than `pnpm test` and the two have to add up
to it. Written out twice, they did not: the copy in `test:coverage` was missing
`apps/web/test`, so nine guards - the client/server boundary among them - passed on a
clone and were never run by CI.

`pnpm dev` starts the application on <http://localhost:3000>. It follows your browser's
`Accept-Language`, so to see the French interface set French as your preferred language
rather than looking for a switcher - there is not one yet, and
[ADR-0010](docs/adr/0010-bilingual-from-the-first-screen.md) explains why.

The database tests spin up their own PostgreSQL through Testcontainers, so `pnpm test`
needs Docker running but not `pnpm db:up`.

The development plan builds separately, and needs a local Chrome:

```bash
cd docs/plan && node build-html.mjs && node build-pdf.mjs
```

## Getting in touch

Open a GitHub discussion for anything design-related, an issue for anything concrete.
Questions are welcome - an hour of discussion beats a week spent building the wrong
thing.
