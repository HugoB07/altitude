'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import {
  bindAccounts,
  commitImport,
  findDuplicates,
  type AccountBinding,
  type BoundCandidate,
  type CandidateOverrides,
  type EntryRole,
  type Verdict,
} from '@altitude/core';
import { accountId as toAccountId, importId, transactionId } from '@altitude/shared';
import { presetById } from '@/lib/import-presets';
import { requireContext, scoped } from './context';
import { ensureTenantIsolation } from './startup';

/**
 * Reading and writing an import, with the file as the only thing that travels.
 *
 * The browser holds the file's text between steps and sends it back with each
 * action. Nothing about a candidate transaction is ever taken from the client:
 * the server re-reads, re-binds and re-deduplicates every time, and the client
 * only says which line numbers a person approved.
 *
 * That is deliberate. A client that could hand back candidates could hand back
 * different ones, and while row-level security means the damage would be
 * confined to the sender's own household, "you can only corrupt your own
 * ledger" is a weak thing to rely on when re-reading a file costs nothing.
 */

export interface PreviewLine {
  /** The candidate's position in the reading, which is what the caller approves by. */
  readonly index: number;
  readonly bookedOn: string;
  readonly kind: string;
  readonly description: string | null;
  readonly sourceLines: readonly number[];
  readonly verdict: Verdict['kind'];
  readonly entries: readonly {
    readonly label: string;
    readonly amount: string;
    readonly currency: string;
    readonly instrument: string | null;
    /** What the reader decided this line is, already in the reader's language. */
    readonly memo: string | null;
    /** Whether this side is the outside world, which each transaction answers for itself. */
    readonly counterpart: boolean;
    /** The account this line would land in as things stand, or null while nothing is chosen. */
    readonly accountId: string | null;
  }[];
}

export interface PreviewResult {
  readonly error?: string;
  /** The file's own accounts, each of which has one answer for the whole file. */
  readonly accounts?: readonly string[];
  /** Where a trade's shares land, as opposed to the cash beside them. */
  readonly securities?: readonly string[];
  /** Labels standing for the outside world. See `ImportReading.counterparts`. */
  readonly counterparts?: readonly string[];
  readonly lines?: readonly PreviewLine[];
  readonly problems?: readonly { line: number; reason: string }[];
  /** False until every label has an account, which is when duplicates can be looked for. */
  readonly checked?: boolean;
  /**
   * The file does not have the shape this preset expects.
   *
   * A warning rather than a refusal. A bank that adds a column should not lock
   * someone out of their own export, and the reading below either produced
   * candidates - which a person can look at and judge - or produced none, which
   * is already an error.
   */
  readonly looksWrong?: boolean;
}

/**
 * What a file would do, without doing any of it.
 *
 * The binding is optional here: before a person has chosen accounts, the
 * preview still shows what the file contains and which accounts it wants. Only
 * once every label is bound can duplicates be looked for, because a duplicate
 * is a question about accounts and amounts, not about labels.
 */
export async function previewImportAction(formData: FormData): Promise<PreviewResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('import');

  const preset = presetById(String(formData.get('preset') ?? ''));
  if (preset === undefined) return { error: t('unknownPreset') };

  const text = String(formData.get('text') ?? '');
  if (text.trim() === '') return { error: t('emptyFile') };

  const reading = preset.read(text);
  if (reading.candidates.length === 0) {
    return {
      error: reading.problems[0]?.reason ?? t('nothingToImport'),
      problems: reading.problems.map((p) => ({ line: p.line, reason: p.reason })),
    };
  }

  const { binding, overrides } = readBinding(formData, reading);

  const { bound } = bindAccounts(reading.candidates, binding, overrides);
  const checked = bound.length === reading.candidates.length;

  // Deduplication needs accounts, so until they are all chosen nothing has been
  // checked. The screen says so rather than calling every line new, which would
  // be a claim about something nobody has looked at.
  const verdicts: Verdict['kind'][] = checked
    ? (await scoped((tx) => findDuplicates(tx, actor, bound))).verdicts.map((v) => v.kind)
    : reading.candidates.map(() => 'new');

  return {
    checked,
    looksWrong: !preset.matches(text),
    accounts: reading.accounts,
    securities: reading.securities,
    counterparts: reading.counterparts,
    problems: reading.problems.map((p) => ({ line: p.line, reason: p.reason })),
    lines: reading.candidates.map((candidate, index) => ({
      index,
      bookedOn: candidate.bookedOn,
      kind: candidate.kind,
      description: candidate.description ?? null,
      sourceLines: candidate.sourceLines,
      verdict: verdicts[index] ?? 'new',
      entries: candidate.entries.map((entry) => ({
        label: entry.account,
        amount: entry.amount,
        currency: entry.currency,
        instrument: entry.instrument?.name ?? null,
        memo: describeEntry(entry, t),
        counterpart: reading.counterparts.includes(entry.account),
        // Resolved here rather than on the screen, so what the preview shows is
        // the same answer the write will use rather than a second guess at it.
        accountId: overrides[index]?.[entry.account] ?? binding[entry.account] ?? null,
      })),
    })),
  };
}

/**
 * What a line of a transaction is, in the reader's language.
 *
 * `packages/core` emits a token - `gross`, `withholdingTax` - rather than
 * prose, because it has no idea what language anyone reads. This is where that
 * becomes words, and it is the only place: the preview shows what comes out of
 * here, and so does the memo written into the ledger, so the two can never say
 * different things.
 *
 * Text the file itself carried wins over the token. A payment reference is the
 * bank's words, not ours, and translating it would be inventing data.
 */
