'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  applyRulesAction,
  createCategoryAction,
  createRuleAction,
  deleteCategoryAction,
  deleteRuleAction,
  previewRulesAction,
} from '@/server/category-actions';

/**
 * The rules that decide what a movement was for.
 *
 * Ordered, readable, and editable one line at a time (plan §8.6). Nothing here
 * learns on its own: a rule exists because somebody wrote it, and the list is
 * the whole of what the engine knows.
 */

export interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly pattern: string;
  readonly direction: string;
  readonly categoryName: string;
}

export interface CategoryView {
  readonly id: string;
  readonly name: string;
}

export function Rules({
  categories,
  rules,
}: {
  categories: readonly CategoryView[];
  rules: readonly RuleView[];
}) {
  const t = useTranslations('categories');
  const [pending, start] = useTransition();

  const [name, setName] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [pattern, setPattern] = useState('');
  const [direction, setDirection] = useState('out');
  const [category, setCategory] = useState('');
  const [preview, setPreview] = useState<{ changed: number; lines: string[] } | null>(null);

  const submit = (work: () => Promise<{ error?: string }>, done: () => void) => {
    start(() => {
      void work().then((result) => {
        if (result.error !== undefined) {
          toast.error(result.error);
          return;
        }
        done();
      });
    });
  };

  return (
    <div className="grid grid-cols-1 gap-8">
      <section className="grid grid-cols-1 gap-3 rounded-2xl border p-5">
        <div>
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">
            {t('categoriesTitle')}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('categoriesHint')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {categories.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noCategories')}</p>
          ) : (
            categories.map((one) => (
              <span
                key={one.id}
                className="bg-muted flex items-center gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs"
              >
                {one.name}
                <button
                  type="button"
                  disabled={pending}
                  aria-label={t('deleteCategory', { name: one.name })}
                  title={t('deleteCategoryHint')}
                  className="hover:bg-foreground/10 flex size-4 items-center justify-center rounded-full transition-colors"
                  onClick={() => {
                    const form = new FormData();
                    form.set('id', one.id);
                    submit(
                      () => deleteCategoryAction(form),
                      () => {
                        toast.success(t('categoryDeleted'));
                      },
                    );
                  }}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))
          )}
        </div>

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData();
            form.set('name', name);
            submit(
              () => createCategoryAction(form),
              () => {
                setName('');
              },
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="category-name">{t('categoryName')}</Label>
            <Input
              id="category-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder={t('categoryPlaceholder')}
              className="sm:w-64"
            />
          </div>
          <Button type="submit" variant="outline" disabled={pending || name.trim() === ''}>
            <Plus className="size-4" aria-hidden />
            {t('addCategory')}
          </Button>
        </form>
      </section>

      <section className="grid grid-cols-1 gap-4 rounded-2xl border p-5">
        <div>
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('rulesTitle')}</h2>
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('rulesHint')}</p>
        </div>

        {rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noRules')}</p>
        ) : (
          <ul className="grid gap-2">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border p-3"
              >
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {rule.priority}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{rule.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {t('ruleReads', {
                      pattern: rule.pattern,
                      direction: t(`direction.${rule.direction}`),
                    })}
                  </span>
                </span>
                <span className="bg-muted shrink-0 rounded-full px-2.5 py-1 text-xs">
                  {rule.categoryName}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label={t('deleteRule')}
                  onClick={() => {
                    const form = new FormData();
                    form.set('id', rule.id);
                    submit(
                      () => deleteRuleAction(form),
                      () => {
                        toast.success(t('ruleDeleted'));
                      },
                    );
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="grid grid-cols-1 items-start gap-3 border-t pt-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData();
            form.set('name', ruleName);
            form.set('pattern', pattern);
            form.set('direction', direction);
            form.set('categoryId', category);
            submit(
              () => createRuleAction(form),
              () => {
                setRuleName('');
                setPattern('');
                toast.success(t('ruleAdded'));
              },
            );
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="rule-name">{t('ruleName')}</Label>
            <Input
              id="rule-name"
              value={ruleName}
              onChange={(event) => {
                setRuleName(event.target.value);
              }}
              placeholder={t('rulePlaceholder')}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rule-pattern">{t('rulePattern')}</Label>
            <Input
              id="rule-pattern"
              value={pattern}
              onChange={(event) => {
                setPattern(event.target.value);
              }}
              placeholder={t('patternPlaceholder')}
            />
            {/* Said once, here, because it is the one thing about these rules
                that is not obvious: they read a cleaned-up label, not the raw
                line, which is what makes a rule outlive next month's file. */}
            <p className="text-muted-foreground text-xs">{t('patternHint')}</p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rule-direction">{t('ruleDirection')}</Label>
            <Select
              name="rule-direction"
              value={direction}
              onValueChange={(value) => {
                setDirection(value ?? 'out');
              }}
            >
              <SelectTrigger id="rule-direction" className="w-full">
                <SelectValue>{t(`direction.${direction}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="out">{t('direction.out')}</SelectItem>
                <SelectItem value="in">{t('direction.in')}</SelectItem>
                <SelectItem value="any">{t('direction.any')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rule-category">{t('ruleCategory')}</Label>
            <Select
              name="rule-category"
              value={category}
              onValueChange={(value) => {
                setCategory(value ?? '');
              }}
            >
              <SelectTrigger id="rule-category" className="w-full">
                <SelectValue>
                  {categories.find((one) => one.id === category)?.name ?? t('chooseCategory')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {categories.map((one) => (
                  <SelectItem key={one.id} value={one.id}>
                    {one.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={
                pending || ruleName.trim() === '' || pattern.trim() === '' || category === ''
              }
            >
              <Plus className="size-4" aria-hidden />
              {t('addRule')}
            </Button>
          </div>
        </form>
      </section>

      <section className="grid grid-cols-1 gap-3 rounded-2xl border p-5">
        <div>
          <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('applyTitle')}</h2>
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('applyHint')}</p>
        </div>

        {/* The count comes before the act, which the plan asks for by name
            (§8.6): re-applying rules is a manual action with a preview of how
            many rows would change. */}
        {preview === null ? (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending || rules.length === 0}
              onClick={() => {
                start(() => {
                  void previewRulesAction().then((outcome) => {
                    if (outcome.error !== undefined || outcome.result === undefined) {
                      toast.error(outcome.error ?? '');
                      return;
                    }
                    setPreview({
                      changed: outcome.result.changed,
                      lines: outcome.result.byCategory.map((one) =>
                        t('wouldBecome', { count: one.count, name: one.name }),
                      ),
                    });
                  });
                });
              }}
            >
              <Wand2 className="size-4" aria-hidden />
              {t('previewRules')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm">{t('wouldChange', { count: preview.changed })}</p>
            {preview.lines.length > 0 && (
              <ul className="text-muted-foreground grid gap-0.5 text-xs">
                {preview.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending || preview.changed === 0}
                onClick={() => {
                  start(() => {
                    void applyRulesAction().then((outcome) => {
                      if (outcome.error !== undefined || outcome.result === undefined) {
                        toast.error(outcome.error ?? '');
                        return;
                      }
                      toast.success(t('applied', { count: outcome.result.changed }));
                      setPreview(null);
                    });
                  });
                }}
              >
                {t('applyRules')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setPreview(null);
                }}
              >
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
