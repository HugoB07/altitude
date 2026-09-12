import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, Undo2 } from 'lucide-react';
import {
  TRANSACTION_STATUSES,
  accountBalances,
  listCategories,
  listCounterparties,
  listTags,
  listTransactions,
  type LedgerEntry,
  type LedgerLine,
  type TransactionStatus,
} from '@altitude/core';
import { TRANSACTION_KINDS } from '@altitude/db';
import { accountId as toAccountId, ledgerDate } from '@altitude/shared';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { Pagination } from '@/components/pagination';
import { TransactionFilters, type FilterValues } from './filters';
import { money } from '@/lib/money';
import { Categorise } from './categorise';
import { Tagging } from './tagging';
import { ReverseButton } from './reverse-button';

export const metadata = { title: 'Altitude' };

export const dynamic = 'force-dynamic';

const PER_PAGE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The two sides of an ordinary movement, when there are exactly two.
 *
 * Most transactions are one account to another, and "Current account -300 /
 * Savings +300" is a correct way to say that which nobody reads as "300 moved
 * from one to the other". When the shape allows it, the card says the sentence
 * instead and keeps the itemised version for the transactions that need it.
 */
function asMovement(lines: readonly LedgerLine[]) {
  if (lines.length !== 2) return null;
  const [a, b] = lines;
  if (a === undefined || b === undefined) return null;

  const from = a.amount.isNegative() ? a : b;
  const to = a.amount.isNegative() ? b : a;
  if (!from.amount.isNegative() || !to.amount.isPositive()) return null;
  if (from.amount.currency !== to.amount.currency) return null;

  return { from, to, amount: to.amount };
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  if (ctx === null) redirect('/setup');

  await ensureTenantIsolation();

  const t = await getTranslations();
  const locale = await getLocale();
  const params = await searchParams;

  // The page number and every filter travel in the URL, so this stays a server
  // component, a reload lands where the reader was, and a filtered view is a
  // thing that can be linked to. Anything unparseable is ignored rather than
  // raised: a hand-edited address should narrow the list or not, never break it.
  const asked = Number.parseInt(typeof params['page'] === 'string' ? params['page'] : '', 10);
  const requested = Number.isFinite(asked) && asked > 0 ? asked : 1;

  const raw = (key: string): string => {
    const value = params[key];
    return typeof value === 'string' ? value : '';
  };

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const filters: FilterValues = {
    accountId: UUID.test(raw('accountId')) ? raw('accountId') : '',
    kind: (TRANSACTION_KINDS as readonly string[]).includes(raw('kind')) ? raw('kind') : '',
    status: (TRANSACTION_STATUSES as readonly string[]).includes(raw('status'))
      ? raw('status')
      : 'all',
    from: DATE.test(raw('from')) ? raw('from') : '',
    to: DATE.test(raw('to')) ? raw('to') : '',
    categoryId: UUID.test(raw('categoryId')) ? raw('categoryId') : '',
    tagId: UUID.test(raw('tagId')) ? raw('tagId') : '',
    // Not validated against a list: it is free text somebody may have typed or
    // a bank may have written, and a name this household does not use simply
    // matches nothing.
    counterparty: raw('counterparty').slice(0, 200),
  };

  const active =
    filters.accountId !== '' ||
    filters.kind !== '' ||
    filters.status !== 'all' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.categoryId !== '' ||
    filters.tagId !== '' ||
    filters.counterparty !== '';

  const accounts = await scoped((tx) => accountBalances(tx, ctx.actor));
  const categories = await scoped((tx) => listCategories(tx, ctx.actor));
  const tags = await scoped((tx) => listTags(tx, ctx.actor));
  const counterparties = await scoped((tx) => listCounterparties(tx, ctx.actor));

  const page = await scoped((tx) =>
    listTransactions(tx, ctx.actor, {
      page: requested,
      perPage: PER_PAGE,
      status: filters.status as TransactionStatus,
      ...(filters.accountId === '' ? {} : { accountId: toAccountId(filters.accountId) }),
      ...(filters.kind === '' ? {} : { kind: filters.kind }),
      ...(filters.from === '' ? {} : { from: ledgerDate(filters.from) }),
      ...(filters.to === '' ? {} : { to: ledgerDate(filters.to) }),
      ...(filters.categoryId === '' ? {} : { categoryId: filters.categoryId }),
      ...(filters.tagId === '' ? {} : { tagId: filters.tagId }),
      ...(filters.counterparty === '' ? {} : { counterparty: filters.counterparty }),
    }),
  );

  // Every filter is carried into the page links, and only the page number
  // changes. A pagination that dropped the filters would send the reader from
  // page 2 of their search to page 3 of everything.
  const hrefFor = (n: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '' && !(key === 'status' && value === 'all')) query.set(key, value);
    }
    if (n > 1) query.set('page', String(n));
    const search = query.toString();
    return search === '' ? '/app/transactions' : `/app/transactions?${search}`;
  };

  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const canReverse = ctx.actor.role !== 'viewer' && ctx.actor.role !== 'child';

  return (
    <div className="grid gap-6">
      <div className="pt-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('transactions.title')}</h1>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">
          {t('transactions.description')}
        </p>
      </div>

      {/* Keyed on the filters themselves, so following a link that changes them
          remounts the form.
          Every control here holds its choice in useState, initialised from the
          URL. React keeps that state across a client-side navigation because
          the component never unmounts - so "clear filters" changed the address
          and the query, and left every field showing what had just been
          cleared. The key makes the URL the single source of truth. */}
      <TransactionFilters
        key={Object.values(filters).join('|')}
        accounts={accounts.map((a) => ({ id: a.accountId, name: a.name }))}
        kinds={TRANSACTION_KINDS}
        statuses={TRANSACTION_STATUSES}
        categories={categories}
        tags={tags}
        counterparties={counterparties}
        value={filters}
        active={active}
      />

      {page.transactions.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t(active ? 'transactions.emptyFiltered' : 'transactions.empty')}
        </p>
      ) : (
        <>
          <ul className="grid gap-3">
            {page.transactions.map((entry) => {
              // Which rule filed it, as a sentence, because the two kinds read
              // differently: a rule of your own doing what you asked is not the
              // same news as Altitude having decided on your behalf. Built here
              // rather than in the card, where `t` is not in scope and the name
              // is per row so a fixed label could not carry it.
              const by =
                entry.lines.find((line) => line.categorisedBy !== null)?.categorisedBy ?? null;

              return (
                <li key={entry.id}>
                  <Card
                    entry={entry}
                    categories={categories}
                    locale={locale}
                    date={dates.format(new Date(`${entry.bookedOn}T00:00:00`))}
                    kindLabel={t(`transactionKind.${entry.kind}`)}
                    tags={tags}
                    filedBy={
                      by === null
                        ? null
                        : by.kind === 'household'
                          ? t('transactions.filedByYourRule', { name: by.name })
                          : t('transactions.filedByShippedRule', { name: by.name })
                    }
                    labels={{
                      reversed: t('transactions.reversed'),
                      isReversal: t('transactions.isReversal'),
                      reverse: t('transactions.reverse'),
                      to: t('transactions.movedTo'),
                      lines: t('transactions.lines'),
                    }}
                    canReverse={canReverse}
                  />
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-muted-foreground text-xs">
              {t('transactions.showing', {
                page: page.page,
                pageCount: page.pageCount,
                total: page.total,
              })}
              {active && ` · ${t('transactions.filtered')}`}
            </p>

            <Pagination
              page={page.page}
              pageCount={page.pageCount}
              hrefFor={hrefFor}
              labels={{
                previous: t('transactions.previous'),
                next: t('transactions.next'),
                page: t('transactions.pageLabel'),
              }}
            />
          </div>

          <p className="text-muted-foreground max-w-prose text-xs">
            {t('transactions.reverseHint')}
          </p>
        </>
      )}
    </div>
  );
}

function Card({
  entry,
  locale,
  date,
  kindLabel,
  filedBy,
  labels,
  canReverse,
  categories,
  tags,
}: {
  entry: LedgerEntry;
  locale: string;
  date: string;
  kindLabel: string;
  /**
   * Which rule filed this, already written out, or null when nobody's did.
   *
   * Null covers both "a person chose this" and "nothing chose it":
   * `setTransactionCategory` clears the provenance when somebody overrules a
   * rule, so a sentence here never claims a rule decided what a person did.
   */
  filedBy: string | null;
  labels: { reversed: string; isReversal: string; reverse: string; to: string; lines: string };
  canReverse: boolean;
  categories: readonly { id: string; name: string }[];
  tags: readonly { id: string; name: string }[];
}) {
  const reversed = entry.reversedById !== null;
  const movement = asMovement(entry.lines);
  // The household's side of the movement carries it; the equity counterpart
  // never does, so the first one found is the one to show.
  const categoryId = entry.lines.find((line) => line.categoryId !== null)?.categoryId ?? null;

  return (
    <div className={`bg-card/60 rounded-2xl border p-4 sm:p-5 ${reversed ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {/* What it was, and what it is worth. Everything a person can change
            about it moved to its own row below: a description, a menu, a name,
            a button and three badges on one line is a line nobody reads, and a
            long description pushed the rest off the card. */}
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-medium">
              {entry.description ?? kindLabel}
            </span>
            {reversed && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                {labels.reversed}
              </span>
            )}
          </p>
          <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
            <span>{date}</span>
            <span aria-hidden>·</span>
            <span className="capitalize">{kindLabel}</span>
            {entry.reversesId !== null && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Undo2 className="size-3" aria-hidden />
                  {labels.isReversal}
                </span>
              </>
            )}
          </p>
        </div>

        {movement !== null && (
          <p className="shrink-0 text-[15px] font-semibold tabular-nums">
            {money(movement.amount.amount.toFixed(), movement.amount.currency, locale)}
          </p>
        )}
      </div>

      {/* The three things a person files a movement under, on their own row.
          Controls first, then what they produced, so the eye finds the same
          two menus in the same place on every card. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Categorise
          transactionId={entry.id}
          description={entry.description}
          current={categoryId ?? ''}
          categories={categories}
        />
        <Tagging transactionId={entry.id} current={entry.tags.map((tag) => tag.id)} tags={tags} />
        {/* Who was on the other side, which no category says: groceries mixes
            every shop. */}
        {entry.counterparty !== null && (
          <span className="text-muted-foreground text-xs">{entry.counterparty}</span>
        )}
        {entry.tags.map((tag) => (
          <span
            key={tag.id}
            className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]"
          >
            {tag.name}
          </span>
        ))}
      </div>

      {/* Why it is filed where it is. Two columns have recorded this since the
          rules engine landed and nothing showed either of them, so a category
          somebody did not choose had its answer in the database and nowhere a
          person could reach. Under the controls rather than beside them: it is
          an explanation of what they show, not a fourth thing to set. */}
      {filedBy !== null && <p className="text-muted-foreground mt-1.5 text-[11px]">{filedBy}</p>}

      {movement === null ? (
        // More than two sides, or two on the same side. Itemised, because there
        // is no sentence that says it.
        <div className="mt-3 border-t pt-3">
          <p className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
            {labels.lines}
          </p>
          <ul className="grid gap-1">
            {entry.lines.map((line, index) => (
              <li
                key={`${line.accountId}-${String(index)}`}
                className="flex items-baseline justify-between gap-4 text-sm"
              >
                <span className="text-muted-foreground min-w-0 truncate">
                  {line.accountName}
                  {line.category !== null && (
                    <span className="text-primary ml-2 text-xs">{line.category}</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  {money(line.amount.amount.toFixed(), line.amount.currency, locale, true)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
          <span className="truncate">{movement.from.accountName}</span>
          <ArrowRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">{labels.to}</span>
          <span className="truncate font-medium">{movement.to.accountName}</span>
        </p>
      )}

      {/* Already reversed: reversing again would take the amount out a second
          time, and the service refuses. No button rather than one that fails. */}
      {canReverse && !reversed && (
        <div className="mt-3 flex justify-end border-t pt-2">
          <ReverseButton id={entry.id} label={labels.reverse} />
        </div>
      )}
    </div>
  );
}
