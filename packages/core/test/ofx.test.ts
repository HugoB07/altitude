import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import { looksLikeOfx, readOfx } from '../src/index';

/**
 * OFX, with invented figures.
 *
 * Modelled on what banks emit and holding none of anybody's data. SECURITY.md
 * and CONTRIBUTING are explicit that real financial data never enters the
 * repository, and a fixture is exactly where it would slip in unnoticed.
 */
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260201120000
<LANGUAGE>FRA
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>EUR
<BANKACCTFROM>
<BANKID>30003
<ACCTID>00012345678
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101
<DTEND>20260131
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105120000.000[+1:CET]
<TRNAMT>-42.10
<FITID>2026010500001
<NAME>CARTE 05/01 SUPERMARCHE INVENTE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260128
<TRNAMT>1800.00
<FITID>2026012800002
<NAME>VIREMENT SALAIRE
<MEMO>Reference PAY-2026-01
<PAYEE>
<NAME>Societe Inventee SAS
<CITY>Paris
</PAYEE>
</STMTTRN>
<STMTTRN>
<TRNTYPE>INT
<DTPOSTED>20260131
<TRNAMT>0.73
<FITID>2026013100003
<NAME>INTERETS &amp; AGIOS
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>1758.63
<DTASOF>20260131
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <CURDEF>EUR</CURDEF>
        <BANKACCTFROM>
          <ACCTID>00012345678</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260105</DTPOSTED>
            <TRNAMT>-42.10</TRNAMT>
            <FITID>2026010500001</FITID>
            <NAME>CARTE 05/01 SUPERMARCHE INVENTE</NAME>
          </STMTTRN>
        </BANKTRANLIST>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>
`;

describe('recognising an OFX file', () => {
  it('takes both dialects, and leaves a CSV alone', () => {
    expect(looksLikeOfx(SGML)).toBe(true);
    expect(looksLikeOfx(XML)).toBe(true);
    expect(looksLikeOfx('Date;Libelle;Montant\n01/05/2026;Loyer;-800,00\n')).toBe(false);
  });
});

describe('reading an OFX 1.x statement', () => {
  const reading = readOfx(SGML);

  it('reads every transaction and nothing else', () => {
    // The signon block, the status blocks and the date range are all STMTTRN's
    // neighbours, and a walk that took any of them for a transaction would
    // produce rows with no amount.
    expect(reading.problems).toEqual([]);
    expect(reading.candidates).toHaveLength(3);
  });

  it('names the account the statement is about', () => {
    // The number, because that is what a person recognises. A CSV says
    // "ACCOUNT" and means whichever one they had in mind.
    expect(reading.accounts).toEqual(['00012345678']);
    expect(reading.counterparts).toEqual(['EXTERNAL']);
  });

  it('takes the day out of a timestamp with a zone', () => {
    // 20260105120000.000[+1:CET]. Midday in Paris is the same day everywhere
    // that matters, and the time is dropped rather than converted (ADR-0006).
    expect(reading.candidates[0]?.bookedOn).toBe('2026-01-05');
  });

  it('books each row between the account and the outside world', () => {
    const first = reading.candidates[0]!;

    expect(first.entries).toEqual([
      { account: '00012345678', amount: '-42.1', currency: 'EUR' },
      { account: 'EXTERNAL', amount: '42.1', currency: 'EUR' },
    ]);
    expect(first.kind).toBe('withdrawal');
    expect(first.externalId).toBe('2026010500001');
  });

  it('files who was on the other side only when the file separated them', () => {
    // The salary carries a PAYEE block, so there is a name to file.
    expect(reading.candidates[1]?.counterparty).toBe('Societe Inventee SAS');

    // The card payment does not. "CARTE 05/01 SUPERMARCHE INVENTE" is a label,
    // not a counterparty, and filing it as one would put a different
    // counterparty on every visit to the same shop.
    expect(reading.candidates[0]?.counterparty).toBeUndefined();
    expect(reading.candidates[0]?.description).toBe('CARTE 05/01 SUPERMARCHE INVENTE');
  });

  it('keeps a memo that says something the description does not', () => {
    expect(reading.candidates[1]?.entries[0]?.memo).toBe('Reference PAY-2026-01');
    expect(reading.candidates[0]?.entries[0]?.memo).toBeUndefined();
  });

  it('decodes the entities SGML needs', () => {
    expect(reading.candidates[2]?.description).toBe('INTERETS & AGIOS');
  });

  it('keeps the kinds the ledger can tell apart', () => {
    expect(reading.candidates.map((one) => one.kind)).toEqual([
      'withdrawal',
      'deposit',
      'interest',
    ]);
  });

  it('reads the closing balance, and says no row was checked against it', () => {
    // OFX has no running balance per row, so there is nothing to read back
    // line by line. Claiming otherwise would be claiming a check that never ran.
    // And says which account it is about. A described CSV has one and can
    // leave it implicit; an OFX file names its own and can hold two.
    expect(reading.balances).toEqual({
      account: '00012345678',
      closing: '1758.63',
      checked: 0,
      mismatches: [],
    });
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

describe('reading an OFX 2.x statement', () => {
  it('reads the XML dialect into the same thing as the SGML one', () => {
    // One tokeniser, because the difference is one rule: a tag holding text is
    // a leaf. In 2.x that makes the closing tag redundant rather than wrong.
    const xml = readOfx(XML).candidates[0]!;
    const sgml = readOfx(SGML).candidates[0]!;

    // Everything but where it sat in the file, which is the one thing the two
    // genuinely disagree about.
    expect({ ...xml, sourceLines: [] }).toEqual({ ...sgml, sourceLines: [] });
  });
});

describe('an OFX file this cannot read', () => {
  it('names an investment statement rather than reporting an empty file', () => {
    const investment = `<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS>
