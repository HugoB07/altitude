import { describe, expect, it } from 'vitest';
import { decodeText } from '@altitude/shared';
import {
  detectDateOrder,
  endingIn,
  lastYear,
  findHeaderRow,
  fromDebitCredit,
  parseAmount,
  readDate,
} from '../src/index';

/**
 * The two pitfalls that corrupt data rather than refusing it.
 *
 * Both are listed in the plan (§8.3) as things to handle on day one, and both
 * share a property that makes them worth this much testing: they do not fail,
 * they produce a plausible wrong answer. A mangled accent is visible. An amount
 * read as a thousandth of itself is not.
 */

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('decodeText', () => {
  it('reads UTF-8 as UTF-8', () => {
    const { text, encoding } = decodeText(utf8('VIREMENT SÉPA'));
    expect(text).toBe('VIREMENT SÉPA');
    expect(encoding).toBe('utf-8');
  });

  it('strips a byte order mark, which Excel writes and a header name inherits', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('date;amount')]);
    const { text, hadBom } = decodeText(withBom);
    expect(hadBom).toBe(true);
    // Not `﻿date`, which compares equal to nothing and makes a preset
    // report that the file has no date column.
    expect(text.startsWith('date')).toBe(true);
  });

  it('reads CP1252 as CP1252 rather than replacing what it cannot decode', () => {
    // "VIREMENT SÉPA" as a French Windows writes it: É is a single byte 0xC9,
    // which is not a valid UTF-8 sequence.
    const cp1252 = new Uint8Array([...utf8('VIREMENT S'), 0xc9, ...utf8('PA')]);
    const { text, encoding } = decodeText(cp1252);

    expect(encoding).toBe('windows-1252');
    expect(text).toBe('VIREMENT SÉPA');
    // The failure this replaces. `file.text()` in a browser produces this and
    // there is no way back from it.
    expect(text).not.toContain('�');
  });

  it('keeps the euro sign, which is where CP1252 and Latin-1 disagree', () => {
    // 0x80 is the euro in CP1252 and a control character in ISO-8859-1.
    const { text } = decodeText(new Uint8Array([...utf8('Solde 12,34 '), 0x80]));
    expect(text).toBe('Solde 12,34 €');
  });
});

describe('parseAmount', () => {
  const value = (raw: string) => parseAmount(raw)?.value.toFixed() ?? null;

  it('reads a French amount, spaces and comma included', () => {
    expect(value('1 234,56')).toBe('1234.56');
    // A no-break space and a narrow no-break space, which is what a properly
    // typeset export actually contains.
    expect(value('1 234,56')).toBe('1234.56');
    expect(value('1 234,56')).toBe('1234.56');
  });

  it('reads an Anglo-Saxon amount without being told which it is', () => {
    expect(value('1,234.56')).toBe('1234.56');
    expect(value('1.234,56')).toBe('1234.56');
  });

  it('reads a lone three-digit group as thousands', () => {
    // Ambiguous by construction. Read as a decimal, a thousand euros becomes
    // one - which hides in a balance, where the reverse does not.
    expect(value('1,234')).toBe('1234');
    expect(value('1.234')).toBe('1234');
    // Two digits after the separator is not ambiguous.
    expect(value('1,23')).toBe('1.23');
  });

  it('reads parentheses as negative', () => {
    expect(value('(45.00)')).toBe('-45');
    expect(parseAmount('(45.00)')?.wasBracketed).toBe(true);
  });

  it('reads a sign written after the number', () => {
    expect(value('45,00-')).toBe('-45');
    expect(value('45,00+')).toBe('45');
  });

  it('ignores a currency written inside the cell', () => {
    expect(value('1 234,56 €')).toBe('1234.56');
    expect(value('-45.00 EUR')).toBe('-45');
  });

  it('refuses what is not a number rather than coercing it', () => {
    // The whole point. `Number('')` is 0 and `Number('n/a')` is NaN, and both
    // reach a ledger as a figure if nobody checks.
    for (const raw of ['', '   ', 'n/a', 'VIREMENT', '12-34-56']) {
      expect(parseAmount(raw), raw).toBeNull();
    }
  });
});

