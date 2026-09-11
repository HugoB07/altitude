/**
 * A page of placed text, read back as the table it was drawn to look like.
 *
 * The plan defers PDF statements to v1.3 and says why: "fragile extraction,
 * high user expectations, poor value-to-risk ratio until the rest is solid"
 * (§8.1). Every word of that is true. It is being done anyway because the
 * README already records the reason - several French banks, Crédit Agricole
 * among them, offer a monthly statement as a PDF and little else, so for those
 * customers the alternative to a fragile reader is typing.
 *
 * The fragility is answered by where the line is drawn. A PDF has no table in
 * it. It has glyphs at coordinates, and a table is something a human eye infers
 * from how they line up - so this infers the same thing, hands back rows and
 * columns, and stops. Naming those columns stays the mapping screen's job, the
 * one every CSV already goes through, which means a wrong guess here is visible
 * in a preview and correctable by a person rather than silently imported.
 *
 * Nothing in this file knows what a PDF is. It takes placed text and returns
 * rows, which is why the whole of the interesting reasoning is testable without
 * a single PDF byte - and why the library that produces the coordinates stays
 * at the application's edge, where `packages/core` does not have to carry it.
 */

/** A run of text a page places somewhere, in points. */
export interface PlacedText {
  readonly text: string;
  /** Left edge, from the left of the page. */
  readonly x: number;
  /**
   * Baseline, from the *top* of the page: larger is further down.
   *
   * PDF's own origin is the bottom-left and its y grows upward. It is flipped
   * before it reaches here so that sorting by y is reading order, which is what
   * every line of this file assumes.
   */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedPage {
  readonly items: readonly PlacedText[];
  readonly width: number;
  readonly height: number;
}

/** One line of a page: the items on it, and where it sits. */
interface Line {
  readonly items: PlacedText[];
  /** Which page it came from, and how far down that page, for the rules below. */
  readonly page: number;
  readonly y: number;
  readonly pageHeight: number;
}

/**
 * How far apart two baselines can be and still be one line.
 *
 * A fraction of the text's own height rather than a number of points, because
 * a statement set in eight point and one set in twelve are the same document
 * with a different ruler. Six tenths is wide enough for the half-point of drift
 * a renderer introduces across a line and narrow enough never to swallow the
 * row below, which is set a full height away.
 */
const SAME_LINE = 0.6;

/**
 * The narrowest run of empty page that counts as a column break, in points.
 *
 * Five points is about two spaces at ten point type. Below that, the ordinary
 * word spacing inside a description would start splitting it into columns; well
 * above it, the gap between a date and a label in a tightly set statement stops
 * being seen at all.
 */
const MIN_GUTTER = 5;

/**
 * What share of lines may write into a gutter and leave it a gutter.
 *
 * Not zero, and this is the difference between working on a real statement and
 * on an invented one. Page one carries an address block and a title that run
 * clean across where the table's columns are; a rule wanting every line to
 * respect every gutter finds no gutters at all on exactly the files this
 * exists for.
 *
 * Eight per cent, which is loose, and it can afford to be: a stripe a real
 * column writes into is covered on most of the page's lines, not on a tenth of
 * them, so the two are nowhere near each other. What it does cost is a column
 * so sparse that fewer than a twelfth of the rows fill it - a separate debit
 * column on a statement of almost nothing but credits - which merges into its
 * neighbour, and which the mapping screen then shows as one column holding two
 * things. Visible and fixable, which is the trade this file keeps making.
 */
const GUTTER_TOLERANCE = 0.08;

/**
 * How much of a gap inside a column is a space rather than nothing.
 *
 * A PDF splits a word into runs wherever it likes - kerning, a font change, the
 * renderer's mood - so "CARREFOUR" arrives as `CARRE` and `FOUR` about as often
 * as it arrives whole. Joining runs with a space unconditionally is how a
 * categorisation rule stops matching a shop it matched last month. A quarter of
 * the line height is comfortably wider than kerning and narrower than a space.
 */
const SPACE_GAP = 0.25;

/** Where on a page a line has to be to count as a header or a footer. */
const MARGIN_BAND = 0.12;

export function readLayout(pages: readonly PlacedPage[]): string[][] {
  const all = withoutRunningHeads(pages.flatMap((page, at) => linesOf(page, at)));
  if (all.length === 0) return [];

  // The table, if one of the things on the page is one. Everything after this
  // works on the chosen lines alone, the gutters included, which is the whole
  // point: a letterhead reaches clean across where the table's columns are, and
  // asking the page as a whole where its columns sit gets the letterhead's
  // answer.
  const tables = pages.map((_, at) => tableOf(all.filter((line) => line.page === at)));
  const chosen = tables.flatMap((table) => table.lines);

  if (chosen.length === 0) {
    const boundaries = gutters(all);
    return joinWrapped(all.map((line) => cells(line, boundaries)));
  }

  const boundaries = gutters(chosen);
  const rows: string[][] = [];

  for (const table of tables) {
    const block = table.lines.map((line) => cells(line, boundaries));
    // A heading set on two lines is one heading. Left as two rows, the second
    // is a transaction with no date and no amount - "opé." and "valeur", in a
    // table of payments - which is both wrong and the first thing a person sees.
    if (table.headings > 0) rows.push(merged(block.slice(0, table.headings)));
    rows.push(...block.slice(table.headings));
  }

  return withoutTotals(joinWrapped(rows));
}

/**
 * The subtotals a statement rules off under its movements.
 *
 * "Total des opérations", "Ancien solde créditeur au 03.08.2026", "Nouveau
 * solde créditeur" - each carries amounts, so the table found them and was
 * right to, and none of them is a movement. Imported, they double a month's
 * spending; reported as problems, they are three lines a person is told to fix
 * and cannot.
 *
 * They are recognised by shape rather than by words, because the words are a
 * bank's and there are as many as there are banks. A movement is dated in the
 * table's own date column; a total is written across the label and the amounts
 * with the date column left empty - which is why it says "au 03.08.2026" in its
 * text at all.
 *
 * Applied only when that first column is one: at least seven rows in ten have
 * to be using it before anything is dropped for leaving it empty. A statement
 * that puts its label first and its date second loses nothing here.
 */
const DATED_ENOUGH = 0.7;

function withoutTotals(rows: readonly string[][]): string[][] {
  const dated = rows.filter((row) => (row[0] ?? '') !== '').length;
  if (dated < rows.length * DATED_ENOUGH) return [...rows];

  return rows.filter((row) => (row[0] ?? '') !== '');
}

/** Several rows as one, column by column, the way a reader joins a stacked heading. */
function merged(rows: readonly (readonly string[])[]): string[] {
  const width = Math.max(...rows.map((row) => row.length));

  return Array.from({ length: width }, (_, at) =>
    rows
      .map((row) => row[at] ?? '')
      .filter((cell) => cell !== '')
      .join(' '),
  );
}

/**
 * The table, picked out of everything else a statement puts on a page.
 *
 * A real statement is not a table. It is a letterhead, an address, a branch, a
 * reference block, *then* a table, and often a summary under it - each set in
 * its own shape. Read as one thing, the blocks fight: the address runs across
 * the table's gutters and destroys them, and the mapping screen is then offered
 * "018931 CENTRE-EST" as a row.
 *
 * So one block is chosen, and the one chosen is where the money is. A
 * transaction line carries an amount and the furniture around it does not, so
 * this takes the run of lines that is densest in amounts: each line scores one
 * for carrying an amount and minus one for not, and the highest-scoring
 * consecutive run wins. That tolerates the wrapped label and the subtotal
 * inside a table while refusing six lines of address above it.
 *
 * Per page rather than per document, because every sheet has its own furniture
 * and its own table. The columns are then measured across all the pieces
 * together, so the sheets still line up with each other.
 *
 * Not a guess that goes anywhere near a ledger. It decides what the mapping
 * screen is shown, and the mapping screen is a person looking at a preview.
 */
interface Table {
  readonly lines: readonly Line[];
  /** How many of them are the column heading rather than a movement. */
  readonly headings: number;
}

function tableOf(lines: readonly Line[]): Table {
  let bestScore = 0;
  let bestStart = 0;
  let bestEnd = -1;

  let score = 0;
  let start = 0;

  for (const [at, line] of lines.entries()) {
    const value = hasAmount(line) ? 1 : -1;

    // Restarted when the run has gone negative, not when it has merely levelled.
    // A wrapped label between two transactions takes the score to zero, and
    // restarting there cut the table off at precisely the row that proves the
    // wrapping works.
    if (score < 0) {
      score = value;
      start = at;
    } else {
      score += value;
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
      bestEnd = at;
    }
  }

  if (bestEnd === -1) return { lines: [], headings: 0 };

  const from = heading(lines, bestStart);
  return { lines: lines.slice(from, bestEnd + 1), headings: bestStart - from };
}

/**
 * Where the table starts once its column heading is counted in.
 *
 * The heading is the one piece of help a bank actually writes down - "Date",
 * "Libellé des opérations", "Débit", "Crédit" - and it is what the mapping
 * screen reads to offer a name for each column. Losing it costs a person the
 * only clue on the page.
 *
 * Up to two lines, because a narrow column is routinely set on two: "Date" with
 * "opé." under it, "Date" with "valeur". Taking one keeps the half that says
 * nothing. Taking more than two starts eating the letterhead.
 *
 * A heading line carries no amount and more than one thing on it, which is what
 * separates it from the wide single runs a letterhead is made of.
 */
const HEADING_LINES = 2;

function heading(lines: readonly Line[], start: number): number {
  let at = start;
  while (start - at < HEADING_LINES) {
    const above = lines[at - 1];
    if (above === undefined || hasAmount(above) || above.items.length < 2) break;
    at -= 1;
  }
  return at;
}

function hasAmount(line: Line): boolean {
  return line.items.some((item) => AMOUNT.test(item.text));
}

/**
 * The items of one page, grouped into lines.
 *
 * Sorted by y and then cut where the gap exceeds what one line allows. Items
 * within a line keep their own order for now; the column assignment sorts them
 * again, and doing it twice is cheaper than reasoning about which sort survived.
 */
function linesOf(page: PlacedPage, at: number): Line[] {
  const items = [...page.items]
    .filter((item) => item.text.trim() !== '')
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const lines: Line[] = [];
  let current: PlacedText[] = [];
  let top = 0;

  for (const item of items) {
    const height = item.height > 0 ? item.height : 10;

    if (current.length === 0 || Math.abs(item.y - top) <= height * SAME_LINE) {
      if (current.length === 0) top = item.y;
      current.push(item);
      continue;
    }

    lines.push({ items: current, page: at, y: top, pageHeight: page.height });
    current = [item];
    top = item.y;
  }

  if (current.length > 0) {
    lines.push({ items: current, page: at, y: top, pageHeight: page.height });
  }

  return lines;
}

/**
 * The page furniture, dropped.
 *
 * A statement repeats its letterhead and its "page 2 of 3" on every sheet, and
 * every one of those becomes a row with no date that the importer would report
 * as a problem - three problems on a three page statement, none of them the
 * person's to fix.
 *
 * Recognised by repetition rather than by content, because the content is a
 * bank's and this cannot know it: a line near the top or bottom edge whose text
 * appears on *every* page is furniture. Digits are collapsed first, so
 * "Page 1/3" and "Page 2/3" are seen as the same line, which they are.
 *
 * The first one is kept and the repeats dropped, rather than all of them. On a
 * statement of several sheets the line that repeats most usefully is the column
 * heading - "Date", "Libellé des opérations", "Débit", "Crédit" - which is the
 * one piece of help the bank wrote down and the only thing the mapping screen
 * can read a column's name from. Dropping every copy threw that away to tidy up
 * the copies.
 *
 * Three conditions decide what counts, all protecting the same thing: dropping
 * a real row would take money out of somebody's ledger. Furniture has to sit in
 * a margin, appear on every sheet, *and* carry no amount.
 *
 * The third is the one that earns its place, and it was a real bug before it
 * was a rule. Blanking the digits is what lets "Page 1 sur 3" and "Page 2 sur
 * 3" be recognised as one line - and it also makes "PRLV ABONNEMENT 9,99" on
 * January's sheet identical to the same subscription on February's. Both near
 * the top of their page, both on every page: both gone, and a person would be
 * looking for two missing direct debits with no idea where they went. A
 * letterhead, an address, a page number and a column heading have no amount on
 * them; every transaction does.
 */
function withoutRunningHeads(lines: readonly Line[]): Line[] {
  const pages = new Set(lines.map((line) => line.page)).size;
  if (pages < 2) return [...lines];

  const seen = new Map<string, Set<number>>();
  for (const line of lines) {
    if (!isFurniture(line)) continue;
    const key = shape(line);
    const pagesSeen = seen.get(key) ?? new Set<number>();
    pagesSeen.add(line.page);
    seen.set(key, pagesSeen);
  }

  const kept = new Set<string>();
  return lines.filter((line) => {
    if (!isFurniture(line)) return true;

    const key = shape(line);
    if ((seen.get(key)?.size ?? 0) < pages) return true;

    // The first of them, and none of the rest.
    if (kept.has(key)) return false;
    kept.add(key);
    return true;
  });
}

/**
 * A number written the way money is: a decimal separator and two digits.
 *
 * Deliberately generous about what precedes it, so a thousands separator of any
 * kind counts, and deliberately blind to the sign and the currency, which sit
 * outside the run as often as inside it. A dotted date matches too, which is
 * the harmless direction: it only ever means a line is kept.
 */
const AMOUNT = /\d[\d\s  .']*[.,]\d{2}(?!\d)/u;

function isFurniture(line: Line): boolean {
  const band = line.pageHeight * MARGIN_BAND;
  if (line.y > band && line.y < line.pageHeight - band) return false;

  return !line.items.some((item) => AMOUNT.test(item.text));
}

/** A line's text with its numbers blanked, so a page number matches itself. */
function shape(line: Line): string {
  return line.items
    .map((item) => item.text)
    .join(' ')
    .replace(/\d+/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Where the columns are, from the vertical runs of empty page between them.
 *
 * The eye finds a table's columns in the white, not the ink, and so does this.
 * Every line's ink is marked along the width of the page; the stripes almost
 * nothing writes into are the gutters; a column boundary is the middle of one.
 *
 * Reading the white rather than the ink is what makes a right-aligned amount
 * column work. Aligning on left edges - the obvious thing - puts every amount
 * of a different length in a different column, which on a real statement is
 * most of them.
 *
 * Computed across every page at once rather than per page, so a three page
 * statement produces one table. Per page, page two's columns would land a
 * fraction elsewhere and the rows would no longer line up with page one's.
 */
function gutters(lines: readonly Line[]): number[] {
  let right = 0;
  for (const line of lines) {
    for (const item of line.items) right = Math.max(right, item.x + item.width);
  }

  const width = Math.ceil(right) + 1;
  const ink = new Array<number>(width).fill(0);

  for (const line of lines) {
    // Per line, not per item: two items overlapping a bin are one line's worth
    // of ink, and counting them twice would make a column look busier than the
    // page it is on.
    const covered = new Set<number>();
    for (const item of line.items) {
      const from = Math.max(0, Math.floor(item.x));
      const to = Math.min(width - 1, Math.ceil(item.x + item.width));
      for (let bin = from; bin <= to; bin += 1) covered.add(bin);
    }
    for (const bin of covered) ink[bin] = (ink[bin] ?? 0) + 1;
  }

  // At least one, so a short page is not held to a stricter rule than a long
  // one purely because a fraction of it rounds to nothing.
  const allowed = Math.max(1, Math.floor(lines.length * GUTTER_TOLERANCE));

  const found: number[] = [];
  let run = -1;
  for (let bin = 0; bin < width; bin += 1) {
    const clear = (ink[bin] ?? 0) <= allowed;

    if (clear && run === -1) run = bin;
    if (!clear && run !== -1) {
      // The left margin is not a column break: nothing is to the left of it.
      if (run > 0 && bin - run >= MIN_GUTTER) found.push((run + bin) / 2);
      run = -1;
    }
  }

  return found;
}

/**
 * One line, distributed into the columns the page's gutters define.
 *
 * By the centre of each run rather than by its left edge, so a number that
 * starts inside one column and ends inside the next - which happens when a
 * total is wider than the column it belongs to - lands where most of it is.
 */
function cells(line: Line, boundaries: readonly number[]): string[] {
  const row = new Array<PlacedText[]>(boundaries.length + 1);
  for (let at = 0; at <= boundaries.length; at += 1) row[at] = [];

  for (const item of line.items) {
    const centre = item.x + item.width / 2;
    let column = 0;
    while (column < boundaries.length && centre > boundaries[column]!) column += 1;
    row[column]!.push(item);
  }

  return row.map(runs);
}

/** The runs of one cell, in order, with a space only where the page left one. */
function runs(items: readonly PlacedText[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);

  let text = '';
  let end = 0;
  let height = 10;

  for (const item of sorted) {
    if (item.height > 0) height = item.height;
    const gap = item.x - end;
    if (text !== '' && gap > height * SPACE_GAP) text += ' ';
    text += item.text;
    end = item.x + item.width;
  }

  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * A description that ran onto the next line, put back on its own row.
 *
 * A statement writes a long label across two lines and only the first carries a
 * date and an amount. Left alone, the second becomes a row the importer cannot
 * read and reports as a problem, and the half of the label it holds is lost.
 *
 * The rule is deliberately narrow, because the alternative to being narrow here
 * is gluing a running total onto the transaction above it. A line joins the one
 * before it only when it has exactly one cell filled, that cell is not the
 * first column - a row that begins at the left margin is a new row, not a
 * continuation - and the line above has at least two.
 */
function joinWrapped(rows: readonly string[][]): string[][] {
  const joined: string[][] = [];

  for (const row of rows) {
    const filled = row.map((cell, at) => (cell === '' ? -1 : at)).filter((at) => at !== -1);
    const previous = joined[joined.length - 1];

    const continues =
      filled.length === 1 &&
      filled[0] !== 0 &&
      previous !== undefined &&
      previous.filter((cell) => cell !== '').length >= 2 &&
      previous[filled[0]!] !== '';

    if (continues) {
      const at = filled[0]!;
      previous[at] = `${previous[at]!} ${row[at]!}`.trim();
      continue;
    }

    joined.push([...row]);
  }

  return joined;
}

/**
 * Rows as RFC 4180 text, which is what `parseDelimited` reads back.
 *
 * Here rather than beside each caller because there are two of them now - a
 * spreadsheet and a page of placed text - and a quoting rule written twice is a
 * quoting rule that disagrees with itself the first time somebody's description
 * contains a comma.
 */
export function writeDelimited(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.map(quote).join(',')).join('\n')}\n`;
}

function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
