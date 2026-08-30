import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, Undo2 } from 'lucide-react';
import { listTransactions, type LedgerEntry, type LedgerLine } from '@altitude/core';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { Pagination } from '@/components/pagination';
import { ReverseButton } from './reverse-button';

export const metadata = { title: 'Altitude' };

export const dynamic = 'force-dynamic';

const PER_PAGE = 25;

/** The one place a Decimal becomes a number, for display only (ADR-0006). */
function money(amount: string, currency: string, locale: string, signed = false): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

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

  // The page number travels in the URL, so this stays a server component, a
  // reload lands where the reader was, and a page is a thing that can be linked
  // to. Anything unparseable is page one rather than an error.
  const asked = Number.parseInt(typeof params['page'] === 'string' ? params['page'] : '', 10);
  const requested = Number.isFinite(asked) && asked > 0 ? asked : 1;

  const page = await scoped((tx) =>
    listTransactions(tx, ctx.actor, { page: requested, perPage: PER_PAGE }),
  );

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

      {page.transactions.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('transactions.empty')}</p>
      ) : (
        <>
          <ul className="grid gap-3">
            {page.transactions.map((entry) => (
              <li key={entry.id}>
                <Card
                  entry={entry}
                  locale={locale}
                  date={dates.format(new Date(`${entry.bookedOn}T00:00:00`))}
                  kindLabel={t(`transactionKind.${entry.kind}`)}
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
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-muted-foreground text-xs">
              {t('transactions.showing', {
                page: page.page,
                pageCount: page.pageCount,
                total: page.total,
              })}
            </p>

            <Pagination
              page={page.page}
              pageCount={page.pageCount}
              hrefFor={(n) =>
                n <= 1 ? '/app/transactions' : `/app/transactions?page=${String(n)}`
              }
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
  labels,
  canReverse,
}: {
  entry: LedgerEntry;
  locale: string;
  date: string;
  kindLabel: string;
  labels: { reversed: string; isReversal: string; reverse: string; to: string; lines: string };
  canReverse: boolean;
}) {
  const reversed = entry.reversedById !== null;
  const movement = asMovement(entry.lines);

  return (
    <div className={`bg-card/60 rounded-2xl border p-4 sm:p-5 ${reversed ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
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
                <span className="text-muted-foreground min-w-0 truncate">{line.accountName}</span>
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
