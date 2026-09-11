import { describe, expect, it } from 'vitest';
import { readLayout, writeDelimited, type PlacedPage, type PlacedText } from '../src/index';

/**
 * A page of placed text, read back as a table.
 *
 * The whole of the PDF reader's judgement is here, and none of it needs a PDF:
 * what arrives from the library is glyphs at coordinates, so a page can be
 * drawn in a test with the coordinates a bank's would have. That is the point
 * of the split - the hard part is testable, and what is left at the
 * application's edge is an adapter.
 *
 * The pages below are *full* pages, forty-odd lines, and that is deliberate.
 * Where the columns are is a question about how a page's ink is distributed,
 * so a fixture of two lines asks it of a sample of two and answers something
 * true of nothing. Every early version of this file passed on two-line pages
 * and would have failed on a statement.
 *
 * Every figure is invented, and the layout is modelled on how a French
 * statement is set: a date at the left margin, a label beside it, and an amount
 * pushed against the right edge.
 */

/** Points per character at ten point type, near enough for a fixture. */
const CHAR = 5;
const HEIGHT = 10;
/** A4, in points. */
const WIDTH = 595;
const PAGE = 842;

/** `at` places a run's left edge; `to` places its right edge, as an amount column does. */
type Run =
  { readonly at: number; readonly text: string } | { readonly to: number; readonly text: string };
type Row = { readonly y?: number; readonly runs: readonly Run[] };

function draw(rows: readonly Row[], height = PAGE): PlacedPage {
  const items: PlacedText[] = [];

  for (const [index, row] of rows.entries()) {
    for (const run of row.runs) {
      const width = run.text.length * CHAR;
      items.push({
        text: run.text,
        x: 'at' in run ? run.at : run.to - width,
        y: row.y ?? 130 + index * 14,
        width,
        height: HEIGHT,
      });
    }
  }

  return { items, width: WIDTH, height };
}

/** One statement line: date at 40, label at 110, amount against 540. */
function line(date: string, label: string, amount: string): Row {
  return {
    runs: [
      { at: 40, text: date },
      { at: 110, text: label },
      { to: 540, text: amount },
    ],
  };
}

/** Enough ordinary rows for the page's ink to say where its columns are. */
function body(count: number, label = 'CARTE INVENTE', amount = '-10,00'): Row[] {
  return Array.from({ length: count }, (_, at) =>
    line(`${String((at % 28) + 1).padStart(2, '0')}/01/2026`, label, amount),
  );
}

describe('a statement drawn in three columns', () => {
  const rows = readLayout([
    draw([
      line('Date', 'Libelle', 'Montant'),
      line('05/01/2026', 'CARTE SUPERMARCHE INVENTE', '-42,10'),
      line('28/01/2026', 'VIREMENT SALAIRE', '1 800,00'),
      line('31/01/2026', 'INTERETS', '0,73'),
      ...body(30),
    ]),
  ]);

  it('finds the three columns the page never declares', () => {
    expect(rows.every((row) => row.length === 3)).toBe(true);
  });

  it('puts each value where a reader would see it', () => {
    expect(rows[1]).toEqual(['05/01/2026', 'CARTE SUPERMARCHE INVENTE', '-42,10']);
    expect(rows[2]).toEqual(['28/01/2026', 'VIREMENT SALAIRE', '1 800,00']);
  });

  it('keeps amounts of different widths in one column', () => {
    // The claim that makes this worth doing. Amounts are set against the right
    // edge, so every amount of a different length starts at a different x -
    // and grouping by left edges, which is the obvious thing, puts these three
    // in three columns.
    expect(rows.slice(0, 4).map((row) => row[2])).toEqual([
      'Montant',
      '-42,10',
      '1 800,00',
      '0,73',
    ]);
  });
});

describe('the runs a page splits a word into', () => {
  /**
   * Both runs sit inside the label column, which exists because thirty other
   * rows write across it. That is the honest way to ask this question: on a
   * page of one line every gap is a gutter, and the answer would be about the
   * fixture rather than about the rule.
   */
  const among = (runs: readonly Run[]) =>
    readLayout([draw([{ runs: [{ at: 40, text: '05/01/2026' }, ...runs] }, ...body(30)])]);

  it('joins two that touch, rather than inventing a space', () => {
    // A PDF breaks a word wherever it likes - kerning, a font change - so
    // "CARREFOUR" arrives in two pieces about as often as whole. A space here
    // is how a categorisation rule stops matching a shop it matched last month.
    // A point apart rather than exactly touching, which is what kerning
    // actually produces - and which a threshold of nothing would turn into a
    // space while a fixture that abuts exactly would not.
    expect(
      among([
        { at: 110, text: 'CARRE' },
        { at: 136, text: 'FOUR' },
      ])[0]?.[1],
    ).toBe('CARREFOUR');
  });

  it('keeps a space the page actually left', () => {
    expect(
      among([
        { at: 110, text: 'CARTE' },
        { at: 142, text: 'INVENTE' },
      ])[0]?.[1],
    ).toBe('CARTE INVENTE');
  });
});

