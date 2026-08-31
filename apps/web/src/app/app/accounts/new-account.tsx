'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { createAccountAction, type ActionResult } from '@/server/actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CURRENCIES, currencyLabel } from '@/lib/currencies';

interface Props {
  /** The kinds the service will accept. Equity is not among them. */
  kinds: readonly string[];
  baseCurrency: string;
  /**
   * Banks Altitude can read, offered as suggestions.
   *
   * Passed in rather than imported. The preset registry pulls in the readers,
   * which pull in `@altitude/core`, which pulls in `postgres` - and this is a
   * client component, so the bundler followed all of it and stopped at
   * "can't resolve 'fs'". A list of strings crosses that boundary; a module
   * graph does not.
   */
  institutions: readonly string[];
  role: string;
}

export function NewAccount({ kinds, baseCurrency, institutions, role }: Props) {
  const t = useTranslations('accounts');
  const kindLabel = useTranslations('accountKind');
  const notify = useTranslations('toast');
  const [open, setOpen] = useState(false);

  // Closed here rather than from an effect: calling setState synchronously in
  // an effect triggers a cascading render, which the React compiler rejects.
  // A failure leaves it open, so the message stays with the form that caused it.
  const [state, action, pending] = useActionState(async (_prev: ActionResult, data: FormData) => {
    const result = await createAccountAction(data);
    if (result.error === undefined) {
      setOpen(false);
      toast.success(notify('accountCreated'));
    } else {
      toast.error(result.error);
    }
    return result;
  }, {});

  const [kind, setKind] = useState(kinds[0] ?? 'cash');
  const [code, setCode] = useState(baseCurrency);

  // The server refuses these roles regardless. Hiding the control is courtesy,
  // not security, and the two must never be confused for one another.
  if (role === 'viewer' || role === 'child') return null;

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        {t('newTitle')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('newTitle')}</DialogTitle>
            <DialogDescription>{t('newDescription')}</DialogDescription>
          </DialogHeader>

          <form action={action} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">{t('name')}</Label>
              <Input id="name" name="name" placeholder={t('namePlaceholder')} required />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="kind">{t('kind')}</Label>
              {/* Controlled, with the label passed explicitly: the trigger cannot
                  resolve an item's text while SelectContent is unmounted. */}
              <Select name="kind" value={kind} onValueChange={(v) => setKind(v ?? kind)}>
                <SelectTrigger id="kind" className="w-full">
                  <SelectValue>{kindLabel(kind)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {kinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {kindLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="currency">{t('currency')}</Label>
              <Select name="currency" value={code} onValueChange={(v) => setCode(v ?? code)}>
                <SelectTrigger id="currency" className="w-full">
                  <SelectValue>{currencyLabel(code)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((currency) => (
                    <SelectItem key={currency.code} value={currency.code}>
                      {currency.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Said before the account exists rather than after, because a
                  currency cannot be changed once entries are posted against it
                  and the account will sit outside every total. */}
              {code !== baseCurrency && (
                <p className="text-muted-foreground text-xs">
                  {t('currencyAside', { base: baseCurrency })}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="institution">{t('institution')}</Label>
              <Input
                id="institution"
                name="institution"
                list="known-institutions"
                placeholder={t('institutionPlaceholder')}
                aria-describedby="institution-hint"
              />
              {/* Suggestions, not a closed list. Naming a bank Altitude can
                  read puts its mark on the account and lets an import of that
                  bank find this account by name later; naming one it cannot
                  read is still worth doing, and still allowed. */}
              <datalist id="known-institutions">
                {institutions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p id="institution-hint" className="text-muted-foreground text-xs">
                {t('institutionHint')}
              </p>
            </div>

            {state.error !== undefined && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={pending}>
              {t('create')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
