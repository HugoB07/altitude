'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createRuleAction, setCategoryAction } from '@/server/category-actions';

/** Base UI reads an empty value as "nothing selected", so "none" needs a name. */
const NONE = 'none';

/**
 * Filing one transaction by hand, and being offered a rule for the rest.
 *
 * The plan calls this explicit learning (§8.6): recategorising offers to write
 * a rule for all similar descriptions, and the offer is an offer. Nothing is
 * learned by watching, because a tool that quietly wrote a rule every time you
 * corrected it is a tool you stop correcting.
 */
export function Categorise({
  transactionId,
  description,
  current,
  categories,
}: {
  transactionId: string;
  description: string | null;
  /** The category id currently on this transaction, or the empty string. */
  current: string;
  categories: readonly { id: string; name: string }[];
}) {
  const t = useTranslations('categories');
  const [pending, start] = useTransition();
  const [chosen, setChosen] = useState(current === '' ? NONE : current);

  if (categories.length === 0) return null;

  const nameOf = (id: string) => categories.find((one) => one.id === id)?.name ?? '';

  const offerRule = (categoryId: string, pattern: string) => {
    toast.success(t('filedUnder', { name: nameOf(categoryId) }), {
      action: {
        label: t('offerRule'),
        onClick: () => {
          const form = new FormData();
          form.set('name', nameOf(categoryId));
          form.set('pattern', pattern);
          // Money out: what a rule written from a purchase almost always
          // means, and what stops it claiming the refund as well.
          form.set('direction', 'out');
          form.set('categoryId', categoryId);
          start(() => {
            void createRuleAction(form).then((made) => {
              if (made.error !== undefined) {
                toast.error(made.error);
                return;
              }
              toast.success(t('ruleAddedFrom', { pattern }));
            });
          });
        },
      },
    });
  };

  return (
    <Select
      name={`category-${transactionId}`}
      value={chosen}
      onValueChange={(value) => {
        const next = value ?? NONE;
        setChosen(next);

        const form = new FormData();
        form.set('transactionId', transactionId);
        form.set('categoryId', next === NONE ? '' : next);
        form.set('description', description ?? '');

        start(() => {
          void setCategoryAction(form).then((result) => {
            if (result.error !== undefined) {
              toast.error(result.error);
              setChosen(current === '' ? NONE : current);
              return;
            }
            if (next === NONE || result.suggestion === undefined) {
              toast.success(t('filed'));
              return;
            }
            offerRule(next, result.suggestion);
          });
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t('fileUnder')}
        disabled={pending}
        className="h-7 w-auto gap-1.5 text-xs"
      >
        <SelectValue>{chosen === NONE ? t('uncategorised') : nameOf(chosen)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('uncategorised')}</SelectItem>
        {categories.map((one) => (
          <SelectItem key={one.id} value={one.id}>
            {one.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
