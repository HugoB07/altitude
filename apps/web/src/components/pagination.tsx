import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The page numbers to show, with gaps where there are too many.
 *
 * Always the first and last, always the current one and its neighbours, and an
 * ellipsis wherever the sequence jumps. A hundred pages rendered in full is a
 * row of numbers nobody reads; three of them plus the ends is a position you
 * can see at a glance.
 *
 * Returns numbers and nulls rather than a formatted string, so the caller
 * decides what a gap looks like and every number stays a real link.
 */
export function pageWindow(current: number, count: number): (number | null)[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);

  const around = [current - 1, current, current + 1].filter((n) => n > 1 && n < count);
  const shown = [1, ...around, count];

  const out: (number | null)[] = [];
  for (const [index, page] of shown.entries()) {
    const previous = shown[index - 1];
    if (previous !== undefined && page - previous > 1) out.push(null);
    out.push(page);
  }
  return out;
}

export function Pagination({
  page,
  pageCount,
  hrefFor,
  labels,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  labels: { previous: string; next: string; page: string };
}) {
  if (pageCount <= 1) return null;

  const base =
    'flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm transition-colors';

  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label={labels.page}>
      <Step
        href={hrefFor(page - 1)}
        disabled={page <= 1}
        label={labels.previous}
        icon={<ChevronLeft className="size-4" aria-hidden />}
      />

      {pageWindow(page, pageCount).map((entry, index) =>
        entry === null ? (
          // Not a link and not a button: there is no page here to go to.
          <span
            key={`gap-${String(index)}`}
            className="text-muted-foreground px-1 text-sm"
            aria-hidden
          >
            ...
          </span>
        ) : (
          <Link
            key={entry}
            href={hrefFor(entry)}
            aria-label={`${labels.page} ${String(entry)}`}
            aria-current={entry === page ? 'page' : undefined}
            className={cn(
              base,
              'tabular-nums',
              entry === page
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {entry}
          </Link>
        ),
      )}

      <Step
        href={hrefFor(page + 1)}
        disabled={page >= pageCount}
        label={labels.next}
        icon={<ChevronRight className="size-4" aria-hidden />}
      />
    </nav>
  );
}

/**
 * A step link, or an inert span at either end.
 *
 * A disabled anchor is still focusable and still followable, so at the ends
 * this stops being a link rather than becoming a link that says no.
 */
function Step({
  href,
  disabled,
  label,
  icon,
}: {
  href: string;
  disabled: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  const shape = 'flex h-8 w-8 items-center justify-center rounded-lg transition-colors';

  if (disabled) {
    return (
      <span aria-hidden className={cn(shape, 'text-muted-foreground/40')}>
        {icon}
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-label={label}
      className={cn(shape, 'text-muted-foreground hover:bg-muted hover:text-foreground')}
    >
      {icon}
    </Link>
  );
}
