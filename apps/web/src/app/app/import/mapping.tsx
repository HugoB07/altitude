'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { CURRENCIES, currencyLabel } from '@/lib/currencies';

/** The columns a mapping names, as the screen collects them. */
export interface DraftMapping {
  readonly bookedOn: string;
  readonly description: string;
  /** `one` for a signed column, `two` for a debit and a credit column. */
  readonly amountMode: 'one' | 'two';
  readonly amount: string;
  readonly debit: string;
  readonly credit: string;
  readonly externalId: string;
  /** A column whose value says whether the row happened. */
  readonly status: string;
  /** Values of that column whose rows are left out. */
  readonly skipStatuses: readonly string[];
  readonly currency: string;
  readonly dateOrder: 'dmy' | 'mdy' | 'ymd';
}

export interface FileShapeView {
  readonly headers: readonly string[];
  readonly sample: readonly (readonly string[])[];
  readonly dates: Readonly<Record<string, { order: string; ambiguous: boolean }>>;
  readonly categories: Readonly<Record<string, readonly string[]>>;
}

/**
 * Naming the columns of a statement nobody wrote a preset for.
 *
 * The screen already knows most of it - where the header is, what separates
 * the fields, how the dates are written - because the file says so. What it
 * cannot know is which column means what, and that is all this asks.
 *
 * The sample is above the questions on purpose. A person recognises their own
 * statement by looking at it, and answering "which column is the date" without
 * seeing the file is answering from memory.
 */
