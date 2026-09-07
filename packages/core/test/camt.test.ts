import { describe, expect, it } from 'vitest';
import { dec } from '@altitude/shared';
import { looksLikeCamt, readCamt } from '../src/index';

/**
 * CAMT.053, with invented figures.
 *
 * Modelled on what banks emit and holding none of anybody's data. SECURITY.md
 * and CONTRIBUTING are explicit that real financial data never enters the
 * repository, and a fixture is exactly where it would slip in unnoticed. The
 * IBAN below is not a valid one: its check digits are wrong on purpose.
 *
 * Two shapes are tested rather than one, because the schema moved twice in ways
 * that change where a name lives, and a reader that only handles the version
 * its author happened to see is a reader that works at one bank.
 */
const STATEMENT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>INVENTE-2026-01</MsgId>
      <CreDtTm>2026-02-01T06:00:00</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>STMT-2026-01</Id>
      <Acct>
        <Id><IBAN>FR7630003000112345678901</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">0.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><Dt>2026-01-01</Dt></Dt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLAV</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1743.63</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><Dt>2026-01-31</Dt></Dt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1758.63</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt><Dt>2026-01-31</Dt></Dt>
      </Bal>
      <Ntry>
        <Amt Ccy="EUR">42.10</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-01-05</Dt></BookgDt>
        <ValDt><Dt>2026-01-06</Dt></ValDt>
        <AcctSvcrRef>2026010500001</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls><TxDtls>
          <RltdPties>
            <Dbtr><Nm>MOI MEME</Nm></Dbtr>
            <Cdtr><Nm>SUPERMARCHE INVENTE</Nm></Cdtr>
          </RltdPties>
          <RmtInf><Ustrd>CARTE 05/01 SUPERMARCHE INVENTE</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
        <AddtlNtryInf>CARTE 05/01 SUPERMARCHE INVENTE 4972</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">1800.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-01-28</Dt></BookgDt>
        <AcctSvcrRef>2026012800002</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>SALA</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
          <RltdPties>
            <Dbtr><Nm>SOCIETE INVENTEE SAS</Nm></Dbtr>
            <Cdtr><Nm>MOI MEME</Nm></Cdtr>
          </RltdPties>
          <RmtInf><Ustrd>VIREMENT SALAIRE</Ustrd><Ustrd>JANVIER 2026</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">0.73</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><DtTm>2026-01-31T23:55:00+01:00</DtTm></BookgDt>
        <AcctSvcrRef>2026013100003</AcctSvcrRef>
        <BkTxCd><Domn><Cd>ACMT</Cd><Fmly><Cd>MDOP</Cd><SubFmlyCd>INTR</SubFmlyCd></Fmly></Domn></BkTxCd>
        <AddtlNtryInf>INTERETS &amp; AGIOS</AddtlNtryInf>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">15.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>PDNG</Sts>
        <BookgDt><Dt>2026-01-31</Dt></BookgDt>
        <AddtlNtryInf>CARTE 31/01 RESTAURANT INVENTE</AddtlNtryInf>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe('a CAMT.053 statement', () => {
  const reading = readCamt(STATEMENT);

  it('is recognised from its namespace', () => {
    expect(looksLikeCamt(STATEMENT)).toBe(true);
    expect(looksLikeCamt('Date;Libelle;Montant\n2026-01-05;X;-42,10')).toBe(false);
  });

  it('names the account by its IBAN, which is what a person recognises', () => {
    expect(reading.accounts).toEqual(['FR7630003000112345678901']);
  });

  it('signs a debit out and a credit in, from the element that says so', () => {
    // The format's own trap: every amount in the file is positive, and a reader
    // that takes them at face value books a month of spending as income.
    expect(reading.candidates.map((one) => one.entries[0]?.amount)).toEqual([
      '-42.1',
      '1800',
      '0.73',
    ]);
  });

  it('reads who was on the other side, from the right side of the entry', () => {
    // The creditor when money left, the debtor when it arrived. Reading one of
    // the two unconditionally names the account holder on half a statement.
    expect(reading.candidates[0]?.counterparty).toBe('SUPERMARCHE INVENTE');
    expect(reading.candidates[1]?.counterparty).toBe('SOCIETE INVENTEE SAS');
  });

  it('joins a remittance written across several lines', () => {
    expect(reading.candidates[1]?.description).toBe('VIREMENT SALAIRE JANVIER 2026');
  });

  it('falls back to the entry information when there is no remittance', () => {
    expect(reading.candidates[2]?.description).toBe('INTERETS & AGIOS');
  });

  it('keeps the additional information only when it says something more', () => {
    expect(reading.candidates[0]?.entries[0]?.memo).toBe('CARTE 05/01 SUPERMARCHE INVENTE 4972');
    expect(reading.candidates[2]?.entries[0]?.memo).toBeUndefined();
  });

  it('takes the booking date, and cuts an instant to its day', () => {
    expect(reading.candidates.map((one) => one.bookedOn)).toEqual([
      '2026-01-05',
      '2026-01-28',
      '2026-01-31',
    ]);
  });

  it('keeps the kinds the ledger can tell apart', () => {
    expect(reading.candidates.map((one) => one.kind)).toEqual([
      'withdrawal',
      'deposit',
      'interest',
    ]);
  });

  it('uses the bank reference as the external id', () => {
    expect(reading.candidates.map((one) => one.externalId)).toEqual([
      '2026010500001',
      '2026012800002',
      '2026013100003',
    ]);
  });

  it('skips a pending entry rather than importing it, and says why', () => {
    // It has not moved any money and it will arrive again, booked, on the next
    // statement. Importing it puts a transaction in the ledger twice.
    expect(reading.candidates).toHaveLength(3);
    expect(reading.skipped).toEqual([
      { line: expect.any(Number), reason: 'Pending: this entry has not been booked yet' },
    ]);
    expect(reading.problems).toEqual([]);
  });

  it('reads the closing booked balance, and says no row was checked against it', () => {
    // CLBD, not CLAV: the available balance nets off holds, and reconciling
    // against it reports a gap that is not an error.
    expect(reading.balances).toEqual({
      account: 'FR7630003000112345678901',
      closing: '1758.63',
      checked: 0,
      mismatches: [],
    });
  });

  it('reconciles: the opening balance plus everything read is the closing one', () => {
    // Not a check the reader performs - the type has no room to say it, and the
    // ledger-side comparison on the preview screen is the one that matters. It
    // is asserted here so the fixture cannot drift into a statement that does
    // not add up, which would make every test above agree with nothing.
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

describe('the shapes a newer schema moved', () => {
  /**
   * camt.053.001.08, with namespace prefixes on every tag.
   *
   * Two things moved: the status became a code inside an element, and the
   * related parties gained a `Pty` level. A file from a bank on the newer
   * schema is not a different format, and reading it as one would mean a person
   * whose bank upgraded finds their statement suddenly unreadable.
   */
  const newer = `<?xml version="1.0" encoding="UTF-8"?>
<ns2:Document xmlns:ns2="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <ns2:BkToCstmrStmt>
    <ns2:Stmt>
      <ns2:Acct><ns2:Id><ns2:Othr><ns2:Id>COMPTE-INVENTE-1</ns2:Id></ns2:Othr></ns2:Id></ns2:Acct>
      <ns2:Ntry>
        <ns2:Amt Ccy="EUR">54.90</ns2:Amt>
        <ns2:CdtDbtInd>DBIT</ns2:CdtDbtInd>
        <ns2:Sts><ns2:Cd>BOOK</ns2:Cd></ns2:Sts>
        <ns2:BookgDt><ns2:Dt>2026-03-12</ns2:Dt></ns2:BookgDt>
        <ns2:AcctSvcrRef>2026031200011</ns2:AcctSvcrRef>
        <ns2:NtryDtls><ns2:TxDtls>
          <ns2:RltdPties><ns2:Cdtr><ns2:Pty><ns2:Nm>BOULANGERIE INVENTEE</ns2:Nm></ns2:Pty></ns2:Cdtr></ns2:RltdPties>
        </ns2:TxDtls></ns2:NtryDtls>
        <ns2:AddtlNtryInf>CARTE 12/03 BOULANGERIE INVENTEE</ns2:AddtlNtryInf>
      </ns2:Ntry>
    </ns2:Stmt>
  </ns2:BkToCstmrStmt>
</ns2:Document>`;

  const reading = readCamt(newer);

  it('reads a document whose every tag carries a namespace prefix', () => {
    expect(reading.candidates).toHaveLength(1);
    expect(reading.problems).toEqual([]);
  });

  it('reads a status written as a code inside an element', () => {
    // Read wrongly, this entry is neither booked nor pending: it is a status
    // this does not know, and the whole statement is skipped in silence.
    expect(reading.skipped).toEqual([]);
  });

  it('finds a party one level deeper than the older schema puts it', () => {
    expect(reading.candidates[0]?.counterparty).toBe('BOULANGERIE INVENTEE');
  });

  it('falls back to the other identifier when there is no IBAN', () => {
    expect(reading.accounts).toEqual(['COMPTE-INVENTE-1']);
  });
});

describe('what a CAMT file gets wrong', () => {
  const around = (
    entry: string,
  ) => `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt><Stmt>
    <Acct><Id><IBAN>FR7630003000112345678901</IBAN></Id><Ccy>EUR</Ccy></Acct>
    ${entry}
  </Stmt></BkToCstmrStmt></Document>`;

  it('refuses an entry that does not say which way the money went', () => {
    // The amount alone is a magnitude. Booking it either way is a coin toss on
    // somebody's ledger, so this is a problem rather than a guess.
    const reading = readCamt(
      around(`<Ntry><Amt Ccy="EUR">42.10</Amt><BookgDt><Dt>2026-01-05</Dt></BookgDt></Ntry>`),
    );

    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('CdtDbtInd');
  });

  it('refuses an entry with no readable date', () => {
    const reading = readCamt(
      around(`<Ntry><Amt Ccy="EUR">42.10</Amt><CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-31</Dt></BookgDt></Ntry>`),
    );

    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('date');
  });

  it('takes the currency on the amount over the account it is booked to', () => {
    // A euro account can hold a dollar entry, and the attribute is the file's
    // own answer. Reading the account's currency instead books dollars as euros
    // at parity, which is a loss nothing later can detect.
    const reading = readCamt(
      around(`<Ntry><Amt Ccy="USD">42.10</Amt><CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-01-05</Dt></BookgDt></Ntry>`),
    );

    expect(reading.candidates[0]?.entries[0]?.currency).toBe('USD');
  });

  it('refuses a placeholder as an external id', () => {
    // `NOTPROVIDED` on every entry would make a whole statement one
    // transaction, and deduplication would then drop all but the first.
    const reading = readCamt(
      around(`<Ntry><Amt Ccy="EUR">42.10</Amt><CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-01-05</Dt></BookgDt><AcctSvcrRef>NOTPROVIDED</AcctSvcrRef></Ntry>`),
    );

    expect(reading.candidates[0]?.externalId).toBeUndefined();
  });

  it('reads a batch as the one booking it is, and names nobody', () => {
    // Forty direct debits collected into one entry. The entry's amount is what
    // moved; naming either payer as the counterparty would be picking one at
    // random out of forty.
    const reading = readCamt(
      around(`<Ntry><Amt Ccy="EUR">300.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-01-05</Dt></BookgDt>
        <NtryDtls>
          <TxDtls><RltdPties><Dbtr><Nm>PAYEUR UN</Nm></Dbtr></RltdPties></TxDtls>
          <TxDtls><RltdPties><Dbtr><Nm>PAYEUR DEUX</Nm></Dbtr></RltdPties></TxDtls>
        </NtryDtls>
        <AddtlNtryInf>REMISE PRELEVEMENTS</AddtlNtryInf></Ntry>`),
    );

    expect(reading.candidates).toHaveLength(1);
    expect(reading.candidates[0]?.entries[0]?.amount).toBe('300');
    expect(reading.candidates[0]?.counterparty).toBeUndefined();
    expect(reading.candidates[0]?.description).toBe('REMISE PRELEVEMENTS');
  });

  it('signs an overdrawn closing balance', () => {
    const reading = readCamt(`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
      <BkToCstmrStmt><Stmt>
        <Acct><Id><IBAN>FR7630003000112345678901</IBAN></Id><Ccy>EUR</Ccy></Acct>
        <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
          <Amt Ccy="EUR">120.45</Amt><CdtDbtInd>DBIT</CdtDbtInd></Bal>
        <Ntry><Amt Ccy="EUR">42.10</Amt><CdtDbtInd>DBIT</CdtDbtInd>
          <BookgDt><Dt>2026-01-05</Dt></BookgDt></Ntry>
      </Stmt></BkToCstmrStmt></Document>`);

    expect(reading.balances?.closing).toBe('-120.45');
  });

  it('says nothing about the balance when the file holds two statements', () => {
    // Two closing balances on two accounts are not one number, and picking
    // either compares the ledger against half of what was imported.
    const reading = readCamt(`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
      <BkToCstmrStmt>
        <Stmt><Acct><Id><IBAN>FR7630003000112345678901</IBAN></Id><Ccy>EUR</Ccy></Acct>
          <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
            <Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
          <Ntry><Amt Ccy="EUR">42.10</Amt><CdtDbtInd>DBIT</CdtDbtInd>
            <BookgDt><Dt>2026-01-05</Dt></BookgDt></Ntry></Stmt>
        <Stmt><Acct><Id><IBAN>FR7630003000198765432109</IBAN></Id><Ccy>EUR</Ccy></Acct>
          <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
            <Amt Ccy="EUR">900.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
          <Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
            <BookgDt><Dt>2026-01-06</Dt></BookgDt></Ntry></Stmt>
      </BkToCstmrStmt></Document>`);

    expect(reading.accounts).toHaveLength(2);
    expect(reading.balances).toBeUndefined();
  });

  it('names a neighbouring ISO 20022 message rather than reporting an empty file', () => {
    // CAMT.052 is a real file this cannot read, and "nothing to import" would
    // send somebody looking for a problem with their bank.
    const reading = readCamt(`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.02">
      <BkToCstmrAcctRpt><Rpt><Id>X</Id></Rpt></BkToCstmrAcctRpt></Document>`);

    expect(reading.candidates).toEqual([]);
    expect(reading.problems[0]?.reason).toContain('CAMT.052');
  });
});
