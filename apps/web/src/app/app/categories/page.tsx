import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { listCategories, listRules } from '@altitude/core';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { Rules } from './rules';

export const metadata = { title: 'Altitude' };

export const dynamic = 'force-dynamic';

export default async function CategoriesPage() {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  if (ctx === null) redirect('/setup');

  await ensureTenantIsolation();

  const t = await getTranslations('categories');
  const categories = await scoped((tx) => listCategories(tx, ctx.actor));
  const rules = await scoped((tx) => listRules(tx, ctx.actor));

  return (
    <div className="grid grid-cols-1 gap-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('description')}</p>
      </div>

      <Rules
        categories={categories.map((category) => ({ id: category.id, name: category.name }))}
        rules={rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          priority: rule.priority,
          pattern: rule.conditions.descriptionMatches ?? '',
          direction:
            rule.conditions.amountBetween === undefined
              ? 'any'
              : rule.conditions.amountBetween[0].startsWith('-')
                ? 'out'
                : 'in',
          categoryName: rule.categoryName,
        }))}
      />
    </div>
  );
}
