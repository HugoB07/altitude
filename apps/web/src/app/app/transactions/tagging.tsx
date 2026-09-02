'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Tags as TagsIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { setTagsAction } from '@/server/category-actions';

/**
 * The tags on one transaction, ticked rather than typed.
 *
 * A popover of checkboxes rather than a select: a transaction carries none, one
 * or five, and every select control on this screen means "choose one of these".
 * Making this one behave differently while looking the same is how somebody
 * loses a tag without noticing.
 *
 * The whole set is sent on every change, and the service replaces rather than
 * merges - otherwise unticking would do nothing.
 */
export function Tagging({
  transactionId,
  current,
  tags,
}: {
  transactionId: string;
  current: readonly string[];
  tags: readonly { id: string; name: string }[];
}) {
  const t = useTranslations('categories');
  const [pending, start] = useTransition();
  const [chosen, setChosen] = useState<readonly string[]>(current);

  if (tags.length === 0) return null;

  const save = (next: readonly string[]) => {
    setChosen(next);

    const form = new FormData();
    form.set('transactionId', transactionId);
    form.set('tagIds', next.join(','));

    start(() => {
      void setTagsAction(form).then((result) => {
        if (result.error !== undefined) {
          toast.error(result.error);
          setChosen(current);
        }
      });
    });
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-label={t('tagThis')}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            <TagsIcon className="size-3.5" aria-hidden />
            {chosen.length === 0 ? t('noTags') : t('tagCount', { count: chosen.length })}
          </Button>
        }
      />
      <PopoverContent className="grid w-56 gap-2 p-3">
        {tags.map((tag) => {
          const id = `tag-${transactionId}-${tag.id}`;
          return (
            <Label
              key={tag.id}
              htmlFor={id}
              className="flex items-center gap-2 text-sm font-normal"
            >
              <Checkbox
                id={id}
                checked={chosen.includes(tag.id)}
                onCheckedChange={(on) => {
                  save(on === true ? [...chosen, tag.id] : chosen.filter((one) => one !== tag.id));
                }}
              />
              {tag.name}
            </Label>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
