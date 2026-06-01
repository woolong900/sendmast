import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { UAParser } from 'ua-parser-js';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { cn, formatDateTime, formatNumber } from '@/lib/utils';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

type Dimension =
  | 'sent'
  | 'delivered'
  | 'pending'
  | 'opened'
  | 'clicked'
  | 'sales'
  | 'failed'
  | 'invalid'
  | 'unsubscribed'
  | 'bounced'
  | 'complained';

interface RecipientRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  eventTime: string | null;
  userAgent: string | null;
  linkUrl: string | null;
  deliveredAt: string | null;
  reason: string | null;
  bounceType: string | null;
}

interface ListResp {
  source: 'hot' | 'archived' | 'events' | 'empty';
  rows: RecipientRow[];
  nextCursor: string | null;
  total: number | null;
}

interface CampaignDetail {
  id: string;
  name: string;
}

const TABS: Array<{ key: Dimension; label: string }> = [
  { key: 'sent', label: '发送' },
  { key: 'delivered', label: '送达' },
  { key: 'pending', label: '投递中' },
  { key: 'opened', label: '打开' },
  { key: 'clicked', label: '点击' },
  { key: 'sales', label: '销售额' },
  { key: 'failed', label: '发送失败' },
  { key: 'invalid', label: '无效邮箱' },
  { key: 'unsubscribed', label: '退订' },
  { key: 'bounced', label: '弹回' },
  { key: 'complained', label: '投诉' },
];

function isDimension(s: string | null): s is Dimension {
  return TABS.some((t) => t.key === s);
}

function displayName(r: RecipientRow): string {
  const composed = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
  if (composed) return composed;
  // CSV imports often skip name columns — falling back to the email local
  // part keeps the table readable instead of showing a wall of dashes.
  const local = r.email.split('@')[0];
  return local || '-';
}

/**
 * Parse user_agent string into { device, os } strings for the table.
 * ua-parser-js handles the long tail (mobile UAs, bots, etc) much better
 * than any regex we'd write by hand. Returns 「-」 when UA is missing
 * (common for events ingested before tracking was wired or from servers
 * that don't forward UA, like Apple Mail Privacy Protection prefetches).
 */
function parseUA(ua: string | null): { device: string; os: string } {
  if (!ua) return { device: '-', os: '-' };
  try {
    const r = new UAParser(ua).getResult();
    // Prefer device.model when it exists (mobile); otherwise fall back to
    // browser name for desktop, which is more meaningful than "device: -".
    const device =
      [r.device.vendor, r.device.model].filter(Boolean).join(' ').trim() ||
      r.browser.name ||
      '桌面端';
    const os = [r.os.name, r.os.version].filter(Boolean).join(' ').trim() || '-';
    return { device, os };
  } catch {
    return { device: '-', os: '-' };
  }
}

// ----- Per-tab column configuration -----------------------------------------
// Each entry produces one <th>/<td>. Keeping this declarative means adding a
// column to a tab is a one-line change without touching render JSX.

interface Column {
  header: string;
  /** Tailwind width class — keeps narrow columns narrow. */
  className?: string;
  /** Cell renderer; receives the row and returns a React node. */
  cell: (r: RecipientRow) => React.ReactNode;
}

