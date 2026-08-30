import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CREATABLE_KINDS, accountBalances, type AccountBalance } from '@altitude/core';
import { Money } from '@altitude/shared';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
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

  // Widened to string: balances arrive as Money<string>, and the literal type
  // would make every sum with one a mismatch.
  const base: string = 'EUR';
  const groupTotal = (kept: readonly AccountBalance[]) =>
    format(
      kept
        .reduce((sum, b) => sum.plus(b.balance), Money.zero(base))
        .abs()
        .amount.toFixed(),
      base,
      locale,
    );

  const assets = balances.filter((b) => b.classification === 'asset');
  const debts = balances.filter((b) => b.classification === 'liability');
  const equity = balances.filter((b) => b.classification === 'equity');
  const groups = [
    { key: 'assets', accounts: assets, total: groupTotal(assets) },
    { key: 'liabilities', accounts: debts, total: groupTotal(debts) },
  ] as const;

  const editable = ctx.actor.role !== 'viewer' && ctx.actor.role !== 'child';

  return (
    <div className="grid gap-10">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('description')}</p>
        </div>
        <NewAccount kinds={CREATABLE_KINDS} baseCurrency={base} role={ctx.actor.role} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {groups.map((group) => (
          <section key={group.key} className="bg-card/60 rounded-2xl border p-5 sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t(group.key)}</h2>
              {group.accounts.length > 0 && (
                <span className="shrink-0 text-sm font-semibold tabular-nums">{group.total}</span>
              )}
            </div>

            {group.accounts.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('empty')}</p>
            ) : (
              <ul className="grid gap-0.5">
                {group.accounts.map((account) => (
                  <li key={account.accountId}>
                    <Row account={account} locale={locale} editable={editable} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {/* Never editable, by anyone, and deliberately not a section of its own:
          renaming or closing the counterpart of every deposit would break
          transactions invisible from this screen, and a heading would weigh it
          more than the accounts it exists to balance. */}
      {equity.length > 0 && (
        <div className="text-muted-foreground grid max-w-prose gap-1 text-xs">
          {equity.map((account) => (
            <div key={account.accountId} className="flex items-center justify-between gap-3">
              <span className="truncate">
                {account.name} · {t('equityShort')}
              </span>
              <span className="shrink-0 tabular-nums">
                {format(account.balance.amount.toFixed(), account.currency, locale)}
              </span>
            </div>
          ))}
          <p className="mt-1">{t('equityNote')}</p>
        </div>
      )}
    </div>
  );
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
      // An asset in the red is worth flagging. A liability is negative by
      // definition and the opening balance by arithmetic - painting either as an
      // alert says "something is wrong" about the two cases where nothing is.
      alarming={account.classification === 'asset' && account.balance.isNegative()}
      closedOn={account.closedOn}
      editable={editable}
    />
  );
}
