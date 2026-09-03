/**
 * What kind of file this is, before anybody has been asked anything.
 *
 * Two of the three formats say what they are, which is the whole reason the
 * plan puts them in v1 (§8.1): "structured format: mapping is deterministic, no
 * mapping screen needed". Recognising them is what turns that into a fact on
 * screen - a person who picked "other bank" and handed over an OFX file should
 * not then be asked which column is the date, because the file already said.
 *
 * In `shared` rather than in `core` for the reason `checkUpload` is: the
 * browser decides what to do with a file the moment it is dropped, and `core`
 * reaches the database driver, so a client component cannot import it (ADR-0007
 * keeps that boundary tested). The readers live in `core`; only the question
 * "which reader" is answered here, by both sides, from the same code.
 */

export const FILE_FORMATS = ['delimited', 'ofx', 'qif'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** How much of a file has to be looked at. A header is at the top or nowhere. */
const HEAD = 4096;

export function sniffFormat(text: string): FileFormat {
  const head = text.slice(0, HEAD);

  // Either the SGML header block of OFX 1.x or the root element, which is what
  // 2.x has after its XML declaration. Both appear within the first few lines.
  if (/<OFX>|OFXHEADER/i.test(head)) return 'ofx';

  // A QIF file opens with a directive: `!Type:Bank`, `!Account`, `!Option:`.
  // Anchored to the start of the file rather than of any line, so a CSV
  // carrying an exclamation mark in a description is never mistaken for one.
  if (/^\s*!\s*(type|account|option|clear)/i.test(head)) return 'qif';

  return 'delimited';
}

/**
 * A file that is not text at all, from its first bytes.
 *
 * Asked before anything tries to decode it: a spreadsheet run through a text
 * decoder is a screenful of replacement characters, and what a person gets from
 * that is "this file is empty" rather than "this is a spreadsheet".
 *
 * `null` means it is text, which is every other path through the importer.
 */
export type BinaryFormat = 'xlsx' | 'legacy-excel';

export function sniffBytes(bytes: Uint8Array): BinaryFormat | null {
  // Every XLSX is a zip, and this is a zip's first four bytes. Not every zip is
  // an XLSX - the reader on the server settles that, and refusing here on a
  // stronger guess would mean opening the archive twice.
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx';

  // The pre-2007 binary format, which is an OLE2 compound document and shares
  // nothing with the modern one. Recognised only to say so: a person told
  // "unreadable file" has no idea what to do next, and "save it as .xlsx" is
  // one step.
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'legacy-excel';

  return null;
}

function starts(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.length <= bytes.length && magic.every((byte, at) => bytes[at] === byte);
}

/** Whether this format describes itself, and so needs nothing named by hand. */
export function describesItself(format: FileFormat): boolean {
  return format !== 'delimited';
}
