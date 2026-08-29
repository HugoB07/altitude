'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createHouseholdAction, type ActionResult } from '@/server/actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

const CURRENCIES = [
  { code: 'EUR', label: 'EUR - euro' },
  { code: 'USD', label: 'USD - US dollar' },
  { code: 'GBP', label: 'GBP - pound sterling' },
  { code: 'CHF', label: 'CHF - Swiss franc' },
] as const;

export function SetupForm() {
  const [state, action, pending] = useActionState(
    async (_prev: ActionResult, formData: FormData) => createHouseholdAction(formData),
    {},
  );

  // Controlled for the same reason as the account pickers: Radix cannot read an
  // item's label while SelectContent is unmounted.
  const [code, setCode] = useState('EUR');
  const t = useTranslations('setup');

  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="name">{t('householdName')}</Label>
        <Input
          id="name"
          name="name"
          required
          placeholder={t('householdNamePlaceholder')}
          autoFocus
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="currency">{t('baseCurrency')}</Label>
        {/* Radix Select renders a button, not a <select>, so it needs a hidden
            field with the same name for the form action to receive a value. */}
        <Select name="currency" value={code} onValueChange={(v) => setCode(v ?? code)}>
          <SelectTrigger id="currency" className="w-full">
            <SelectValue>{CURRENCIES.find((c) => c.code === code)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{t('baseCurrencyHint')}</p>
      </div>

      {state.error !== undefined && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={pending} className="w-full">
        {t('submit')}
      </Button>
    </form>
  );
}
