import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LINES, checkUpload } from '../src/index';

/**
 * The ceiling on a file, which step 1 of the plan asks for (§8.2) and which
 * nothing enforced.
 *
 * What made this worth doing is not the pathological case. It is that Next
 * caps a server action body at one megabyte by default: a statement over that
 * already failed, with a framework error naming nothing. A limit the
 * application states and explains is the difference between "too big, here is
 * the number" and a stack trace.
 */

describe('checkUpload', () => {
  it('accepts a file inside both limits', () => {
    expect(checkUpload(1_000, 'a\nb\nc')).toBeNull();
  });

  it('refuses one past the size, and says by how much', () => {
    const refusal = checkUpload(MAX_UPLOAD_BYTES + 1);
    expect(refusal).toEqual({
      reason: 'bytes',
      limit: MAX_UPLOAD_BYTES,
      found: MAX_UPLOAD_BYTES + 1,
    });
  });

  it('refuses one past the line count, which size alone would let through', () => {
    // A real shape rather than a contrived one: one narrow column and years of
    // rows weighs little and reads long.
    const long = 'a\n'.repeat(MAX_UPLOAD_LINES + 10);
    expect(checkUpload(long.length, long)?.reason).toBe('lines');
  });

  it('stops counting once it knows the answer', () => {
    // Ten million lines, and the check returns without building an array of
    // them. A guard that costs more than what it guards is not a guard.
    const huge = 'a\n'.repeat(10_000_000);
    const started = performance.now();
    expect(checkUpload(1_000, huge)?.reason).toBe('lines');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('takes the size without the text, which is all a browser has at first', () => {
    // The point of the two arguments: a file is refused before it is read.
    expect(checkUpload(MAX_UPLOAD_BYTES + 1)).not.toBeNull();
    expect(checkUpload(10)).toBeNull();
  });

  it('does not count the lines of a format that spends twenty on one movement', () => {
    // A CAMT.053 entry is twenty lines of XML. Counted as rows, fifty thousand
    // lines is two and a half thousand transactions - a limit an order of
    // magnitude below what the number says, on the format a business account
    // is most likely to arrive in. The byte cap holds these instead.
    const entry = `  <Ntry>
    <Amt Ccy="EUR">42.10</Amt>
    <CdtDbtInd>DBIT</CdtDbtInd>
    <BookgDt><Dt>2026-01-05</Dt></BookgDt>
  </Ntry>
`;
    const camt = `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
${entry.repeat(MAX_UPLOAD_LINES)}</Stmt></BkToCstmrStmt></Document>`;

    expect(checkUpload(1_000, camt)).toBeNull();
  });

  it('still counts them for a format where a line is a movement', () => {
    // The other direction, so the exemption above cannot quietly widen into
    // "no file is ever refused for its length".
    const qif = `!Type:Bank\n${'D05/01/2026\n'.repeat(MAX_UPLOAD_LINES + 10)}`;

    expect(checkUpload(qif.length, qif)?.reason).toBe('lines');
  });
});
