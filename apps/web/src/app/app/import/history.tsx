'use client';

import { useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { rollbackImportAction } from '@/server/import-actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ImportRunView {
  readonly id: string;
  readonly source: string;
  readonly filename: string;
  readonly createdAt: string;
  readonly transactions: number;
  readonly rolledBack: boolean;
}

/**
 * What has been imported, and the way back out.
 *
 * The plan calls this "undoable in one click", and the reason it matters is not
 * convenience: an import a person cannot undo is an import they hesitate to
 * try. A wrong account chosen once would otherwise mean finding forty
 * transactions by date and reversing them by hand.
 *
 * Undone runs stay on the list. The file was read, the transactions were
 * written and then cancelled, and all three are history - a list that hid them
 * would answer "has this file been imported?" with no.
 */
export function ImportHistory({ runs }: { runs: readonly ImportRunView[] }) {
  const t = useTranslations('import');
  const format = useFormatter();
  const [asked, setAsked] = useState<ImportRunView | null>(null);
  const [pending, start] = useTransition();

  if (runs.length === 0) {
    return (
      <section className="grid gap-3">
        <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('historyTitle')}</h2>
        <p className="text-muted-foreground text-sm">{t('historyEmpty')}</p>
      </section>
    );
  }

  function undo(run: ImportRunView) {
    const form = new FormData();
    form.set('id', run.id);

    start(() => {
      void rollbackImportAction(form).then((result) => {
        if (result.error !== undefined) {
          toast.error(result.error);
          return;
        }
        setAsked(null);
        toast.success(t('rolledBack', { count: result.reversed ?? 0 }));
      });
    });
  }

  return (
    <section className="grid gap-3">
      <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('historyTitle')}</h2>

      <ul className="grid gap-2">
        {runs.map((run) => (
          <li
            key={run.id}
            className="bg-card/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{run.filename}</p>
              <p className="text-muted-foreground mt-0.5 truncate text-xs">
                {t('runLine', {
                  count: run.transactions,
                  date: format.dateTime(new Date(run.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </p>
            </div>

            {run.rolledBack ? (
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase">
                {t('undone')}
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAsked(run);
                }}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t('undo')}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {/* Asked, because it moves every balance the file touched. The dialog
          says what will happen rather than "are you sure", which is a question
          nobody can answer without being told the consequence. */}
      <Dialog
        open={asked !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('undoTitle')}</DialogTitle>
            <DialogDescription>
              {t('undoBody', { filename: asked?.filename ?? '' })}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAsked(null);
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                if (asked !== null) undo(asked);
              }}
            >
              <RotateCcw className="size-4" aria-hidden />
              {t('undoConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
