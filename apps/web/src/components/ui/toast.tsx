import * as React from 'react';
import { Check, Info, X } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: React.ReactNode;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: React.ReactNode, variant?: ToastVariant) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4000;

let nextId = 0;

/**
 * Provider mounting a single toast viewport centered at the top.
 * Card style: pale surface + colored border + left circular icon + dark text.
 * Success / error / info share the same shell; only surface + icon color differ.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  const dismiss = React.useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (message: React.ReactNode, variant: ToastVariant = 'info') => {
      const id = ++nextId;
      setToasts((cur) => [...cur, { id, message, variant }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <Viewport toasts={toasts} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx.toast;
}

function Viewport({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;
  return (
    // Width-auto column so each pill sizes to its content. Centered horizontally;
    // pointer-events-none on the wrapper so it never blocks underlying UI.
    <div className="pointer-events-none fixed left-1/2 top-6 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
}

// Per-variant surface + icon badge (body text always neutral-900).
// Success/error use explicit hex pairs analogous to each other (light fill +
// slightly darker border), same idea as the green reference card.
const VARIANT_STYLES: Record<
  ToastVariant,
  { wrap: string; badge: string; icon: React.ElementType }
> = {
  success: {
    wrap: 'border-[#b7ebcf] bg-[#e6f7ef]',
    badge: 'bg-[#35c08e]',
    icon: Check,
  },
  error: {
    wrap: 'border-[#f0b8b8] bg-[#fef5f5]',
    badge: 'bg-[#ef4444]',
    icon: X,
  },
  info: {
    wrap: 'border-[#bae6fd] bg-[#f0f9ff]',
    badge: 'bg-[#0ea5e9]',
    icon: Info,
  },
};

function ToastCard({ item }: { item: ToastItem }) {
  const v = VARIANT_STYLES[item.variant];
  const Icon = v.icon;
  const isError = item.variant === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={
        'pointer-events-auto inline-flex max-w-[min(420px,calc(100vw-2rem))] items-center gap-3 rounded-lg border px-3 py-2.5 text-sm text-neutral-900 shadow-sm ' +
        v.wrap
      }
    >
      <span
        className={
          'flex size-6 shrink-0 items-center justify-center rounded-full text-white ' + v.badge
        }
      >
        <Icon className="size-3.5" strokeWidth={2.5} />
      </span>
      <span className="min-w-0 flex-1 break-words leading-snug">{item.message}</span>
    </div>
  );
}
