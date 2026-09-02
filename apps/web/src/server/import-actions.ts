'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import {
  SECURITIES_SUFFIX,
  accountBalances,
  bindAccounts,
  commitImport,
  ImportNotFoundError,
  STATEMENT_ACCOUNT,
  createAccount,
  findDuplicates,
  findImportsOfFile,
  fingerprintOf,
  findMapping,
  parseMapping,
  readShape,
  rememberMapping,
  listImports,
  rollbackImport,
  type AccountBinding,
  type BalanceReading,
  type BoundCandidate,
  type CandidateOverrides,
  type EntryRole,
  type Verdict,
} from '@altitude/core';
import {
  Money,
  accountId as toAccountId,
  checkUpload,
  dec,
  importId,
  isUuid,
  todayIn,
  transactionId,
} from '@altitude/shared';
import { CUSTOM_PRESET_ID, customPreset, presetById, type Preset } from '@/lib/import-presets';
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
  /** Who the bank says was on the other side, where it says so. */
  readonly counterparty: string | null;
  readonly sourceLines: readonly number[];
  readonly verdict: Verdict['kind'];
  /**
   * Days between this line and the transaction it looks like, or null.
   *
   * Null for anything but a look-alike. Zero reads as "the same day", which
   * the screen leaves unsaid; anything above it has to be said, or a person is
   * asked to judge a match against a date they can see is different.
   */
  readonly daysApart: number | null;
  /**
   * The transaction this line looks like, named rather than referenced.
   *
   * Deciding means comparing, and comparing means seeing both. Account names
   * are resolved here because the browser has the household's accounts for the
   * binding controls, not for a transaction it has never seen.
   */
  readonly existing: {
    readonly id: string;
    readonly bookedOn: string;
    readonly description: string | null;
    readonly entries: readonly { readonly name: string; readonly amount: string }[];
  } | null;
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
  /**
   * A run that read this exact file before, if there is one.
   *
   * The return on keeping a digest instead of the file. Deduplication would
   * catch it a step later, line by line; this says it once, up front, with the
   * date.
   */
  readonly alreadyImported?: { readonly filename: string; readonly at: string };
  /**
   * The statement's own balance, against what the ledger would hold.
   *
   * The phase's exit criterion is an export that "reconciles to the statement"
   * (§17), and this is the number that says whether it does. Absent when the
   * file has no balance column, which most broker exports do not.
   */
  readonly reconciliation?: {
    /** What the last row of the file says the account holds. */
    readonly closing: string;
    /** What the account will hold once the ticked lines are written. */
    readonly afterImport: string;
    /** `closing` less `afterImport`. Zero is the answer everybody wants. */
    readonly gap: string;
    readonly currency: string;
    /** Rows inside the file where the balance did not move by the amount. */
    readonly mismatches: readonly { readonly line: number }[];
    readonly checked: number;
  };
  /** Every account the file needs, named. Cash and securities first, then counterparts. */
  readonly requested?: readonly RequestedAccount[];
  readonly lines?: readonly PreviewLine[];
  readonly problems?: readonly { line: number; reason: string }[];
  /** Rows the reader left out on purpose, with the state that caused it. */
  readonly skipped?: readonly { line: number; reason: string }[];
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
/**
 * Refuses a file past what the application says it accepts.
 *
 * Checked on every action that takes one, not only the one that writes: an
 * action is an endpoint, and the browser's own check is there to explain the
 * limit rather than to hold it.
 */
async function refuseOversized(text: string): Promise<string | null> {
  const refused = checkUpload(Buffer.byteLength(text, 'utf8'), text);
  if (refused === null) return null;

  const t = await getTranslations('import');
  return refused.reason === 'bytes'
    ? t('fileTooBig', { limit: Math.round(refused.limit / (1024 * 1024)) })
    : t('fileTooLong', { limit: refused.limit });
}

