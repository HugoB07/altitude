import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import {
  STATEMENT_ACCOUNT,
  STATEMENT_COUNTERPART,
  mappingFits,
  parseMapping,
  readMapped,
  readShape,
  type ColumnMapping,
} from '../src/index';

/**
 * A statement described rather than coded.
 *
 * The file below is shaped like a French bank export and holds invented
 * figures: an identification block on top, semicolons, a decimal comma, and
 * debit and credit in separate columns, both written positive. Every one of
 * those is a pitfall the plan lists (§8.3), and together they are what a
 * reader that assumed a comma-separated file with a header on line one would
 * make of a real statement: nothing at all.
 */
const STATEMENT = [
  'Releve de compte;;;',
  'Titulaire;M. Dupont;;',
  'IBAN;FR76 0000 0000 0000 0000 0000 000;;',
  ';;;',
  'Date;Libelle;Debit;Credit',
  '01/04/2026;Loyer avril;800,00;',
  '02/04/2026;Salaire;;2 500,00',
  '15/04/2026;Courses;45,20;',
  '30/04/2026;Interets;;1,06',
  '',
].join('\n');

const MAPPING: ColumnMapping = {
  columns: { bookedOn: 'Date', description: 'Libelle', debit: 'Debit', credit: 'Credit' },
  currency: 'EUR',
};

describe('readShape', () => {
  it('describes a file nobody has described yet', () => {
    const shape = readShape(STATEMENT);

    expect(shape.delimiter).toBe(';');
    // Past the identification block, which is four lines of it.
    expect(shape.headerRow).toBe(4);
    expect(shape.headers).toEqual(['Date', 'Libelle', 'Debit', 'Credit']);
    expect(shape.sample).toHaveLength(4);
  });

  it('works out the date order of the date column, and only that column', () => {
    const shape = readShape(STATEMENT);

    // 15 and 30 can only be days.
    expect(shape.dates['Date']).toEqual({ order: 'dmy', ambiguous: false });
    // The detector is not run over columns that hold no dates: an answer about
    // an amount column reads as an answer.
    expect(Object.keys(shape.dates)).toEqual(['Date']);
  });
});

describe('readMapped', () => {
  it('reads every row of a statement that breaks four rules at once', () => {
    const reading = readMapped(STATEMENT, MAPPING);

    expect(reading.problems).toEqual([]);
    expect(reading.candidates).toHaveLength(4);

    // The account the statement is about, and the outside world. Both are
    // bound on the preview: a statement never says where money came from.
    expect(reading.accounts).toEqual([STATEMENT_ACCOUNT]);
    expect(reading.counterparts).toEqual([STATEMENT_COUNTERPART]);
    expect(reading.securities).toEqual([]);
  });

  it('negates the debit column and leaves the credit alone', () => {
    const [rent, salary] = readMapped(STATEMENT, MAPPING).candidates;

    // Written 800,00 in the file, and money leaving the account.
    expect(rent?.entries[0]?.amount).toBe('-800');
    expect(rent?.kind).toBe('withdrawal');

    // A thousands space that is not a plain space, and a decimal comma.
    expect(salary?.entries[0]?.amount).toBe('2500');
    expect(salary?.kind).toBe('deposit');
  });

  it('balances every candidate, which is what the ledger will insist on', () => {
    for (const candidate of readMapped(STATEMENT, MAPPING).candidates) {
      const residual = candidate.entries.reduce((sum, e) => sum.plus(dec(e.amount)), dec('0'));
      expect(residual.toFixed()).toBe('0');
    }
  });

  it('points at the line of a row it cannot read, and reads the rest', () => {
    const broken = STATEMENT.replace('15/04/2026;Courses;45,20;', '31/02/2026;Courses;45,20;');
    const reading = readMapped(broken, MAPPING);

    // Three read, one reported - not four dropped, and not a whole file
    // refused for one bad date.
    expect(reading.candidates).toHaveLength(3);
    expect(reading.problems).toHaveLength(1);
    // Counting the junk block and the header, so it matches a spreadsheet.
    expect(reading.problems[0]?.line).toBe(8);
    expect(reading.problems[0]?.reason).toContain('31/02/2026');
  });

  it('says which column is missing rather than reading nonsense', () => {
    const reading = readMapped(STATEMENT, {
      columns: { bookedOn: 'Date', amount: 'Montant' },
      currency: 'EUR',
    });
    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('Montant');
  });

  it('refuses a row with no currency instead of assuming one', () => {
    const reading = readMapped(STATEMENT, { columns: MAPPING.columns });
    expect(reading.candidates).toEqual([]);
    expect(reading.problems).toHaveLength(4);
    expect(reading.problems[0]?.reason).toContain('currency');
  });

  it('carries the bank identifier when the file has one', () => {
    const withIds = [
      'Date;Libelle;Montant;Reference',
      '01/04/2026;Loyer;-800,00;REF-1',
      '02/04/2026;Salaire;2500,00;REF-2',
      '',
    ].join('\n');

    const reading = readMapped(withIds, {
      columns: {
        bookedOn: 'Date',
        description: 'Libelle',
        amount: 'Montant',
        externalId: 'Reference',
      },
      currency: 'EUR',
    });

    // What makes a second import of the same file add nothing.
    expect(reading.candidates.map((c) => c.externalId)).toEqual(['REF-1', 'REF-2']);
  });
});

