/**
 * What an import will accept, said in one place.
 *
 * The plan asks for size and type to be checked at step 1 (§8.2) and gives
 * orders of magnitude for spreadsheets at §8.7. These are the numbers for a
 * text file sent to a server action: everything travels in memory, and the
 * whole file is sent again on every preview, so the ceiling that matters is
 * not what a disk can hold.
 *
 * Five megabytes is fifteen to twenty-five years of a bank statement, or a
 * large broker export. Fifty thousand lines is past what anybody has - as long
 * as a line is a movement, which is where the second cap earns its keep and
 * where it has to be told to stand down. See `checkUpload`.
 *
 * Here rather than in `core` because the browser has to refuse before it
 * sends: a file rejected after a five megabyte upload is a file rejected too
 * late, and `core` reaches the database, so a client component cannot import
 * it (ADR-0007 keeps that boundary tested).
 */

import { sniffFormat, type FileFormat } from './formats';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_LINES = 50_000;

/**
 * Columns, which matters less for CSV than for the spreadsheets to come, and
 * is cheap to hold the line on now.
 */
export const MAX_UPLOAD_COLUMNS = 1_000;

export type UploadRefusal =
  | { readonly reason: 'bytes'; readonly limit: number; readonly found: number }
  | { readonly reason: 'lines'; readonly limit: number; readonly found: number };

/**
 * The formats where a line is roughly a movement.
 *
 * A CSV spends one line on a transaction, QIF five and MT940 two, so counting
 * lines is counting movements to within a small factor. Markup does not work
 * that way: a CAMT.053 entry is twenty lines of XML and an OFX 1.x transaction
 * six, so fifty thousand lines is two thousand transactions - a limit an order
 * of magnitude below what the number says, on the two formats a business
 * account is most likely to arrive in.
 *
 * Those two are held by the byte cap instead, which is the one that actually
 * bounds what this has to hold in memory. The line cap was always a proxy for
 * the number of rows, and this is where the proxy stops working.
 */
const LINE_PER_RECORD: ReadonlySet<FileFormat> = new Set<FileFormat>(['delimited', 'qif', 'mt940']);

/**
 * Why this file cannot be read, or null when it can.
 *
 * Takes the size separately from the text because the two callers know
 * different things: the browser has a `File` and its byte count before it has
 * decoded anything, and the server has the decoded text.
 */
export function checkUpload(bytes: number, text?: string): UploadRefusal | null {
  if (bytes > MAX_UPLOAD_BYTES) {
    return { reason: 'bytes', limit: MAX_UPLOAD_BYTES, found: bytes };
  }

  if (text !== undefined && LINE_PER_RECORD.has(sniffFormat(text))) {
    // Counted rather than split: a five megabyte file would otherwise become an
    // array of a hundred thousand strings to answer a question about a number.
    let lines = 1;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
      lines += 1;
      if (lines > MAX_UPLOAD_LINES) {
        return { reason: 'lines', limit: MAX_UPLOAD_LINES, found: lines };
      }
    }
  }

  return null;
}
