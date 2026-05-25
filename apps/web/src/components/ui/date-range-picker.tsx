import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Date range value. Both bounds are ISO 8601 strings; the picker emits the
 * start at 00:00:00.000 local and the end at 23:59:59.999 local for normal
 * (calendar-picked) ranges. Quick presets like "过去24小时" emit literal
 * timestamps (now − 24h .. now) so the API filter matches exactly what the
 * preset name promises, even though the UI only renders the date portion.
 */
export interface DateRange {
  from: string;
  to: string;
}

interface Props {
  value: DateRange | null;
  onChange: (v: DateRange | null) => void;
  placeholder?: string;
  /** Max range allowed in days. Defaults to 365 to match the "最多选择 1 年" hint. */
  maxDays?: number;
  className?: string;
}

const TZ_LABEL = (() => {
  const offMin = -new Date().getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offMin) % 60).padStart(2, '0');
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    zone = '';
  }
  return `(GMT${sign}${hh}:${mm})${zone ? ' ' + zone : ''}`;
})();

const PRESETS = [
  { id: 'today', label: '今天' },
  { id: 'last24h', label: '过去24小时' },
  { id: 'yesterday', label: '昨天' },
  { id: 'last7d', label: '过去7天' },
  { id: 'last30d', label: '过去30天' },
  { id: 'last90d', label: '过去90天' },
  { id: 'lastMonth', label: '上月' },
] as const;
type PresetId = (typeof PRESETS)[number]['id'];

function pad(n: number) {
  return String(n).padStart(2, '0');
}
function fmtDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}
function startOfDay(d: Date) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function endOfDay(d: Date) {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}
function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function diffDays(a: Date, b: Date) {
  return Math.floor((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);
}

function applyPreset(id: PresetId): DateRange {
  const now = new Date();
  switch (id) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case 'last24h':
      return { from: new Date(now.getTime() - 24 * 3600_000).toISOString(), to: now.toISOString() };
    case 'yesterday': {
      const y = addDays(now, -1);
      return { from: startOfDay(y).toISOString(), to: endOfDay(y).toISOString() };
    }
    case 'last7d':
      return { from: startOfDay(addDays(now, -6)).toISOString(), to: endOfDay(now).toISOString() };
    case 'last30d':
      return { from: startOfDay(addDays(now, -29)).toISOString(), to: endOfDay(now).toISOString() };
    case 'last90d':
      return { from: startOfDay(addDays(now, -89)).toISOString(), to: endOfDay(now).toISOString() };
    case 'lastMonth': {
      const lm = addMonths(startOfMonth(now), -1);
      return { from: startOfMonth(lm).toISOString(), to: endOfMonth(lm).toISOString() };
    }
  }
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = '选择时间',
  maxDays = 365,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Editing state lives only while the popup is open.
  const [draftFrom, setDraftFrom] = useState<Date | null>(null);
  const [draftTo, setDraftTo] = useState<Date | null>(null);
  const [hover, setHover] = useState<Date | null>(null);
  const [leftMonth, setLeftMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');

  const triggerLabel = useMemo(() => {
    if (!value) return placeholder;
    return `${fmtDate(new Date(value.from))} 至 ${fmtDate(new Date(value.to))}`;
  }, [value, placeholder]);

  // Open: seed draft from current value, position calendars to that month.
  useEffect(() => {
    if (!open) return;
    const f = value ? new Date(value.from) : null;
    const t = value ? new Date(value.to) : null;
    setDraftFrom(f);
    setDraftTo(t);
    setHover(null);
    setFromText(f ? fmtDate(f) : '');
    setToText(t ? fmtDate(t) : '');
    setLeftMonth(startOfMonth(f ?? new Date()));
  }, [open, value]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pickDay(d: Date) {
    if (!draftFrom || (draftFrom && draftTo)) {
      // Start a new selection.
      setDraftFrom(d);
      setDraftTo(null);
      setFromText(fmtDate(d));
      setToText('');
      return;
    }
    // Have draftFrom but no draftTo — set the second endpoint, with auto-swap.
    let from = draftFrom;
    let to = d;
    if (to.getTime() < from.getTime()) [from, to] = [to, from];
    if (diffDays(from, to) + 1 > maxDays) {
      // Clamp the range to maxDays from `from`.
      to = addDays(from, maxDays - 1);
    }
    setDraftFrom(from);
    setDraftTo(to);
    setFromText(fmtDate(from));
    setToText(fmtDate(to));
  }

  function applyTextInputs() {
    const f = parseDate(fromText);
    const t = parseDate(toText);
    if (f) setDraftFrom(f);
    if (t) setDraftTo(t);
    if (f && t && t.getTime() < f.getTime()) {
      setDraftFrom(t);
      setDraftTo(f);
    }
  }

  function commit() {
    if (!draftFrom || !draftTo) {
      setOpen(false);
      return;
    }
    onChange({ from: startOfDay(draftFrom).toISOString(), to: endOfDay(draftTo).toISOString() });
    setOpen(false);
  }

  function clear() {
    onChange(null);
    setOpen(false);
  }

  const rightMonth = addMonths(leftMonth, 1);
  const previewEnd = draftFrom && !draftTo && hover ? hover : draftTo;

  return (
    <div ref={containerRef} className={cn('relative inline-block', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 w-full min-w-[260px] items-center gap-2 rounded-md border border-input bg-background px-3 text-sm transition-colors',
          'hover:border-primary/40',
          open && 'border-primary ring-1 ring-primary/20',
          !value && 'text-muted-foreground',
        )}
      >
        <span className="flex-1 truncate text-left">{triggerLabel}</span>
        <Calendar className="size-4 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 flex w-[640px] flex-col overflow-hidden rounded-lg border bg-popover shadow-xl">
          <div className="flex">
            {/* Left preset sidebar */}
            <div className="w-36 shrink-0 border-r bg-muted/20 py-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    const r = applyPreset(p.id);
                    onChange(r);
                    setOpen(false);
                  }}
                  className="block w-full px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Right calendar area */}
            <div className="flex-1 p-4">
              {/* Two text inputs */}
              <div className="mb-3 grid grid-cols-2 gap-2">
                <DateInput
                  label="开始时间"
                  value={fromText}
                  onChange={setFromText}
                  onCommit={applyTextInputs}
                />
                <DateInput
                  label="结束时间"
                  value={toText}
                  onChange={setToText}
                  onCommit={applyTextInputs}
                />
              </div>

              {/* Two-month calendar with nav */}
              <div className="grid grid-cols-2 gap-4">
                <CalendarGrid
                  month={leftMonth}
                  draftFrom={draftFrom}
                  draftTo={previewEnd}
                  onPick={pickDay}
                  onHover={setHover}
                  showLeftNav
                  onPrevMonth={() => setLeftMonth(addMonths(leftMonth, -1))}
                  onPrevYear={() => setLeftMonth(addMonths(leftMonth, -12))}
                />
                <CalendarGrid
                  month={rightMonth}
                  draftFrom={draftFrom}
                  draftTo={previewEnd}
                  onPick={pickDay}
                  onHover={setHover}
                  showRightNav
                  onNextMonth={() => setLeftMonth(addMonths(leftMonth, 1))}
                  onNextYear={() => setLeftMonth(addMonths(leftMonth, 12))}
                />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t bg-card px-4 py-2.5">
            <div className="text-xs text-muted-foreground">{TZ_LABEL}</div>
            <div className="flex items-center gap-2">
              {value && (
                <Button size="sm" variant="ghost" onClick={clear}>
                  清除
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button size="sm" onClick={commit} disabled={!draftFrom || !draftTo}>
                确定
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20">
      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{label}</span>
      <input
        type="text"
        placeholder="YYYY-MM-DD"
        className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit();
          }
        }}
      />
    </div>
  );
}