describe('mappingFits', () => {
  it('recognises a file a mapping can read', () => {
    expect(mappingFits(STATEMENT, MAPPING)).toBe(true);
  });

  it('rejects one it cannot, without reading a row of it', () => {
    expect(mappingFits('a,b\n1,2', MAPPING)).toBe(false);
  });
});

describe('rows a statement lists but that did not happen', () => {
  /**
   * A card payment reverted, beside the one that went through.
   *
   * Both rows carry an amount and both are in the file. Imported, the reverted
   * one takes money out of an account it never left - and the balance is wrong
   * by exactly what a person was refunded. Reported from a real Revolut export.
   */
  const REVOLUT = [
    'Type,Date de debut,Description,Montant,Devise,Etat',
    'Paiement par carte,2026-08-24 13:12:06,Ile-de-France Mobilites,-2.55,EUR,RENVOYÉ',
    'Paiement par carte,2026-08-24 10:41:18,Ile-de-France Mobilites,-2.55,EUR,TERMINÉ',
    'Ajout de fonds,2026-08-22 07:32:08,Paiement envoye,10.00,EUR,TERMINÉ',
    '',
  ].join('\n');

  const MAPPED: ColumnMapping = {
    columns: {
      bookedOn: 'Date de debut',
      description: 'Description',
      amount: 'Montant',
      currency: 'Devise',
      status: 'Etat',
    },
    skipStatuses: ['RENVOYÉ'],
  };

  it('leaves the reverted row out, and says so', () => {
    const reading = readMapped(REVOLUT, MAPPED);

    expect(reading.candidates).toHaveLength(2);
    // Not a problem: nothing failed to be read. Kept apart so the screen can
    // say "one line left out because it was reverted" rather than reporting an
    // error about a file that is perfectly fine.
    expect(reading.problems).toEqual([]);
    expect(reading.skipped).toHaveLength(1);
    expect(reading.skipped[0]?.line).toBe(2);
    expect(reading.skipped[0]?.reason).toBe('RENVOYÉ');
  });

  it('matches a status without case or accents', () => {
    const reading = readMapped(REVOLUT, { ...MAPPED, skipStatuses: ['renvoye'] });
    expect(reading.skipped).toHaveLength(1);
  });

  it('imports a status nobody listed rather than dropping it', () => {
    // A keep-list would silently stop importing the day the bank adds a state.
    // Losing a movement is the failure this reader exists to avoid; an extra
    // one is visible and can be reversed.
    const reading = readMapped(REVOLUT, { ...MAPPED, skipStatuses: ['ANNULÉ'] });
    expect(reading.candidates).toHaveLength(3);
    expect(reading.skipped).toEqual([]);
  });

  it('offers the states the file actually contains', () => {
    const shape = readShape(REVOLUT);
    expect(shape.categories['Etat']).toEqual(['RENVOYÉ', 'TERMINÉ']);
    // Two rows share a description, so it is not a state - and a column with
    // one value everywhere is a constant, not a choice.
    expect(shape.categories['Montant']).toBeUndefined();
    expect(shape.categories['Devise']).toBeUndefined();
  });
});

