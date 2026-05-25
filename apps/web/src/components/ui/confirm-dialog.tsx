import * as React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` colours the confirm button red — use for destructive actions. */
  variant?: 'default' | 'danger';
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = React.createContext<ConfirmContextValue | null>(null);

interface QueueItem {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/**
 * Provider that mounts a single global confirm dialog. Exposes a Promise-based
 * `useConfirm()` hook so callers can write `if (await confirm({...})) doX()`
 * instead of dealing with their own open/close state per call site.
 *
 * Concurrent calls are not stacked — the latest call replaces the previous
 * one and resolves the previous as `false`. We don't expect concurrent
 * confirms in practice; if we do, swap `item` for a queue.
 */
export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = React.useState<QueueItem | null>(null);
  const itemRef = React.useRef<QueueItem | null>(null);
  itemRef.current = item;

  const confirm = React.useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const prev = itemRef.current;
      if (prev) prev.resolve(false);
      setItem({ opts, resolve });
    });
  }, []);

  const close = React.useCallback((ok: boolean) => {
    const current = itemRef.current;
    if (!current) return;
    current.resolve(ok);
    setItem(null);
  }, []);

  React.useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, close]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {item && <ConfirmDialog opts={item.opts} onClose={close} />}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmDialogProvider>');
  }
  return ctx.confirm;
}

function ConfirmDialog({
  opts,
  onClose,
}: {
  opts: ConfirmOptions;
  onClose: (ok: boolean) => void;
}) {
  const isDanger = opts.variant === 'danger';
  const iconWrapClass = isDanger
    ? 'flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive'
    : 'flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => onClose(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-md overflow-hidden rounded-lg bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5">
          <div className={iconWrapClass}>
            <AlertTriangle className="size-4" />
          </div>
          <div className="flex-1 pt-1">
            <h2 id="confirm-dialog-title" className="text-base font-semibold">
              {opts.title}
            </h2>
            {opts.description && (
              <div className="mt-2 text-sm text-muted-foreground">{opts.description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onClose(false)}
            className="-m-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex justify-end gap-2 border-t bg-muted/20 px-5 py-3">
          <Button variant="outline" onClick={() => onClose(false)}>
            {opts.cancelLabel ?? '取消'}
          </Button>
          <Button
            variant={isDanger ? 'destructive' : 'default'}
            onClick={() => onClose(true)}
            autoFocus
          >
            {opts.confirmLabel ?? '确定'}
          </Button>
        </div>
      </div>
    </div>
  );
}
