import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Mountain } from 'lucide-react';
import { getContext, getSessionUser } from '@/server/context';
import { AppBarNav, AppSidebarNav } from '@/components/app-nav';
import { SignOut } from './sign-out';

// Per-user by definition: this reads a session, so it can never be static.
export const dynamic = 'force-dynamic';

/**
 * Up to two initials from a display name.
 *
 * `Array.from` rather than indexing, so a name starting outside the basic plane
 * yields its character rather than half of one.
 */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

/**
 * The frame every signed-in screen sits in.
 *
 * The guards are repeated in the page rather than trusted from here. `redirect`
 * in a layout does stop the render, but a page that assumed a context it never
 * checked would break the moment it is reached another way - and `getContext`
 * is cached per request, so asking twice costs one query.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  if ((await getSessionUser()) === null) redirect('/login');

  const ctx = await getContext();
  if (ctx === null) redirect('/setup');

  const t = await getTranslations();

  return (
    <div className="bg-muted/40 min-h-screen">
      {/* Fixed rather than sticky: the column keeps its own scroll, so a long
          account list never pushes the navigation out of reach. */}
      <aside className="bg-sidebar fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b px-5">
          <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
            <Mountain className="size-4" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">{t('app.name')}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-5">
          <AppSidebarNav />
        </div>

        <div className="flex items-center gap-2.5 border-t p-3">
          <span
            className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            aria-hidden
          >
            {initials(ctx.displayName)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm leading-tight font-medium">{ctx.displayName}</p>
            <p className="text-muted-foreground truncate text-xs leading-tight">{ctx.email}</p>
          </div>
          <SignOut />
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b px-5 backdrop-blur sm:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg lg:hidden">
              <Mountain className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">{ctx.householdName}</p>
              <p className="text-muted-foreground truncate text-xs">
                {t('dashboard.greeting', { name: ctx.displayName })}
              </p>
            </div>
          </div>
          <SignOut className="lg:hidden" />
        </header>

        {/* Bottom padding on small screens so the bar never covers the last row. */}
        <main className="mx-auto max-w-6xl px-5 pt-6 pb-24 sm:px-8 lg:pb-10">{children}</main>
      </div>

      <AppBarNav />
    </div>
  );
}