describe('fromDebitCredit', () => {
  const value = (debit: string, credit: string) =>
    fromDebitCredit(debit, credit)?.value.toFixed() ?? null;

  it('negates the debit, which the file writes as positive', () => {
    expect(value('45,00', '')).toBe('-45');
    expect(value('', '45,00')).toBe('45');
  });

  it('treats a zero in the unused column as unused', () => {
    expect(value('0,00', '45,00')).toBe('45');
    expect(value('45,00', '0,00')).toBe('-45');
  });

  it('refuses a row with two real figures rather than adding them', () => {
    expect(fromDebitCredit('45,00', '20,00')).toBeNull();
  });

  it('reads a debit already written negative as a debit, not as a credit', () => {
    // Some exports put the sign in as well as splitting the columns. Read
    // literally, the negation would turn it back into a credit.
    expect(value('-45,00', '')).toBe('-45');
  });
});

describe('findHeaderRow', () => {
  const rows = (...lines: string[][]) => lines;

  it('returns 0 for a file that starts with its header', () => {
    expect(findHeaderRow(rows(['date', 'label', 'amount'], ['01/04/2026', 'Rent', '-800']))).toBe(
      0,
    );
  });

  it('skips the identification block a bank puts on top', () => {
    // What a real export looks like: who, which account, which period, a blank
    // line, and then the table. Read as a header, "Releve de compte" becomes
    // the column names and every row below it is discarded.
    const found = findHeaderRow(
      rows(
        ['Releve de compte'],
        ['Titulaire', 'M. Dupont'],
        ['IBAN', 'FR76 0000 0000 0000'],
        [''],
        ['date', 'libelle', 'debit', 'credit'],
        ['01/04/2026', 'Loyer', '800,00', ''],
        ['02/04/2026', 'Salaire', '', '2500,00'],
        ['03/04/2026', 'Courses', '45,20', ''],
      ),
    );
    expect(found).toBe(4);
  });

  it('is not fooled by a two-column block that repeats', () => {
    // Three lines of label-and-value in a row look stable, and a header they
    // are not. Width is what tells them apart.
    const found = findHeaderRow(
      rows(
        ['Titulaire', 'M. Dupont'],
        ['IBAN', 'FR76'],
        ['Periode', 'avril'],
        ['date', 'libelle', 'montant'],
        ['01/04/2026', 'Loyer', '-800'],
        ['02/04/2026', 'Salaire', '2500'],
        ['03/04/2026', 'Courses', '-45'],
      ),
    );
    expect(found).toBe(3);
  });
});

describe('detectDateOrder', () => {
  it('settles the order on one value that can only be a day', () => {
    const { order, ambiguous } = detectDateOrder(['03/04/2026', '31/03/2026', '01/04/2026']);
    expect(order).toBe('dmy');
    expect(ambiguous).toBe(false);
  });

  it('settles it the other way when the second group is the one above twelve', () => {
    const { order, ambiguous } = detectDateOrder(['04/03/2026', '03/31/2026']);
    expect(order).toBe('mdy');
    expect(ambiguous).toBe(false);
  });

  it('says so when nothing in the column decides', () => {
    // Every value works both ways. A silent guess here moves transactions by
    // up to eleven months and looks perfectly normal afterwards.
    const { ambiguous } = detectDateOrder(['03/04/2026', '05/06/2026', '07/08/2026']);
    expect(ambiguous).toBe(true);
  });

  it('recognises ISO without ambiguity', () => {
    const { order, ambiguous } = detectDateOrder(['2026-04-03', '2026-03-31']);
    expect(order).toBe('ymd');
    expect(ambiguous).toBe(false);
  });
});

