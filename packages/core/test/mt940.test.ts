import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import { looksLikeMt940, readMt940 } from '../src/index';

/**
 * MT940, with invented figures.
 *
 * Modelled on what banks emit and holding none of anybody's data. SECURITY.md
 * and CONTRIBUTING are explicit that real financial data never enters the
 * repository, and a fixture is exactly where it would slip in unnoticed. The
 * account numbers below are not valid ones.
 */
const FRENCH = `:20:RELEVE260131
:25:30003/00012345678
:28C:00001/001
:60F:C260101EUR0,00
:61:2601050105D42,10NMSCNONREF//2026010500001
:86:CARTE 05/01 SUPERMARCHE INVENTE 4972
:61:2601280128C1800,00NTRFSALAIRE//2026012800002
:86:VIREMENT SALAIRE JANVIER
:61:2601310131C0,73NINTNONREF//2026013100003
:86:INTERETS CREDITEURS
:62F:C260131EUR1758,63
-`;

describe('an MT940 statement', () => {
  const reading = readMt940(FRENCH);

  it('is recognised from its tags, and a CSV is not', () => {
    expect(looksLikeMt940(FRENCH)).toBe(true);
    expect(looksLikeMt940('Date;Libelle;Montant\n2026-01-05;X;-42,10')).toBe(false);
  });

  it('names the account as the file writes it', () => {
    expect(reading.accounts).toEqual(['30003/00012345678']);
  });

  it('signs a debit out and a credit in', () => {
    expect(reading.candidates.map((one) => one.entries[0]?.amount)).toEqual([
      '-42.1',
      '1800',
      '0.73',
    ]);
  });

  it('reads a comma as the decimal separator, which is all this format has', () => {
    expect(reading.candidates[0]?.entries[0]?.amount).toBe('-42.1');
  });

  it('takes the currency from the balance, which is the only place it appears', () => {
    expect(reading.candidates.every((one) => one.entries[0]?.currency === 'EUR')).toBe(true);
  });

  it('books on the entry date', () => {
    expect(reading.candidates.map((one) => one.bookedOn)).toEqual([
      '2026-01-05',
      '2026-01-28',
      '2026-01-31',
    ]);
  });

  it('reads the narrative as the description', () => {
    expect(reading.candidates[1]?.description).toBe('VIREMENT SALAIRE JANVIER');
  });

  it('uses the bank reference after the double slash as the external id', () => {
    expect(reading.candidates.map((one) => one.externalId)).toEqual([
      '2026010500001',
      '2026012800002',
      '2026013100003',
    ]);
  });

  it('keeps the kinds the ledger can tell apart', () => {
    expect(reading.candidates.map((one) => one.kind)).toEqual([
      'withdrawal',
      'deposit',
      'interest',
    ]);
  });

  it('reads the closing balance, and says no row was checked against it', () => {
    expect(reading.balances).toEqual({
      account: '30003/00012345678',
      closing: '1758.63',
      checked: 0,
      mismatches: [],
    });
  });

  it('reconciles: the opening balance plus everything read is the closing one', () => {
    // Asserted so the fixture cannot drift into a statement that does not add
    // up, which would make every test above agree with nothing.
    const moved = reading.candidates.reduce(
      (total, candidate) => total.plus(dec(candidate.entries[0]!.amount)),
      dec('0'),
    );

    expect(dec('0.00').plus(moved).toFixed(2)).toBe('1758.63');
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

describe('the structured narrative a German bank writes', () => {
  /**
   * `:86:` as a record rather than a sentence: `?00` is the booking text, `?20`
   * onwards the remittance split into chunks, `?32` and `?33` the two halves of
   * the other party's name. It is the only place this format ever names a
   * counterparty, which is the whole reason it is read rather than kept whole.
   */
  const german = `:20:940S
:25:DE89370400440532013000
:28C:1/1
:60F:C260301EUR1000,00
:61:2603120312D54,90NDDTNONREF//SVWZ0012026
:86:105?00LASTSCHRIFT?20FACTURE 2026-03 ?21BOULANGERIE?32BOULANGERIE?33 INVENTEE
:62F:C260331EUR945,10
-`;

  const reading = readMt940(german);

  it('names the other party from the two fields that hold it', () => {
    expect(reading.candidates[0]?.counterparty).toBe('BOULANGERIE INVENTEE');
  });

  it('joins the remittance chunks without inserting anything between them', () => {
    // The chunks are a fixed-width split of one string, so an IBAN can straddle
    // two of them. A separator here would corrupt every long reference.
    expect(reading.candidates[0]?.description).toBe('FACTURE 2026-03 BOULANGERIE');
  });

  it('keeps the booking text as a memo rather than as the description', () => {
    expect(reading.candidates[0]?.entries[0]?.memo).toBe('LASTSCHRIFT');
  });

  it('reads an IBAN as the account label', () => {
    expect(reading.accounts).toEqual(['DE89370400440532013000']);
  });
});

describe('the two things this format gets wrong on its own', () => {
  const around = (lines: string) => `:20:X
:25:30003/00012345678
:60F:C251201EUR0,00
${lines}
:62F:C260131EUR0,00`;

  it('borrows the year backwards across a December boundary', () => {
    // A statement dated 2 January holds entries booked on 31 December. The
    // booking date carries no year, and taking the value date's files them
    // eleven months into the future.
    const reading = readMt940(around(':61:2601021231D42,10NMSCNONREF'));

    expect(reading.candidates[0]?.bookedOn).toBe('2025-12-31');
  });

  it('borrows it forwards too', () => {
    const reading = readMt940(around(':61:2512310102C42,10NMSCNONREF'));

    expect(reading.candidates[0]?.bookedOn).toBe('2026-01-02');
  });

  it('does not shift a date that is merely a few days late', () => {
    const reading = readMt940(around(':61:2601310202C42,10NMSCNONREF'));

    expect(reading.candidates[0]?.bookedOn).toBe('2026-02-02');
  });

  it('reads a reversal as undoing the direction it names', () => {
    // `RC` is the reversal of a credit, so money leaves. Read as a credit it
    // books a refund as a second payment, and the balance is out by twice it.
    const reading = readMt940(around(':61:2601050105RC45,00NMSCNONREF'));

    expect(reading.candidates[0]?.entries[0]?.amount).toBe('-45');
  });

  it('reads a reversal of a debit as money arriving', () => {
    const reading = readMt940(around(':61:2601050105RD45,00NMSCNONREF'));

    expect(reading.candidates[0]?.entries[0]?.amount).toBe('45');
  });

  it('refuses NONREF as an external id, on either side of the slash', () => {
    // The standard's own word for "there isn't one". Used as an id it would
    // make every line in a statement the same transaction, and deduplication
    // would then drop all but the first.
    const written = readMt940(around(':61:2601050105D42,10NMSCREF001//NONREF'));
    const absent = readMt940(around(':61:2601050105D42,10NMSCNONREF'));

    expect(written.candidates[0]?.externalId).toBeUndefined();
    expect(absent.candidates[0]?.externalId).toBeUndefined();
  });

  it('takes an optional funds code without reading it as part of the amount', () => {
    const reading = readMt940(around(':61:2601050105DR42,10NMSCNONREF'));

    expect(reading.candidates[0]?.entries[0]?.amount).toBe('-42.1');
  });

  it('joins a narrative wrapped across several lines', () => {
    const reading = readMt940(
      around(
        ':61:2601050105D42,10NMSCNONREF\n:86:VIREMENT VERS UN COMPTE\nDONT LE LIBELLE EST LONG',
      ),
    );

    expect(reading.candidates[0]?.description).toBe(
      'VIREMENT VERS UN COMPTE DONT LE LIBELLE EST LONG',
    );
  });
});

describe('a file this cannot take at its word', () => {
  it('reports an unreadable line and reads the rest of the statement', () => {
    // Collected rather than thrown. A file of four hundred rows with one bad
    // line should import three hundred and ninety-nine and say which one it
    // could not read.
    const reading = readMt940(`:20:X
:25:30003/00012345678
:60F:C260101EUR0,00
:61:PAS UNE LIGNE DE RELEVE
:61:2601050105D42,10NMSCNONREF
:62F:D260131EUR42,10`);

    expect(reading.candidates).toHaveLength(1);
    expect(reading.problems).toHaveLength(1);
    expect(reading.problems[0]?.reason).toContain('Unreadable statement line');
    expect(reading.problems[0]?.line).toBe(4);
  });

  it('refuses to read amounts in a statement that never states a currency', () => {
    // Rather than falling back on the household's. A file whose amounts might
    // be dollars, booked as euros at parity, is a loss nothing later detects.
    const reading = readMt940(`:20:X
:25:30003/00012345678
:61:2601050105D42,10NMSCNONREF`);

    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('no currency');
  });

  it('says nothing about the balance when the file holds several messages', () => {
    // Three months exported at once is three messages concatenated, which is
    // what a bank hands over when a statement is asked for by year.
    const reading = readMt940(`:20:JANVIER
:25:30003/00012345678
:60F:C260101EUR0,00
:61:2601050105D42,10NMSCNONREF
:62F:D260131EUR42,10
:20:FEVRIER
:25:30003/00012345678
:60F:D260201EUR42,10
:61:2602050205C10,00NMSCNONREF
:62F:D260228EUR32,10`);

    expect(reading.candidates).toHaveLength(2);
    expect(reading.balances).toBeUndefined();
  });

  it('ignores an intermediate closing balance', () => {
    // `:62M:` is the middle of a month. Reconciling a ledger against it reports
    // a gap that is not an error and that nothing in the file explains.
    const reading = readMt940(`:20:X
:25:30003/00012345678
:60F:C260101EUR0,00
:61:2601050105D42,10NMSCNONREF
:62M:D260115EUR42,10`);

    expect(reading.balances).toBeUndefined();
  });

  it('reads a message still inside its SWIFT envelope', () => {
    const reading = readMt940(`{1:F01BANKINVEXXXX0000000000}{2:O9401200260105BANKINVEXXXX}{4:
:20:X
:25:30003/00012345678
:60F:C260101EUR0,00
:61:2601050105D42,10NMSCNONREF
:62F:D260131EUR42,10
-}`);

    expect(reading.candidates).toHaveLength(1);
    expect(reading.balances?.closing).toBe('-42.1');
  });

  it('still finds the currency in a balance written the wrong way round', () => {
    // The standard puts the sign in the mark and writes the amount unsigned.
    // A writer that puts a minus in the amount as well is wrong about one
    // field - and this field is the only place the currency appears, so
    // refusing the whole of it would make every line in the statement
    // unreadable over a character nobody looks at.
    const reading = readMt940(`:20:X
:25:30003/00012345678
:60F:D260101EUR-42,10
:61:2601050105C42,10NMSCNONREF`);

    expect(reading.problems).toEqual([]);
    expect(reading.candidates[0]?.entries[0]?.currency).toBe('EUR');
    expect(reading.candidates[0]?.entries[0]?.amount).toBe('42.1');
  });

  it('signs an overdrawn closing balance', () => {
    const reading = readMt940(`:20:X
:25:30003/00012345678
:60F:C260101EUR0,00
:61:2601050105D42,10NMSCNONREF
:62F:D260131EUR42,10`);

    expect(reading.balances?.closing).toBe('-42.1');
  });
});
