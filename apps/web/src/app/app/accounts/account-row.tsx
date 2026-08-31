'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Lock, Pencil, Unlock, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  closeAccountAction,
  renameAccountAction,
  reopenAccountAction,
  type ActionResult,
} from '@/server/actions';
import { AccountIcon } from '@/components/account-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface AccountRowProps {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** Who holds it, when somebody said so. */
  readonly institution: string | null;
  /** Shown beside the balance when it is not the household's own. */
  readonly currency: string | null;
  /** Already formatted for the reader's locale. */
  readonly balance: string;
  /** Whether to render the amount as a warning. Equity is never negative news. */
  readonly alarming: boolean;
  readonly closedOn: string | null;
  readonly editable: boolean;
}

/**
 * One account: a line of text, with the controls that act on it.
 *
 * The name was a permanently visible text field, which on a themed input turns
 * every row into what looks like a search box - four of them stacked read as a
 * form, not as a list of accounts. It is text now, and becomes a field only
 * when someone asks to rename it.
 */
export function AccountRow(props: AccountRowProps) {
  const t = useTranslations('accounts');
  const kindLabel = useTranslations('accountKind');
  const notify = useTranslations('toast');

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.name);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  const [renameState, rename, renaming] = useActionState(
    async (_prev: ActionResult, data: FormData) => {
      const result = await renameAccountAction(data);
      if (result.error === undefined) {
        setEditing(false);
        toast.success(notify('accountRenamed'));
      } else {
        toast.error(result.error);
      }
      return result;
    },
    {},
  );
  const [closeState, toggle, toggling] = useActionState(
    async (_prev: ActionResult, data: FormData) => {
      const closing = props.closedOn === null;
      const result = closing ? await closeAccountAction(data) : await reopenAccountAction(data);
      if (result.error === undefined) {
        toast.success(notify(closing ? 'accountClosed' : 'accountReopened'));
      } else {
        // Refusing to close an account that still holds money is the message
        // most worth surfacing here, and it is long enough to need the room.
        toast.error(result.error);
      }
      return result;
    },
    {},
  );

  const error = renameState.error ?? closeState.error;
  const closed = props.closedOn !== null;

  return (
    <div className="hover:bg-muted/50 -mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 transition-colors">
      <AccountIcon kind={props.kind} />
      {editing ? (
        <form action={rename} className="flex min-w-0 flex-1 items-center gap-1.5">
          <input type="hidden" name="id" value={props.id} />
          <Input
            ref={field}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setName(props.name);
                setEditing(false);
              }
            }}
            aria-label={t('name')}
            className="h-8 min-w-0 flex-1"
          />
          <Button type="submit" size="icon-sm" variant="ghost" disabled={renaming}>
            <Check className="size-4" aria-hidden />
            <span className="sr-only">{t('save')}</span>
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              setName(props.name);
              setEditing(false);
            }}
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">{t('cancel')}</span>
          </Button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate text-[15px] leading-tight font-medium">{props.name}</span>
            {closed && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                {t('closedBadge')}
              </span>
            )}
          </p>
          {/* The institution earns its place here. It was a field people
              filled in and nobody ever saw, which is a field nobody fills in
              twice. Currency only when it is not the household's, where it
              explains why this account is missing from the totals. */}
          <p className="text-muted-foreground mt-0.5 truncate text-xs">
            {[kindLabel(props.kind), props.institution, props.currency]
              .filter((part) => part !== null && part !== '')
              .join(' · ')}
          </p>
        </div>
      )}

      <span
        className={`shrink-0 text-[15px] font-semibold tabular-nums ${
          props.alarming ? 'text-destructive' : ''
        }`}
      >
        {props.balance}
      </span>

      {props.editable && !editing && (
        // Always rendered rather than revealed on hover: a control that appears
        // only under a pointer is a control a touch screen never shows.
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            title={t('edit')}
            aria-label={`${t('edit')} - ${props.name}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" aria-hidden />
          </Button>
          <form action={toggle}>
            <input type="hidden" name="id" value={props.id} />
            <Button
              type="submit"
              size="icon-sm"
              variant="ghost"
              disabled={toggling}
              title={closed ? t('reopen') : t('close')}
              aria-label={`${closed ? t('reopen') : t('close')} - ${props.name}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {closed ? (
                <Unlock className="size-3.5" aria-hidden />
              ) : (
                <Lock className="size-3.5" aria-hidden />
              )}
            </Button>
          </form>
        </div>
      )}

      {error !== undefined && <p className="text-destructive w-full text-xs">{error}</p>}
    </div>
  );
}
