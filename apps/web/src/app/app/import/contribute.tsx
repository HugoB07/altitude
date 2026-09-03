'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { presetFileDraft } from '@/lib/preset-draft';

/**
 * Offering back the description of a file that just read correctly.
 *
 * The end of the loop the plan draws at §8.4 and the README has been promising:
 * a preset is a JSON file, so the person who described their bank on the
 * mapping screen has already done the work, and this hands them the file.
 *
 * Placed here rather than after the import, and that is the point of it: what
 * makes a description worth contributing is a screen full of rows that read
 * correctly, which is exactly what is on this screen. Offered after the
 * writing, it would be a question asked once the answer had stopped mattering.
 *
 * It carries the names of the columns and nothing from inside the file. A
 * sample is the other half of a contribution and is a separate, deliberate act
 * - CONTRIBUTING's anonymisation checklist is about that one, and this says so
 * rather than quietly attaching anything.
 */
export function Contribute({ mapping }: { mapping: unknown }) {
  const t = useTranslations('import');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');

  const file = presetFileDraft({ name, country, mapping });

  const copy = () => {
    if (file === null) return;

    void navigator.clipboard.writeText(file.json).then(
      () => {
        toast.success(t('contributeCopied'));
      },
      () => {
        // Refused rather than failed: a page served over plain HTTP has no
        // clipboard, and a self-hosted instance on a home network often is one.
        // The text is on screen, so saying so beats saying nothing.
        toast.error(t('contributeCopyFailed'));
      },
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-xs font-medium underline underline-offset-4 transition-colors"
      >
        <Share2 className="size-3.5" aria-hidden />
        {t('contribute')}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('contributeTitle')}</DialogTitle>
            <DialogDescription>{t('contributeHint')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <div className="grid gap-2">
              <Label htmlFor="contribute-name">{t('contributeName')}</Label>
              <Input
                id="contribute-name"
                value={name}
                autoComplete="off"
                placeholder={t('contributeNamePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="contribute-country">{t('contributeCountry')}</Label>
              <Input
                id="contribute-country"
                value={country}
                autoComplete="off"
                maxLength={2}
                placeholder="FR"
                className="uppercase"
                onChange={(event) => {
                  setCountry(event.target.value);
                }}
              />
            </div>
          </div>

          {file === null ? (
            <p className="text-muted-foreground text-sm">{t('contributeIncomplete')}</p>
          ) : (
            <div className="grid gap-2">
              <p className="text-muted-foreground font-mono text-xs break-all">{file.path}</p>
              {/* Its own scrolling box. A mapping with eight columns is thirty
                  lines, and a dialog that grows to fit them puts its buttons
                  below the fold. */}
              <pre className="bg-muted/50 max-h-64 overflow-auto rounded-xl border p-3 text-xs">
                <code>{file.json}</code>
              </pre>
              <p className="text-muted-foreground text-xs">{t('contributeNext')}</p>
            </div>
          )}

          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="secondary" onClick={copy} disabled={file === null}>
              <Copy className="size-4" aria-hidden />
              {t('contributeCopy')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('contributeDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