describe('a label that ran onto the next line', () => {
  it('goes back onto the row it belongs to', () => {
    // Left alone this is a row with no date, which the importer reports as a
    // problem - and half the label is lost with it.
    const rows = readLayout([
      draw([
        line('05/01/2026', 'PRLV ASSURANCE', '-63,40'),
        { runs: [{ at: 110, text: 'HABITATION INVENTEE' }] },
        line('06/01/2026', 'CARTE GARAGE', '-87,45'),
        ...body(30),
      ]),
    ]);

    expect(rows[0]).toEqual(['05/01/2026', 'PRLV ASSURANCE HABITATION INVENTEE', '-63,40']);
    expect(rows[1]?.[1]).toBe('CARTE GARAGE');
  });

  it('leaves a line that starts at the left margin alone', () => {
    // A row beginning where every other row begins is a new row, whatever else
    // is missing from it. Joining it would put a running total into the
    // description of the transaction above.
    const rows = readLayout([
      draw([
        line('05/01/2026', 'CARTE INVENTE', '-42,10'),
        { runs: [{ at: 40, text: 'SOLDE AU 31/01/2026' }] },
        ...body(30),
      ]),
    ]);

    expect(rows[0]?.[1]).toBe('CARTE INVENTE');
    expect(rows[1]?.[0]).toContain('SOLDE');
  });
});

describe('what a statement repeats on every sheet', () => {
  const head: Row = { y: 60, runs: [{ at: 40, text: 'BANQUE INVENTEE' }] };
  const foot = (n: number): Row => ({
    y: 800,
    runs: [{ at: 40, text: `Page ${String(n)} sur 2` }],
  });

  const rows = readLayout([
    draw([head, line('05/01/2026', 'CARTE PREMIERE', '-42,10'), ...body(30), foot(1)]),
    draw([head, line('28/01/2026', 'VIREMENT SALAIRE', '1 800,00'), ...body(30), foot(2)]),
  ]);

  it('drops the letterhead rather than turning it into a row with no date', () => {
    expect(rows.some((row) => row.join(' ').includes('BANQUE INVENTEE'))).toBe(false);
  });

  it('drops a page number, whose text differs on every page', () => {
    // "Page 1 sur 2" and "Page 2 sur 2" are the same line. Compared with their
    // digits blanked, which is the only way that is true.
    expect(rows.some((row) => row.join(' ').includes('Page'))).toBe(false);
  });

  it('keeps both sheets of transactions, in order', () => {
    expect(rows[0]).toEqual(['05/01/2026', 'CARTE PREMIERE', '-42,10']);
    expect(rows[31]).toEqual(['28/01/2026', 'VIREMENT SALAIRE', '1 800,00']);
  });

  it('gives every sheet the same columns', () => {
    // Computed across the whole document rather than per page. Per page, the
    // second sheet's boundaries would land a fraction elsewhere and its rows
    // would stop lining up with the first's.
    expect(new Set(rows.map((row) => row.length))).toEqual(new Set([3]));
  });
});

describe('a line that repeats but is not furniture', () => {
  it('survives, because two identical payments are two payments', () => {
    // §8.5 calls this the case everyone gets wrong, and it is met here as well
    // as at deduplication: two identical direct debits on one day are two
    // payments, and dropping the second to tidy up a repeated line takes money
    // out of a ledger. Which is why furniture has to be in a margin, on every
    // sheet, and carrying no amount before anything touches it.
    const repeated = line('05/01/2026', 'PRLV ABONNEMENT', '-9,99');

    const rows = readLayout([
      draw([repeated, repeated, ...body(30)]),
      draw([repeated, repeated, ...body(30)]),
    ]);

    expect(rows.filter((row) => row[1] === 'PRLV ABONNEMENT')).toHaveLength(4);
  });
});

describe('a transaction that lands in a margin', () => {
  it('survives even when the next sheet holds the same one', () => {
    // The bug this rule was written to stop, and the reason furniture has to
    // carry no amount. Blanking the digits is what lets "Page 1 sur 2" and
    // "Page 2 sur 2" be seen as one line - and it also makes January's
    // subscription identical to February's. Both near the top of their sheet,
    // both on every sheet: without the third condition, both vanish, and a
    // person is left looking for two direct debits with no idea where they went.
    const subscription: Row = {
      y: 70,
      runs: [
        { at: 40, text: '05/01/2026' },
        { at: 110, text: 'PRLV ABONNEMENT' },
        { to: 540, text: '-9,99' },
      ],
    };

    const rows = readLayout([draw([subscription, ...body(30)]), draw([subscription, ...body(30)])]);

    expect(rows.filter((row) => row[1] === 'PRLV ABONNEMENT')).toHaveLength(2);
  });
});

