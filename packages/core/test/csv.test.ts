import { describe, expect, it } from 'vitest';
import { parseDelimited, parseRecords } from '../src/import/csv';

/**
 * The cases that actually appear in bank exports.
 *
 * Every one of these came from looking at a real file rather than from the
 * specification: continental Europe uses `;` because the comma is a decimal
 * separator, Excel writes a byte order mark, and a description field will
 * eventually contain a quote or a line break because somebody typed one into a
 * payment reference.
 */

describe('parseDelimited', () => {
  it('splits on the delimiter it is given', () => {
    expect(parseDelimited('a,b,c')).toEqual([['a', 'b', 'c']]);
    expect(parseDelimited('a;b;c', ';')).toEqual([['a', 'b', 'c']]);
  });

  it('keeps a delimiter that is inside quotes', () => {
    // "Paiement CB, Carrefour" is one field, not two.
    expect(parseDelimited('a;"Paiement CB, Carrefour";c', ';')).toEqual([
      ['a', 'Paiement CB, Carrefour', 'c'],
    ]);
    expect(parseDelimited('"a;b";c', ';')).toEqual([['a;b', 'c']]);
  });

  it('keeps a newline that is inside quotes', () => {
    expect(parseDelimited('a,"line one\nline two",c')).toEqual([['a', 'line one\nline two', 'c']]);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(parseDelimited('a,"say ""hello""",c')).toEqual([['a', 'say "hello"', 'c']]);
  });

  it('accepts CRLF, LF, and both in one file', () => {
    expect(parseDelimited('a,b\r\nc,d\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('strips a byte order mark rather than making it part of a column name', () => {
    // Excel writes one. Without this, the first header is "﻿date" and
    // every lookup by name silently misses.
    const rows = parseDelimited('﻿date;amount', ';');
    expect(rows[0]?.[0]).toBe('date');
  });

  it('does not invent a row for the newline at the end of a file', () => {
    expect(parseDelimited('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a last line that has no newline after it', () => {
    expect(parseDelimited('a,b\nc,d')).toHaveLength(2);
  });

  it('keeps empty fields, including trailing ones', () => {
    // Trade Republic ends most rows with several empty columns, and losing them
    // shifts every field after the first gap.
    expect(parseDelimited('a;;c;;', ';')).toEqual([['a', '', 'c', '', '']]);
  });
});

describe('parseRecords', () => {
  const file = [
    'date;amount;description',
    '01/05/2026;0.73;Interest',
    '18/05/2026;-39.82;Buy',
  ].join('\n');

  it('keys each row by the header', () => {
    const { header, records } = parseRecords(file, ';');
    expect(header).toEqual(['date', 'amount', 'description']);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ date: '01/05/2026', amount: '0.73', description: 'Interest' });
  });

  it('fills a short row with empty strings rather than undefined', () => {
    // Exporters routinely omit trailing empty columns. Two kinds of nothing is
    // one kind too many for every caller downstream.
    const { records } = parseRecords('a;b;c\n1;2', ';');
    expect(records[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('drops a blank final line', () => {
    const { records } = parseRecords(`${file}\n`, ';');
    expect(records).toHaveLength(2);
  });

  it('returns nothing for an empty file rather than throwing', () => {
    expect(parseRecords('', ';')).toEqual({ header: [], records: [] });
  });
});
