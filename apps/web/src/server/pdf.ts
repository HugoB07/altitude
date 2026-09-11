import 'server-only';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { readLayout, writeDelimited, type PlacedPage, type PlacedText } from '@altitude/core';

/**
 * A PDF statement, turned into the delimited text everything else already reads.
 *
 * The same shape as the spreadsheet reader beside it, and for the same reason:
 * a format that is not text crosses to the server as a file, becomes a CSV
 * here, and from that moment the run is a CSV run - the same mapping screen,
 * the same presets, the same fingerprint, the same everything. Which is also
 * the answer to the plan's objection. §8.1 defers PDF to v1.3 on "fragile
 * extraction, high user expectations", and both halves of that are true of a
 * reader that files transactions on its own. This one does not: it turns a page
 * into rows and stops, and a person names the columns and reads a preview
 * before a single line is written.
 *
 * This file is only the adapter. Every judgement about where a table's rows and
 * columns are lives in `packages/core/src/import/layout.ts`, with no dependency
 * and a test suite that draws pages by hand - so what is here is a coordinate
 * flip, some caps, and the four ways a PDF can arrive unreadable.
 */

/** Why a PDF was not read. Rendered by the caller, in the reader's language. */
export type PdfRefusal =
  | { readonly reason: 'unreadable' }
  /** This server cannot read PDFs right now. Not the file's fault, and not said to be. */
  | { readonly reason: 'unavailable' }
  | { readonly reason: 'encrypted' }
  | { readonly reason: 'noTextLayer' }
  | { readonly reason: 'empty' }
  | { readonly reason: 'tooManyPages'; readonly limit: number };

export interface PdfReading {
  /** The reconstructed table, as RFC 4180 text. */
  readonly text: string;
  readonly pages: number;
}

/**
 * How many sheets one statement may be.
 *
 * A year of a busy current account is twenty or thirty; a hundred is past
 * anything a bank issues as one statement, and a page count is the cheapest
 * thing in a PDF to inflate - it is a number in the catalogue, and every page
 * past it costs a parse and a text extraction (§8.7, memory exhaustion).
 */
const MAX_PAGES = 100;

/**
 * How many runs of text, across the document.
 *
 * The other half of the same cap, and the one that actually binds: a page can
 * hold a hundred thousand one-character runs and still be one page. Two hundred
 * thousand is far past a statement and far below what a laptop notices.
 */
const MAX_ITEMS = 200_000;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfJs> | undefined;

/**
 * pdf.js, loaded the first time a PDF arrives rather than when this module is.
 *
 * This is a real bug's fix before it is a performance note. `import-actions.ts`
 * imports this file, and imported pdf.js at the top along with it - so when
 * pdf.js failed to load under the application's bundle, every action in that
 * module failed with it, and a CSV import sat on "Reading the file..." forever.
 * A heavy optional dependency gets to break the feature that uses it and
 * nothing else, and loading it here is what draws that line.
 *
 * A failed load is not remembered, so a transient one does not stick for the
 * life of the process.
 */
