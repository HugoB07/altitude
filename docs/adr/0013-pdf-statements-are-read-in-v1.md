# ADR-0013 - PDF statements are read in v1, as a table inferred from a page

- **Status:** accepted
- **Date:** 2026-09-12
- **Deciders:** @HugoB07

## Context

The development plan defers PDF statements to v1.3 and gives its reasons in one line
(§8.1): "deliberately deferred: fragile extraction, high user expectations, poor
value-to-risk ratio until the rest is solid". Every word of that is true and none of it
has become less true.

What changed is what we learned about the files people actually hold. Import replaces
synchronisation in this product, so the formats it reads decide who can use it at all -
and several French banks, Crédit Agricole among them, publish a monthly statement as a
PDF and nothing else. No CSV, no OFX, no export of any kind behind any menu. For those
customers the alternative to a fragile reader is not a better format later; it is typing
their statement in by hand, every month, for as long as they keep the account.

The rest of the phase is also, by now, solid. CSV, XLSX, OFX, CAMT.053, MT940 and QIF all
land through one pipeline that ends in the same mapping screen, the same deduplication
and the same rollback. A seventh format is a seventh entrance to a corridor that already
exists, which is a much smaller thing to add than it was when the plan was written.

The word that carries the risk is "extraction". A PDF has no table in it. It has glyphs
at coordinates, and a table is something a human eye infers from how they line up. Any
reader has to infer the same thing, and it will sometimes infer wrongly.

## Decision

PDF is read in v1, and the inference is confined to one question: which rows and which
columns. Nothing about a PDF decides what a column **means**.

The reading is split in two. `packages/core/src/import/layout.ts` takes text at
coordinates and returns rows of cells - finding columns in the vertical whitespace
between them, choosing the block of the page densest in amounts as the table, joining a
heading set on two lines, and leaving out the letterhead above and the totals below. It
has no dependency and knows nothing about PDF. `apps/web/src/server/pdf.ts` is the
adapter: pdf.js at the application's edge, a coordinate flip, and the caps §8.7 asks for.

From the first row onwards the run is a CSV run. The same mapping screen names the
columns, the same preview shows every line and every problem, the same deduplication and
the same one-press rollback apply. A misread reaches a person as a table that looks wrong
on a screen they are already reading, before anything is written.

## Alternatives considered

| Option                                      | Why it was rejected                                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold to the plan and defer to v1.3          | The plan's argument is about risk to the product. This is a whole class of user with no other way in, and the risk it worried about is answered by where the inference stops rather than by waiting.                            |
| A reader per bank, extracting known regions | Accurate for the bank that wrote it and useless for every other, and it puts a bank's layout in code rather than in a preset. The gutter inference is bank-agnostic and produces something the mapping screen can already read. |
| Extract text in reading order, no geometry  | What every "pdf to text" library does, and it destroys the table: a right-aligned amount column becomes a word at the end of a sentence. Columns are the whole reason to read a statement.                                      |
| OCR, so scans work too                      | A different problem with a different failure mode - a misread digit rather than a misplaced column - and a much larger dependency. A scan is refused by name instead, and told apart from a file we cannot parse.               |

## Consequences

A Crédit Agricole customer can use Altitude. That is the point, and it is worth the rest
of this section.

The inference will be wrong on layouts nobody has seen. It is wrong visibly: the mapping
screen shows the reconstructed table, and a person who sees the branch address where the
first transaction should be knows immediately. It is not wrong silently, which is the
only kind that matters.

Every rule in `layout.ts` is a judgement about how statements are set, and judgements
drift. They are stated as constants with the reasoning attached, and covered by tests
that draw pages by hand - full pages, because where the columns are is a question about
how a page's ink is distributed and a fixture of two lines answers something true of
nothing.

pdf.js is a dependency the domain does not carry and the application does. It is loaded
the first time a PDF arrives rather than when the module is: a heavy optional dependency
gets to break the feature that uses it and nothing else. That line was drawn after it
failed to load under the application's bundle and took every other import down with it.

A PDF is closer to a program than to a document - font programs, an XFA forms engine,
scripts of its own - so it is also the largest attack surface in the repository. What is
switched off is named in `pdf.ts` rather than left at a default, and SECURITY.md says
which importers to look at first.

## Revisit if

A statement arrives whose table cannot be inferred at all - columns that do not align,
or a layout where the densest block of amounts is not the transactions. The answer then
is a preset that names regions rather than columns, which is a bigger idea than this one
and should get its own record.

Or if OCR becomes worth having, which is a decision about a different failure mode and
does not follow from this one.
