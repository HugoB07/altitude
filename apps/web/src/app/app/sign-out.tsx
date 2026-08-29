'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Sign out, as an icon.
 *
 * It was a ghost button with a text label, which on the sidebar's own
 * background has no fill and no border and reads as a stray line of text rather
 * than a control. An icon in a fixed square is unmistakably a button, and the
 * label survives as the accessible name and the tooltip rather than being lost.
 */
export function SignOut({ className }: { className?: string }) {
  const router = useRouter();
  const t = useTranslations('auth');
  const label = t('signOut');

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={cn('text-muted-foreground hover:text-foreground shrink-0', className)}
      onClick={() => {
        void signOut().then(() => {
          router.replace('/login');
          router.refresh();
        });
      }}
    >
      <LogOut className="size-4" aria-hidden />
    </Button>
  );
}
