import { cn } from '@/lib/utils';

/** A single pulsing placeholder block. Compose these to mirror real content. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />;
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
