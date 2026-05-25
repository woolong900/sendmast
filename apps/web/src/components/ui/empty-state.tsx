import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Project-wide empty state for lists / tables when there's no data.
 * Uses a soft browser-with-search illustration matching the product spec.
 *
 * Three render modes:
 *   - <EmptyState />          standalone block (centered, vertical padding)
 *   - <EmptyStateRow colSpan/> use inside <tbody> for table empties
 *   - children                 optional CTA below the title (e.g. a button)
 */
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  /** Optional one-line hint under the title. */
  description?: React.ReactNode;
  /** Compact mode — smaller illustration for inline contexts (e.g. dropdowns). */
  compact?: boolean;
}

export function EmptyState({
  title = '暂无数据',
  description,
  compact,
  className,
  children,
  ...rest
}: EmptyStateProps) {
  const size = compact ? 96 : 140;
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 py-6' : 'gap-3 py-10',
        className,
      )}
      {...rest}
    >
      <EmptyIllustration width={size} height={size} />
      <div
        className={cn(
          'font-medium text-foreground/80',
          compact ? 'text-xs' : 'text-sm',
        )}
      >
        {title}
      </div>
      {description ? (
        <div className="text-xs text-muted-foreground">{description}</div>
      ) : null}
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

/**
 * Drop-in <tr><td> wrapper that places <EmptyState> inside a table body
 * spanning all columns. Saves call sites the boilerplate of building the
 * row themselves.
 */
export function EmptyStateRow({
  colSpan,
  ...props
}: EmptyStateProps & { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8">
        <EmptyState {...props} />
      </td>
    </tr>
  );
}

/**
 * Pure SVG illustration — no external assets, scales cleanly at any size.
 * Browser frame (rounded rect + 3 dots) + magnifier circle and handle.
 * Colors picked to match the muted neutral palette so the asset blends
 * with backgrounds light or dark.
 */
function EmptyIllustration({ width, height }: { width: number; height: number }) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 140"
      role="img"
      aria-hidden="true"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* soft drop shadow */}
      <ellipse cx="80" cy="124" rx="48" ry="6" fill="#e5e7eb" opacity="0.5" />
      {/* browser frame */}
      <rect
        x="28"
        y="22"
        width="104"
        height="84"
        rx="8"
        fill="#ffffff"
        stroke="#e5e7eb"
        strokeWidth="1.5"
      />
      {/* top bar */}
      <rect x="28" y="22" width="104" height="14" rx="8" fill="#f3f4f6" />
      <rect x="28" y="30" width="104" height="6" fill="#f3f4f6" />
      {/* traffic-light dots */}
      <circle cx="36" cy="29" r="1.6" fill="#d1d5db" />
      <circle cx="42" cy="29" r="1.6" fill="#d1d5db" />
      <circle cx="48" cy="29" r="1.6" fill="#d1d5db" />
      {/* magnifier */}
      <circle
        cx="76"
        cy="68"
        r="14"
        stroke="#cbd5e1"
        strokeWidth="3"
        fill="#ffffff"
      />
      <line
        x1="87"
        y1="79"
        x2="96"
        y2="88"
        stroke="#cbd5e1"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
