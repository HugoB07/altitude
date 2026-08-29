import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getContext, getSessionUser } from '@/server/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SetupForm } from './setup-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('setup');
  return { title: `${t('title')} - Altitude` };
}

export default async function SetupPage() {
  // Signed in is required; being in a household is what this page fixes.
  if ((await getSessionUser()) === null) redirect('/login');
  if ((await getContext()) !== null) redirect('/app');

  const t = await getTranslations('setup');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </main>
  );
}
