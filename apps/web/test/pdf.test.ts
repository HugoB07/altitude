import { describe, expect, it } from 'vitest';
import { parseDelimited } from '@altitude/core';
import { readPdf } from '../src/server/pdf';

/**
 * The adapter between pdf.js and the layout reader, on real PDF bytes.
 *
 * `packages/core/test/layout.test.ts` covers every judgement about where a
 * table's rows and columns are, by drawing pages directly. What is left for
 * this file is the join: that a real document's coordinates arrive the right
 * way up, that the four refusals are told apart, and above all that pdf.js's
 * own habits do not undo the reading.
 *
 * The documents below are written by hand rather than produced by a library.
 * A PDF that holds one page of positioned text is a hundred lines of ASCII, and
 * writing them keeps a PDF *writer* out of the dependency list for the sake of
 * testing a reader.
 *
 * Every figure is invented.
 */

/** One run of text: where its left edge sits, how far down the page, and what it says. */
type Run = readonly [x: number, y: number, text: string];

const PAGE_HEIGHT = 842;

/**
 * A PDF, assembled around a content stream.
 *
 * `y` is given from the top, as a reader sees it, and flipped here into PDF's
 * own bottom-left origin - so a fixture reads in the order the page does and
 * the flip is exercised rather than assumed.
 */
