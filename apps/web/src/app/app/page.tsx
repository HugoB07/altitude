import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowDownRight, ArrowUpRight, Sparkles } from 'lucide-react';
import { accountBalances, netWorth, type AccountBalance } from '@altitude/core';
import { Money } from '@altitude/shared';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
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

/** Sums one class of account, in one currency. */
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
  // Widened to string on purpose: balances arrive as Money<string>, and the
  // literal type would make every sum with one a mismatch. Multi-currency is
  // phase 3, and this is the variable that becomes a lookup then.
  const base: string = 'EUR';

  const all = await scoped((tx) => accountBalances(tx, ctx.actor));

  // Closed accounts leave the dashboard entirely. They are guaranteed empty -
  // closeAccount refuses otherwise - so dropping them changes no total, only
  // the length of the list.
  const balances = all.filter((b) => b.closedOn === null);

  const assets = balances.filter((b) => b.classification === 'asset');
  const debts = balances.filter((b) => b.classification === 'liability');
  const equity = balances.filter((b) => b.classification === 'equity');

  const total = netWorth(balances, base);
  const assetTotal = totalOf(balances, base, (b) => b.classification === 'asset');
  // Liability balances are negative, so the magnitude is what a reader expects
  // next to the word "debt". The sign lives in the net worth above.
  const debtTotal = totalOf(balances, base, (b) => b.classification === 'liability').abs();

  const hasMovement = balances.some((b) => !b.balance.isZero());

  /**
   * Assets by kind, largest first.
   *
   * Only positive holdings are charted. A cash account overdrawn into the
   * negative is an asset with a negative balance, and a bar segment cannot be
   * negative - it would either vanish or, worse, render as a positive share of
   * something the household does not have.
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
        // Divided as a Decimal, then read as a number for a CSS width.
        share: Number(value.amount.div(chartTotal.amount).times(100).toFixed(4)),
      }))
    : [];

  return (
    <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
      <div className="grid gap-6 lg:col-span-2">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-muted-foreground text-sm font-medium">
              {t('dashboard.netWorth')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div>
              <p className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
                {format(total.amount.toFixed(), base, locale)}
              </p>
              <p className="text-muted-foreground mt-2 text-sm">{t('dashboard.netWorthHint')}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat
                label={t('dashboard.assets')}
                value={format(assetTotal.amount.toFixed(), base, locale)}
                tone="up"
              />
              <Stat
                label={t('dashboard.liabilities')}
                value={format(debtTotal.amount.toFixed(), base, locale)}
                tone="down"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.allocation')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Allocation
              segments={segments}
              emptyLabel={t('dashboard.allocationEmpty')}
              shareLabel={(percent) => t('dashboard.share', { percent })}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">{t('dashboard.assetAccounts')}</CardTitle>
            <span className="text-muted-foreground text-xs">
              {t('dashboard.accountCount', { count: assets.length })}
            </span>
          </CardHeader>
          <CardContent className="pt-0">
            <AccountList accounts={assets} locale={locale} />
          </CardContent>
        </Card>

        {debts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('dashboard.liabilityAccounts')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <AccountList accounts={debts} locale={locale} />
            </CardContent>
          </Card>
        )}

        {/* Equity, shown rather than hidden. It is plumbing, not something the
            household owns, but an account list that quietly omitted where the
            money came from would not add up for anyone who looked. */}
        {equity.length > 0 && (
          <div className="text-muted-foreground grid gap-1.5 px-1 text-xs">
            {equity.map((account) => (
              <div key={account.accountId} className="flex items-center justify-between gap-3">
                <span className="truncate">
                  {account.name} · {t('dashboard.equityNote')}
                </span>
                <span className="shrink-0 tabular-nums">
                  {format(account.balance.amount.toFixed(), account.currency, locale)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:sticky lg:top-22">
        {!hasMovement && (
          <Card className="border-dashed shadow-none">
            <CardContent className="flex gap-3 py-5">
              <Sparkles className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="grid gap-1">
                <p className="text-sm font-medium">{t('dashboard.emptyTitle')}</p>
                <p className="text-muted-foreground text-sm">{t('dashboard.emptyBody')}</p>
              </div>
            </CardContent>
          </Card>
        )}

        <QuickAdd
          accounts={balances.map((a) => ({ id: a.accountId, name: a.name }))}
          role={ctx.actor.role}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'up' | 'down' }) {
  const Icon = tone === 'up' ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="bg-muted/50 rounded-lg px-3.5 py-3">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{value}</p>
    </div>
  );
}

async function AccountList({
  accounts,
  locale,
}: {
  accounts: readonly AccountBalance[];
  locale: string;
}) {
  const t = await getTranslations();

  return (
    <ul>
      {accounts.map((account, index) => (
        <li key={account.accountId}>
          {index > 0 && <Separator />}
          <div className="flex items-center justify-between gap-4 py-3">
            <span className="grid min-w-0">
              <span className="truncate text-sm font-medium">{account.name}</span>
              <span className="text-muted-foreground truncate text-xs capitalize">
                {t(`accountKind.${account.kind}`)}
              </span>
            </span>
            <span
              className={`shrink-0 text-sm tabular-nums ${
                account.balance.isNegative() ? 'text-destructive' : ''
              }`}
            >
              {format(account.balance.amount.toFixed(), account.currency, locale)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
