import { describe, expect, it } from 'vitest';
import { describesItself, FILE_FORMATS, sniffFormat, type FileFormat } from '@altitude/shared';
import { formatPreset, formatPresetById } from '../src/index';

/**
 * The four formats that need no preset, held to what that claim means.
 *
 * §8.1 puts OFX, CAMT.053 and MT940 in v1 on one argument: "structured format:
 * mapping is deterministic, no mapping screen needed". QIF joins them with an
 * asterisk, since it carries no currency and is asked for one.
 *
 * The claim only holds if three things agree - the sniffer in `shared`, the
 * reader's own `matches` in `core`, and the registry that hands a request the
 * right reader - and they live in three files that cannot import each other.
 * Nothing but this joins them. A format added to the list and forgotten in
 * `formatPreset` would be recognised on the screen and then unreadable.
 *
 * Every figure below is invented.
 */

const SAMPLES: Readonly<Record<Exclude<FileFormat, 'delimited'>, string>> = {
  ofx: `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKACCTFROM><ACCTID>00012345678<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-42.10<FITID>1<NAME>INVENTE</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,

  camt: `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>FR7630003000112345678901</IBAN></Id><Ccy>EUR</Ccy></Acct>
  <Ntry><Amt Ccy="EUR">42.10</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
    <BookgDt><Dt>2026-01-05</Dt></BookgDt><AddtlNtryInf>INVENTE</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`,

  mt940: `:20:RELEVE
:25:30003/00012345678
:60F:C260101EUR0,00
:61:2601050105D42,10NMSCNONREF//1
:86:INVENTE
:62F:D260131EUR42,10`,

  qif: `!Type:Bank
D05/01/2026
T-42.10
PINVENTE
^`,
};

describe('the formats that describe themselves', () => {
  const named = FILE_FORMATS.filter((format): format is Exclude<FileFormat, 'delimited'> =>
    describesItself(format),
  );

  it('has a sample for each, so the checks below cover the list', () => {
    expect(named.map((format) => format).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(named)('%s has a reader the registry can hand out', (format) => {
    const preset = formatPreset(format, 'EUR');

    expect(preset, `add ${format} to formatPreset in presets/index.ts`).not.toBeNull();
    expect(preset?.id).toBe(format);
  });

  it.each(named)('%s is reachable by the id a request carries', (format) => {
    // The screen sends the format's own name as the preset id. An id the
    // registry does not answer to is a file recognised and then refused.
    expect(formatPresetById(format, 'EUR')?.id).toBe(format);
  });

  it.each(named)('%s is what its own sample sniffs to', (format) => {
    expect(sniffFormat(SAMPLES[format])).toBe(format);
  });

  it.each(named)('%s reads its own sample into a movement', (format) => {
    const reading = formatPreset(format, 'EUR')!.read(SAMPLES[format]);

    expect(reading.problems).toEqual([]);
    expect(reading.candidates).toHaveLength(1);
    expect(reading.candidates[0]?.bookedOn).toBe('2026-01-05');
    expect(reading.candidates[0]?.entries[0]?.amount).toBe('-42.1');
    expect(reading.candidates[0]?.entries[0]?.currency).toBe('EUR');
  });

  it.each(named)("%s claims its own sample and nobody else's", (format) => {
    // The half that is easy to get wrong. A sniffer widened to catch one bank's
    // odd file starts claiming another format's, and the symptom is not an
    // error: it is a reader confidently producing nothing.
    for (const [other, sample] of Object.entries(SAMPLES)) {
      expect(formatPreset(format, 'EUR')!.matches(sample), `${format} vs ${other}`).toBe(
        other === format,
      );
    }
  });
});

describe('a delimited file, which describes nothing', () => {
  const csv = `Date;Libelle;Montant
05/01/2026;CARTE 05/01 INVENTE;-42,10`;

  it('is what a CSV sniffs to', () => {
    expect(sniffFormat(csv)).toBe('delimited');
  });

  it('has no reader of its own, because a bank decides what its columns mean', () => {
    expect(formatPreset('delimited', 'EUR')).toBeNull();
    expect(formatPresetById('delimited', 'EUR')).toBeNull();
  });

  it('is claimed by none of the readers that need no preset', () => {
    for (const format of FILE_FORMATS.filter(describesItself)) {
      expect(formatPreset(format, 'EUR')!.matches(csv), format).toBe(false);
    }
  });

  it('is what an unknown id falls back to, rather than a reader', () => {
    expect(formatPresetById('camt.054', 'EUR')).toBeNull();
    expect(formatPresetById('', 'EUR')).toBeNull();
  });
});
