import { cn } from '@/lib/utils';

export interface AllocationSegment {
  readonly key: string;
  readonly label: string;
  /** Already formatted for the reader's locale. */
  readonly amount: string;
  /** 0 to 100. Computed as a Decimal and turned into a number only here. */
  readonly share: number;
}

/**
 * The five chart tokens, cycled.
 *
 * Fourteen account kinds and five colours, so a household holding more than
 * five kinds repeats one. That is a real limitation and the honest fix is a
 * generated palette, not a sixth hand-picked token: the segments are labelled
 * and carry their amount, so a repeated colour costs recognition rather than
 * information.
 */
const TOKENS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;

const colourFor = (index: number) => TOKENS[index % TOKENS.length]!;

export function Allocation({
  segments,
  emptyLabel,
  shareLabel,
}: {
  segments: readonly AllocationSegment[];
  emptyLabel: string;
  shareLabel: (percent: string) => string;
}) {
  if (segments.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyLabel}</p>;
  }

  return (
    <div className="grid gap-4">
      <div
        className="bg-muted flex h-2.5 w-full overflow-hidden rounded-full"
        // The bar repeats what the list below says, so it is decoration to a
        // screen reader rather than a second, unreadable copy of the figures.
        aria-hidden
      >
        {segments.map((segment, index) => (
          <span
            key={segment.key}
            className={cn('h-full', colourFor(index))}
            style={{ width: `${segment.share}%` }}
          />
        ))}
      </div>

      <ul className="grid gap-2.5">
        {segments.map((segment, index) => (
          <li key={segment.key} className="flex items-center gap-3 text-sm">
            <span className={cn('size-2.5 shrink-0 rounded-full', colourFor(index))} aria-hidden />
            <span className="truncate font-medium capitalize">{segment.label}</span>
            <span className="text-muted-foreground ml-auto shrink-0 text-xs">
              {shareLabel(segment.share.toFixed(1))}
            </span>
            <span className="w-28 shrink-0 text-right tabular-nums">{segment.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
