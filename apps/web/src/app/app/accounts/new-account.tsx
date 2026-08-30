'use client';

import { useActionState, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createAccountAction, type ActionResult } from '@/server/actions';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  /** The kinds the service will accept. Equity is not among them. */
  kinds: readonly string[];
  baseCurrency: string;
  role: string;
}

export function NewAccount({ kinds, baseCurrency, role }: Props) {
  const t = useTranslations('accounts');
  const kindLabel = useTranslations('accountKind');
  const form = useRef<HTMLFormElement>(null);

  const [state, action, pending] = useActionState(async (_prev: ActionResult, data: FormData) => {
    const result = await createAccountAction(data);
    // Cleared only on success, so a rejected submission keeps what was typed.
    if (result.error === undefined) form.current?.reset();
    return result;
  }, {});

  // Controlled, with the label passed to SelectValue explicitly: the trigger
  // cannot resolve an item's text while SelectContent is unmounted, and would
  // otherwise render the raw value.
  const [kind, setKind] = useState(kinds[0] ?? 'cash');

  // The server refuses these roles regardless. Hiding the form is courtesy,
  // not security, and the two must never be confused for one another.
  if (role === 'viewer' || role === 'child') return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('newTitle')}</CardTitle>
        <CardDescription>{t('newDescription')}</CardDescription>
      </CardHeader>

      <CardContent>
        <form ref={form} action={action} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">{t('name')}</Label>
            <Input id="name" name="name" placeholder={t('namePlaceholder')} required />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="kind">{t('kind')}</Label>
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
            <Label htmlFor="institution">{t('institution')}</Label>
            <Input id="institution" name="institution" placeholder={t('institutionPlaceholder')} />
          </div>

          <input type="hidden" name="currency" value={baseCurrency} />

          {state.error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending}>
            {t('create')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
