'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Globe, Plus } from 'lucide-react';
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
          /* Folded, and grouped by what it files under.
             
             Sixty-two rules listed flat is a wall: it pushed the button that
             runs them a screen and a half down, and put the effect of each rule
             an inch from the right edge of a wide window, away from its name.
             Grouped, the effect is said once per group and the rules under it
             are read as a list of shops. Closed by default because this is
             reference rather than something to act on - what a person does here
             is turn the set on, and then go and run it. */
          <details className="group border-t pt-4">
            <summary className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-medium">
              <ChevronRight
                className="size-3.5 transition-transform group-open:rotate-90"
                aria-hidden
              />
              {t('communityList', { count: rules.length })}
            </summary>

            {/* The category on the left, the rules under it on the right.
                
                Above them it read as a caption: eleven points of muted upper
                case over fourteen points of ordinary text puts the label below
                the data it labels, which is backwards. In a column of its own
                it is a label whatever its size, the way a field's name is, and
                the eye goes down one list instead of across twenty headings. */}
            <dl className="mt-4 grid gap-4">
              {grouped(rules, t('communityNamesOnly')).map((group) => (
                <div
                  key={group.name}
                  className="grid gap-x-6 gap-y-2 border-t pt-4 first:border-t-0 first:pt-0 sm:grid-cols-[9rem_1fr]"
                >
                  <dt className="text-sm font-semibold">{group.name}</dt>
                  <dd className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                    {group.rules.map((rule) => (
                      <div key={rule.id} className="min-w-0">
                        <p className="truncate text-sm">{rule.name}</p>
                        {/* Shown rather than hidden behind a tooltip: the plan
                            asks for the engine to be fully inspectable, and a
                            pattern nobody can read is a rule nobody can check. */}
                        <code className="text-muted-foreground block truncate font-mono text-[11px]">
                          {rule.pattern}
                        </code>
                      </div>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * The rules by what they file under, in the order the categories first appear.
 *
 * Ordered by the set rather than alphabetically, so the groups keep the shape
 * the file has: what two rules would both claim comes before the shops, and the
 * fallbacks come last. A rule that only names a shop has no category to sit
 * under and gets its own group at the end.
 */
function grouped(
  rules: readonly CommunityRuleView[],
  namesOnly: string,
): { name: string; rules: CommunityRuleView[] }[] {
  const groups = new Map<string, CommunityRuleView[]>();

  for (const rule of rules) {
    const name = rule.categoryName ?? namesOnly;
    const already = groups.get(name);
    if (already === undefined) groups.set(name, [rule]);
    else already.push(rule);
  }

  // The unfiled group last wherever it first appeared: it is the exception, and
  // reading it in the middle of the shops is reading it as one of them.
  const found = [...groups].map(([name, list]) => ({ name, rules: list }));
  return [
    ...found.filter((group) => group.name !== namesOnly),
    ...found.filter((group) => group.name === namesOnly),
  ];
}
