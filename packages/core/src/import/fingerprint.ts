import { createHash } from 'node:crypto';

/**
 * What an import keeps about the file it read.
 *
 * Not the file. A statement holds an IBAN, an account holder's name, and every
 * operation of the period - including the ones nobody imported. A digest
 * answers the question people actually ask, "have I already imported this?",
 * and holds none of it. The migration that adds the columns says the rest.
 *
 * Taken over the decoded text rather than the bytes: decoding removes a byte
 * order mark and settles the encoding, so the same statement saved twice by
 * the same bank digests the same even when the two files differ by a byte.
 */
export interface FileFingerprint {
  readonly hash: string;
  readonly bytes: number;
  readonly lines: number;
}

export function fingerprintFile(text: string): FileFingerprint {
  return {
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    // Trailing newline or not, a file of one row is one line.
    lines: text.trimEnd() === '' ? 0 : text.trimEnd().split('\n').length,
  };
}
