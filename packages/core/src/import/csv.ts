/**
 * A delimited-text reader, written rather than depended on.
 *
 * `packages/core` must keep working with no browser, no server and no network,
 * and every dependency it takes needs a reason (CONTRIBUTING). A CSV parser is
 * forty lines and the rules are fixed by RFC 4180, so the reason is thin - and
 * the file formats banks emit are exactly where a surprising dependency update
 * would be least welcome.
 *
 * What it handles, because real exports contain all of them:
 *
 * - a delimiter that is not a comma (Trade Republic uses `;`, and so does most
 *   of continental Europe, where the comma is a decimal separator)
 * - quoted fields containing the delimiter, a newline, or a quote doubled to
 *   escape itself
 * - CRLF and LF, mixed within one file
 * - a UTF-8 byte order mark, which Excel writes and which otherwise becomes
 *   part of the first column's name
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  // The BOM is stripped once, here, rather than defended against by every
  // caller comparing header names.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const char = input[index]!;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF and a lone CR both end the row; the LF is consumed with it.
      endRow();
      index += input[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file that does not end in a newline still has a last row, and one that
  // does must not gain an empty one.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * The same, as records keyed by the header row.
 *
 * Rows shorter than the header get empty strings rather than `undefined`: a
 * trailing empty column is routinely omitted by exporters, and every caller
 * treating that as a different kind of nothing is a caller that will get it
 * wrong once.
 */
export function parseRecords(
  text: string,
  delimiter = ',',
): { header: readonly string[]; records: readonly Record<string, string>[] } {
  const rows = parseDelimited(text, delimiter);
  const [header, ...rest] = rows;
  if (header === undefined) return { header: [], records: [] };

  const records = rest
    // A blank final line is not a record. Exporters end files with one.
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));

  return { header, records };
}
