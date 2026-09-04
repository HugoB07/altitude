'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { applyRulesAction, previewRulesAction } from '@/server/category-actions';

/**
 * Running the rules over what is already in the ledger.
 *
 * Below both lists rather than between them, because it acts on both: a pass
 * runs the household's own rules and then the community set under them, and a
 * panel sitting above the set read as if the set had nothing to do with it.
 *
 * `count` is every rule that would run, the shipped ones included. Counting
 * only the household's was a real bug: turning a set on gave sixty-two rules
 * and a disabled button, with nothing on screen to explain why.
 */
export function ApplyRules({ count }: { count: number }) {
  const t = useTranslations('categories');
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<{ changed: number; lines: string[] } | null>(null);

  return (
    <section className="grid grid-cols-1 gap-3 rounded-2xl border p-5">
      <div>
        <h2 className="text-[13px] font-semibold tracking-wide uppercase">{t('applyTitle')}</h2>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm">{t('applyHint')}</p>
      </div>

      {/* The count comes before the act, which the plan asks for by name
          (§8.6): re-applying rules is a manual action with a preview of how
          many rows would change. */}
      {preview === null ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={pending || count === 0}
            onClick={() => {
              start(() => {
                void previewRulesAction().then((outcome) => {
                  if (outcome.error !== undefined || outcome.result === undefined) {
                    toast.error(outcome.error ?? '');
                    return;
                  }
                  setPreview({
                    changed: outcome.result.changed,
                    lines: outcome.result.byCategory.map((one) =>
                      t('wouldBecome', { count: one.count, name: one.name }),
                    ),
                  });
                });
              });
            }}
          >
            <Wand2 className="size-4" aria-hidden />
            {t('previewRules')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm">{t('wouldChange', { count: preview.changed })}</p>
          {preview.lines.length > 0 && (
            <ul className="text-muted-foreground grid gap-0.5 text-xs">
              {preview.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending || preview.changed === 0}
              onClick={() => {
                start(() => {
                  void applyRulesAction().then((outcome) => {
                    if (outcome.error !== undefined || outcome.result === undefined) {
                      toast.error(outcome.error ?? '');
                      return;
                    }
                    toast.success(t('applied', { count: outcome.result.changed }));
                    setPreview(null);
                  });
                });
              }}
            >
              {t('applyRules')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setPreview(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
