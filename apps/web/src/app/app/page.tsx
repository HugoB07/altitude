import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { accountBalances, netWorth } from '@altitude/core';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { QuickAdd } from './quick-add';
import { SignOut } from './sign-out';

export const metadata = { title: 'Altitude' };

// Per-user by definition: these pages read a session, so they can never be
// static. Declared rather than inferred from the first dynamic API call -
// without it the build tries to prerender, reaches the auth setup before the
// dynamic signal, and fails on a missing DATABASE_URL that production would
// have had anyway.
export const dynamic = 'force-dynamic';

/**
 * Amounts are formatted here and nowhere else.
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

export default async function DashboardPage() {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  // Signed in but in no household yet: that is what /setup is for.
  if (ctx === null) redirect('/setup');

  await ensureTenantIsolation();

  const t = await getTranslations();
  const locale = await getLocale();

  const balances = await scoped((tx) => accountBalances(tx, ctx.actor));
  const assets = balances.filter((b) => !b.isLiability);
  const total = netWorth(assets, 'EUR');

  return (
    <div className="bg-muted/30 min-h-screen">
      <main className="mx-auto grid max-w-3xl gap-6 px-6 py-10">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-muted-foreground text-sm">{ctx.displayName}</p>
            <h1 className="text-xl font-semibold tracking-tight">Altitude</h1>
          </div>
          <SignOut />
        </header>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-medium">
              {t('dashboard.netWorth')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-5xl font-semibold tracking-tight tabular-nums">
              {format(total.amount.toFixed(), 'EUR', locale)}
            </p>
            <p className="text-muted-foreground mt-2 text-sm">{t('dashboard.netWorthHint')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.accounts')}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul>
              {balances.map((account, index) => (
                <li key={account.accountId}>
                  {index > 0 && <Separator />}
                  <div className="flex items-center justify-between py-3">
                    <span className="grid">
                      <span className="text-sm font-medium">{account.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {t(`accountKind.${account.kind}`)}
                        {account.isLiability ? ` · ${t('dashboard.notCounted')}` : ''}
                      </span>
                    </span>
                    <span
                      className={`text-sm tabular-nums ${
                        account.balance.isNegative() ? 'text-destructive' : ''
                      }`}
                    >
                      {format(account.balance.amount.toFixed(), account.currency, locale)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <QuickAdd
          accounts={balances.map((a) => ({ id: a.accountId, name: a.name }))}
          role={ctx.actor.role}
        />
      </main>
    </div>
  );
}