export async function previewImportAction(formData: FormData): Promise<PreviewResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('import');

  const preset = resolvePreset(formData);
  if (preset === undefined) return { error: t('unknownPreset') };

  const text = String(formData.get('text') ?? '');

  const oversized = await refuseOversized(text);
  if (oversized !== null) return { error: oversized };
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
  const verdicts: Verdict[] = checked
    ? [...(await scoped((tx) => findDuplicates(tx, actor, bound))).verdicts]
    : reading.candidates.map(() => ({ kind: 'new' }) as const);

  const seenBefore = await scoped((tx) => findImportsOfFile(tx, actor, text));
  const reconciliation = reconcile(reading, bound, binding, existing);

  return {
    checked,
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(seenBefore[0] === undefined
      ? {}
      : {
          alreadyImported: {
            filename: seenBefore[0].filename,
            at: seenBefore[0].createdAt.toISOString(),
          },
        }),
    looksWrong: !preset.matches(text),
    requested: describeAccounts(preset, reading, binding, t, existing),
    problems: reading.problems.map((p) => ({ line: p.line, reason: p.reason })),
    skipped: reading.skipped.map((p) => ({ line: p.line, reason: p.reason })),
    lines: reading.candidates.map((candidate, index) => ({
      index,
      bookedOn: candidate.bookedOn,
      kind: candidate.kind,
      description: candidate.description ?? null,
      counterparty: candidate.counterparty ?? null,
      sourceLines: candidate.sourceLines,
      verdict: verdicts[index]?.kind ?? 'new',
      daysApart: verdicts[index]?.kind === 'probable' ? verdicts[index].daysApart : null,
      existing: describeMatch(verdicts[index], existing),
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
  /** Existing transactions a person said were the same as a line of the file. */
  readonly merged?: number;
  readonly instruments?: number;
}

/**
 * The statement's closing balance against what the ledger will hold.
 *
 * Only the account the statement is about: an import touches a counterpart
 * too, and that side is the edge of the household rather than something a bank
 * has an opinion about.
 *
 * Says nothing when the account has not been chosen yet, when the file has no
 * balance column, or when the currencies differ. A comparison nobody can act
 * on is worse than none - it invites reading a difference as an error when it
 * is an apples-to-oranges sum.
 */
function reconcile(
  reading: { balances?: BalanceReading },
  bound: readonly BoundCandidate[],
  binding: AccountBinding,
  existing: readonly { accountId: string; balance: Money; currency: string }[],
): PreviewResult['reconciliation'] {
  const balances = reading.balances;
  const accountId = binding[STATEMENT_ACCOUNT];
  if (balances === undefined || accountId === undefined) return undefined;

  const account = existing.find((one) => one.accountId === accountId);
  if (account === undefined) return undefined;

  // Every entry of the file that lands on that account, whatever the
  // transaction shape around it.
  const moved = bound
    .flatMap((candidate) => candidate.entries)
    .filter((entry) => entry.accountId === accountId && entry.currency === account.currency)
    .reduce((total, entry) => total.plus(dec(entry.amount)), dec('0'));

  const afterImport = account.balance.amount.plus(moved);

  return {
    closing: balances.closing,
    afterImport: afterImport.toFixed(),
    gap: dec(balances.closing).minus(afterImport).toFixed(),
    currency: account.currency,
    mismatches: balances.mismatches.map((one) => ({ line: one.line })),
    checked: balances.checked,
  };
}

/** The matched transaction, with its accounts named the way the household names them. */
function describeMatch(
  verdict: Verdict | undefined,
  accounts: readonly { accountId: string; name: string }[],
): PreviewLine['existing'] {
  if (verdict === undefined || verdict.kind === 'new') return null;
  return {
    id: verdict.existing.id,
    bookedOn: verdict.existing.bookedOn,
    description: verdict.existing.description,
    entries: verdict.existing.entries.map((entry) => ({
      name: accounts.find((a) => a.accountId === entry.accountId)?.name ?? '',
      amount: `${entry.amount} ${entry.currency}`,
    })),
  };
}

export async function commitImportAction(formData: FormData): Promise<CommitOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('import');

  const preset = resolvePreset(formData);
  if (preset === undefined) return { error: t('unknownPreset') };

  const text = String(formData.get('text') ?? '');
  const filename = String(formData.get('filename') ?? 'import.csv');

  const oversized = await refuseOversized(text);
  if (oversized !== null) return { error: oversized };
  const chosen = new Set(
    String(formData.get('selected') ?? '')
      .split(',')
      .filter((value) => value !== '')
      .map(Number),
  );
  // Lines a person said were already in the ledger, as `index:transactionId`.
  // Nothing is posted for these: the existing row takes the line's hash so the
  // same file read again recognises it outright.
  const merges = new Map<number, string>();
  for (const pair of String(formData.get('merged') ?? '').split(',')) {
    const [index, id] = pair.split(':');
    if (index === undefined || id === undefined || !isUuid(id)) continue;
    merges.set(Number(index), id);
  }

  if (chosen.size === 0 && merges.size === 0) return { error: t('nothingSelected') };

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
        text,
        candidates: described,
        transactionIds: described.map(() => transactionId(randomUUID())),
        merges: [...merges.entries()].flatMap(([index, id]) => {
          const candidate = reading.candidates[index];
          if (candidate === undefined) return [];
          const { bound: one, problems: refused } = bindAccounts([candidate], binding, {
            ...(overrides[index] === undefined ? {} : { 0: overrides[index] }),
          });
          if (refused.length > 0 || one[0] === undefined) return [];
          return [{ existing: transactionId(id), line: one[0] }];
        }),
      }),
    );

    revalidatePath('/app');
    revalidatePath('/app/accounts');
    revalidatePath('/app/transactions');
    return {
      written: result.written,
      merged: result.merged,
      instruments: result.instrumentsCreated,
    };
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

  const preset = resolvePreset(formData);
  if (preset === undefined) return { error: t('unknownPreset') };

  const text = String(formData.get('text') ?? '');

  const oversized = await refuseOversized(text);
  if (oversized !== null) return { error: oversized };
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

export interface RollbackOutcome {
  readonly error?: string;
  readonly reversed?: number;
}

/**
 * Undoes an import, from the screen.
 *
 * The reversal ids are minted here, one per transaction the run made, and the
 * service uses as many as it needs - the ones already reversed by hand are
 * skipped, so the count it wants is never more than this. Minting them at the
 * edge is the same rule as everywhere else: the domain builds a transaction
 * before anything is written, so it cannot depend on what the database hands
 * back.
 */
