import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CREATABLE_KINDS, accountBalances, type AccountBalance } from '@altitude/core';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { AccountRow } from './account-row';
import { NewAccount } from './new-account';

export const metadata = { title: 'Altitude' };

export const dynamic = 'force-dynamic';

/** The one place a Decimal becomes a number, for display only (ADR-0006). */
function format(amount: string, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

export default async function AccountsPage() {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  if (ctx === null) redirect('/setup');

  await ensureTenantIsolation();

  const t = await getTranslations('accounts');
  const locale = await getLocale();
  const balances = await scoped((tx) => accountBalances(tx, ctx.actor));

  const groups = [
    { key: 'assets', accounts: balances.filter((b) => b.classification === 'asset') },
    { key: 'liabilities', accounts: balances.filter((b) => b.classification === 'liability') },
  ] as const;

  const equity = balances.filter((b) => b.classification === 'equity');

  return (
    <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
      <div className="grid gap-6 lg:col-span-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
        </div>

        {groups.map((group) => (
          <Card key={group.key}>
            <CardHeader>
              <CardTitle className="text-base">{t(group.key)}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {group.accounts.length === 0 ? (
                <p className="text-muted-foreground py-2 text-sm">{t('empty')}</p>
              ) : (
                <div>
                  {group.accounts.map((account, index) => (
                    <div key={account.accountId}>
                      {index > 0 && <Separator />}
                      <Row
                        account={account}
                        locale={locale}
                        editable={editableBy(ctx.actor.role)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {equity.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('equity')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {/* Never editable, by anyone. Renaming or closing the counterpart
                  of every deposit would break transactions nobody is looking at
                  from this screen. */}
              {equity.map((account) => (
                <Row key={account.accountId} account={account} locale={locale} editable={false} />
              ))}
              <p className="text-muted-foreground px-2 pt-1 text-xs">{t('equityNote')}</p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:sticky lg:top-22">
        <NewAccount kinds={CREATABLE_KINDS} baseCurrency="EUR" role={ctx.actor.role} />
        <p className="text-muted-foreground px-1 text-xs">{t('closeHint')}</p>
      </div>
    </div>
  );
}

/** Who may rename and close. The service refuses the rest regardless. */
function editableBy(role: string): boolean {
  return role !== 'viewer' && role !== 'child';
}

function Row({
  account,
  locale,
  editable,
}: {
  account: AccountBalance;
  locale: string;
  editable: boolean;
}) {
  return (
    <AccountRow
      id={account.accountId}
      name={account.name}
      kind={account.kind}
      balance={format(account.balance.amount.toFixed(), account.currency, locale)}
      negative={account.balance.isNegative()}
      closedOn={account.closedOn}
      editable={editable}
    />
  );
}
