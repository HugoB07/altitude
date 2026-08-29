'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { enGB, fr } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface Props {
  readonly name: string;
  readonly id?: string;
  readonly describedBy?: string;
  readonly placeholder: string;
}

/**
 * A calendar date, submitted as `YYYY-MM-DD`.
 *
 * The formatting below is deliberate and is the whole reason this component is
 * not three lines. `toISOString()` converts to UTC first, so 1 March picked in
 * Paris arrives as `2026-02-28` - the transaction moves to the previous month
 * and takes the monthly report with it. This is the same bug the `LedgerDate`
 * type exists to prevent on the server, and it has to be prevented here too:
 * a value that is already wrong when it leaves the browser cannot be recovered.
 *
 * Reading the local year, month and day is the fix. `en-CA` would also work,
 * but doing the arithmetic explicitly says why.
 */
function toLedgerDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * date-fns locales, keyed by the application's.
 *
 * The calendar and the field label have to agree: "August 2026" above
 * "1 août 2026" is worse than either language alone. enGB rather than enUS so
 * the week starts on Monday, matching French and every other European locale
 * this is likely to run under.
 */
const CALENDAR_LOCALES = { en: enGB, fr } as const;

export function DateField({ name, id, describedBy, placeholder }: Props) {
  const [selected, setSelected] = useState<Date | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const locale = useLocale();
  const calendarLocale = CALENDAR_LOCALES[locale as keyof typeof CALENDAR_LOCALES] ?? enGB;
  const label = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });

  return (
    <>
      {/* The value the form action reads. The calendar is a button, not a
          field, so the value has to travel through something that is. */}
      <input
        type="hidden"
        name={name}
        value={selected === undefined ? '' : toLedgerDate(selected)}
      />

      <Popover open={open} onOpenChange={setOpen}>
        {/* Base UI composes with `render`, not Radix's `asChild`. */}
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              aria-describedby={describedBy}
              className="w-full justify-start font-normal"
            />
          }
        >
          {selected === undefined ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : (
            label.format(selected)
          )}
        </PopoverTrigger>

        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            locale={calendarLocale}
            selected={selected}
            defaultMonth={selected}
            // Month and year as a plain label, navigated with the arrows.
            //
            // The dropdown layout was tried and abandoned. react-day-picker's
            // own dropdowns are native selects, which look nothing like the
            // rest of the application; replacing them with shadcn Selects put
            // one popup inside another, and the outer closed on the click that
            // opened the inner. Making that hold needed the nested list
            // portalled into the popover element - a fix resting on two
            // libraries continuing to agree about where things render.
            //
            // A label and two arrows have none of that, and the range below
            // keeps the arrows from wandering anywhere useless.
            captionLayout="label"
            // The dropdown range, not left to the default. react-day-picker
            // offers a hundred years either side, which puts 1926 in a list of
            // transaction dates and makes the native picker a scroll rather
            // than a choice.
            //
            // Ten years back covers what an import can reasonably reach; the
            // upper bound is today, because a transaction cannot be booked in
            // the future - it has not happened. Backdating stays easy, since
            // that is most of what importing history is.
            startMonth={new Date(new Date().getFullYear() - 10, 0)}
            endMonth={new Date()}
            disabled={{ after: new Date() }}
            onSelect={(date) => {
              setSelected(date);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