function CalendarGrid({
  month,
  draftFrom,
  draftTo,
  onPick,
  onHover,
  showLeftNav,
  showRightNav,
  onPrevMonth,
  onNextMonth,
  onPrevYear,
  onNextYear,
}: {
  month: Date;
  draftFrom: Date | null;
  draftTo: Date | null;
  onPick: (d: Date) => void;
  onHover: (d: Date | null) => void;
  showLeftNav?: boolean;
  showRightNav?: boolean;
  onPrevMonth?: () => void;
  onNextMonth?: () => void;
  onPrevYear?: () => void;
  onNextYear?: () => void;
}) {
  const year = month.getFullYear();
  const monthIdx = month.getMonth();
  const first = new Date(year, monthIdx, 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  const days: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(year, monthIdx, 1 - offset + i);
    return d;
  });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm font-medium">
        <div className="flex w-12 items-center gap-1">
          {showLeftNav && (
            <>
              <NavBtn onClick={onPrevYear} title="上一年">
                <ChevronsLeft className="size-3.5" />
              </NavBtn>
              <NavBtn onClick={onPrevMonth} title="上月">
                <ChevronLeft className="size-3.5" />
              </NavBtn>
            </>
          )}
        </div>
        <div className="flex-1 text-center">
          {year}年 {monthIdx + 1}月
        </div>
        <div className="flex w-12 items-center justify-end gap-1">
          {showRightNav && (
            <>
              <NavBtn onClick={onNextMonth} title="下月">
                <ChevronRight className="size-3.5" />
              </NavBtn>
              <NavBtn onClick={onNextYear} title="下一年">
                <ChevronsRight className="size-3.5" />
              </NavBtn>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-xs text-muted-foreground">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
        {days.map((d, i) => {
          const inMonth = d.getMonth() === monthIdx;
          const isStart = draftFrom && isSameDay(d, draftFrom);
          const isEnd = draftTo && isSameDay(d, draftTo);
          const inRange =
            draftFrom &&
            draftTo &&
            d.getTime() >= startOfDay(draftFrom).getTime() &&
            d.getTime() <= endOfDay(draftTo).getTime();
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(d)}
              onMouseEnter={() => onHover(d)}
              onMouseLeave={() => onHover(null)}
              className={cn(
                'mx-auto flex size-8 items-center justify-center text-sm tabular-nums transition-colors',
                'rounded-md',
                inMonth ? 'text-foreground' : 'text-muted-foreground/40',
                inRange && !isStart && !isEnd && 'bg-primary/10 rounded-none',
                inRange && isStart && 'rounded-l-md rounded-r-none',
                inRange && isEnd && 'rounded-r-md rounded-l-none',
                (isStart || isEnd) && 'bg-primary text-primary-foreground hover:bg-primary',
                !isStart && !isEnd && !inRange && 'hover:bg-muted',
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NavBtn({
  onClick,
  title,
  children,
}: {
  onClick?: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
