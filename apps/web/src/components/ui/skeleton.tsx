import { cn } from '@/lib/utils';

/** A single pulsing placeholder block. Compose these to mirror real content. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />;
}

/**
 * Loading rows for data tables. Keep the real table header visible and place
 * these inside tbody so loading does not replace or resize the page frame.
 */
export function TableSkeletonRows({
  columns,
  rows = 4,
  cellClassName = 'px-4 py-4',
}: {
  columns: number;
  rows?: number;
  cellClassName?: string;
}) {
  const widths = ['w-28', 'w-20', 'w-24', 'w-16', 'w-32', 'w-20', 'w-14', 'w-24', 'w-12'];

  return Array.from({ length: rows }, (_, row) => (
    <tr key={row} className="border-b last:border-0">
      {Array.from({ length: columns }, (_, column) => (
        <td key={column} className={cellClassName}>
          <Skeleton className={cn('h-4 max-w-full', widths[column % widths.length])} />
        </td>
      ))}
    </tr>
  ));
}

/**
 * Full-page loading placeholder. Renders a title row (optionally with a back
 * button) plus a content block so the page frame shows immediately and the
 * layout doesn't jump when data lands — replaces bare "加载中..." text returns.
 */
export function PageSkeleton({
  withBack = false,
  children,
}: {
  withBack?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {withBack && <Skeleton className="size-9 shrink-0" />}
        <Skeleton className="h-7 w-48" />
      </div>
      {children ?? <Skeleton className="h-64 w-full" />}
    </div>
  );
}
