import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import { looksLikeQif, readQif } from '../src/index';

/**
 * A QIF export, with invented figures.
 *
 * Written the way a French bank writes one: `DD/MM/YYYY`, a decimal comma and a
 * space for thousands. SECURITY.md and CONTRIBUTING are explicit that real
 * financial data never enters the repository.
 */
const BANK = `!Type:Bank
D05/01/2026
T-42,10
PCARTE 05/01 SUPERMARCHE INVENTE
^
D28/01/2026
T1 800,00
PVIREMENT SALAIRE
MReference PAY-2026-01
^
D31/01/2026
T-120,00
PCHEQUE
N1234567
^
`;

describe('recognising a QIF file', () => {
  it('takes a directive at the top, and leaves a CSV alone', () => {
    expect(looksLikeQif(BANK)).toBe(true);
    expect(looksLikeQif('!Account\nNCompte courant\n^\n')).toBe(true);

    // A description holding an exclamation mark is not a directive. The test
    // is anchored to the start of the file for exactly this.
    expect(looksLikeQif('Date;Libelle;Montant\n01/05/2026;SOLDES !;-800,00\n')).toBe(false);
  });
});

describe('reading a QIF statement', () => {
  const reading = readQif(BANK, 'EUR');

  it('reads every record', () => {
    expect(reading.problems).toEqual([]);
    expect(reading.candidates).toHaveLength(3);
  });

  it('settles the date order across the file rather than per row', () => {
    // 28/01 is the row that proves it: no month is the twenty-eighth. Read on
    // its own, 05/01 is the fifth of January or the first of May, and reading
    // each row separately would put half a statement in the wrong month.
    expect(reading.candidates.map((one) => one.bookedOn)).toEqual([
      '2026-01-05',
      '2026-01-28',
      '2026-01-31',
    ]);
  });

  it('reads a decimal comma and a space for thousands', () => {
    expect(reading.candidates.map((one) => one.entries[0]?.amount)).toEqual([
      '-42.1',
      '1800',
      '-120',
    ]);
  });

  it('takes the currency it is given, because the format carries none', () => {
    // The plan says it is asked for at import time (§8.1). Reading a Swiss
    // statement as euros because euros are common would be the worst kind of
    // wrong: every figure plausible and every one of them false.
    const swiss = readQif(BANK, 'CHF');

    expect(swiss.candidates[0]?.entries.map((entry) => entry.currency)).toEqual(['CHF', 'CHF']);
    expect(reading.candidates[0]?.entries.map((entry) => entry.currency)).toEqual(['EUR', 'EUR']);
  });

  it('books each row between the account and the outside world', () => {
    expect(reading.candidates[0]?.entries).toEqual([
      { account: 'ACCOUNT', amount: '-42.1', currency: 'EUR' },
      { account: 'EXTERNAL', amount: '42.1', currency: 'EUR' },
    ]);
    expect(reading.accounts).toEqual(['ACCOUNT']);
    expect(reading.counterparts).toEqual(['EXTERNAL']);
  });

  it('keeps the payee as the description and files nobody as the counterparty', () => {
    // The format has no field that means "who", only one that means "what the
    // bank wrote". Filing "CARTE 05/01 SUPERMARCHE INVENTE" as a counterparty
    // would invent a new one on every visit to the same shop.
    expect(reading.candidates[0]?.description).toBe('CARTE 05/01 SUPERMARCHE INVENTE');
    expect(reading.candidates[0]?.counterparty).toBeUndefined();
  });

  it('keeps a memo, and a cheque number when there is no memo', () => {
    expect(reading.candidates[1]?.entries[0]?.memo).toBe('Reference PAY-2026-01');
    expect(reading.candidates[2]?.entries[0]?.memo).toBe('1234567');
  });

  it('reads the direction from the sign', () => {
    expect(reading.candidates.map((one) => one.kind)).toEqual([
      'withdrawal',
      'deposit',
      'withdrawal',
    ]);
  });

  it('produces transactions that balance', () => {
    for (const candidate of reading.candidates) {
      const sum = candidate.entries.reduce(
        (total, entry) => total.plus(dec(entry.amount)),
        dec('0'),
      );
      expect(sum.isZero()).toBe(true);
    }
  });
});

describe('the parts of a QIF that are not transactions', () => {
  it('takes the account name out of an !Account block', () => {
    const named = `!Account
NCompte courant
TBank
^
${BANK}`;

    // And the block is not read as a transaction. It has an N and a T like a
    // record does, and taking it for one produces a row with no date - which
    // is why the count of problems is the assertion that matters here.
    expect(readQif(named, 'EUR').accounts).toEqual(['Compte courant']);
    expect(readQif(named, 'EUR').candidates).toHaveLength(3);
    expect(readQif(named, 'EUR').problems).toEqual([]);
  });

  it('names a section it cannot read rather than dropping it', () => {
    const investment = `${BANK}!Type:Invst
D05/01/2026
NBuy
YSociete Inventee
Q10
T-250,00
^
`;

    const reading = readQif(investment, 'EUR');

    // The bank records still import; the investment ones are reported. An
    // investment QIF is a real file this cannot read, and silence about it
    // would look like a file with fewer rows than it has.
    expect(reading.candidates).toHaveLength(3);
    expect(reading.problems).toHaveLength(1);
    expect(reading.problems[0]?.reason).toMatch(/this section is "invst"/);
  });

  it('reads a last record whose terminator the writer forgot', () => {
    const truncated = `!Type:Bank
D05/01/2026
T-42,10
PCARTE
`;

    expect(readQif(truncated, 'EUR').candidates).toHaveLength(1);
  });

  it('reports a row it cannot read, and reads the rest', () => {
    const broken = BANK.replace('D28/01/2026', 'Dnotadate');
    const reading = readQif(broken, 'EUR');

    expect(reading.candidates).toHaveLength(2);
    expect(reading.problems[0]?.reason).toMatch(/Unreadable date "notadate"/);
    expect(reading.problems[0]?.line).toBe(6);
  });
});
