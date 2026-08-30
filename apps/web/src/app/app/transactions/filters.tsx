'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DateField } from '@/components/date-field';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface FilterValues {
  readonly accountId: string;
  readonly kind: string;
  readonly status: string;
  readonly from: string;
  readonly to: string;
}

interface Props {
  readonly accounts: readonly { id: string; name: string }[];
  readonly kinds: readonly string[];
  readonly statuses: readonly string[];
  readonly value: FilterValues;
  readonly active: boolean;
}

/**
 * The filter bar, as a plain GET form.
 *
 * A form rather than links or client state: submitting builds the query string
 * itself, the result is a URL that can be bookmarked and shared, reloading
 * keeps what was chosen, and the whole thing works with JavaScript off. The
 * page it drives stays a server component.
 *
 * `page` is deliberately not carried across. Changing a filter changes how many
 * pages there are, so keeping the old number would land the reader on page 7 of
 * a result that now has two - or on nothing at all.
 */
export function TransactionFilters({ accounts, kinds, statuses, value, active }: Props) {
  const t = useTranslations('transactions');
  const kindLabel = useTranslations('transactionKind');

  // Controlled, and the label passed to SelectValue explicitly: Base UI resolves
  // an item's text from SelectContent, which is unmounted until the menu opens.
  const [accountId, setAccountId] = useState(value.accountId);
  const [kind, setKind] = useState(value.kind);
  const [status, setStatus] = useState(value.status);

  const accountName = accounts.find((a) => a.id === accountId)?.name ?? t('anyAccount');
  const statusLabel = (key: string) =>
    key === 'reversal'
      ? t('statusReversal')
      : key === 'reversed'
        ? t('statusReversed')
        : t('statusAll');

  return (
    <form
      method="get"
      action="/app/transactions"
      className="bg-card/60 grid gap-4 rounded-2xl border p-4 sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold tracking-wide uppercase">
          <Filter className="size-3.5" aria-hidden />
          {t('filters')}
        </p>
        {active && (
          <Link
            href="/app/transactions"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
          >
            <X className="size-3.5" aria-hidden />
            {t('clear')}
          </Link>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="grid gap-1.5">
          <Label htmlFor="accountId">{t('filterAccount')}</Label>
          <Select name="accountId" value={accountId} onValueChange={(v) => setAccountId(v ?? '')}>
            <SelectTrigger id="accountId" className="w-full">
              <SelectValue>{accountName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('anyAccount')}</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="kind">{t('filterKind')}</Label>
          <Select name="kind" value={kind} onValueChange={(v) => setKind(v ?? '')}>
            <SelectTrigger id="kind" className="w-full">
              <SelectValue>{kind === '' ? t('anyKind') : kindLabel(kind)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('anyKind')}</SelectItem>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {kindLabel(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="status">{t('filterStatus')}</Label>
          <Select name="status" value={status} onValueChange={(v) => setStatus(v ?? 'all')}>
            <SelectTrigger id="status" className="w-full">
              <SelectValue>{statusLabel(status)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* The same calendar the booking form uses. A native date input would
            have worked and would have looked like a different application. */}
        <div className="grid gap-1.5">
          <Label htmlFor="from">{t('filterFrom')}</Label>
          <DateField
            id="from"
            name="from"
            placeholder={t('anyDate')}
            defaultValue={value.from}
            clearable
            clearLabel={t('clearDate')}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="to">{t('filterTo')}</Label>
          <DateField
            id="to"
            name="to"
            placeholder={t('anyDate')}
            defaultValue={value.to}
            clearable
            clearLabel={t('clearDate')}
          />
        </div>
      </div>

      <div>
        <Button type="submit" size="sm">
          {t('apply')}
        </Button>
      </div>
    </form>
  );
}