describe('readDate', () => {
  it('reads a value in the order the column was found to use', () => {
    expect(readDate('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(readDate('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(readDate('2026-04-03', 'ymd')).toBe('2026-04-03');
  });

  it('accepts the separators exports actually use', () => {
    expect(readDate('03.04.2026', 'dmy')).toBe('2026-04-03');
    expect(readDate('03-04-2026', 'dmy')).toBe('2026-04-03');
  });

  it('reads a two-digit year as this century', () => {
    expect(readDate('03/04/26', 'dmy')).toBe('2026-04-03');
  });

  it('refuses a day that does not exist rather than rolling it forward', () => {
    // 31 February read leniently becomes 3 March, which is a transaction on a
    // day it did not happen.
    expect(readDate('31/02/2026', 'dmy')).toBeNull();
    expect(readDate('nonsense', 'dmy')).toBeNull();
  });
});

describe('a date column with no year in it', () => {
  /**
   * What a French statement writes: `13.08`, with the year said once in the
   * letterhead - a block that is not part of the table and never reaches here.
   * Left unread, every row of the statement is a problem a person cannot fix.
   *
   * Today is passed in rather than taken from the clock, so these say something
   * on the day they are read as well as on the day they were written.
   */
  const august = ['13.08', '18.08', '22.08', '31.08'];

  it('reads the day and the month the way the column is written', () => {
    const column = detectDateOrder(august, '2026-09-03');

    expect(column.order).toBe('dmy');
    expect(column.ambiguous).toBe(false);
    expect(readDate('13.08', column.order, column.years)).toBe('2026-08-13');
  });

  it('takes the year the statement has already reached', () => {
    // A statement is of movements that have happened, so its last day is not in
    // the future. Read on 3 September 2026, an August column is 2026's.
    expect(detectDateOrder(august, '2026-09-03').years?.get('13.08')).toBe(2026);
  });

  it('takes last year when this year has not got there yet', () => {
    // Read in February, an August column cannot be this year's.
    expect(detectDateOrder(august, '2027-02-01').years?.get('13.08')).toBe(2026);
  });

  it('turns the year where the months turn', () => {
    // A statement that runs across New Year. December is the year before the
    // January under it, and one year for the column would move eleven months of
    // it by twelve.
    const across = ['28.12', '31.12', '02.01', '15.01'];
    const column = detectDateOrder(across, '2027-02-01');

    expect(readDate('28.12', column.order, column.years)).toBe('2026-12-28');
    expect(readDate('15.01', column.order, column.years)).toBe('2027-01-15');
  });

  it('refuses a bare day and month when no column decided the year', () => {
    // One value is not evidence of a year. A caller that did not ask the column
    // gets nothing rather than this year by default.
    expect(readDate('13.08', 'dmy')).toBeNull();
  });

  it('says nothing about the year when every value carries one', () => {
    expect(detectDateOrder(['13/08/2026', '18/08/2026'], '2026-09-03').years).toBeUndefined();
  });
});

describe('a year somebody chose rather than the one worked out', () => {
  /**
   * The inference is right for a statement imported within a year of its issue
   * and a year out for anything older, so the screen says which year it read and
   * offers this. What it must not do is flatten a column that crosses New Year:
   * the anchor moves, the shape does not.
   */
  const across = detectDateOrder(['28.12', '31.12', '02.01', '15.01'], '2027-02-01');

  it('moves the whole column, not one value', () => {
    const moved = endingIn(across.years!, 2024);

    expect(readDate('28.12', across.order, moved)).toBe('2023-12-28');
    expect(readDate('15.01', across.order, moved)).toBe('2024-01-15');
  });

  it('keeps December a year behind the January under it', () => {
    // The part that was never a guess. Sliding the anchor must not turn a
    // statement that ran across New Year into one that did not.
    const moved = endingIn(across.years!, 2024);

    expect(lastYear(moved)).toBe(2024);
    expect(new Set(moved.values())).toEqual(new Set([2023, 2024]));
  });

  it('is the year the column ends in, which is what a person is asked about', () => {
    expect(lastYear(across.years!)).toBe(2027);
  });

  it('changes nothing when it is the year already read', () => {
    expect(endingIn(across.years!, 2027)).toBe(across.years);
  });
});

describe('dates that carry a time', () => {
  /**
   * What a modern export writes, and what a matcher anchored at the end of the
   * string does not see.
   *
   * Read by one that required a bare date, a whole column stopped looking like
   * dates at all - so the screen asked whether 03/04 was March or April about a
   * file where every value said the year first. Reported from a real statement.
   */
  const WITH_TIME = ['2026-08-22 07:32:08', '2026-08-22 07:33:06', '2026-08-23 12:01:15'];

  it('recognises the column, and reads it as unambiguous', () => {
    const { order, ambiguous } = detectDateOrder(WITH_TIME);
    expect(order).toBe('ymd');
    expect(ambiguous).toBe(false);
  });

  it('reads the day and drops the time', () => {
    // The time is not kept. An accounting date is a calendar day, and an
    // instant late on the 31st is the 1st in half the world.
    expect(readDate('2026-08-22 07:32:08', 'ymd')).toBe('2026-08-22');
    expect(readDate('2026-08-22T07:32:08Z', 'ymd')).toBe('2026-08-22');
    expect(readDate('22/08/2026 07:32', 'dmy')).toBe('2026-08-22');
  });

  it('still refuses a value that is not a date at all', () => {
    expect(readDate('TERMINE 07:32', 'ymd')).toBeNull();
  });
});