<CURDEF>EUR</CURDEF></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>`;

    expect(readOfx(investment).problems[0]?.reason).toMatch(/investment statement/);
  });

  it('reports the row it could not read, and reads the rest', () => {
    const broken = SGML.replace('<DTPOSTED>20260128', '<DTPOSTED>notadate');
    const reading = readOfx(broken);

    // One bad row must not stop the other two (§8.2), and the line has to be
    // the one a person can find in their own file.
    expect(reading.candidates).toHaveLength(2);
    expect(reading.problems).toHaveLength(1);
    expect(reading.problems[0]?.reason).toMatch(/Unreadable date "notadate"/);
    // The transaction's own line, not the field's: a preview pointing at
    // <DTPOSTED> sends somebody looking one line past the row they want.
    const second = SGML.indexOf('<STMTTRN>', SGML.indexOf('<STMTTRN>') + 1);
    expect(reading.problems[0]?.line).toBe(SGML.slice(0, second).split('\n').length);
  });

  it('refuses a statement with no currency anywhere', () => {
    const reading = readOfx(SGML.replace('<CURDEF>EUR', '<CURDEF>'));

    expect(reading.candidates).toHaveLength(0);
    expect(reading.problems).toHaveLength(3);
    expect(reading.problems[0]?.reason).toMatch(/No currency/);
  });
});

describe('a file holding more than one statement', () => {
  const two = SGML.replace(
    '</BANKMSGSRSV1>',
    `<STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKACCTFROM><ACCTID>00098765432<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260115
<TRNAMT>500.00
<FITID>2026011500009
<NAME>VIREMENT EPARGNE
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2500.00<DTASOF>20260131</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>`,
  );

  it('names both accounts', () => {
    expect(readOfx(two).accounts).toEqual(['00012345678', '00098765432']);
    expect(readOfx(two).candidates).toHaveLength(4);
  });

  it('states no closing balance, because two balances are not one number', () => {
    // Picking either would compare the ledger against half of what was
    // imported, and the screen would say the file ends somewhere it does not.
    expect(readOfx(two).balances).toBeUndefined();
  });
});
