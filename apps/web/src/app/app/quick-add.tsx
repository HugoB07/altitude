'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { quickAddAction, type ActionResult } from '@/server/actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
 * Two accounts, an amount, a date.
 *
 * The smallest thing that proves the ledger works: moving money between two
 * accounts must leave net worth untouched.
 */
export function QuickAdd({ accounts, role }: Props) {
  const [state, action, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => quickAddAction(formData),
    {},
  );

  // Controlled, and the label passed to SelectValue explicitly. Radix resolves
  // an item's text from SelectContent, which is unmounted until the menu is
  // opened - so an uncontrolled Select renders the raw value, and here that
  // value is an account UUID.
  const [from, setFrom] = useState(accounts[0]?.id ?? '');
  const [to, setTo] = useState(accounts[1]?.id ?? '');
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
  const t = useTranslations('quickAdd');

  // The server refuses these roles regardless. Hiding the form is courtesy, not
  // security, and the two must never be confused for one another.
  if (role === 'viewer' || role === 'child') return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>

      <CardContent>
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
            <Input id="description" name="description" placeholder={t('descriptionPlaceholder')} />
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
      </CardContent>
    </Card>
  );
}