describe('parseMapping', () => {
  /**
   * A mapping arrives from a browser and comes back out of a database, so it
   * is input in both directions. Unchecked, it produces a reader that indexes
   * every row by `undefined` and reports a perfectly good file as unreadable.
   */
  const valid = { columns: { bookedOn: 'Date', amount: 'Montant' } };

  it('accepts the smallest mapping that can read anything', () => {
    expect(parseMapping(valid)).toEqual({ columns: { bookedOn: 'Date', amount: 'Montant' } });
  });

  it('refuses anything that is not an object with columns', () => {
    for (const value of [null, undefined, 'Date', 42, [], {}, { columns: null }, { columns: 7 }]) {
      expect(parseMapping(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses a mapping with no date column', () => {
    expect(parseMapping({ columns: { amount: 'Montant' } })).toBeNull();
    // Present but blank is the same as absent: a select nobody touched.
    expect(parseMapping({ columns: { bookedOn: '   ', amount: 'Montant' } })).toBeNull();
    expect(parseMapping({ columns: { bookedOn: 7, amount: 'Montant' } })).toBeNull();
  });

  it('insists on one amount column or two, never both and never neither', () => {
    expect(parseMapping({ columns: { bookedOn: 'Date' } })).toBeNull();
    expect(parseMapping({ columns: { bookedOn: 'Date', debit: 'D' } })).toBeNull();
    expect(parseMapping({ columns: { bookedOn: 'Date', credit: 'C' } })).toBeNull();
    // Both shapes at once describes two different files.
    expect(
      parseMapping({ columns: { bookedOn: 'Date', amount: 'M', debit: 'D', credit: 'C' } }),
    ).toBeNull();

    expect(parseMapping({ columns: { bookedOn: 'Date', debit: 'D', credit: 'C' } })).toEqual({
      columns: { bookedOn: 'Date', debit: 'D', credit: 'C' },
    });
  });

  it('keeps the optional columns it is given, and drops the blank ones', () => {
    const parsed = parseMapping({
      columns: {
        ...valid.columns,
        description: 'Libelle',
        currency: 'Devise',
        externalId: 'Reference',
        status: 'Etat',
      },
    });
    expect(parsed?.columns.description).toBe('Libelle');
    expect(parsed?.columns.status).toBe('Etat');

    const blank = parseMapping({ columns: { ...valid.columns, description: '  ', status: '' } });
    expect(blank?.columns.description).toBeUndefined();
    expect(blank?.columns.status).toBeUndefined();
  });

  it('refuses a date order it does not know, and keeps one it does', () => {
    expect(parseMapping({ ...valid, dateOrder: 'sideways' })).toBeNull();
    expect(parseMapping({ ...valid, dateOrder: 'mdy' })?.dateOrder).toBe('mdy');
    expect(parseMapping(valid)?.dateOrder).toBeUndefined();
  });

  it('refuses a header row that is not a whole number', () => {
    expect(parseMapping({ ...valid, headerRow: 1.5 })).toBeNull();
    expect(parseMapping({ ...valid, headerRow: 'four' })).toBeNull();
    expect(parseMapping({ ...valid, headerRow: 4 })?.headerRow).toBe(4);
  });

  it('keeps only the statuses that are strings, and drops an empty list', () => {
    const parsed = parseMapping({ ...valid, skipStatuses: ['RENVOYÉ', '', 7, null, 'ANNULÉ'] });
    expect(parsed?.skipStatuses).toEqual(['RENVOYÉ', 'ANNULÉ']);

    expect(parseMapping({ ...valid, skipStatuses: [] })?.skipStatuses).toBeUndefined();
    expect(parseMapping({ ...valid, skipStatuses: 'RENVOYÉ' })?.skipStatuses).toBeUndefined();
  });

  it('drops a blank currency rather than storing one', () => {
    expect(parseMapping({ ...valid, currency: '  ' })?.currency).toBeUndefined();
    expect(parseMapping({ ...valid, currency: 'CHF' })?.currency).toBe('CHF');
  });

  it('keeps a delimiter, for a file that defeats the sniffer', () => {
    expect(parseMapping({ ...valid, delimiter: '|' })?.delimiter).toBe('|');
    expect(parseMapping({ ...valid, delimiter: 7 })?.delimiter).toBeUndefined();
  });
});

describe('a mapping that overrides what would be detected', () => {
  const PIPED = ['ignore me', 'Date|Montant', '01/04/2026|-800,00', ''].join('\n');

  it('uses the delimiter and header row it is given', () => {
    const reading = readMapped(PIPED, {
      columns: { bookedOn: 'Date', amount: 'Montant' },
      currency: 'EUR',
      delimiter: '|',
      headerRow: 1,
    });
    expect(reading.problems).toEqual([]);
    expect(reading.candidates).toHaveLength(1);
    expect(reading.candidates[0]?.entries[0]?.amount).toBe('-800');
  });

  it('uses the date order it is given rather than the one it would find', () => {
    // Nothing in a one-row column settles it, so without this the default
    // would apply and read the fourth of January.
    const reading = readMapped(PIPED, {
      columns: { bookedOn: 'Date', amount: 'Montant' },
      currency: 'EUR',
      delimiter: '|',
      headerRow: 1,
      dateOrder: 'mdy',
    });
    expect(reading.candidates[0]?.bookedOn).toBe('2026-01-04');
  });

  it('takes the currency from a column when the file has one', () => {
    const mixed = ['Date;Montant;Devise', '01/04/2026;-800,00;CHF', ''].join('\n');
    const reading = readMapped(mixed, {
      columns: { bookedOn: 'Date', amount: 'Montant', currency: 'Devise' },
    });
    expect(reading.candidates[0]?.entries[0]?.currency).toBe('CHF');
  });

  it('reports a row whose amount cannot be read, and keeps the others', () => {
    const broken = ['Date;Montant', '01/04/2026;n/a', '02/04/2026;-12,00', ''].join('\n');
    const reading = readMapped(broken, {
      columns: { bookedOn: 'Date', amount: 'Montant' },
      currency: 'EUR',
    });
    expect(reading.candidates).toHaveLength(1);
    expect(reading.problems[0]?.reason).toContain('amount');
  });
});
