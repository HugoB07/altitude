'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface AllocationSegment {
  readonly key: string;
  readonly label: string;
  /** Already formatted for the reader's locale. */
  readonly amount: string;
  /** 0 to 100. Computed as a Decimal and turned into a number only here. */
  readonly share: number;
  /**
   * The share, already worded for the reader.
   *
   * Carried on the datum rather than produced by a formatter prop: this is a
   * client component, and a function cannot cross the server boundary. Passing
   * one compiles, typechecks, builds, and throws on the first render.
   */
  readonly shareText: string;
}

/**
 * Categorical series, in fixed order, never cycled.
 *
 * The order is the palette's order, so a kind keeps its colour as other kinds
 * appear and disappear: colour follows the entity, not its rank in this
 * household. A sixth kind repeats the first, which is the point at which this
 * should fold the tail into an "other" slice rather than reuse a hue.
 */
const TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const;
const colourFor = (index: number) => `var(--${TOKENS[index % TOKENS.length]!})`;

/** Geometry of the ring, in the SVG's own units. */
const SIZE = 200;
const STROKE = 26;
/**
 * How thick a hovered arc gets, and the width the radius must be sized for.
 *
 * The radius was computed from STROKE alone, so the ring's outer edge landed
 * exactly on the viewBox: growing an arc on hover pushed it past the edge and
 * the browser clipped it flat. The circle has to be small enough for its
 * thickest state, not its usual one.
 */
const STROKE_ACTIVE = 32;
const RADIUS = (SIZE - STROKE_ACTIVE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** A sliver of surface between slices, so two neighbours never touch. */
const GAP = 3;

export function Allocation({
  segments,
  total,
  totalLabel,
  emptyLabel,
}: {
  segments: readonly AllocationSegment[];
  /** The sum of the slices, formatted. Sits in the middle of the ring. */
  total: string;
  totalLabel: string;
  emptyLabel: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  if (segments.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyLabel}</p>;
  }

  // Cumulative start of each arc, built up front rather than by mutating a
  // counter inside the map: reassigning during render is what the React
  // compiler forbids, and it caught this one.
  const arcs = segments.reduce<{ segment: AllocationSegment; length: number; start: number }[]>(
    (acc, segment) => {
      const length = (segment.share / 100) * CIRCUMFERENCE;
      const previous = acc[acc.length - 1];
      return [
        ...acc,
        { segment, length, start: previous === undefined ? 0 : previous.start + previous.length },
      ];
    },
    [],
  );

  const shown = active === null ? null : segments[active];

  return (
    <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-center">
      <div className="relative shrink-0" onMouseLeave={() => setActive(null)}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-52 -rotate-90">
          {arcs.map(({ segment, length, start }, index) => {
            const dash = Math.max(length - GAP, 0.5);
            const dimmed = active !== null && active !== index;
            return (
              <circle
                key={segment.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={colourFor(index)}
                strokeWidth={active === index ? STROKE_ACTIVE : STROKE}
                strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                strokeDashoffset={-start}
                className="cursor-pointer transition-[stroke-width,opacity] duration-150"
                opacity={dimmed ? 0.35 : 1}
                onMouseEnter={() => setActive(index)}
              />
            );
          })}
        </svg>

        {/* The centre answers whatever the pointer is on, and falls back to the
            total. A hovered slice that showed its value in a floating box would
            put the answer somewhere the eye is not already looking. */}
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          <p className="text-muted-foreground max-w-32 truncate text-xs font-medium capitalize">
            {shown?.label ?? totalLabel}
          </p>
          <p className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">
            {shown?.amount ?? total}
          </p>
          {shown !== undefined && shown !== null && (
            <p className="text-muted-foreground mt-0.5 text-xs tabular-nums">{shown.shareText}</p>
          )}
        </div>
      </div>

      <ul className="grid w-full min-w-0 gap-0.5">
        {segments.map((segment, index) => (
          <li key={segment.key}>
            <button
              type="button"
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                active === index ? 'bg-muted' : 'hover:bg-muted/60',
              )}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colourFor(index) }}
                aria-hidden
              />
              <span className="truncate font-medium capitalize">{segment.label}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                {segment.shareText}
              </span>
              <span className="w-28 shrink-0 text-right tabular-nums">{segment.amount}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
