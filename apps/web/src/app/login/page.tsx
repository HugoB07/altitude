import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getContext } from '@/server/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from './login-form';

// Per-user by definition: these pages read a session, so they can never be
// static. Declared rather than inferred from the first dynamic API call -
// without it the build tries to prerender, reaches the auth setup before the
// dynamic signal, and fails on a missing DATABASE_URL that production would
// have had anyway.
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: `${t('signIn')} - Altitude` };
}

export default async function LoginPage() {
  // Already signed in and already in a household: nothing to do here.
  if ((await getContext()) !== null) redirect('/app');

  const t = await getTranslations('app');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">
            <h1>{t('name')}</h1>
          </CardTitle>
          <CardDescription>{t('tagline')}</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
