import { dec } from '@altitude/shared';

/**
 * Reading an amount as a bank wrote it.
 *
 * `dec('1 234,56')` is not a number, and `Number('1 234,56')` is NaN. Neither
 * failure is loud: a reader that drops unparseable rows silently loses a
 * month, and one that coerces reads a thousand euros as one. Every French
 * export needs this, and the plan lists it among the pitfalls to handle on day
 * one (§8.3).
 *
 * Nothing here rounds or scales. It normalises the writing of a number and
 * hands the result to `dec`, so precision is still ADR-0006's problem and not
 * this file's.
 */

/**
 * Spaces a number can be written with, none of which are a plain space.
 *
 * A French thousands separator is a narrow no-break space (U+202F) in anything
 * typeset properly, a no-break space (U+00A0) in most exports, and an ordinary
 * space in the rest. All three are removed; a separator is never meaningful
 * inside a number.
 */
const SPACES = /[\s   ]/g;

export interface ParsedAmount {
  readonly value: ReturnType<typeof dec>;
  /** True when the number was written in parentheses, meaning negative. */
  readonly wasBracketed: boolean;
}

/**
 * Reads an amount written in any of the ways a statement writes one.
 *
 * The decimal separator is decided per value by position, not by locale: the
 * *last* separator is the decimal one, and anything before it is a thousands
 * separator. `1,234.56` and `1.234,56` both come out as 1234.56 without anyone
 * declaring which country the file came from.
 *
 * The exception is a lone separator with exactly three digits after it, which
 * is ambiguous by construction - `1,234` is a thousand in one convention and
 * one-and-a-bit in the other. Read as thousands, which is what a statement
 * means: an amount of 1.234 euros is not a thing a bank writes, and a thousand
 * read as one is a mistake somebody notices immediately, where the reverse
 * hides in a balance.
 *
 * Parentheses mean negative. That is the Anglo-Saxon accounting convention and
 * it is common in broker exports; read as positive it flips the sign of every
 * debit in the file.
 */
export function parseAmount(raw: string): ParsedAmount | null {
  let text = raw.trim().replace(SPACES, '');
  if (text === '') return null;

  // Currency symbols and codes, which exports put inside the cell often enough
  // to matter. Removed before anything else looks at the shape.
  text = text.replace(/[€$£¥]|EUR|USD|GBP|CHF/gi, '').trim();

  const wasBracketed = /^\((.*)\)$/.test(text);
  if (wasBracketed) text = text.slice(1, -1).trim();

  // A sign written after the number, which some exports do: "45,00-".
  let sign = '';
  if (/^[+-]/.test(text)) {
    sign = text[0] === '-' ? '-' : '';
    text = text.slice(1);
  } else if (/[+-]$/.test(text)) {
    sign = text.endsWith('-') ? '-' : '';
    text = text.slice(0, -1);
  }

  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const cut = Math.max(lastComma, lastDot);

  let normalised: string;
  if (cut === -1) {
    normalised = text;
  } else {
    const after = text.length - cut - 1;
    const separators = (text.match(/[.,]/g) ?? []).length;

    // One separator, three digits after it, and nothing else: thousands. See
    // the note above about which way to be wrong.
    if (separators === 1 && after === 3) {
      normalised = text.replace(/[.,]/g, '');
    } else {
      normalised = `${text.slice(0, cut).replace(/[.,]/g, '')}.${text.slice(cut + 1)}`;
    }
  }

  try {
    const value = dec(`${sign}${normalised}`);
    if (value.isNaN()) return null;
    return { value: wasBracketed ? value.negated() : value, wasBracketed };
  } catch {
    return null;
  }
}

/**
 * An amount from a pair of debit and credit columns.
 *
 * A statement that splits them writes both as positive numbers, so read
 * column-by-column the file says every movement increased the balance. The
 * debit is negated here, which is the only place that decision belongs: a
 * reader that returned both untouched would leave every caller to remember.
 *
 * Both filled is a contradiction rather than a sum. Some exports write a zero
 * in the unused column, which is not the same thing and is handled; a row with
 * two real figures is a row nobody can interpret, and it is refused rather than
 * added together.
 */
export function fromDebitCredit(debit: string, credit: string): ParsedAmount | null {
  const out = parseAmount(debit);
  const into = parseAmount(credit);

  const owed = out !== null && !out.value.isZero();
  const gained = into !== null && !into.value.isZero();

  if (owed && gained) return null;
  if (owed) return { value: out.value.abs().negated(), wasBracketed: out.wasBracketed };
  if (gained) return { value: into.value.abs(), wasBracketed: into.wasBracketed };

  // Both empty or both zero: a zero movement, which is still a row the file
  // wrote and not a failure to read one.
  if (out !== null || into !== null) return { value: dec('0'), wasBracketed: false };
  return null;
}