export function MappingForm({
  shape,
  draft,
  onChange,
  onDone,
  baseCurrency,
}: {
  shape: FileShapeView;
  draft: DraftMapping;
  onChange: (next: DraftMapping) => void;
  onDone: () => void;
  baseCurrency: string;
}) {
  const t = useTranslations('import');

  const set = <K extends keyof DraftMapping>(key: K, value: DraftMapping[K]) => {
    onChange({ ...draft, [key]: value });
  };

  // Asked only when nothing in the column settled it. A file where some day is
  // above the twelfth has already answered, and asking anyway would be asking
  // a person to confirm arithmetic.
  const chosen = shape.dates[draft.bookedOn];
  const mustAskOrder = draft.bookedOn !== '' && (chosen === undefined || chosen.ambiguous);

  // The question asked about a value from the file rather than about 03/04.
  // "Nothing in this column says whether 03/04 is..." is true and unreadable:
  // a person is looking at their own statement, not at an example.
  const dateIndex = shape.headers.indexOf(draft.bookedOn);
  const dateExample =
    shape.sample.map((row) => (row[dateIndex] ?? '').trim()).find((cell) => cell !== '') ?? '';

  const ready =
    draft.bookedOn !== '' &&
    (draft.amountMode === 'one' ? draft.amount !== '' : draft.debit !== '' && draft.credit !== '');

  return (
    <section className="grid gap-5">
      <div>
        <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('mappingTitle')}</h2>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('mappingHint')}</p>
      </div>

      {/* The file itself, first. Everything below is a question about it. */}
      <div className="overflow-x-auto rounded-2xl border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              {shape.headers.map((name, index) => (
                <th
                  key={`${name}-${String(index)}`}
                  className="px-3 py-2 text-left font-medium whitespace-nowrap"
                >
                  {name === '' ? '-' : name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shape.sample.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t">
                {shape.headers.map((_, index) => (
                  <td
                    key={index}
                    className="text-muted-foreground max-w-[16rem] truncate px-3 py-1.5 whitespace-nowrap"
                  >
                    {row[index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Column
          id="map-date"
          sample={shape.sample}
          label={t('columnDate')}
          headers={shape.headers}
          value={draft.bookedOn}
          onChange={(value) => {
            set('bookedOn', value);
          }}
        />
        <Column
          id="map-description"
          sample={shape.sample}
          label={t('columnDescription')}
          headers={shape.headers}
          value={draft.description}
          optional
          onChange={(value) => {
            set('description', value);
          }}
        />
      </div>

      {/* Two shapes of statement, and the file cannot be read as both. Asked as
          a choice rather than inferred: a column called "Debit" holding signed
          amounts is a real file, and guessing would negate all of it twice. */}
      <div className="grid gap-3">
        <Label htmlFor="map-mode">{t('amountShape')}</Label>
        <Select
          name="map-mode"
          value={draft.amountMode}
          onValueChange={(value) => {
            set('amountMode', value === 'two' ? 'two' : 'one');
          }}
        >
          <SelectTrigger id="map-mode" className="w-full sm:max-w-sm">
            <SelectValue>
              {draft.amountMode === 'two' ? t('amountTwoColumns') : t('amountOneColumn')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="one">{t('amountOneColumn')}</SelectItem>
            <SelectItem value="two">{t('amountTwoColumns')}</SelectItem>
          </SelectContent>
        </Select>

        {draft.amountMode === 'one' ? (
          <div className="sm:max-w-sm">
            <Column
              id="map-amount"
              sample={shape.sample}
              label={t('columnAmount')}
              headers={shape.headers}
              value={draft.amount}
              onChange={(value) => {
                set('amount', value);
              }}
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Column
              id="map-debit"
              sample={shape.sample}
              label={t('columnDebit')}
              headers={shape.headers}
              value={draft.debit}
              onChange={(value) => {
                set('debit', value);
              }}
            />
            <Column
              id="map-credit"
              sample={shape.sample}
              label={t('columnCredit')}
              headers={shape.headers}
              value={draft.credit}
              onChange={(value) => {
                set('credit', value);
              }}
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Column
          id="map-reference"
          sample={shape.sample}
          label={t('columnReference')}
          headers={shape.headers}
          value={draft.externalId}
          optional
          hint={t('columnReferenceHint')}
          onChange={(value) => {
            set('externalId', value);
          }}
        />

        <div className="grid gap-1.5">
          <Label htmlFor="map-currency">{t('currency')}</Label>
          <Select
            name="map-currency"
            value={draft.currency === '' ? baseCurrency : draft.currency}
            onValueChange={(value) => {
              set('currency', value ?? baseCurrency);
            }}
          >
            <SelectTrigger id="map-currency" className="w-full">
              <SelectValue>
                {currencyLabel(draft.currency === '' ? baseCurrency : draft.currency)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((currency) => (
                <SelectItem key={currency.code} value={currency.code}>
                  {currency.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t('currencyFileHint')}</p>
        </div>
      </div>

      {/* A statement lists more than movements. A card payment that was
          reverted is a row with an amount, and importing it takes money out of
          an account it never left. Which states mean that is a fact about the
          bank, so it is asked rather than guessed - and the values offered are
          the ones the file actually contains. */}
      {Object.keys(shape.categories).length > 0 && (
        <div className="grid gap-3">
          <Column
            id="map-status"
            sample={shape.sample}
            label={t('columnStatus')}
            headers={Object.keys(shape.categories)}
            value={draft.status}
            optional
            hint={t('columnStatusHint')}
            onChange={(value) => {
              onChange({ ...draft, status: value, skipStatuses: [] });
            }}
          />

          {draft.status !== '' && (
            <fieldset className="grid gap-2 rounded-2xl border p-4">
              <legend className="px-1 text-xs font-medium">{t('skipStatusesTitle')}</legend>
              <p className="text-muted-foreground -mt-1 max-w-prose text-xs">
                {t('skipStatusesHint')}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
                {(shape.categories[draft.status] ?? []).map((value) => (
                  <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.skipStatuses.includes(value)}
                      onCheckedChange={(on) => {
                        set(
                          'skipStatuses',
                          on === true
                            ? [...draft.skipStatuses, value]
                            : draft.skipStatuses.filter((kept) => kept !== value),
                        );
                      }}
                    />
                    {value}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}

      {/* The one question a file genuinely cannot answer. 03/04 is the third of
          April and the fourth of March, and no value in a column where every
          first group is twelve or under settles it. */}
      {mustAskOrder && (
        <Alert>
          <AlertDescription className="grid gap-3">
            <p>{t('dateOrderAsk', { value: dateExample })}</p>
            <Select
              name="map-order"
              value={draft.dateOrder}
              onValueChange={(value) => {
                set('dateOrder', value === 'mdy' ? 'mdy' : value === 'ymd' ? 'ymd' : 'dmy');
              }}
            >
              <SelectTrigger id="map-order" className="w-full sm:max-w-xs">
                <SelectValue>{t(`dateOrder.${draft.dateOrder}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dmy">{t('dateOrder.dmy')}</SelectItem>
                <SelectItem value="mdy">{t('dateOrder.mdy')}</SelectItem>
                <SelectItem value="ymd">{t('dateOrder.ymd')}</SelectItem>
              </SelectContent>
            </Select>
          </AlertDescription>
        </Alert>
      )}

      <div>
        <Button type="button" onClick={onDone} disabled={!ready}>
          {t('mappingDone')}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

/** One question: which of the file's columns is this. */
function Column({
  id,
  label,
  headers,
  value,
  onChange,
  optional,
  hint,
  sample,
}: {
  id: string;
  label: string;
  headers: readonly string[];
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  hint?: string;
  /** The rows shown above, so the choice can echo a real value back. */
  sample?: readonly (readonly string[])[];
}) {
  const t = useTranslations('import');

  // The first value that column actually holds. A column name proves nothing -
  // two are called "Date de debut" and "Date de fin" - and reading the answer
  // back from the file is how somebody sees they picked the right one.
  const index = headers.indexOf(value);
  const example =
    value === '' || sample === undefined
      ? ''
      : (sample.map((row) => (row[index] ?? '').trim()).find((cell) => cell !== '') ?? '');

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="flex flex-wrap items-baseline gap-2">
        {label}
        {optional === true && (
          <span className="text-muted-foreground text-[11px] font-normal">{t('optional')}</span>
        )}
      </Label>
      <Select
        name={id}
        value={value}
        onValueChange={(next) => {
          onChange(next ?? '');
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{value === '' ? t('columnNone') : value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {optional === true && <SelectItem value="">{t('columnNone')}</SelectItem>}
          {headers
            .filter((name) => name !== '')
            .map((name, index) => (
              <SelectItem key={`${name}-${String(index)}`} value={name}>
                {name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {example !== '' && (
        <p className="text-muted-foreground truncate text-xs">
          {t('columnExample', { value: example })}
        </p>
      )}
      {hint !== undefined && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