export async function rollbackImportAction(formData: FormData): Promise<RollbackOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();

  const id = String(formData.get('id') ?? '');
  if (id === '') return { error: (await getTranslations('import'))('unknownImport') };

  try {
    const result = await scoped(async (tx) => {
      const runs = await listImports(tx, actor);
      const run = runs.find((candidate) => candidate.id === id);
      if (run === undefined) throw new ImportNotFoundError(importId(id));

      return rollbackImport(tx, actor, {
        importId: importId(id),
        // Today, not the day the file covered. A correction happened when it
        // happened; backdating one rewrites what a past month looked like.
        on: todayIn(),
        reversalIds: Array.from({ length: run.transactions }, () => transactionId(randomUUID())),
      });
    });

    revalidatePath('/app');
    revalidatePath('/app/accounts');
    revalidatePath('/app/transactions');
    revalidatePath('/app/import');
    return { reversed: result.reversed };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}

/**
 * Which reader this request wants.
 *
 * A named preset is looked up. `custom` is built from the mapping the screen
 * sends, which is why the mapping travels with every step exactly as the file's
 * text does: nothing about how to read a file is remembered between actions, so
 * two requests cannot disagree about it.
 *
 * The mapping is checked before it is trusted. It came from a browser, and an
 * unchecked one produces a reader that indexes every row by `undefined` and
 * reports the whole file as unreadable.
 */
function resolvePreset(formData: FormData): Preset | undefined {
  const id = String(formData.get('preset') ?? '');
  if (id !== CUSTOM_PRESET_ID) return presetById(id);

  const raw = String(formData.get('mapping') ?? '');
  if (raw === '') return undefined;

  try {
    const mapping = parseMapping(JSON.parse(raw));
    return mapping === null ? undefined : customPreset(mapping);
  } catch {
    return undefined;
  }
}

export interface ShapeResult {
  readonly error?: string;
  readonly delimiter?: string;
  readonly headers?: readonly string[];
  readonly sample?: readonly (readonly string[])[];
  /** Per column, the date order found and whether anything settled it. */
  readonly dates?: Readonly<Record<string, { order: string; ambiguous: boolean }>>;
  /** Columns repeating a handful of values, and which - a status column is one. */
  readonly categories?: Readonly<Record<string, readonly string[]>>;
  /** What identifies this file's shape, sent back when the mapping is kept. */
  readonly fingerprint?: string;
  /**
   * A mapping this household already has for a file of this shape.
   *
   * When it is here, the screen has nothing to ask: it was asked once, for this
   * bank, and the answer is what makes the phase's exit criterion say "without
   * manual intervention".
   */
  readonly remembered?: {
    readonly name: string;
    readonly mapping: unknown;
  };
}

/**
 * What a file looks like, before anyone has said which column is what.
 *
 * A server action rather than a call in the browser, because `readShape` lives
 * in `@altitude/core` and core imports the database driver - a client component
 * that reached for it would take `postgres` into the bundle and stop the build
 * at "can't resolve 'fs'". The rule has a guard of its own now.
 */
export async function shapeFileAction(formData: FormData): Promise<ShapeResult> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('import');

  const text = String(formData.get('text') ?? '');

  const oversized = await refuseOversized(text);
  if (oversized !== null) return { error: oversized };
  if (text.trim() === '') return { error: t('emptyFile') };

  const shape = readShape(text);
  if (shape.headers.length === 0) return { error: t('nothingToImport') };

  const fingerprint = fingerprintOf(text, shape.delimiter);
  const kept = await scoped((tx) => findMapping(tx, actor, fingerprint));

  return {
    delimiter: shape.delimiter,
    headers: shape.headers,
    sample: shape.sample,
    dates: shape.dates,
    categories: shape.categories,
    fingerprint,
    ...(kept === null ? {} : { remembered: { name: kept.name, mapping: kept.mapping } }),
  };
}

export interface RememberOutcome {
  readonly error?: string;
  readonly kept?: boolean;
}

/**
 * Keeps the description a person just wrote, so the next file of this shape
 * asks nothing.
 *
 * Called when the import is written rather than when the mapping screen is
 * finished. A description that was never used to import anything is a guess
 * nobody confirmed, and keeping it would answer the next import with it.
 */
export async function rememberMappingAction(formData: FormData): Promise<RememberOutcome> {
  await ensureTenantIsolation();
  const { actor } = await requireContext();
  const t = await getTranslations('import');

  const fingerprint = String(formData.get('fingerprint') ?? '');
  const raw = String(formData.get('mapping') ?? '');
  if (fingerprint === '' || raw === '') return { error: t('genericError') };

  try {
    const kept = await scoped((tx) =>
      rememberMapping(tx, actor, {
        name: String(formData.get('name') ?? ''),
        fingerprint,
        mapping: JSON.parse(raw),
      }),
    );
    return { kept: kept !== null };
  } catch (error) {
    return { error: await toMessage(error) };
  }
}
