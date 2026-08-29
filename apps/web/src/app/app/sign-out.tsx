'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignOut() {
  const router = useRouter();
  const t = useTranslations('auth');
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        void signOut().then(() => {
          router.replace('/login');
          router.refresh();
        });
      }}
    >
      {t('signOut')}
    </Button>
  );
}
