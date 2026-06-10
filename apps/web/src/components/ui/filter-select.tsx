import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Single-select dropdown with the same look as the campaigns list page's
 * StatusFilter (popover, not a native <select>):
 *
 *   ┌────────────────┐
 *   │ 全部状态     ▾ │  ← closed
 *   └────────────────┘
 *   ┌──────────────────┐
 *   │ 全部状态     ▴   │  ← open (primary border)
 *   ├──────────────────┤
 *   │ 选项 A           │
 *   │ 选项 B           │
 *   └──────────────────┘
 *
 * Keeps the StatusFilter in CampaignListPage intact; this is the version
 * used by every other dropdown in the segment editor so the whole app
 * speaks the same visual language.
 */
export function FilterSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  dropdownClassName,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  placeholder?: string;
  className?: string;
  /** Override popover width — defaults to matching the trigger. */
  dropdownClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside to close. Plain DOM listener instead of onBlur because we
  // want clicks on the option list (children of the popover) to commit
  // selection rather than dismiss the popover before the click fires.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? '请选择';

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border px-3 text-sm transition-colors',
          open
            ? 'border-primary bg-background text-primary'
            : 'border-input bg-background hover:bg-muted/40',
        )}
      >
        <span className="truncate">{label}</span>
        {open ? (
          <ChevronUp className="ml-2 size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div
          className={cn(
            'absolute left-0 top-full z-20 mt-1 max-h-64 min-w-full overflow-auto rounded-md border bg-popover py-1 shadow-lg',
            dropdownClassName,
          )}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                'block w-full px-3 py-2 text-left text-sm hover:bg-muted/60',
                o.value === value ? 'text-primary' : 'text-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Multi-select sibling of FilterSelect — same trigger style, dropdown items
 * are checkboxes, trigger shows "N 已选" once anything is picked.
 */
export function FilterMultiSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  emptyHint,
  className,
  dropdownClassName,
}: {
  value: T[];
  onChange: (next: T[]) => void;
  options: Array<{ value: T; label: string; sub?: string }>;
  placeholder?: string;
  emptyHint?: string;
  className?: string;
  dropdownClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = (v: T) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  const label =
    value.length === 0
      ? (placeholder ?? '请选择')
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? `已选 ${value.length}`)
        : `已选 ${value.length} 项`;

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border px-3 text-sm transition-colors',
          open
            ? 'border-primary bg-background text-primary'
            : 'border-input bg-background hover:bg-muted/40',
        )}
      >
        <span
          className={cn(
            'truncate',
            value.length === 0 && 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {open ? (
          <ChevronUp className="ml-2 size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div
          className={cn(
            'absolute left-0 top-full z-20 mt-1 max-h-64 min-w-full overflow-auto rounded-md border bg-popover py-1 shadow-lg',
            dropdownClassName,
          )}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {emptyHint ?? '暂无选项'}
            </div>
          ) : (
            options.map((o) => {
              const checked = value.includes(o.value);
              return (
                <div
                  key={o.value}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"
                  onClick={() => toggle(o.value)}
                >
                  <input type="checkbox" checked={checked} readOnly />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'truncate text-sm',
                        checked ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {o.label}
                    </div>
                    {o.sub && (
                      <div className="truncate text-xs text-muted-foreground">
                        {o.sub}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
