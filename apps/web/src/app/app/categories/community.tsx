'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { addStandardCategoriesAction, setRuleSetAction } from '@/server/category-actions';

export interface CommunityRuleView {
  readonly id: string;
  readonly name: string;
  readonly pattern: string;
  /** The household's name for what it files under, or null when it only names a shop. */
  readonly categoryName: string | null;
  readonly counterparty: string | null;
}

/**
 * The rules that came with the application rather than from this household.
 *
 * Read-only on purpose, and the screen says why: a shipped rule is a file, not
 * a row, so it can be covered by a rule of your own or switched off, and it
 * cannot be edited. That is the trade the plan's ordering buys (§8.6) - a
 * correction upstream reaches everybody at the next update, which it could not
 * do if the set had been copied into each database at setup.
 *
 * Off until somebody turns it on. A set that categorised a first import without
 * being asked would be the one thing on this page that happened invisibly.
 */
export function Community({
  countries,
  active,
  activeName,
  rules,
  missing,
}: {
  /** The sets that exist, as country codes with a name to show. */
  readonly countries: readonly { code: string; name: string }[];
  readonly active: string | null;
  readonly activeName: string | null;
  readonly rules: readonly CommunityRuleView[];
  /** Categories the active set points at and this household does not have. */
  readonly missing: number;
}) {
  const t = useTranslations('categories');
  const [pending, start] = useTransition();

  const run = (work: () => Promise<{ error?: string }>, said: string) => {
    start(() => {
      void work().then((result) => {
        if (result.error !== undefined) {
          toast.error(result.error);
          return;
        }
        toast.success(said);
      });
    });
  };

  const choose = (country: string) => {
    const form = new FormData();
    form.set('country', country);
    run(
      () => setRuleSetAction(form),
      country === '' ? t('communityStopped') : t('communityStarted'),
    );
  };

  return (
    <section className="grid gap-4">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('communityTitle')}</h2>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('communityHint')}</p>
      </div>

      <div className="bg-card/60 grid gap-4 rounded-2xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm">
            <Globe className="text-muted-foreground size-4" aria-hidden />
            {active === null
              ? t('communityOff')
              : t('communityOn', { count: rules.length, country: activeName ?? active })}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {active === null ? (
              countries.map((country) => (
                <Button
                  key={country.code}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    choose(country.code);
                  }}
                >
                  {t('communityUse', { country: country.name })}
                </Button>
              ))
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  choose('');
                }}
              >
                {t('communityStop')}
              </Button>
            )}
          </div>
        </div>

        {active !== null && (
          <div className="grid gap-3 border-t pt-4">
            {/* A rule that names a category this household does not have still
                names the shop. Saying so beats a set that looks broken. */}
            <p className="text-muted-foreground max-w-prose text-sm">
              {missing === 0 ? t('communityAll') : t('communityMissing', { count: missing })}
            </p>

            {missing > 0 && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit"
                disabled={pending}
                onClick={() => {
                  run(() => addStandardCategoriesAction(), t('communityAdded'));
                }}
              >
                <Plus className="size-4" aria-hidden />
                {t('communityAdd')}
              </Button>
            )}
          </div>
        )}

        {active !== null && rules.length > 0 && (
          <ul className="grid gap-2 border-t pt-4">
            {rules.map((rule) => (
              <li key={rule.id} className="grid gap-1 sm:flex sm:items-baseline sm:gap-3">
                <span className="text-sm font-medium">{rule.name}</span>
                <code className="text-muted-foreground truncate font-mono text-xs">
                  {rule.pattern}
                </code>
                <span className="text-muted-foreground text-xs sm:ml-auto">
                  {rule.categoryName === null
                    ? t('communityRuleCounterparty', { counterparty: rule.counterparty ?? '' })
                    : t('communityRuleCategory', { category: rule.categoryName })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