describe('the column heading a statement repeats on every sheet', () => {
  const heading: Row = {
    y: 60,
    runs: [
      { at: 40, text: 'Date' },
      { at: 110, text: 'Libelle' },
      { to: 540, text: 'Montant' },
    ],
  };

  it('is kept once, and dropped on every sheet after', () => {
    // Both halves matter. Kept, because it is the only place the bank says what
    // its columns are and the mapping screen reads a name from it. Once,
    // because the copies are rows with no date that the importer would report
    // as problems nobody can fix.
    const rows = readLayout([draw([heading, ...body(30)]), draw([heading, ...body(30)])]);

    expect(rows.filter((row) => row[0] === 'Date')).toHaveLength(1);
    expect(rows[0]).toEqual(['Date', 'Libelle', 'Montant']);
  });

  it('is kept on each sheet that has it when some sheet does not', () => {
    // Anything short of every sheet is the bank saying something on some of
    // them, and this does not get to decide it was decoration.
    const rows = readLayout([
      draw([heading, ...body(30)]),
      draw([heading, ...body(30)]),
      draw([...body(30)]),
    ]);

    expect(rows.filter((row) => row[0] === 'Date')).toHaveLength(2);
  });
});

describe('everything on a statement that is not the table', () => {
  /**
   * The case this was rebuilt for, and the shape a real Crédit Agricole
   * statement has: a page is not a table. It is a letterhead, a branch, a
   * reference block, an address, *then* the operations, each set in its own
   * shape. Read as one thing the blocks fight - the wide lines above run clean
   * across where the table's gutters are, and the first rows the mapping screen
   * gets offered are the account number and the branch.
   */
  const letterhead: Row[] = [
    { runs: [{ at: 40, text: 'BANQUE INVENTEE RELEVE DE COMPTES EN EUROS N 009' }] },
    { runs: [{ at: 40, text: '018931 CENTRE-EST Date d arrete : 03 Septembre 2026' }] },
    { runs: [{ at: 40, text: '0001' }] },
    { runs: [{ at: 40, text: '0002' }] },
    { runs: [{ at: 40, text: '000001' }] },
    { runs: [{ at: 40, text: 'Votre agence' }] },
    { runs: [{ at: 40, text: 'MADAME PRENOM INVENTEE' }] },
    { runs: [{ at: 40, text: '12 RUE DE NULLE PART QUI EXISTE' }] },
  ];

  const rows = readLayout([
    draw([
      ...letterhead,
      line('Date', 'Libelle des operations', 'Montant'),
      line('13/08/2026', 'CARTE X7094 BOULANGERIE INVENTEE', '-12,00'),
      ...body(40),
    ]),
  ]);

  it('leaves the letterhead out of the table', () => {
    expect(rows.some((row) => row.join(' ').includes('CENTRE-EST'))).toBe(false);
    expect(rows.some((row) => row.join(' ').includes('Votre agence'))).toBe(false);
    expect(rows.some((row) => row.join(' ').includes('NULLE PART'))).toBe(false);
  });

  it('keeps the column heading the table does have', () => {
    expect(rows[0]).toEqual(['Date', 'Libelle des operations', 'Montant']);
  });

  it('reads the operations with the columns the operations have', () => {
    expect(rows[1]).toEqual(['13/08/2026', 'CARTE X7094 BOULANGERIE INVENTEE', '-12,00']);
    expect(rows.filter((row) => row.filter((cell) => cell !== '').length === 3)).toHaveLength(42);
  });
});

