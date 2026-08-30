'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Lock, Unlock } from 'lucide-react';
import {
  closeAccountAction,
  renameAccountAction,
  reopenAccountAction,
  type ActionResult,
} from '@/server/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface AccountRowProps {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** Already formatted for the reader's locale. */
  readonly balance: string;
  readonly negative: boolean;
  readonly closedOn: string | null;
  readonly editable: boolean;
}

/**
 * One account: rename in place, close, reopen.
 *
 * The name is an input rather than a label with an edit button, and the save
 * control appears only once the value differs from what is stored. Nothing
 * submits on blur - a rename that happens because someone clicked elsewhere is
 * a rename nobody asked for.
 */
export function AccountRow(props: AccountRowProps) {
  const t = useTranslations('accounts');
  const kindLabel = useTranslations('accountKind');
  const [name, setName] = useState(props.name);

  const [renameState, rename, renaming] = useActionState(
    async (_prev: ActionResult, data: FormData) => renameAccountAction(data),
    {},
  );
  const [closeState, toggle, toggling] = useActionState(
    async (_prev: ActionResult, data: FormData) =>
      props.closedOn === null ? closeAccountAction(data) : reopenAccountAction(data),
    {},
  );

  const dirty = name.trim() !== props.name && name.trim() !== '';
  const error = renameState.error ?? closeState.error;
  const closed = props.closedOn !== null;

  return (
    <div className="grid gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {props.editable ? (
          <form action={rename} className="flex min-w-0 flex-1 items-center gap-2">
            <input type="hidden" name="id" value={props.id} />
            <Input
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label={t('name')}
              className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 shadow-none hover:border-input focus-visible:border-input"
            />
            {dirty && (
              <Button type="submit" size="icon-sm" variant="ghost" disabled={renaming}>
                <Check className="size-4" aria-hidden />
                <span className="sr-only">{t('save')}</span>
              </Button>
            )}
          </form>
        ) : (
          <span className="min-w-0 flex-1 truncate px-2 text-sm font-medium">{props.name}</span>
        )}

        <span
          className={`shrink-0 text-sm tabular-nums ${props.negative ? 'text-destructive' : ''}`}
        >
          {props.balance}
        </span>

        {props.editable && (
          <form action={toggle}>
            <input type="hidden" name="id" value={props.id} />
            <Button
              type="submit"
              size="icon-sm"
              variant="ghost"
              disabled={toggling}
              title={closed ? t('reopen') : t('close')}
              aria-label={closed ? t('reopen') : t('close')}
              className="text-muted-foreground hover:text-foreground"
            >
              {closed ? <Unlock className="size-4" /> : <Lock className="size-4" />}
            </Button>
          </form>
        )}
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 px-2 text-xs">
        <span className="capitalize">{kindLabel(props.kind)}</span>
        {closed && (
          <span className="bg-muted rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {t('closedBadge')}
          </span>
        )}
      </div>

      {error !== undefined && <p className="text-destructive px-2 text-xs">{error}</p>}
    </div>
  );
}
