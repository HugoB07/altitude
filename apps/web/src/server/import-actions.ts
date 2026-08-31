'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import {
  SECURITIES_SUFFIX,
  accountBalances,
  bindAccounts,
  commitImport,
  createAccount,
  findDuplicates,
  type AccountBinding,
  type BoundCandidate,
  type CandidateOverrides,
  type EntryRole,
  type Verdict,
} from '@altitude/core';
import { accountId as toAccountId, importId, transactionId } from '@altitude/shared';
import { presetById, type Preset } from '@/lib/import-presets';
import { toMessage } from './errors';
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

/**
 * An account the file needs, described well enough to answer without guessing.
 *
 * One shape for all three kinds, because the screen was showing three lists of
 * raw codes - `DEFAULT`, `PEA:SECURITIES`, `EXTERNAL` - and asking which of
 * your accounts each one was. That is the exporter's vocabulary; nobody has to
 * learn it to import their own statement.
 */
export interface RequestedAccount {
  /** What the file calls it. Still shown, small, so a person can match it up. */
  readonly label: string;
  /** What it is, in the reader's language. */
  readonly name: string;
  readonly nature: 'cash' | 'securities' | 'counterpart';
  /** The kind to create it as, if nobody has one for it yet. */
  readonly kind: string;
  /** The account chosen so far, or null. */
  readonly accountId: string | null;
  /**
   * True when nobody chose this: it is an account of yours that already has the
   * name, offered so a second import lands where the first one did.
   *
   * The screen materialises it as a real choice on the next round, so nothing
   * downstream has to know the difference between a suggestion and an answer.
   */
  readonly suggested?: boolean;
}

export interface PreviewResult {
  readonly error?: string;
  /** Every account the file needs, named. Cash and securities first, then counterparts. */
  readonly requested?: readonly RequestedAccount[];
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

  const { binding, overrides } = readBinding(formData, preset, reading);

  // Accounts a person already has, so an account this file needs and a matching
  // one of theirs are put together rather than asked about. The second import
  // of a bank should not make anybody name the same accounts again.
  const existing = await scoped((tx) => accountBalances(tx, actor));

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
    requested: describeAccounts(preset, reading, binding, t, existing),
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
 * Every account a file needs, named rather than coded.
 *
 * Three sources, in order. The preset's own dictionary, which is the point of a
 * preset: it knows `DEFAULT` is the cash account. Then the shape of the label,
 * which catches the securities side of any account including ones no dictionary
 * lists. Then the label itself, unchanged, which is where a code nobody has
 * seen lands - no worse than before, and it never blocks a file.
 */
function describeAccounts(
  preset: Preset,
  reading: {
    accounts: readonly string[];
    securities: readonly string[];
    counterparts: readonly string[];
  },
  binding: AccountBinding,
  t: Awaited<ReturnType<typeof getTranslations>>,
  /** What the household already holds, for the suggestion. Empty means no suggestions. */
  existing: readonly { accountId: string; name: string; closedOn: string | null }[] = [],
): RequestedAccount[] {
  const named = (label: string): string => {
    const known = preset.accounts?.[label];
    if (known !== undefined) return t(`account.${known.nameKey}`);

    // The securities side of an account is named after it, so a dictionary that
    // lists `PEA` names `PEA:SECURITIES` too without listing it twice.
    if (label.endsWith(SECURITIES_SUFFIX)) {
      return t('account.securitiesOf', { name: named(label.slice(0, -SECURITIES_SUFFIX.length)) });
    }
    return label;
  };

  const describe = (label: string, nature: RequestedAccount['nature']): RequestedAccount => {
    const name = nature === 'counterpart' ? t('account.outside') : named(label);
    const chosen = binding[label];

    // Matched on the name this screen would have given it, which is the same
    // name `openAccountsAction` creates it under - so an account made by one
    // import is found by the next without anybody touching a control.
    const already =
      chosen === undefined && nature !== 'counterpart'
        ? existing.find(
            (account) =>
              account.closedOn === null && account.name.toLowerCase() === name.toLowerCase(),
          )
        : undefined;

    return {
      label,
      name,
      nature,
      kind: preset.accounts?.[label]?.kind ?? (nature === 'securities' ? 'securities' : 'cash'),
      accountId: chosen ?? already?.accountId ?? null,
      ...(already === undefined ? {} : { suggested: true }),
    };
  };

  const merged = mergedIntoTheirCash(preset, reading);

  return [
    ...reading.accounts.map((label) => describe(label, 'cash')),
    // Not asked about when the account holds its own shares. Asking would make
    // a person invent a "PEA securities" account that does not exist.
    ...reading.securities
      .filter((label) => merged[label] === undefined)
      .map((label) => describe(label, 'securities')),
    ...reading.counterparts.map((label) => describe(label, 'counterpart')),
  ];
}

/**
 * Securities labels that are not their own account, and whose they are.
 *
 * A reader splits every trade in two, because for most accounts the cash and
 * the shares live in different places. A French PEA holds both, and Trade
 * Republic's own accounts show all three cases at once: the current account and
 * the CTO beside it are two accounts, and the PEA is one.
 *
 * Only a preset can know that, so only a preset says it. Where it does,
 * `PEA:SECURITIES` follows `PEA` and never appears as a question.
 */
function mergedIntoTheirCash(
  preset: Preset,
  reading: { securities: readonly string[] },
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const label of reading.securities) {
    const cash = label.slice(0, -SECURITIES_SUFFIX.length);
    if (preset.accounts?.[cash]?.holdsSharesToo === true) merged[label] = cash;
  }
  return merged;
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
  preset: Preset,
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

