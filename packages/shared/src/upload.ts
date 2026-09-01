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
 * large broker export. Fifty thousand lines is past what anybody has.
 *
 * Here rather than in `core` because the browser has to refuse before it
 * sends: a file rejected after a five megabyte upload is a file rejected too
 * late, and `core` reaches the database, so a client component cannot import
 * it (ADR-0007 keeps that boundary tested).
 */

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

  if (text !== undefined) {
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
