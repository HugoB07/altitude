'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { quickAddAction, type ActionResult } from '@/server/actions';
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
import { DateField } from '@/components/date-field';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  accounts: readonly { id: string; name: string }[];
  role: string;
}

/**
 * Moving money, behind a button.
 *
 * It used to sit open in a column beside the figures, which gave a form the
 * same weight as the numbers it exists to change - and left a third of the
 * dashboard empty underneath it. A dashboard reports; the form is an action
 * taken on what it reports, so it lives in a dialog.
 */
export function QuickAdd({ accounts, role }: Props) {
  const t = useTranslations('quickAdd');
  const notify = useTranslations('toast');
  const [open, setOpen] = useState(false);

  // Closed here rather than from an effect: calling setState synchronously in
  // an effect triggers a cascading render, which the React compiler rejects.
  // A failure leaves it open, so the message stays with the form that caused it.
  const [state, action, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => {
      const result = await quickAddAction(formData);
      if (result.error === undefined) {
        setOpen(false);
        // Confirmed by a toast rather than by the dialog closing. A dialog that
        // vanishes is ambiguous: it looks the same whether the work happened or
        // the escape key was pressed.
        //
        // And it says when a rule filed it. There is no preview on the way in
        // here the way there is for an import, so this is the only place a
        // person learns that something other than them chose the category.
        toast.success(
          result.filedUnder === undefined
            ? notify('transactionRecorded')
            : notify('transactionFiled', { name: result.filedUnder }),
        );
      } else {
        toast.error(result.error);
      }
      return result;
    },
    {},
  );

  // Controlled, and the label passed to SelectValue explicitly. Base UI resolves
  // an item's text from SelectContent, which is unmounted until the menu opens,
  // so an uncontrolled Select renders the raw value - here, an account UUID.
  const [from, setFrom] = useState(accounts[0]?.id ?? '');
  const [to, setTo] = useState(accounts[1]?.id ?? '');
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';

  // The server refuses these roles regardless. Hiding the control is courtesy,
  // not security, and the two must never be confused for one another.
  if (role === 'viewer' || role === 'child') return null;

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        {t('title')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          <form action={action} className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="from">{t('from')}</Label>
              <Select name="from" value={from} onValueChange={(v) => setFrom(v ?? from)}>
                <SelectTrigger id="from" className="w-full">
                  <SelectValue>{nameOf(from)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="to">{t('to')}</Label>
              <Select name="to" value={to} onValueChange={(v) => setTo(v ?? to)}>
                <SelectTrigger id="to" className="w-full">
                  <SelectValue>{nameOf(to)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="amount">{t('amount')}</Label>
              <Input
                id="amount"
                name="amount"
                required
                inputMode="decimal"
                placeholder="300"
                className="tabular-nums"
                aria-describedby="amount-hint"
              />
              <p id="amount-hint" className="text-muted-foreground text-xs">
                {t('amountHint')}
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="bookedOn">{t('date')}</Label>
              <DateField
                id="bookedOn"
                name="bookedOn"
                describedBy="date-hint"
                placeholder={t('datePlaceholder')}
              />
              <p id="date-hint" className="text-muted-foreground text-xs">
                {t('dateHint')}
              </p>
            </div>

            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="description">{t('description_')}</Label>
              <Input
                id="description"
                name="description"
                placeholder={t('descriptionPlaceholder')}
              />
            </div>

            {state.error !== undefined && (
              <Alert variant="destructive" role="alert" className="sm:col-span-2">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={pending} className="sm:col-span-2">
              {t('submit')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
