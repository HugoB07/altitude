'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Building2,
  ChartPie,
  CreditCard,
  LayoutDashboard,
  Settings,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The sections of the application, including the ones not built yet.
 *
 * Showing them is a deliberate choice over hiding them. A single link is not a
 * navigation, and someone opening Altitude for the first time should be able to
 * see what it is going to be. Marking the unbuilt ones rather than linking to an
 * empty page is the honest half of that: they are visibly inert, and nothing
 * here pretends to work.
 */
interface NavItem {
  readonly key: 'dashboard' | 'accounts' | 'transactions' | 'holdings' | 'realEstate' | 'settings';
  readonly href?: string;
  readonly icon: LucideIcon;
  /** Shown in the bottom bar on small screens, where there is room for four. */
  readonly compact?: boolean;
}

const MAIN: readonly NavItem[] = [
  { key: 'dashboard', href: '/app', icon: LayoutDashboard, compact: true },
  { key: 'accounts', href: '/app/accounts', icon: Wallet, compact: true },
  { key: 'transactions', icon: CreditCard, compact: true },
  { key: 'holdings', icon: ChartPie },
  { key: 'realEstate', icon: Building2 },
];

const MANAGE: readonly NavItem[] = [{ key: 'settings', icon: Settings, compact: true }];

function useItemState(item: NavItem) {
  const pathname = usePathname();
  return {
    active: item.href !== undefined && pathname === item.href,
    available: item.href !== undefined,
  };
}

function SidebarItem({ item }: { item: NavItem }) {
  const t = useTranslations('nav');
  const { active, available } = useItemState(item);
  const Icon = item.icon;

  const content = (
    <>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{t(item.key)}</span>
      {!available && (
        <span className="bg-muted text-muted-foreground ml-auto rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium tracking-wide uppercase">
          {t('soon')}
        </span>
      )}
    </>
  );

  const shape =
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors';

  if (!available) {
    return (
      <span aria-disabled className={cn(shape, 'text-muted-foreground/60 cursor-default')}>
        {content}
      </span>
    );
  }

  return (
    <Link
      href={item.href!}
      aria-current={active ? 'page' : undefined}
      className={cn(
        shape,
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
      )}
    >
      {content}
    </Link>
  );
}

function Section({ label, items }: { label: string; items: readonly NavItem[] }) {
  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground px-3 pb-1 text-[11px] font-semibold tracking-wider uppercase">
        {label}
      </p>
      {items.map((item) => (
        <SidebarItem key={item.key} item={item} />
      ))}
    </div>
  );
}

/** The left column on large screens. Hidden below `lg`, where the bar takes over. */
export function AppSidebarNav() {
  const t = useTranslations('nav');
  return (
    <nav className="grid gap-6">
      <Section label={t('sectionMain')} items={MAIN} />
      <Section label={t('sectionManage')} items={MANAGE} />
    </nav>
  );
}

/**
 * The bottom bar on small screens.
 *
 * A bar rather than a hamburger: it needs no state, so it cannot open on the
 * server and closed on the client, and the destinations stay visible instead of
 * hiding behind a control someone has to discover.
 */
export function AppBarNav() {
  const items = [...MAIN, ...MANAGE].filter((item) => item.compact === true);

  return (
    <nav className="bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur lg:hidden">
      <ul className="mx-auto grid max-w-lg grid-cols-4">
        {items.map((item) => (
          <li key={item.key}>
            <BarItem item={item} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function BarItem({ item }: { item: NavItem }) {
  const t = useTranslations('nav');
  const { active, available } = useItemState(item);
  const Icon = item.icon;

  const shape = 'flex flex-col items-center gap-1 px-2 py-2.5 text-[11px] font-medium';
  const label = (
    <>
      <Icon className="size-5" aria-hidden />
      <span className="truncate">{t(item.key)}</span>
    </>
  );

  if (!available) {
    return (
      <span aria-disabled className={cn(shape, 'text-muted-foreground/50')}>
        {label}
      </span>
    );
  }

  return (
    <Link
      href={item.href!}
      aria-current={active ? 'page' : undefined}
      className={cn(shape, active ? 'text-foreground' : 'text-muted-foreground')}
    >
      {label}
    </Link>
  );
}
