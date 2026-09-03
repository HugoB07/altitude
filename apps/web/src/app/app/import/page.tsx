import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PRESETS, accountBalances, listImports } from '@altitude/core';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { ImportHistory } from './history';
import { Importer } from './importer';

export const metadata = { title: 'Altitude' };

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  if (ctx === null) redirect('/setup');

  await ensureTenantIsolation();

  const t = await getTranslations('import');
  const balances = await scoped((tx) => accountBalances(tx, ctx.actor));
  const runs = await scoped((tx) => listImports(tx, ctx.actor));

  // Only open accounts: importing into a closed one would reopen a period a
  // person deliberately shut.
  const accounts = balances
    .filter((balance) => balance.closedOn === null)
    .map((balance) => ({ id: balance.accountId, name: balance.name }));

  // Offered for EXTERNAL, which is not a column in anybody's file. See the
  // explanation the screen shows next to it.
  const opening = balances.find((balance) => balance.kind === 'opening_balance');

  return (
    <div className="grid grid-cols-1 gap-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('description')}</p>
      </div>

      <Importer
        presets={PRESETS.map((preset) => ({
          id: preset.id,
          name: preset.name,
          monogram: preset.monogram,
          ...(preset.logo === undefined ? {} : { logo: preset.logo }),
        }))}
        accounts={accounts}
        openingAccountId={opening?.accountId ?? null}
        baseCurrency={ctx.baseCurrency}
      />

      {/* Dates cross to the client as strings. A Date would be serialised and
          rebuilt anyway, and the component formats it in the reader's locale. */}
      <ImportHistory
        runs={runs.map((run) => ({
          id: run.id,
          source: run.source,
          filename: run.filename,
          createdAt: run.createdAt.toISOString(),
          transactions: run.transactions,
          rolledBack: run.rolledBackAt !== null,
        }))}
      />
    </div>
  );
}