function describeEntry(
  entry: { role?: EntryRole; memo?: string },
  t: Awaited<ReturnType<typeof getTranslations>>,
): string | null {
  if (entry.memo !== undefined) return entry.memo;
  if (entry.role === undefined) return null;
  return t(ROLE_MESSAGES[entry.role]);
}

/**
 * Spelled out rather than built as `role.${role}`.
 *
 * The messages are not typed, so a template would let a new role ship with no
 * translation and fail at render time in front of somebody. Written as a
 * `Record<EntryRole, string>`, adding a role stops compiling until this table
 * names its message - which is where the person adding it will look anyway.
 */
const ROLE_MESSAGES: Record<EntryRole, string> = {
  gross: 'role.gross',
  withholdingTax: 'role.withholdingTax',
  netCredited: 'role.netCredited',
};

/**
 * The accounts a person has chosen, as the form carries them.
 *
 * Two namespaces, because the two questions differ. `account:<label>` is the
 * file's answer for a label, and `counterpart:<index>` is one transaction's
 * answer for where its money came from - a salary and a transfer from your own
 * other bank are both `EXTERNAL` in the file and are not the same account.
 *
 * Only labels the reading actually mentions are read, so a form naming a label
 * the file does not have contributes nothing.
 */
function readBinding(
  formData: FormData,
  reading: {
    accounts: readonly string[];
    securities: readonly string[];
    counterparts: readonly string[];
  },
): { binding: AccountBinding; overrides: CandidateOverrides } {
  const binding: Record<string, ReturnType<typeof toAccountId> | undefined> = {};
  for (const label of [...reading.accounts, ...reading.securities, ...reading.counterparts]) {
    const chosen = String(formData.get(`account:${label}`) ?? '');
    if (chosen !== '') binding[label] = toAccountId(chosen);
  }

  const overrides: Record<number, AccountBinding> = {};
  for (const [key, value] of formData.entries()) {
    const match = /^counterpart:(\d+)$/.exec(key);
    if (match === null || typeof value !== 'string' || value === '') continue;

    // One override per candidate, applied to every counterpart label it holds.
    // No file has two, and inventing a second dimension for a case nobody has
    // is how a screen ends up asking a question with one answer twice.
    const index = Number(match[1]);
    overrides[index] = Object.fromEntries(
      reading.counterparts.map((label) => [label, toAccountId(value)]),
    );
  }

  return { binding, overrides };
}

export interface CommitOutcome {
  readonly error?: string;
  readonly written?: number;
  readonly instruments?: number;
}

export async function commitImportAction(formData: FormData): Promise<CommitOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('import');

  const preset = presetById(String(formData.get('preset') ?? ''));
  if (preset === undefined) return { error: t('unknownPreset') };

  const text = String(formData.get('text') ?? '');
  const filename = String(formData.get('filename') ?? 'import.csv');
  const chosen = new Set(
    String(formData.get('selected') ?? '')
      .split(',')
      .filter((value) => value !== '')
      .map(Number),
  );
  if (chosen.size === 0) return { error: t('nothingSelected') };

  // Read again rather than trusting what came back. The file is the source of
  // truth; the browser only says which of its lines a person approved.
  const reading = preset.read(text);

  const { binding, overrides } = readBinding(formData, reading);
  for (const label of [...reading.accounts, ...reading.securities]) {
    if (binding[label] === undefined) return { error: t('accountMissing', { label }) };
  }

  // Filtering renumbers the candidates, so the overrides have to be renumbered
  // with them. Keying them by their old position against the new array would
  // move somebody's counterpart onto a different transaction - the kind of
  // mistake that writes a plausible ledger and is invisible afterwards.
  const kept = [...reading.candidates.entries()].filter(([index]) => chosen.has(index));
  const keep = kept.map(([, candidate]) => candidate);
  const renumbered: Record<number, (typeof overrides)[number]> = {};
  for (const [position, [original]] of kept.entries()) {
    const override = overrides[original];
    if (override !== undefined) renumbered[position] = override;
  }

  const { bound, problems } = bindAccounts(keep, binding, renumbered);
  if (problems.length > 0) return { error: problems[0]!.reason };

  // The tokens become words here, once, on their way into the ledger. `memo` is
  // free text a person can edit afterwards, so it has to be text - and it is
  // written in the language of whoever ran the import, which is the best a
  // single stored string can do.
  const described: BoundCandidate[] = bound.map((candidate) => ({
    ...candidate,
    entries: candidate.entries.map((entry) => {
      const memo = describeEntry(entry, t);
      return memo === null ? entry : { ...entry, memo };
    }),
  }));

  try {
    const result = await scoped((tx) =>
      commitImport(tx, actor, {
        importId: importId(randomUUID()),
        source: preset.id,
        filename,
        candidates: described,
        transactionIds: described.map(() => transactionId(randomUUID())),
      }),
    );

    revalidatePath('/app');
    revalidatePath('/app/accounts');
    revalidatePath('/app/transactions');
    return { written: result.written, instruments: result.instrumentsCreated };
  } catch (error) {
    return { error: error instanceof Error ? error.message : t('genericError') };
  }
}
