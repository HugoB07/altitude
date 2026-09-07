/**
 * The tag languages a statement arrives in, read as one tree.
 *
 * Three of the formats the plan lists are markup of some kind (§8.1): OFX 1.x
 * is SGML, OFX 2.x is XML, and CAMT.053 is XML with namespaces and attributes.
 * They differ in what they are allowed to leave out, and in nothing else that
 * matters to a reader looking for a date and an amount.
 *
 * One rule covers all three: a tag holding text is a leaf, and its text closes
 * it. A `</TAG>` for something already closed that way is skipped, which is
 * every closing tag in an XML file and none in an SGML one. Nothing downstream
 * has to know which dialect it is looking at.
 *
 * Written here rather than taken from a library, for the reason CONTRIBUTING
 * gives: `packages/core` takes a dependency with a reason, and an XML parser
 * would be one more thing to keep current for formats that have not changed in
 * a decade - and one that would want configuring against entity expansion
 * (§8.7) rather than simply not having entities. What this does with `<!ENTITY`
 * is skip it, and what it does with `&anything;` it was not taught is leave it
 * as written. `packages/core/test/entities.test.ts` is the regression test the
 * plan asks for by name.
 *
 * Tolerant on purpose. These are formats real banks emit imperfectly, and a
 * parser that threw on a stray tag would refuse a file whose four hundred
 * transactions are all perfectly readable.
 */

/** A tag, its text if it is a leaf, its attributes, and where it started. */
export interface MarkupNode {
  /**
   * Uppercased, with any namespace prefix dropped.
   *
   * Uppercased because OFX writes `TRNAMT` and CAMT writes `Ntry`, and one
   * convention here means one convention at every lookup. The prefix goes
   * because `<ns2:Ntry>` and `<Ntry>` are the same element and only the writer
   * knows why it chose one - ISO 20022 files from two banks disagree about it
   * routinely.
   */
  readonly tag: string;
  value: string;
  readonly line: number;
  /** Uppercased keys. `EMPTY` when the tag had none, which is most of them. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: MarkupNode[];
}

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

export function readMarkup(text: string): MarkupNode {
  const root: MarkupNode = { tag: '', value: '', line: 1, attributes: EMPTY, children: [] };
  const stack: MarkupNode[] = [root];

  // Everything before the first tag: an XML declaration, or OFX 1.x's block of
  // `KEY:VALUE` lines saying how the file is encoded, which is a question
  // already answered by the time this reads a string.
  let at = text.indexOf('<');
  if (at === -1) return root;
  let line = 1 + count(text.slice(0, at));

  while (at < text.length) {
    if (text[at] === '<') {
      // The first `>`, which is wrong only for an attribute value holding one
      // unescaped. XML permits that and no bank writes it.
      const close = text.indexOf('>', at);
      if (close === -1) break;

      const body = text.slice(at + 1, close).trim();
      // Where the tag opened, not where it ended: a node's line is what the
      // preview points at, and pointing past a tag that wrapped is worse than
      // not pointing at all.
      const opened = line;
      line += count(text.slice(at, close));
      at = close + 1;

      // `<?xml ...?>`, `<?OFX ...?>`, `<!-- -->`, and `<!DOCTYPE ...>` with
      // whatever internal subset it drags behind it. None of them opens or
      // closes an element, and a document type declaration is the one thing
      // this must never act on (§8.7).
      if (body.startsWith('?') || body.startsWith('!')) continue;

      if (body.startsWith('/')) {
        const name = clean(body.slice(1));
        // Popped only if it is still open. In XML the value already closed it.
        if (stack.some((node) => node.tag === name)) {
          while (stack.length > 1 && stack.pop()!.tag !== name);
        }
        continue;
      }

      // `<TAG/>`, which carries nothing worth keeping.
      if (body.endsWith('/')) continue;

      const cut = body.search(/\s/u);
      const node: MarkupNode = {
        tag: clean(cut === -1 ? body : body.slice(0, cut)),
        value: '',
        line: opened,
        attributes: cut === -1 ? EMPTY : attributes(body.slice(cut + 1)),
        children: [],
      };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }

    const next = text.indexOf('<', at);
    const raw = text.slice(at, next === -1 ? text.length : next);
    line += count(raw);
    at = next === -1 ? text.length : next;

    const trimmed = raw.trim();
    // Whitespace between tags is layout, not a value - and treating it as one
    // would close every container the moment it was indented.
    if (trimmed === '') continue;

    const top = stack[stack.length - 1]!;
    // Appended rather than assigned. An element with two runs of text around a
    // child is mixed content, which none of these formats uses, but an SGML
    // file with a stray tag inside a description produces it - and keeping only
    // the last run would silently drop the front of somebody's label.
    top.value =
      top.value === '' ? decodeEntities(trimmed) : `${top.value} ${decodeEntities(trimmed)}`;
    if (stack.length > 1) stack.pop();
  }

  return root;
}

/** A tag or attribute name, without its namespace prefix and in one case. */
function clean(name: string): string {
  const trimmed = name.trim();
  const colon = trimmed.lastIndexOf(':');
  return (colon === -1 ? trimmed : trimmed.slice(colon + 1)).toUpperCase();
}

/**
 * `Ccy="EUR"`, which is where CAMT keeps the currency of every amount.
 *
 * Namespace declarations are dropped: `xmlns` and `xmlns:ns2` say which
 * dictionary the tags come from, and this reads tags by name whatever the
 * dictionary. Keeping them would put a URN in a record nothing reads.
 */
function attributes(body: string): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};

  for (const match of body.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"|([\w.:-]+)\s*=\s*'([^']*)'/gu)) {
    const name = match[1] ?? match[3] ?? '';
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    found[clean(name)] = decodeEntities(match[2] ?? match[4] ?? '');
  }

  return Object.keys(found).length === 0 ? EMPTY : found;
}

