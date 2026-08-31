import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CREATABLE_KINDS, accountBalances, type AccountBalance } from '@altitude/core';
import { Money } from '@altitude/shared';
import { Coins } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { PRESETS } from '@/lib/import-presets';
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

  const base = ctx.baseCurrency;

  /**
   * Only what is in the household's own currency.
   *
   * `Money.plus` throws on a mismatch rather than adding dollars to euros, so
   * without this filter a single foreign account took the whole page down. The
   * ones left out are named below rather than dropped: a total that quietly
   * omits an account is worse than one that says it did.
   */
  const groupTotal = (kept: readonly AccountBalance[]) =>
    format(
      kept
        .filter((b) => b.currency === base)
        .reduce((sum, b) => sum.plus(b.balance), Money.zero(base))
        .abs()
        .amount.toFixed(),
      base,
      locale,
    );

  const foreign = balances.filter(
    (b) => b.currency !== base && b.classification !== 'equity' && b.closedOn === null,
  );

  const assets = balances.filter((b) => b.classification === 'asset');
  const debts = balances.filter((b) => b.classification === 'liability');
  const equity = balances.filter((b) => b.classification === 'equity');
  const groups = [
    { key: 'assets', accounts: assets, total: groupTotal(assets) },
    { key: 'liabilities', accounts: debts, total: groupTotal(debts) },
  ] as const;

  const editable = ctx.actor.role !== 'viewer' && ctx.actor.role !== 'child';

  // Read here, on the server: the registry imports the readers, and they import
  // the database driver.
  const institutions = PRESETS.map((preset) => preset.institution ?? preset.name).sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <div className="grid gap-10">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('description')}</p>
        </div>
        <NewAccount
          kinds={CREATABLE_KINDS}
          baseCurrency={base}
          institutions={institutions}
          role={ctx.actor.role}
        />
      </div>

      {/* Said out loud, because the alternative is a total that is wrong by an
          account and looks exactly like one that is right. Converting them
          needs a dated rate per account, which is phase 3. */}
      {foreign.length > 0 && (
        <Alert>
          <Coins className="size-4" aria-hidden />
          <AlertDescription>
            {t('foreignExcluded', {
              count: foreign.length,
              base,
              names: foreign.map((account) => `${account.name} (${account.currency})`).join(', '),
            })}
          </AlertDescription>
        </Alert>
      )}

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
                    <Row account={account} locale={locale} editable={editable} base={base} />
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
  base,
}: {
  account: AccountBalance;
  locale: string;
  editable: boolean;
  base: string;
}) {
  return (
    <AccountRow
      id={account.accountId}
      name={account.name}
      kind={account.kind}
      institution={account.institution}
      // Only when it differs, so the common case stays quiet and the odd one
      // out says why it is not in the total above it.
      currency={account.currency === base ? null : account.currency}
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