describe('the totals a statement rules off under its movements', () => {
  /**
   * Carrying amounts, so the table finds them and is right to, and not one of
   * them a movement. Imported, they double a month's spending. Reported as
   * problems, they are lines a person is told to fix and cannot - which is what
   * they were: "Unreadable date" three times on every statement.
   */
  const rows = readLayout([
    draw([
      line('Date', 'Libelle des operations', 'Montant'),
      {
        runs: [
          { at: 110, text: 'Ancien solde crediteur au 03.08.2026' },
          { to: 540, text: '364,31' },
        ],
      },
      line('13/08/2026', 'CARTE BOULANGERIE INVENTEE', '-12,00'),
      ...body(40),
      {
        runs: [
          { at: 110, text: 'Total des operations' },
          { to: 540, text: '467,07' },
        ],
      },
      {
        runs: [
          { at: 110, text: 'Nouveau solde crediteur au 03.09.2026' },
          { to: 540, text: '253,34' },
        ],
      },
    ]),
  ]);

  it('leaves out a line that carries amounts and no date of its own', () => {
    expect(rows.some((row) => row.join(' ').includes('Total des operations'))).toBe(false);
    expect(rows.some((row) => row.join(' ').includes('Ancien solde'))).toBe(false);
    expect(rows.some((row) => row.join(' ').includes('Nouveau solde'))).toBe(false);
  });

  it('keeps every movement and the heading above them', () => {
    expect(rows[0]).toEqual(['Date', 'Libelle des operations', 'Montant']);
    expect(rows[1]).toEqual(['13/08/2026', 'CARTE BOULANGERIE INVENTEE', '-12,00']);
    expect(rows).toHaveLength(42);
  });

  it('drops nothing when the first column is not the dated one', () => {
    // A statement that puts its label first and its date second uses its first
    // column for text, and half of those cells are legitimately empty. Dropping
    // a row for that would be dropping the statement.
    const other = readLayout([
      draw([
        ...Array.from({ length: 20 }, () => ({
          runs: [
            { at: 110, text: 'CARTE INVENTE' },
            { to: 340, text: '-10,00' },
          ],
        })),
        ...Array.from({ length: 20 }, () => ({
          runs: [
            { at: 40, text: 'VIR INVENTE' },
            { at: 110, text: 'CARTE INVENTE' },
            { to: 340, text: '-10,00' },
          ],
        })),
      ]),
    ]);

    expect(other).toHaveLength(40);
  });
});

describe('a column heading set on two lines', () => {
  it('is kept whole, not halved', () => {
    // What a real statement does with a narrow column: "Date" on one line and
    // "opé." under it. Taking one line above the table keeps the second half
    // and loses the word that names the column.
    const rows = readLayout([
      draw([
        { runs: [{ at: 40, text: 'RELEVE DE COMPTE INVENTE' }] },
        {
          runs: [
            { at: 40, text: 'Date' },
            { at: 110, text: 'Libelle des' },
          ],
        },
        {
          runs: [
            { at: 40, text: 'ope.' },
            { at: 110, text: 'operations' },
            { to: 540, text: 'Montant' },
          ],
        },
        ...body(40),
      ]),
    ]);

    // One heading, not two rows - the second of which would be a payment whose
    // description is "ope." and whose date and amount are missing.
    expect(rows[0]).toEqual(['Date ope.', 'Libelle des operations', 'Montant']);
    expect(rows[1]?.[1]).toBe('CARTE INVENTE');
    expect(rows.some((row) => row.join(' ').includes('RELEVE DE COMPTE'))).toBe(false);
  });
});

describe('a value wider than the column it belongs to', () => {
  it('lands where most of it is, not where it starts', () => {
    // A total is set against the same right edge as every other amount and is
    // longer than all of them, so it begins on the wrong side of the boundary.
    // Placing a run by its left edge - the obvious thing - files the one figure
    // on the statement that matters most under the description beside it.
    const tight = (label: string, amount: string): Row => ({
      runs: [
        { at: 40, text: '05/01/2026' },
        { at: 110, text: label },
        { to: 340, text: amount },
      ],
    });

    const rows = readLayout([
      draw([
        tight('CARTE INVENTE ZONE COMMERCIALE NORD', '-42,10'),
        tight('TOTAL DES OPERATIONS DU MOIS INVENTE', '1 234 567,89'),
        ...Array.from({ length: 30 }, () => tight('CARTE INVENTE ZONE COMMERCIALE NORD', '-10,00')),
      ]),
    ]);

    expect(rows[1]?.[2]).toBe('1 234 567,89');
    expect(rows[1]?.[1]).toBe('TOTAL DES OPERATIONS DU MOIS INVENTE');
  });
});

describe('a page with nothing on it', () => {
  it('is no rows rather than one empty one', () => {
    expect(readLayout([])).toEqual([]);
    expect(readLayout([{ items: [], width: WIDTH, height: PAGE }])).toEqual([]);
  });
});

describe('writing the rows back out', () => {
  it('quotes what would otherwise be read as another column', () => {
    expect(writeDelimited([['a', 'b,c']])).toBe('a,"b,c"\n');
    expect(writeDelimited([['say "hi"']])).toBe('"say ""hi"""\n');
  });

  it('ends with a newline, so the last row is a row', () => {
    expect(writeDelimited([['a'], ['b']])).toBe('a\nb\n');
  });
});
