import 'server-only';
import ExcelJS from 'exceljs';
import { MAX_UPLOAD_COLUMNS, MAX_UPLOAD_LINES } from '@altitude/shared';

/**
 * A spreadsheet, turned into the delimited text everything else already reads.
 *
 * The plan puts XLSX in v1 (§8.1) and it enters differently from the other
 * three: it is not text, so it cannot be decoded in the browser and sent as a
 * string. The file itself crosses to the server, one sheet becomes CSV, and
 * from that moment the run is a CSV run - the same mapping screen, the same
 * presets, the same fingerprint keyed on the header, the same everything.
 *
 * Converting rather than writing a fifth reader is the point. A bank's
 * spreadsheet is a bank's CSV with formatting on top: one row per movement,
 * columns nobody named yet. A reader of its own would be a second place for
 * every decision the mapping screen already makes.
 *
 * Here rather than in `packages/core` because of the dependency. The core takes
 * one with a reason (CONTRIBUTING), and reading a zip archive full of XML is a
 * reason to keep a large library at the application's edge instead - where it
 * is behind a Server Action and never reaches a browser bundle.
 */

/** Why a spreadsheet was not read. Rendered by the caller, in the reader's language. */
export type SpreadsheetRefusal =
  | { readonly reason: 'unreadable' }
  | { readonly reason: 'empty' }
  | { readonly reason: 'tooLarge'; readonly limit: number }
  | { readonly reason: 'tooManyRows'; readonly limit: number }
  | { readonly reason: 'tooManyColumns'; readonly limit: number };

export interface SheetReading {
  /** The chosen sheet, as RFC 4180 text. */
  readonly text: string;
  /** Every sheet holding anything, in the workbook's own order. */
  readonly sheets: readonly string[];
  /** Which of them this text came from. */
  readonly sheet: string;
}

/**
 * What the archive may claim to hold, uncompressed.
 *
 * The plan asks for streamed reading and a 500 MB ceiling (§8.7). ExcelJS
 * 4.4.0 ships a streaming reader that throws on any workbook it is given here,
 * so the reading is not streamed and the ceiling has to be one a process can
 * survive holding: 50 MB of sheet XML is already far past the row cap below,
 * and a zip that claims more than that is refused before it is opened.
 *
 * Not a complete defence on its own - a crafted archive can under-declare -
 * which is why the upload is capped at five megabytes compressed before any of
 * this runs. Together they bound a zip bomb to something a laptop shrugs off.
 */
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;

export async function readSpreadsheet(
  bytes: Uint8Array,
  wanted?: string,
): Promise<SheetReading | SpreadsheetRefusal> {
  const declared = declaredSize(bytes);
  if (declared === null) return { reason: 'unreadable' };
  if (declared > MAX_UNCOMPRESSED) return { reason: 'tooLarge', limit: MAX_UNCOMPRESSED };

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    // A zip that is not a workbook, or one this version cannot parse. Nothing
    // useful to say beyond that, and the message names the file rather than
    // the library.
    return { reason: 'unreadable' };
  }

  const sheets = workbook.worksheets.filter((sheet) => sheet.rowCount > 0);
  if (sheets.length === 0) return { reason: 'empty' };

  // The one asked for, or the first with anything in it. A workbook whose
  // first sheet is a cover page is common enough that "the first" would be the
  // wrong default; "the first with rows" is right nearly always, and the
  // screen offers the others when there is more than one.
  const chosen = sheets.find((sheet) => sheet.name === wanted) ?? sheets[0]!;

  if (chosen.rowCount > MAX_UPLOAD_LINES) {
    return { reason: 'tooManyRows', limit: MAX_UPLOAD_LINES };
  }
  if (chosen.columnCount > MAX_UPLOAD_COLUMNS) {
    return { reason: 'tooManyColumns', limit: MAX_UPLOAD_COLUMNS };
  }

  const lines: string[] = [];
  const columns = chosen.columnCount;

  chosen.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let at = 1; at <= columns; at += 1) cells.push(field(row.getCell(at).value));

    // A row of nothing is layout in a spreadsheet, the way a blank line is in a
    // CSV. Kept rather than dropped, so the line numbers the preview points at
    // are the ones Excel shows in its own margin.
    lines.push(cells.map(quote).join(','));
  });

  return {
    text: `${lines.join('\n')}\n`,
    sheets: sheets.map((sheet) => sheet.name),
    sheet: chosen.name,
  };
}

/**
 * One cell as text, which is where Excel's classic trap lives.
 *
 * A date in a spreadsheet is a number - days since 1900, with a bug about 1900
 * itself - and every library that hands it over as one turns a statement into
 * forty thousand five-digit integers. ExcelJS resolves it to a `Date`, so the
 * job here is to write it back in a form the date reader cannot misread: ISO,
 * which `detectDateOrder` settles outright rather than asking about.
 */
function field(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) return stamp(value);

  if (typeof value === 'object') {
    // A formula's value is what the sheet shows, and what the sheet shows is
    // what a person reconciled against.
    if ('result' in value) return field(value.result ?? null);
    if ('richText' in value) return value.richText.map((part) => part.text).join('');
    // A hyperlink's text, not its target: a bank that links a transaction to
    // its detail page still wrote the label a person reads.
    if ('text' in value) return String(value.text);
    if ('error' in value) return String(value.error);
    return '';
  }

  return String(value);
}

/**
 * A date, written the only way that cannot be read two ways.
 *
 * The time is kept when there is one, because a statement that carries it uses
 * it to order two movements on one day - and `dayPart` drops it again when the
 * date is read (ADR-0006).
 */
function stamp(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith('T00:00:00.000Z')
    ? iso.slice(0, 10)
    : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** RFC 4180, which is what `parseDelimited` reads back on the other side. */
function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * What the archive says it holds, from its own index.
 *
 * A zip ends with a central directory listing every entry and its uncompressed
 * size. Reading it costs nothing and answers the question that matters before
 * any of it is expanded: how much would this become.
 *
 * Null when the file is not a zip at all, which is also the answer to "can this
 * be a workbook".
 */
function declaredSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record, searched backwards: it is the last
  // thing in the file except for a comment, which may be up to 64 KB.
  const floor = Math.max(0, bytes.length - (0xffff + 22));
  let eocd = -1;
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) return null;

  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  let total = 0;

  for (let seen = 0; seen < entries; seen += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;

    total += view.getUint32(at + 24, true);
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }

  return total;
}
