'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { reverseTransactionAction, type ActionResult } from '@/server/actions';
import { Button } from '@/components/ui/button';

/**
 * Reversal, as an ordinary button rather than a confirmation dance.
 *
 * Nothing is destroyed by pressing it: the original stays, the opposite is
 * added, and reversing the reversal undoes the undo. A modal asking "are you
 * sure?" would suggest otherwise, and would teach people to dismiss modals.
 */
export function ReverseButton({ id, label }: { id: string; label: string }) {
  const notify = useTranslations('toast');

  const [, action, pending] = useActionState(async (_prev: ActionResult, data: FormData) => {
    const result = await reverseTransactionAction(data);
    if (result.error === undefined) {
      toast.success(notify('transactionReversed'));
    } else {
      toast.error(result.error);
    }
    return result;
  }, {});

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        disabled={pending}
        className="text-muted-foreground hover:text-foreground"
      >
        <Undo2 className="size-3.5" aria-hidden />
        {label}
      </Button>
    </form>
  );
}