function pdf(pages: readonly (readonly Run[])[], trailerExtra = '', encrypt = ''): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];

  // 1 is the catalogue and 2 the page tree; the rest follow.
  const fontId = 3;
  let next = 4;

  for (const runs of pages) {
    const content = [
      'BT /F1 10 Tf',
      ...runs.map(
        ([x, y, text]) => `1 0 0 1 ${String(x)} ${String(PAGE_HEIGHT - y)} Tm (${text}) Tj`,
      ),
      'ET',
    ].join('\n');

    const contentId = next;
    next += 1;
    const pageId = next;
    next += 1;

    objects[contentId] = `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${String(PAGE_HEIGHT)}] ` +
      `/Contents ${String(contentId)} 0 R ` +
      `/Resources << /Font << /F1 ${String(fontId)} 0 R >> >> >>`;
    pageIds.push(pageId);
  }

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] ` +
    `/Count ${String(pageIds.length)} >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  if (encrypt !== '') objects[next] = encrypt;
  const encryptId = next;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  const highest = encrypt === '' ? next - 1 : next;

  for (let id = 1; id <= highest; id += 1) {
    offsets[id] = out.length;
    out += `${String(id)} 0 obj\n${objects[id] ?? '<< >>'}\nendobj\n`;
  }

  const startxref = out.length;
  out += `xref\n0 ${String(highest + 1)}\n0000000000 65535 f \n`;
  for (let id = 1; id <= highest; id += 1) {
    out += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out +=
    `trailer\n<< /Size ${String(highest + 1)} /Root 1 0 R` +
    (encrypt === '' ? '' : ` /Encrypt ${String(encryptId)} 0 R`) +
    `${trailerExtra} >>\nstartxref\n${String(startxref)}\n%%EOF`;

  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** Enough ordinary rows for the page's ink to say where its columns are. */
function body(from: number, count: number): Run[] {
  return Array.from({ length: count }, (_, at) => {
    const y = from + at * 14;
    return [
      [40, y, `${String((at % 28) + 1).padStart(2, '0')}/02/2026`],
      [110, y, 'CARTE INVENTE'],
      [500, y, '-10,00'],
    ] as Run[];
  }).flat();
}

/**
 * Read back the way the importer reads it.
 *
 * With `split(',')` rather than the real parser, `-42,10` is two columns and
 * every assertion below is about the helper instead of about the reader. It
 * cost three failures to notice.
 */
function rows(text: string): string[][] {
  return parseDelimited(text).filter((row) => row.some((cell) => cell !== ''));
}

describe('a statement laid out as a page of text', () => {
  it('comes back as the table a reader sees', async () => {
    const read = await readPdf(
      pdf([
        [
          [40, 70, 'Date'],
          [110, 70, 'Libelle'],
          [500, 70, 'Montant'],
          [40, 84, '05/01/2026'],
          [110, 84, 'CARTE SUPERMARCHE INVENTE'],
          [500, 84, '-42,10'],
          ...body(98, 30),
        ],
      ]),
    );

    expect('reason' in read).toBe(false);
    if ('reason' in read) return;

    const table = rows(read.text);
    expect(read.pages).toBe(1);
    expect(table[0]).toEqual(['Date', 'Libelle', 'Montant']);
    expect(table[1]).toEqual(['05/01/2026', 'CARTE SUPERMARCHE INVENTE', '-42,10']);
  });

  it('keeps the columns pdf.js papers over with spaces of its own', async () => {
    /**
     * The finding this test exists for. pdf.js synthesises a text item holding
     * a single space wherever it sees a horizontal gap - and a horizontal gap
     * between two columns is precisely the gutter the columns are found by. Left
     * in, those synthetic runs ink over every boundary on the page and a
     * three-column statement comes back as one column of glued-together text.
     */
    const read = await readPdf(pdf([body(70, 40)]));

    expect('reason' in read).toBe(false);
    if ('reason' in read) return;

    const table = rows(read.text);
    expect(table.every((row) => row.length === 3)).toBe(true);
    expect(table[0]).toEqual(['01/02/2026', 'CARTE INVENTE', '-10,00']);
  });

  it('reads the pages in order and gives them one set of columns', async () => {
    const read = await readPdf(
      pdf([
        body(70, 30),
        [
          [40, 70, '28/02/2026'],
          [110, 70, 'VIREMENT SALAIRE'],
          [500, 70, '1 800,00'],
          ...body(84, 30),
        ],
      ]),
    );

    expect('reason' in read).toBe(false);
    if ('reason' in read) return;

    const table = rows(read.text);
    expect(read.pages).toBe(2);
    expect(new Set(table.map((row) => row.length))).toEqual(new Set([3]));
    expect(table[30]).toEqual(['28/02/2026', 'VIREMENT SALAIRE', '1 800,00']);
  });

  it('puts the top of the page first, which PDF does not', async () => {
    // PDF's origin is the bottom-left and its y grows upward, so an untouched
    // sort by y reads a statement from December back to January.
    const read = await readPdf(
      pdf([
        [
          [40, 70, 'PREMIERE'],
          [110, 70, 'LIGNE'],
          [500, 70, '-1,00'],
          ...body(84, 30),
          [40, 520, 'DERNIERE'],
          [110, 520, 'LIGNE'],
          [500, 520, '-2,00'],
        ],
      ]),
    );

    expect('reason' in read).toBe(false);
    if ('reason' in read) return;

    const table = rows(read.text);
    expect(table[0]?.[0]).toBe('PREMIERE');
    expect(table[table.length - 1]?.[0]).toBe('DERNIERE');
  });
});

describe('a PDF this cannot read', () => {
  it('says so when the file is not a PDF at all', async () => {
    const read = await readPdf(new Uint8Array(Buffer.from('Date;Libelle;Montant\n', 'latin1')));

    expect(read).toEqual({ reason: 'unreadable' });
  });

  it('names a scan rather than calling it unreadable', async () => {
    // A statement photographed or scanned has no text layer at all: its pages
    // are images. Reading it needs OCR, which is not here, and "unreadable"
    // would have somebody trying the same file again tomorrow.
    const read = await readPdf(pdf([[]]));

    expect(read).toEqual({ reason: 'noTextLayer' });
  });

  it('names a document that wants a password', async () => {
    // The one failure a person can act on. Told apart so the answer is "this
    // file is locked" rather than "this file is broken".
    const read = await readPdf(
      pdf(
        [body(70, 5)],
        ' /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]',
        '<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 ' +
          '/O <0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF> ' +
          '/U <FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210> >>',
      ),
    );

    expect(read).toEqual({ reason: 'encrypted' });
  });
});
