'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signIn, signUp } from '@/lib/auth-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Mode = 'signin' | 'signup';

export function LoginForm() {
  const [mode, setMode] = useState<Mode>('signin');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  async function submit(formData: FormData) {
    setError(null);
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    const name = String(formData.get('name') ?? '').trim();

    const result =
      mode === 'signup'
        ? await signUp.email({ email, password, name: name === '' ? email : name })
        : await signIn.email({ email, password });

    if (result.error) {
      // Better Auth's own message rather than a rewritten one: "password too
      // short" and "no such account" are different problems, and the person in
      // front of the form needs to know which one they have.
      setError(result.error.message ?? 'Could not sign in.');
      return;
    }
    // The household is resolved server-side; /app sends new users on to /setup.
    start(() => router.replace('/app'));
    router.refresh();
  }

  return (
    <form action={(fd) => void submit(fd)} className="grid gap-4">
      {mode === 'signup' && (
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" />
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          // Matches the server rule in auth.ts. Stated here so the browser can
          // say so before a round trip, never instead of the server checking.
          minLength={12}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          aria-describedby={mode === 'signup' ? 'password-hint' : undefined}
        />
        {mode === 'signup' && (
          <p id="password-hint" className="text-muted-foreground text-xs">
            At least 12 characters.
          </p>
        )}
      </div>

      {error !== null && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={pending} className="w-full">
        {mode === 'signup' ? 'Create account' : 'Sign in'}
      </Button>

      <Button
        type="button"
        variant="link"
        className="text-muted-foreground h-auto p-0"
        onClick={() => {
          setMode(mode === 'signup' ? 'signin' : 'signup');
          setError(null);
        }}
      >
        {mode === 'signup' ? 'I already have an account' : 'Create an account'}
      </Button>
    </form>
  );
}
