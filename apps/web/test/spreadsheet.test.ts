import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseDelimited, readShape } from '@altitude/core';
import { sniffBytes } from '@altitude/shared';
import { readSpreadsheet } from '../src/server/spreadsheet';

/**
 * A spreadsheet is a CSV with formatting on top, and this proves the "on top"
 * part comes off.
 *
 * The workbooks below are built rather than committed: a fixture would be a
 * binary blob nobody can read in a diff, and what is being tested is what Excel
 * puts in a cell - a date as a number, a formula with a cached result, a string
 * shared across the file - all of which ExcelJS writes the same way Excel does.
 *
 * Invented figures throughout. SECURITY.md and CONTRIBUTING are explicit that
 * real financial data never enters the repository.
 */
async function workbook(build: (book: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  build(book);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

/** A statement the way a bank exports one, with a junk row above the header. */
async function statement(): Promise<Uint8Array> {
  return workbook((book) => {
    const sheet = book.addWorksheet('Operations');
    sheet.addRow(['Releve du compte 00042424242']);
    sheet.addRow(['Date', 'Libelle', 'Debit', 'Credit', 'Solde']);

    const first = sheet.addRow([
      new Date(Date.UTC(2026, 0, 5)),
      'PRLV ASSURANCE',
      120.5,
      null,
      879.5,
    ]);
    first.getCell(1).numFmt = 'dd/mm/yyyy';

    const second = sheet.addRow([
      new Date(Date.UTC(2026, 0, 28)),
      'VIR SALAIRE',
      null,
      1800,
      2679.5,
    ]);
    second.getCell(1).numFmt = 'dd/mm/yyyy';
  });
}

describe('a workbook recognised from its first bytes', () => {
  it('is told apart from text, and from the format before it', async () => {
    expect(sniffBytes(await statement())).toBe('xlsx');
    expect(sniffBytes(new TextEncoder().encode('Date;Libelle\n01/05/2026;Loyer\n'))).toBeNull();

    // The pre-2007 binary format, recognised only so the message can say what
    // to do about it. Its first eight bytes are an OLE2 compound document.
    const legacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(sniffBytes(legacy)).toBe('legacy-excel');
  });
});

describe('turning a sheet into the text every reader already takes', () => {
  it('writes the rows as they sit in the sheet', async () => {
    const read = await readSpreadsheet(await statement());
    expect('reason' in read).toBe(false);
    if ('reason' in read) return;

    const rows = parseDelimited(read.text, ',');

    // The junk row is kept rather than stripped: `findHeaderRow` is what
    // decides where a statement starts, and it does it for every format.
    expect(rows[0]?.[0]).toBe('Releve du compte 00042424242');
    expect(rows[1]).toEqual(['Date', 'Libelle', 'Debit', 'Credit', 'Solde']);
    expect(rows[2]).toEqual(['2026-01-05', 'PRLV ASSURANCE', '120.5', '', '879.5']);
  });

  it('writes a date as a date, which is the trap the plan names', async () => {
    // "Excel dates are serial numbers: explicit conversion, a classic trap"
    // (§8.1). Written back as ISO, the date order is settled outright instead
    // of being guessed at or asked about.
    const read = await readSpreadsheet(await statement());
    if ('reason' in read) throw new Error(read.reason);

    const shape = readShape(read.text);
    expect(shape.dates['Date']).toEqual({ order: 'ymd', ambiguous: false });
    expect(shape.headers).toEqual(['Date', 'Libelle', 'Debit', 'Credit', 'Solde']);
  });

  it('keeps a time when the cell carries one', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Operations');
      sheet.addRow(['Date']);
      sheet.addRow([new Date(Date.UTC(2026, 0, 5, 13, 12, 6))]);
    });

    const read = await readSpreadsheet(bytes);
    if ('reason' in read) throw new Error(read.reason);

    expect(parseDelimited(read.text, ',')[1]?.[0]).toBe('2026-01-05 13:12:06');
  });

  it('takes what a formula shows rather than the formula', async () => {
    // A statement whose total is computed still reconciles against the number
    // a person read on screen.
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Operations');
      sheet.addRow(['Montant']);
      sheet.addRow([{ formula: 'SUM(B1:B3)', result: -42.1 }]);
    });

    const read = await readSpreadsheet(bytes);
    if ('reason' in read) throw new Error(read.reason);

    expect(parseDelimited(read.text, ',')[1]?.[0]).toBe('-42.1');
  });

  it('quotes a cell that would otherwise split its own row', async () => {
    // The conversion writes a delimiter into text that is read back by the same
    // parser, so a description holding a comma, a quote or a newline has to
    // survive the round trip - otherwise one cell becomes two columns.
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Operations');
      sheet.addRow(['Libelle', 'Montant']);
      sheet.addRow(['VIR "URGENT", 2 lignes\nsuite', -12.5]);
    });

    const read = await readSpreadsheet(bytes);
    if ('reason' in read) throw new Error(read.reason);

    expect(parseDelimited(read.text, ',')[1]).toEqual(['VIR "URGENT", 2 lignes\nsuite', '-12.5']);
  });
});

describe('choosing a sheet', () => {
  const many = async () =>
    workbook((book) => {
      // Deliberately first and empty: a cover sheet is common, and "the first
      // sheet" would read nothing at all.
      book.addWorksheet('Couverture');
      const one = book.addWorksheet('Janvier');
      one.addRow(['Date', 'Montant']);
      one.addRow([new Date(Date.UTC(2026, 0, 5)), -120.5]);
      const two = book.addWorksheet('Fevrier');
      two.addRow(['Date', 'Montant']);
      two.addRow([new Date(Date.UTC(2026, 1, 3)), -80]);
    });

  it('reads the first sheet that holds anything, and lists the others', async () => {
    const read = await readSpreadsheet(await many());
    if ('reason' in read) throw new Error(read.reason);

    expect(read.sheet).toBe('Janvier');
    expect(read.sheets).toEqual(['Janvier', 'Fevrier']);
    expect(read.text).toContain('2026-01-05');
  });

  it('reads the one it is asked for', async () => {
    const read = await readSpreadsheet(await many(), 'Fevrier');
    if ('reason' in read) throw new Error(read.reason);

    expect(read.sheet).toBe('Fevrier');
    expect(read.text).toContain('2026-02-03');
  });

  it('falls back rather than failing when the sheet is gone', async () => {
    const read = await readSpreadsheet(await many(), 'Mars');
    if ('reason' in read) throw new Error(read.reason);

    expect(read.sheet).toBe('Janvier');
  });
});

describe('a file that is not a workbook this can read', () => {
  it('refuses something that is not a zip at all', async () => {
    const read = await readSpreadsheet(new TextEncoder().encode('Date;Montant\n'));

    expect(read).toEqual({ reason: 'unreadable' });
  });

  it('refuses a zip that is not a workbook', async () => {
    // A real zip - the archive of this test's own statement, truncated to its
    // first entry - is a zip whose central directory no longer describes it.
    const read = await readSpreadsheet(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));

    expect(read).toEqual({ reason: 'unreadable' });
  });

  it('refuses a workbook with no rows anywhere', async () => {
    const read = await readSpreadsheet(
      await workbook((book) => {
        book.addWorksheet('Vide');
      }),
    );

    expect(read).toEqual({ reason: 'empty' });
  });
});
