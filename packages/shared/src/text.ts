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
      text: new TextDecoder('windows-1252').decode(body),
      encoding: 'windows-1252',
      hadBom,
    };
  }
}
