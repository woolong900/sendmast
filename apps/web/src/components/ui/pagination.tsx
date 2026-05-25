import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';

function buildItems(page: number, totalPages: number): (number | 'ellipsis')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  let start: number;
  let end: number;
  if (page <= 4) {
    start = 1;
    end = 5;
  } else if (page >= totalPages - 3) {
    start = totalPages - 4;
    end = totalPages;
  } else {
    start = page - 1;
    end = page + 1;
  }

  const items: (number | 'ellipsis')[] = [];
  if (start > 1) {
    items.push(1);
    if (start > 2) items.push('ellipsis');
  }
  for (let i = start; i <= end; i++) items.push(i);
  if (end < totalPages) {
    if (end < totalPages - 1) items.push('ellipsis');
    items.push(totalPages);
  }
  return items;
}

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100, 200],
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = buildItems(page, totalPages);

  return (
    <div className="flex items-center gap-1.5">
      <PageButton disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页">
        <ChevronLeft className="size-3.5" />
      </PageButton>
      {items.map((it, i) =>
        it === 'ellipsis' ? (
          <span
            key={`e-${i}`}
            className="px-1 text-sm text-muted-foreground"
            aria-hidden="true"
          >
            …
          </span>
        ) : (
          <PageButton
            key={it}
            active={it === page}
            onClick={() => onPageChange(it)}
            aria-current={it === page ? 'page' : undefined}
            aria-label={`第 ${it} 页`}
          >
            {it.toLocaleString()}
          </PageButton>
        ),
      )}
      <PageButton
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        aria-label="下一页"
      >
        <ChevronRight className="size-3.5" />
      </PageButton>

      {onPageSizeChange && (
        <PageSizeSelect
          value={pageSize}
          options={pageSizeOptions}
          onChange={(n) => {
            onPageSizeChange(n);
            onPageChange(1);
          }}
        />
      )}
    </div>
  );
}

function PageButton({
  active,
  disabled,
  children,
  onClick,
  ...rest
}: {
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 min-w-[32px] items-center justify-center rounded-md border bg-background px-2 text-sm tabular-nums transition-colors ${
        active
          ? 'border-primary text-primary'
          : 'border-input text-foreground hover:border-primary/40 hover:text-primary'
      } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-input disabled:hover:text-foreground`}
      {...rest}
    >
      {children}
    </button>
  );
}

function PageSizeSelect({
  value,
  options,
  onChange,
}: {
  value: number;
  options: number[];
  onChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 items-center gap-1 rounded-md border bg-background px-2.5 text-sm transition-colors ${
          open ? 'border-primary text-primary' : 'border-input hover:border-primary/40'
        }`}
      >
        <span className="tabular-nums">{value}</span>
        <span className="text-muted-foreground">条/页</span>
        <ChevronDown
          className={`size-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-20 mb-1 w-full overflow-hidden rounded-md border bg-popover p-1 shadow-md">
          {options.map((opt) => {
            const selected = opt === value;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm tabular-nums transition-colors hover:bg-accent ${
                  selected ? 'bg-accent text-accent-foreground' : ''
                }`}
              >
                <span>{opt}</span>
                <span className="text-xs text-muted-foreground">条/页</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