const COL_NAME: Column = {
  header: '姓名',
  className: 'w-1/5',
  cell: (r) => displayName(r),
};
const COL_EMAIL: Column = {
  header: '邮箱',
  cell: (r) => <span className="text-muted-foreground">{r.email}</span>,
};
const COL_DEVICE: Column = {
  header: '设备',
  className: 'w-32',
  cell: (r) => (
    <span className="text-muted-foreground">{parseUA(r.userAgent).device}</span>
  ),
};
const COL_OS: Column = {
  header: '操作系统',
  className: 'w-32',
  cell: (r) => (
    <span className="text-muted-foreground">{parseUA(r.userAgent).os}</span>
  ),
};
const COL_URL: Column = {
  header: 'URL',
  cell: (r) =>
    r.linkUrl ? (
      <a
        href={r.linkUrl}
        target="_blank"
        rel="noreferrer noopener"
        // Long URLs are common; truncate but keep the full link in the title
        // so hovering shows the actual destination.
        className="block max-w-xs truncate text-primary hover:underline"
        title={r.linkUrl}
      >
        {r.linkUrl}
      </a>
    ) : (
      <span className="text-muted-foreground">-</span>
    ),
};
const COL_BOUNCE_TYPE: Column = {
  header: '弹回类型',
  className: 'w-32',
  cell: (r) => (
    <span className="text-muted-foreground">{r.bounceType ?? '-'}</span>
  ),
};
const COL_REASON = (header: string): Column => ({
  header,
  cell: (r) => (
    <span className="block max-w-md truncate text-muted-foreground" title={r.reason ?? undefined}>
      {r.reason ?? '-'}
    </span>
  ),
});
// Distinct from COL_REASON because failed/invalid tabs come from PG
// (campaign_recipients.error_message — written by worker-sender on send
// failure or by tick on quota exhaustion), while bounced/unsubscribed
// tabs come from CH events (raw_meta.deliveryStatusDetails). Keeping the
// two sources in separate columns avoids a confusing `reason ?? errorMessage`
// fallback that would silently hide bugs if either source went stale.
const COL_ERROR_MESSAGE = (header: string): Column => ({
  header,
  cell: (r) => (
    <span
      className="block max-w-md truncate text-muted-foreground"
      title={r.errorMessage ?? undefined}
    >
      {r.errorMessage ?? '-'}
    </span>
  ),
});

const COL_TIME = (header: string, key: 'sentAt' | 'deliveredAt' | 'eventTime'): Column => ({
  header,
  className: 'w-44',
  cell: (r) => (
    <span className="text-right tabular-nums text-muted-foreground">
      {formatDateTime(r[key])}
    </span>
  ),
});

// Each tab's column list. Order here matches the user's spec.
const COLUMNS_BY_DIM: Record<Dimension, Column[]> = {
  sent: [COL_NAME, COL_EMAIL, COL_TIME('发送时间', 'eventTime')],
  delivered: [COL_NAME, COL_EMAIL, COL_TIME('送达时间', 'eventTime')],
  pending: [COL_NAME, COL_EMAIL, COL_TIME('发送时间', 'eventTime')],
  opened: [
    COL_NAME,
    COL_EMAIL,
    COL_DEVICE,
    COL_OS,
    COL_TIME('送达时间', 'deliveredAt'),
    COL_TIME('打开时间', 'eventTime'),
  ],
  clicked: [
    COL_NAME,
    COL_EMAIL,
    COL_DEVICE,
    COL_OS,
    COL_TIME('发送时间', 'sentAt'),
    COL_TIME('点击时间', 'eventTime'),
    COL_URL,
  ],
  sales: [COL_NAME, COL_EMAIL, COL_TIME('下单时间', 'eventTime')],
  failed: [
    COL_NAME,
    COL_EMAIL,
    COL_ERROR_MESSAGE('失败原因'),
    COL_TIME('失败时间', 'eventTime'),
  ],
  invalid: [
    COL_NAME,
    COL_EMAIL,
    COL_REASON('原因'),
    COL_TIME('失效时间', 'eventTime'),
  ],
  unsubscribed: [
    COL_NAME,
    COL_EMAIL,
    COL_TIME('退订时间', 'eventTime'),
    COL_REASON('退订原因'),
  ],
  bounced: [
    COL_NAME,
    COL_EMAIL,
    COL_BOUNCE_TYPE,
    COL_REASON('弹回原因'),
    COL_TIME('发送时间', 'sentAt'),
  ],
  complained: [
    COL_NAME,
    COL_EMAIL,
    COL_REASON('投诉原因'),
    COL_TIME('发送时间', 'sentAt'),
  ],
};