function count(text: string): number {
  let lines = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return lines;
}

/**
 * The five XML names every dialect agrees on, plus the one SGML files add.
 *
 * A closed table, and that is the point rather than an omission: an entity this
 * does not know is left exactly as it was written. A file declaring its own
 * `&secret;` in a `<!DOCTYPE>` gets back the six characters it sent, which is
 * what makes external entity expansion (§8.7) an operation this cannot perform
 * rather than one it has been asked not to.
 */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Where Unicode stops, and the surrogate range no text may contain on its own. */
const MAX_CODE_POINT = 0x10ffff;

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;

  // The digit counts are a limit, not a shape: `&#99999999999999;` matches
  // nothing and is left alone, rather than being parsed into a number no
  // character has.
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, body: string) => {
    if (!body.startsWith('#')) return NAMED[body.toLowerCase()] ?? whole;

    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);

    // Out of range, or half of a surrogate pair. Left as written rather than
    // thrown on: `String.fromCodePoint` raises a `RangeError`, and a lone
    // surrogate is text PostgreSQL refuses - either way one malformed
    // reference in a memo would take down a file of four hundred readable
    // transactions.
    if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;

    return String.fromCodePoint(code);
  });
}

export function child(node: MarkupNode, tag: string): MarkupNode | undefined {
  return node.children.find((one) => one.tag === tag);
}

/** A child's text, or the empty string. Absent and empty are the same question here. */
export function value(node: MarkupNode, tag: string): string {
  return child(node, tag)?.value ?? '';
}

/** Every descendant with this tag, in document order, not descending into a match. */
export function deep(node: MarkupNode, tag: string): MarkupNode[] {
  const found: MarkupNode[] = [];

  const walk = (current: MarkupNode) => {
    for (const one of current.children) {
      if (one.tag === tag) found.push(one);
      else walk(one);
    }
  };

  walk(node);
  return found;
}

/**
 * A path of single children, for a format that nests.
 *
 * ISO 20022 puts a creditor's name six elements down, and writing that as six
 * `child` calls guarded against `undefined` buries what is being asked for.
 */
export function descend(
  node: MarkupNode | undefined,
  ...tags: readonly string[]
): MarkupNode | undefined {
  let current = node;
  for (const tag of tags) {
    if (current === undefined) return undefined;
    current = child(current, tag);
  }
  return current;
}