  // An account that holds its own shares answers for both sides, so the shares
  // land where the cash is. Applied after reading, not instead of it, so a form
  // that does name the label is not silently overruled by nothing.
  for (const [shares, cash] of Object.entries(mergedIntoTheirCash(preset, reading))) {
    const chosen = binding[cash];
    if (chosen !== undefined) binding[shares] = chosen;
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

  const { binding, overrides } = readBinding(formData, preset, reading);
  for (const account of describeAccounts(preset, reading, binding, t)) {
    if (account.nature !== 'counterpart' && account.accountId === null) {
      return { error: t('accountMissing', { label: account.name }) };
    }
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
    return { error: await toMessage(error) };
  }
}

export interface OpenedAccounts {
  readonly error?: string;
  /** Label to account id, for every account the file needed and nobody had chosen. */
  readonly bound?: Readonly<Record<string, string>>;
  /** How many were created rather than matched to something that already existed. */
  readonly created?: number;
}

/**
 * Gives every unanswered account an answer, creating what is missing.
 *
 * The question "which of your accounts is PEA?" has no answer for somebody who
 * has just installed this and holds no accounts at all, and asking it four
 * times before showing a single transaction is most of what made this screen
 * hard. So it can be answered in one press.
 *
 * An existing account of the same name is reused rather than duplicated. That
 * is what makes the second import of the same bank land in the same place as
 * the first instead of quietly building a parallel set of accounts.
 *
 * Counterparts are never created. `EXTERNAL` is not an account of yours, and
 * the opening balance account already exists to stand for the outside world.
 */
export async function openAccountsAction(formData: FormData): Promise<OpenedAccounts> {
  await ensureTenantIsolation();
  const { actor, baseCurrency } = await requireContext();
  const t = await getTranslations('import');

  const preset = presetById(String(formData.get('preset') ?? ''));
  if (preset === undefined) return { error: t('unknownPreset') };

  const text = String(formData.get('text') ?? '');
  if (text.trim() === '') return { error: t('emptyFile') };

  const reading = preset.read(text);
  const { binding } = readBinding(formData, preset, reading);
  const wanted = describeAccounts(preset, reading, binding, t).filter(
    (account) => account.nature !== 'counterpart' && account.accountId === null,
  );
  if (wanted.length === 0) return { bound: {}, created: 0 };

  // What the file says each account is moved in. Written as `'EUR'` here, a
  // dollar statement created euro accounts and then posted dollar entries into
  // them - and `accountBalances` sums entries without looking at their
  // currency, so the balance would have been dollars and euros added together,
  // labelled in euros, and wrong in a way nothing on screen could show.
  const currencies = currenciesByLabel(reading);

  try {
    return await scoped(async (tx) => {
      const existing = await accountBalances(tx, actor);
      const bound: Record<string, string> = {};
      let created = 0;

      for (const account of wanted) {
        const match = existing.find(
          (candidate) =>
            candidate.closedOn === null &&
            candidate.name.toLowerCase() === account.name.toLowerCase(),
        );
        if (match !== undefined) {
          bound[account.label] = match.accountId;
          continue;
        }

        const made = await createAccount(tx, actor, {
          name: account.name,
          kind: account.kind,
          currency: currencies[account.label] ?? baseCurrency,
          ...(preset.institution === undefined ? {} : { institution: preset.institution }),
        });
        bound[account.label] = made.id;
        created += 1;
      }

      revalidatePath('/app/accounts');
      return { bound, created };
    });
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/**
 * The currency to open each account in, according to the file.
 *
 * The most frequent one, not the first seen, and that distinction was reported
 * from a real import: a Trade Republic statement whose first line touching the
 * cash account happened to be in dollars opened a euro current account in USD.
 * Every euro entry after it then belonged to an account that could not hold it.
 *
 * A securities label follows its cash account rather than counting its own
 * lines. A brokerage account holds shares from everywhere - buy one American
 * share in a euro CTO and the file says USD - and what denominates it is the
 * cash it settles in, not the first thing bought with that cash.
 *
 * A label carrying two currencies is still a real thing, and the entries that
 * do not match are refused when they are posted rather than quietly added to a
 * total they do not belong in.
 */
function currenciesByLabel(reading: {
  candidates: readonly { entries: readonly { account: string; currency: string }[] }[];
}): Readonly<Record<string, string>> {
  const tally = new Map<string, Map<string, number>>();
  for (const candidate of reading.candidates) {
    for (const entry of candidate.entries) {
      const counts = tally.get(entry.account) ?? new Map<string, number>();
      counts.set(entry.currency, (counts.get(entry.currency) ?? 0) + 1);
      tally.set(entry.account, counts);
    }
  }

  const found: Record<string, string> = {};
  for (const [label, counts] of tally) {
    // Ties go to the first seen, which is the file's own order.
    let best = '';
    let most = 0;
    for (const [code, count] of counts) {
      if (count > most) {
        most = count;
        best = code;
      }
    }
    found[label] = best;
  }

  // After the tally, so a securities label takes its cash account's answer
  // rather than racing its own.
  for (const label of Object.keys(found)) {
    if (!label.endsWith(SECURITIES_SUFFIX)) continue;
    const cash = found[label.slice(0, -SECURITIES_SUFFIX.length)];
    if (cash !== undefined) found[label] = cash;
  }

  return found;
}