export function CampaignRecipientsPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const dimRaw = params.get('tab');
  const dim: Dimension = isDimension(dimRaw) ? dimRaw : 'sent';
  const cursor = params.get('cursor') ?? undefined;

  const columns = useMemo(() => COLUMNS_BY_DIM[dim], [dim]);

  const detail = useQuery<CampaignDetail>({
    queryKey: ['campaigns', id],
    queryFn: async () => (await api.get(`/api/campaigns/${id}`)).data,
    enabled: !!id,
  });

  const list = useQuery<ListResp>({
    queryKey: ['campaign-recipients', id, dim, cursor],
    queryFn: async () =>
      (
        await api.get(`/api/campaigns/${id}/recipients`, {
          params: { dimension: dim, cursor, pageSize: 50 },
        })
      ).data,
    enabled: !!id,
    // Keep previous rows visible ONLY while paginating within the SAME tab (so
    // 上/下一页 doesn't flash). On a tab switch the dimension changes, so drop
    // the placeholder and show the loading skeleton instead of the old tab's
    // rows (which would briefly look like wrong data).
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey?.[2] === dim ? prev : undefined,
  });

  // Cursor-based pagination is forward-only (the API returns nextCursor), so
  // "上一页" needs a remembered stack of the cursors we came from rather than
  // window.history.back() (which broke after a tab switch — back went to the
  // previous tab, not the previous page).
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const setTab = (next: Dimension) => {
    const sp = new URLSearchParams(params);
    sp.set('tab', next);
    sp.delete('cursor');
    setParams(sp, { replace: true });
    setCursorStack([]);
  };

  const goToCursor = (next: string | null) => {
    const sp = new URLSearchParams(params);
    if (next) sp.set('cursor', next);
    else sp.delete('cursor');
    setParams(sp);
  };

  const goNext = () => {
    const next = list.data?.nextCursor;
    if (!next) return;
    setCursorStack((s) => [...s, cursor ?? '']);
    goToCursor(next);
  };

  const goPrev = () => {
    if (cursorStack.length === 0) return;
    const prev = cursorStack[cursorStack.length - 1];
    setCursorStack((s) => s.slice(0, -1));
    goToCursor(prev || null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" asChild className="shrink-0">
          <Link to={`/campaigns/${id}/analytics`} aria-label="返回活动数据">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="min-w-0 truncate text-xl font-semibold">用户明细数据</h1>
        {detail.data && (
          <span className="truncate text-sm text-muted-foreground">
            · {detail.data.name}
          </span>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="border-b">
            <div className="flex flex-wrap gap-x-1 px-2">
              {TABS.map((t) => {
                const active = t.key === dim;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={cn(
                      'relative px-4 py-3 text-sm transition-colors',
                      active
                        ? 'font-semibold text-primary'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                    {active && (
                      <span className="absolute inset-x-3 -bottom-px h-0.5 rounded bg-primary" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.header}
                      className={cn(
                        'px-3 py-3 text-left font-medium sm:px-6',
                        c.className,
                      )}
                    >
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={`sk-${i}`} className="border-t">
                      {columns.map((c) => (
                        <td key={c.header} className="px-3 py-4 sm:px-6">
                          <Skeleton className="h-4 w-24" />
                        </td>
                      ))}
                    </tr>
                  ))}
                {!list.isLoading && (list.data?.rows.length ?? 0) === 0 && (
                  <EmptyStateRow
                    colSpan={columns.length}
                    title={dim === 'sales' ? '订单数据功能即将推出' : '暂无数据'}
                  />
                )}
                {list.data?.rows.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    {columns.map((c) => (
                      <td key={c.header} className="px-3 py-4 sm:px-6">
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground sm:px-6">
            <div>
              {list.data?.total != null
                ? `共 ${formatNumber(list.data.total)} 条`
                : ''}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursorStack.length === 0}
                onClick={goPrev}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!list.data?.nextCursor}
                onClick={goNext}
              >
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
