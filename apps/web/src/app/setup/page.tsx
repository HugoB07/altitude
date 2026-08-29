import { redirect } from 'next/navigation';
import { getContext, getSessionUser } from '@/server/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SetupForm } from './setup-form';

export const metadata = { title: 'Create your household — Altitude' };

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  // Signed in is required; being in a household is what this page fixes.
  if ((await getSessionUser()) === null) redirect('/login');
  if ((await getContext()) !== null) redirect('/app');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight">Create your household</CardTitle>
          <CardDescription>
            A household holds your accounts and everyone who shares them. You can add people later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </main>
  );
}
