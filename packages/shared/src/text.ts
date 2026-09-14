/**
 * Turning the bytes of a file into text, without guessing wrongly.
 *
 * A browser reading a file with `file.text()` assumes UTF-8 and replaces
 * anything that is not with U+FFFD. That is not recoverable afterwards: by the
 * time the string reaches a reader, "VIREMENT SÉPA" has become "VIREMENT S?PA"
 * and no amount of care downstream brings the E back. So the file has to arrive
 * as bytes and be decoded here.
 *
 * French bank exports are the reason. Plenty of them are still written in
 * CP1252, which is what Excel on a French Windows produces, and the plan lists
 * it first among the pitfalls to handle on day one (§8.3).
 */

/** What the bytes turned out to be, kept so the screen can say so. */
export interface DecodedText {
  readonly text: string;
  readonly encoding: 'utf-8' | 'windows-1252';
  /** True when a byte order mark was present and stripped. */
  readonly hadBom: boolean;
}

/**
 * The thirty-two code points CP1252 puts where Latin-1 has control characters.
 *
 * Written as escapes rather than as the characters themselves, because this
 * table is about bytes and a file that got re-encoded on its way through a
 * checkout would change the answer without changing the look of the line.
 * Index 0 is byte 0x80; the five undefined slots keep their own control
 * character, which is what every decoder does with them.
 *
 * Every other byte maps to the code point of the same value - CP1252 agrees
 * with Latin-1 everywhere outside this range - so those need no table.
 */
// Kept eight to a line, which is how a byte table reads.
// prettier-ignore
const CP1252_HIGH = [
  '\u20AC', '\u0081', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '\u008D', '\u017D', '\u008F',
  '\u0090', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
  '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '\u009D', '\u017E', '\u0178',
] as const;

/**
 * CP1252, decoded here rather than by the platform.
 *
 * `new TextDecoder('windows-1252')` needs ICU, and a Node built with
 * `small-icu` - which several distributions ship - throws a RangeError on it.
 * That is not a test being fussy about a machine: it is every CP1252 bank
 * export failing to import on that host, which is the encoding §8.3 lists
 * first among the pitfalls to handle on day one.
 *
 * Thirty-two entries and a cast is the whole of the alternative, so the
 * dependency is not worth keeping for it. UTF-8 stays with `TextDecoder`, which
 * every build supports without ICU.
 */
function decodeCp1252(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte);
  }
  return text;
}

/**
 * Decodes a file's bytes, choosing between UTF-8 and CP1252.
 *
 * No character-frequency heuristic and no dependency, because UTF-8 does not
 * need one: it is self-validating. A multi-byte sequence has a shape, and a
 * byte stream that is not UTF-8 will, in practice, break that shape within the
 * first accented word. So the rule is simply: if it decodes as UTF-8, it is
 * UTF-8; otherwise it is CP1252.
 *
 * The fallback is CP1252 rather than ISO-8859-1 on purpose. The two agree on
 * every letter a French export uses and differ in the range 0x80-0x9F, where
 * CP1252 puts the curly quotes and the euro sign that Excel writes. Decoding
 * CP1252 as Latin-1 turns those into control characters; the other way round is
 * harmless, because a real Latin-1 file never uses that range.
 *
 * The one thing this cannot catch is a file that is valid UTF-8 and meant to be
 * something else, which for these encodings means a file with no byte above
 * 0x7F - and there the two decode identically anyway.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hadBom ? bytes.subarray(3) : bytes;

  try {
    // `fatal`, so an invalid sequence throws rather than being replaced. Without
    // it every input "is" UTF-8 and the fallback is unreachable.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, encoding: 'utf-8', hadBom };
  } catch {
    return {
      text: decodeCp1252(body),
      encoding: 'windows-1252',
      hadBom,
    };
  }
}
