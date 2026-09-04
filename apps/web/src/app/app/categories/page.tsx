import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  listCategories,
  listRules,
  listTags,
  RULE_SET_COUNTRIES,
  ruleSetFor,
} from '@altitude/core';
import { getContext, getSessionUser, scoped } from '@/server/context';
import { ensureTenantIsolation } from '@/server/startup';
import { ApplyRules } from './apply';
import { Community, type CommunityRuleView } from './community';
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
  const tags = await scoped((tx) => listTags(tx, ctx.actor));

  /**
   * The active set, resolved against this household's own categories.
   *
   * A shipped rule names a category by key and the household names it by row,
   * so this is where the two meet - and where a key with no row becomes a rule
   * that names a shop and files nothing rather than one that looks broken.
   */
  const set = ruleSetFor(ctx.ruleSet);
  const named = new Map(
    categories.filter((one) => one.key !== null).map((one) => [one.key!, one.name]),
  );

  const community: CommunityRuleView[] =
    set === undefined
      ? []
      : set.rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          pattern: rule.conditions.descriptionMatches ?? '',
          categoryName: rule.category === null ? null : (named.get(rule.category) ?? null),
          counterparty: rule.counterparty,
        }));

  const missing = set === undefined ? 0 : set.categories.filter((key) => !named.has(key)).length;

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('description')}</p>
      </div>

      <Rules
        categories={categories.map((category) => ({ id: category.id, name: category.name }))}
        tags={tags}
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
          counterparty: rule.counterparty,
          tagNames: rule.tagNames,
        }))}
      />

      {/* After a household's own, because that is the order they run in and the
          order they matter in: what somebody wrote about their own statements
          comes first, and this fills what it left. */}
      <Community
        countries={RULE_SET_COUNTRIES.map((code) => ({
          code,
          name: t(`country.${code}` as 'country.fr'),
        }))}
        active={set === undefined ? null : set.country.toLowerCase()}
        activeName={
          set === undefined ? null : t(`country.${set.country.toLowerCase()}` as 'country.fr')
        }
        rules={community}
        missing={missing}
      />

      {/* Last, because it acts on both lists above it: a pass runs what this
          household wrote and then the set under it. */}
      <ApplyRules count={rules.length + community.length} />
    </div>
  );
}