function pdfjs(): Promise<PdfJs> {
  loading ??= import('pdfjs-dist/legacy/build/pdf.mjs').catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

/**
 * pdf.js's own font data, found on disk rather than fetched.
 *
 * Without it pdf.js maps standard-font text through a fallback and says so in a
 * warning. With it, nothing warns. It is a nicety either way, which is why a
 * failure to find it returns undefined rather than failing the read.
 *
 * Resolved from the working directory and emphatically not from
 * `import.meta.url`. Under the application's bundle that is a module id - a
 * number - and `createRequire` throws "The path argument must be of type
 * string" on it. Caught, that surfaced as every statement in the world being
 * "not a PDF Altitude can open", which is the kind of wrong answer that costs
 * an evening.
 */
function standardFonts(): string | undefined {
  try {
    const from = createRequire(join(process.cwd(), 'package.json'));
    return `${join(dirname(from.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;
  } catch {
    return undefined;
  }
}

export async function readPdf(bytes: Uint8Array): Promise<PdfReading | PdfRefusal> {
  let lib: PdfJs;
  try {
    lib = await pdfjs();
  } catch (error) {
    // Where an operator can find it. The person is told the server cannot
    // read PDFs, which is true, rather than that their file is not one, which
    // is what this said for a while and was not.
    console.error('[altitude] pdf.js could not be loaded', error);
    return { reason: 'unavailable' };
  }

  const { getDocument, InvalidPDFException, PasswordException, Util, VerbosityLevel } = lib;

  const fonts = standardFonts();

  const task = getDocument({
    // A copy, because pdf.js transfers the buffer it is given to its worker and
    // the caller still owns this one.
    data: new Uint8Array(bytes),
    ...(fonts === undefined ? {} : { standardFontDataUrl: fonts }),
    /**
     * The settings §8.7 asks for, named rather than left at their defaults.
     *
     * A PDF is a program as much as a document: it can carry font programs that
     * get compiled, an XFA forms engine that is XML and JavaScript, and
     * document-level scripts. None of that is needed to read where the text is,
     * so none of it is switched on - and a default that changes in a future
     * version cannot switch it on either, because the answer is written here.
     *
     * The plan's wording expects an `isEvalSupported` flag, which every guide
     * to hardening pdf.js still names. There is no such option in version 6:
     * the eval path for font programs was removed rather than defaulted off, so
     * the guarantee is stronger than a setting and there is nothing here to
     * pin. Left as a note because its absence otherwise reads as an omission.
     */
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    // Warnings are for a viewer to act on. Here they are noise in a server log
    // for a file somebody is about to see a preview of anyway.
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      // Named apart from every other failure because it is the one a person can
      // do something about, and "unreadable file" would send them looking for a
      // problem with their bank rather than for the password they already have.
      if (error instanceof PasswordException) return { reason: 'encrypted' };
      // A file that is not a PDF, or one too damaged to open. Their file.
      if (error instanceof InvalidPDFException) return { reason: 'unreadable' };
      // Anything else is ours, and was being reported as the first kind.
      console.error('[altitude] pdf.js could not open a document', error);
      return { reason: 'unavailable' };
    }

    if (document.numPages === 0) return { reason: 'empty' };
    if (document.numPages > MAX_PAGES) return { reason: 'tooManyPages', limit: MAX_PAGES };

    const pages: PlacedPage[] = [];
    let items = 0;

    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      items += content.items.length;
      if (items > MAX_ITEMS) return { reason: 'tooManyPages', limit: MAX_PAGES };

      pages.push({
        items: content.items.flatMap((item) => placed(item, viewport.transform, Util)),
        width: viewport.width,
        height: viewport.height,
      });

      page.cleanup();
    }

    if (pages.every((page) => page.items.length === 0)) {
      // A scan. The pages are images of a statement and there is no text in
      // them at all, which is a different thing from a file this cannot parse -
      // and the only honest answer is that reading it needs OCR, which is not
      // here. Said plainly, because "unreadable" would have somebody trying the
      // same file again.
      return { reason: 'noTextLayer' };
    }

    const rows = readLayout(pages);
    if (rows.length === 0) return { reason: 'empty' };

    return { text: writeDelimited(rows), pages: document.numPages };
  } catch (error) {
    // A document that opened and then failed partway through a page. Possibly
    // the file, possibly not, and in both cases worth the log line.
    console.error('[altitude] pdf.js failed while reading a document', error);
    return { reason: 'unreadable' };
  } finally {
    // The loading task owns the worker, not the document, and it owns one
    // whether or not the document ever opened - so this has to cover the
    // refusals too. A task left alive keeps its worker for the life of the
    // process, which on a server is one per import until it runs out.
    await task.destroy().catch(() => undefined);
  }
}

/**
 * One run of text, in the coordinates `readLayout` works in.
 *
 * Two things happen here. The position goes through the page's own viewport
 * transform, which flips PDF's bottom-left origin to a top-left one and
 * applies any rotation the page declares - so sorting by y is reading order,
 * which is what every rule in `layout.ts` assumes.
 *
 * And the empty runs go. pdf.js synthesises a space item wherever it sees a
 * horizontal gap, which is well meant and exactly wrong here: those synthetic
 * runs sit in the gutters between columns, and gutters are how the columns are
 * found at all. Left in, they ink over every boundary on the page and a
 * statement comes back as one column.
 */
function placed(item: unknown, transform: readonly number[], util: PdfJs['Util']): PlacedText[] {
  if (!isText(item) || item.str.trim() === '') return [];

  const placement = util.transform(transform, item.transform) as number[];

  return [
    {
      text: item.str,
      x: placement[4] ?? 0,
      y: placement[5] ?? 0,
      width: item.width,
      // The rendered height, which pdf.js reports as zero for a run it
      // synthesised and occasionally for one it did not.
      height: item.height > 0 ? item.height : Math.abs(placement[3] ?? 0),
    },
  ];
}

function isText(item: unknown): item is TextItem {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}
