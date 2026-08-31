import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { accountBalances, netWorth, type AccountBalance } from '@altitude/core';
import { Money } from '@altitude/shared';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { AccountIcon } from '@/components/account-icon';
import { Allocation, type AllocationSegment } from './allocation';
import { QuickAdd } from './quick-add';

export const metadata = { title: 'Altitude' };

export const dynamic = 'force-dynamic';

/**
 * Amounts become numbers here and nowhere else.
 *
 * Intl.NumberFormat takes a number, and this is the one place a Decimal is
 * allowed to become one: at the very end, for display, after every sum has been
 * done exactly (ADR-0006). Nothing downstream computes with the result.
 */
function format(amount: string, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

function totalOf(
  balances: readonly AccountBalance[],
  currency: string,
  keep: (balance: AccountBalance) => boolean,
): Money {
  return balances
    .filter((balance) => balance.currency === currency && keep(balance))
    .reduce((total, balance) => total.plus(balance.balance), Money.zero(currency));
}

export default async function DashboardPage() {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  if (ctx === null) redirect('/setup');

  await ensureTenantIsolation();

  const t = await getTranslations();
  const locale = await getLocale();
  // Widened on purpose: balances arrive as Money<string>, and the literal type
  // would make every sum with one a mismatch. Multi-currency is phase 3.
  const base = ctx.baseCurrency;

  const all = await scoped((tx) => accountBalances(tx, ctx.actor));
  // Closed accounts leave the dashboard. closeAccount refuses a non-empty one,
  // so dropping them changes no total, only the length of the list.
  const balances = all.filter((b) => b.closedOn === null);

  const assets = balances.filter((b) => b.classification === 'asset');
  const debts = balances.filter((b) => b.classification === 'liability');

  const total = netWorth(balances, base);
  const assetTotal = totalOf(balances, base, (b) => b.classification === 'asset');
  // Liability balances are negative, so the magnitude is what a reader expects
  // next to the word "debt". The sign lives in the net worth above.
  const debtTotal = totalOf(balances, base, (b) => b.classification === 'liability').abs();

  const hasMovement = balances.some((b) => !b.balance.isZero());

  /**
   * Assets by kind, largest first.
   *
   * Only positive holdings are charted. An overdrawn cash account is an asset
   * with a negative balance, and an arc cannot be negative: it would either
   * vanish or render as a positive share of something nobody has.
   */
  const byKind = new Map<string, Money>();
  for (const account of assets) {
    if (account.currency !== base || !account.balance.isPositive()) continue;
    byKind.set(account.kind, (byKind.get(account.kind) ?? Money.zero(base)).plus(account.balance));
  }

  const chartable = [...byKind.entries()].sort((a, b) => b[1].compare(a[1]));
  const chartTotal = chartable.reduce((sum, [, value]) => sum.plus(value), Money.zero(base));

  const segments: AllocationSegment[] = chartTotal.isPositive()
    ? chartable.map(([kind, value]) => ({
        key: kind,
        label: t(`accountKind.${kind}`),
        amount: format(value.amount.toFixed(), base, locale),
        share: Number(value.amount.div(chartTotal.amount).times(100).toFixed(4)),
        shareText: t('dashboard.share', {
          percent: value.amount.div(chartTotal.amount).times(100).toFixed(1),
        }),
      }))
    : [];

  return (
    <div className="grid gap-6">
      {/* The headline sits on the page, unboxed. A figure that matters more than
          everything else on the screen should not be inside the same kind of
          container as everything else on the screen. */}
      <section className="flex flex-wrap items-start justify-between gap-x-6 gap-y-5 pt-2 pb-1">
        <div>
          <p className="text-muted-foreground text-[13px] font-medium">{t('dashboard.netWorth')}</p>
          <p className="mt-1.5 text-5xl font-semibold tracking-tight tabular-nums">
            {format(total.amount.toFixed(), base, locale)}
          </p>
          <p className="text-muted-foreground mt-2.5 max-w-prose text-sm">
            {t('dashboard.netWorthHint')}
          </p>

          <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-4">
            <Stat
              label={t('dashboard.assets')}
              value={format(assetTotal.amount.toFixed(), base, locale)}
            />
            <Stat
              label={t('dashboard.liabilities')}
              value={format(debtTotal.amount.toFixed(), base, locale)}
            />
            <Stat
              label={t('dashboard.accounts')}
              value={t('dashboard.accountCount', { count: balances.length })}
            />
          </dl>
        </div>

        <QuickAdd
          accounts={balances.map((a) => ({ id: a.accountId, name: a.name }))}
          role={ctx.actor.role}
        />
      </section>

      {!hasMovement && (
        <div className="rounded-2xl border border-dashed p-5">
          <p className="text-sm font-medium">{t('dashboard.emptyTitle')}</p>
          <p className="text-muted-foreground mt-1 text-sm">{t('dashboard.emptyBody')}</p>
        </div>
      )}

      {/* Panels, not the flat page. The complaint about cards was that they all
          weighed the same and boxed the headline in with the detail; a quiet
          surface under the detail while the headline stays on the page is the
          hierarchy that was missing. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel title={t('dashboard.allocation')}>
          <Allocation
            segments={segments}
            total={format(chartTotal.amount.toFixed(), base, locale)}
            totalLabel={t('dashboard.assets')}
            emptyLabel={t('dashboard.allocationEmpty')}
          />
        </Panel>

        <div className="grid gap-6">
          <Panel
            title={t('dashboard.assetAccounts')}
            action={
              <Link
                href="/app/accounts"
                className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 text-xs font-medium transition-colors"
              >
                {t('dashboard.manageAccounts')}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          >
            <AccountRows
              accounts={assets}
              locale={locale}
              scale={assetTotal}
              labelOf={(kind) => t(`accountKind.${kind}`)}
              shareOf={(percent) => t('dashboard.sharePlain', { percent })}
              base={base}
            />
          </Panel>

          {debts.length > 0 && (
            <Panel title={t('dashboard.liabilityAccounts')}>
              <AccountRows
                accounts={debts}
                locale={locale}
                scale={debtTotal}
                labelOf={(kind) => t(`accountKind.${kind}`)}
                shareOf={(percent) => t('dashboard.sharePlain', { percent })}
                base={base}
              />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-card/60 rounded-2xl border p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-wide uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Accounts as rows with a glyph, a weight and an amount.
 *
 * The bar repeats the percentage next to it on purpose: a column of numbers
 * gives the ranking only after you have read every one, and the shape of a
 * household is legible from the bars at a glance. The percentage is bare here
 * rather than "x % of assets" - the panel heading already said which.
 */
function AccountRows({
  accounts,
  locale,
  scale,
  labelOf,
  shareOf,
  base,
}: {
  accounts: readonly AccountBalance[];
  locale: string;
  /** What a full bar means. Zero when there is nothing to compare against. */
  scale: Money;
  labelOf: (kind: string) => string;
  shareOf: (percent: string) => string;
  /** The household's own currency, so an account in another one can say so. */
  base: string;
}) {
  const reference = scale.abs();

  return (
    <ul className="grid gap-0.5">
      {accounts.map((account) => {
        const share = reference.isZero()
          ? 0
          : Number(account.balance.abs().amount.div(reference.amount).times(100).toFixed(2));

        return (
          <li
            key={account.accountId}
            className="hover:bg-muted/50 -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors"
          >
            <AccountIcon kind={account.kind} />

            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] leading-tight font-medium">{account.name}</p>
              {/* Kind, then who holds it, then its currency when it is not the
                  household's - the third being why this account is missing
                  from the total above. */}
              <p className="text-muted-foreground mt-0.5 truncate text-xs">
                {[
                  labelOf(account.kind),
                  account.institution,
                  account.currency === base ? null : account.currency,
                ]
                  .filter((part) => part !== null && part !== '')
                  .join(' · ')}
              </p>
            </div>

            <span className="bg-muted hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full sm:block">
              <span
                className="bg-foreground/40 block h-full rounded-full"
                style={{ width: `${Math.min(share, 100)}%` }}
              />
            </span>

            <span className="text-muted-foreground hidden w-14 shrink-0 text-right text-xs tabular-nums sm:block">
              {shareOf(share.toFixed(1))}
            </span>

            <span
              className={`w-32 shrink-0 text-right text-[15px] font-semibold tabular-nums ${
                account.classification === 'asset' && account.balance.isNegative()
                  ? 'text-destructive'
                  : ''
              }`}
            >
              {format(account.balance.amount.toFixed(), account.currency, locale)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
