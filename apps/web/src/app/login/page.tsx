import { redirect } from 'next/navigation';
import { getContext } from '@/server/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — Altitude' };

// Per-user by definition: these pages read a session, so they can never be
// static. Declared rather than inferred from the first dynamic API call —
// without it the build tries to prerender, reaches the auth setup before the
// dynamic signal, and fails on a missing DATABASE_URL that production would
// have had anyway.
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Already signed in and already in a household: nothing to do here.
  if ((await getContext()) !== null) redirect('/app');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">Altitude</CardTitle>
          <CardDescription>Self-hosted wealth tracking.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
