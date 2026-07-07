import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api, apiErrMessage } from '@/lib/api';
import { formatCompactNumber, formatDateTime } from '@/lib/utils';
import { useAuth } from '@/store/auth';
import type { DateRange } from '@/components/ui/date-range-picker';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

interface CampaignListItem {
  id: string;
  name: string;
  subject: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'failed' | 'canceled';
  fromName: string;
  fromEmail: string;
  // Server-rendered preview thumbnail URL (WebP), produced by worker-thumbnail.
  // `thumbnailPending` is true while a (re)render is queued — the list shows a
  // placeholder and polls until it lands.
  thumbnail: string | null;
  thumbnailPending: boolean;
  totalRecipients: number;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  lists: Array<{ id: string; name: string }>;
  stats: { sent: number; opened: number; clicked: number };
}

const STATUS_LABEL: Record<CampaignListItem['status'], string> = {
  draft: '草稿',
  scheduled: '已定时',
  sending: '发送中',
  sent: '发送成功',
  paused: '已暂停',
  failed: '失败',
  canceled: '已取消',
};
const STATUS_VARIANT: Record<
  CampaignListItem['status'],
  'success' | 'muted' | 'warning' | 'danger' | 'default'
> = {
  draft: 'muted',
  scheduled: 'warning',
  sending: 'default',
  sent: 'success',
  paused: 'muted',
  failed: 'danger',
  canceled: 'muted',
};

const MAX_THUMB_POLLS = 15;

export function CampaignListPage() {
  const [search, setSearch] = useState('');
  // Counts consecutive thumbnail-poll cycles so a stuck render can't poll forever.
  const thumbPollRef = useRef(0);
  // Debounced copy used in the query key — typing updates `search` (the input)
  // instantly but only fires a request 350ms after the user stops, instead of
  // one request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(t);
  }, [search]);
  // Server enforces this in CampaignService.create / send too — UI just
  // disables the entry point so users don't get a 403 surprise after
  // filling out the wizard.
  const { account } = useAuth();
  const accountStatus = account?.status;
  const canCreate = !accountStatus || accountStatus === 'active';
  const disabledHint =
    accountStatus === 'pending_activation'
      ? '请先激活账号(点击注册邮箱里的激活链接)后再创建活动。'
      : accountStatus === 'suspended'
        ? '账号已被封禁,无法创建活动。'
        : '';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['campaigns', debouncedSearch, status, dateRange?.from ?? '', dateRange?.to ?? ''],
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', pageSize: '50' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (status) params.set('status', status);
      if (dateRange) {
        params.set('createdFrom', dateRange.from);
        params.set('createdTo', dateRange.to);
      }
      return (await api.get(`/api/campaigns?${params}`)).data as {
        items: CampaignListItem[];
        total: number;
      };
    },
    // Polling policy:
    //  - any 发送中 campaign → 5s so its stats update live;
    //  - else any thumbnail still rendering → 4s, capped at MAX_THUMB_POLLS
    //    (~1min) so a stuck worker can't poll forever;
    //  - otherwise stop.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      if (items.some((c) => c.status === 'sending')) {
        thumbPollRef.current = 0;
        return 5000;
      }
      if (!items.some((c) => c.thumbnailPending)) {
        thumbPollRef.current = 0;
        return false;
      }
      if (thumbPollRef.current >= MAX_THUMB_POLLS) return false;
      thumbPollRef.current += 1;
      return 4000;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">营销活动</h1>
        {canCreate ? (
          <Button asChild className="w-full sm:w-auto">
            <Link to="/campaigns/new">
              <Plus className="mr-1 size-4" />
              新建营销活动
            </Link>
          </Button>
        ) : (
          <Button disabled title={disabledHint} className="w-full sm:w-auto">
            <Plus className="mr-1 size-4" />
            新建营销活动
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full min-w-0 flex-1 sm:min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="活动名称"
                className="pl-8"
              />
            </div>
            <StatusFilter value={status} onChange={setStatus} />
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              placeholder="开始日期 至 结束日期"
              className="w-full shrink-0 sm:w-auto sm:min-w-[280px]"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-3 pl-4 pr-2 font-medium">内容</th>
                <th className="py-3 pl-2 pr-4 font-medium">名称</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={2} />}
              {isError && !isLoading && (
                <tr>
                  <td colSpan={2} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    加载失败,请
                    <button
                      type="button"
                      className="ml-1 font-medium text-primary hover:underline"
                      onClick={() => void refetch()}
                    >
                      重试
                    </button>
                  </td>
                </tr>
              )}
              {data && data.items.length === 0 && <EmptyStateRow colSpan={2} />}
              {data?.items.map((c) => (
                <CampaignRow key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function CampaignRow({ c }: { c: CampaignListItem }) {
  const navigate = useNavigate();
  const editable = c.status === 'draft' || c.status === 'scheduled';
  const titleHref = editable ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`;

  return (
    <tr
      className="group cursor-pointer border-b last:border-0 hover:bg-muted/30"
      onClick={(e) => {
        // Preserve modifier-clicks so users can still Cmd/Ctrl/Shift+click
        // the title <Link> to open the campaign in a new tab/window.
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        navigate(titleHref);
      }}
    >
      <td className="py-4 pl-4 pr-2 align-middle">
        <ThumbnailWithHover
          campaignId={c.id}
          thumbnail={c.thumbnail}
          pending={c.thumbnailPending}
          subject={c.subject || c.name}
        />
      </td>
      <td className="py-4 pl-2 pr-4 align-middle">
        <Link
          to={titleHref}
          onClick={(e) => e.stopPropagation()}
          className="block text-base font-semibold leading-snug text-foreground transition-colors group-hover:text-primary sm:text-[17px]"
        >
          {c.name}
        </Link>
        {/* Below md the row's right-hand details (meta + stats + status + menu)
            stack vertically so they fit on a 360px screen; sm+ keeps the
            original horizontal layout. */}
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            <div className="leading-5">
              发送时间：{formatDateTime(c.sentAt ?? c.scheduledAt ?? c.createdAt)}
            </div>
            <div className="flex leading-5">
              <span className="shrink-0">发送列表：</span>
              <SendListSummary lists={c.lists} />
            </div>
          </div>
          <div className="flex shrink-0 gap-4 sm:gap-7">
            <StatItem value={c.stats.sent} label="发送" />
            <StatItem value={c.stats.opened} label="打开" />
            <StatItem value={c.stats.clicked} label="点击" />
          </div>
          {/* Status + action menu share a row on mobile (justify-between)
              and revert to inline-with-the-rest at sm+ via `sm:contents`. */}
          <div className="flex items-center justify-between gap-2 sm:contents">
            <div className="shrink-0 sm:w-[100px]">
              <Badge variant={STATUS_VARIANT[c.status]}>
                <span className="mr-1 inline-block size-1.5 rounded-full bg-current opacity-70" />
                {STATUS_LABEL[c.status]}
              </Badge>
            </div>
            {/* Action menu trigger and items must not bubble — otherwise
                clicking "..." or any menu item would also navigate. */}
            <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <ActionMenu c={c} />
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * 发送列表展示:列表多时只显示首个 + "…等 N 个列表",鼠标悬浮弹出全部。
 * 用具名 group/sl 避免和外层行的 `group`(hover 高亮)冲突;浮层从 top-full
 * 紧贴并用 pt-1 透明桥接,鼠标移向浮层时不会脱离 hover 导致闪退。
 */
function SendListSummary({ lists }: { lists: Array<{ id: string; name: string }> }) {
  if (lists.length === 0) return <>-</>;
  if (lists.length === 1) return <span className="min-w-0 truncate">{lists[0].name}</span>;

  return (
    <span className="group/sl relative inline-flex min-w-0 items-center gap-1 align-bottom">
      <span className="min-w-0 truncate">{lists[0].name}</span>
      <span className="shrink-0 cursor-default text-muted-foreground">
        …等 {lists.length} 个列表
      </span>
      <div className="invisible absolute left-0 top-full z-30 pt-1 opacity-0 transition-opacity group-hover/sl:visible group-hover/sl:opacity-100">
        <div className="max-h-64 w-max max-w-md overflow-auto rounded-md border bg-popover p-2 text-xs shadow-lg">
          <div className="mb-1 font-medium text-muted-foreground">全部 {lists.length} 个列表</div>
          {lists.map((l) => (
            <div key={l.id} className="whitespace-nowrap py-0.5 text-foreground">
              {l.name}
            </div>
          ))}
        </div>
      </div>
    </span>
  );
}

function StatItem({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-[56px] text-center">
      <div className="text-[15px] font-semibold leading-5 tabular-nums text-foreground">
        {formatCompactNumber(value)}
      </div>
      <div className="text-xs leading-5 text-muted-foreground">{label}</div>
    </div>
  );
}

const PREVIEW_HEIGHT = 480;

/**
 * Two-tier preview:
 *   - Small thumbnail = a cheap <img> of the server-rendered WebP (produced by
 *     worker-thumbnail via headless Chromium). While the render is still queued
 *     (`pending`) or the campaign has none yet, we show a subject placeholder.
 *   - Hover preview = the campaign's full HTML in an iframe, fetched on-demand
 *     the first time the user hovers (one campaign's HTML at a time, never all
 *     50) and cached by react-query.
 */
function ThumbnailWithHover({
  campaignId,
  thumbnail,
  pending,
  subject,
}: {
  campaignId: string;
  thumbnail: string | null;
  pending: boolean;
  subject: string;
}) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `enabled: open` keeps the fetch off until the user actually hovers.
  const preview = useQuery<{ html: string | null }>({
    queryKey: ['campaign-html', campaignId],
    queryFn: async () =>
      (await api.get(`/api/campaigns/${campaignId}`)).data,
    enabled: open,
  });

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const show = () => {
    // Skip the hover preview on touch-only devices: mouseenter still fires on
    // first-tap simulation, but showing a 420×480 popover next to the
    // thumbnail (a) covers half the screen, (b) traps the user because there's
    // no obvious way to dismiss it without leaving the row. On true hover-
    // capable devices (desktop, laptop with trackpad, iPad with mouse) the
    // matchMedia probe is true and the preview behaves as before.
    if (
      typeof window !== 'undefined' &&
      !window.matchMedia('(hover: hover)').matches
    ) {
      return;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    // Flip the preview upward when there isn't room below — otherwise the
    // popup extends past the viewport, the main scroller adds a vertical
    // scrollbar, and the page width jumps.
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (rect) {
      setFlipUp(rect.top + PREVIEW_HEIGHT > window.innerHeight);
    }
    setOpen(true);
  };
  // Small grace period so the mouse can travel across the gap between the
  // thumbnail and the popup without it disappearing.
  const scheduleHide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };

  const previewHtml = preview.data?.html ?? null;
  const canShowPopup = open && !!previewHtml;
  const showThumb = !!thumbnail && !thumbBroken;

  return (
    <div
      ref={wrapperRef}
      className="relative inline-block"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <div className="relative size-[88px] overflow-hidden rounded border bg-white shadow-sm">
        {showThumb ? (
          <img
            src={thumbnail!}
            alt={subject}
            loading="lazy"
            className="h-full w-full object-cover object-top"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] leading-tight text-muted-foreground">
            <span className="line-clamp-3">{subject || '无内容'}</span>
          </div>
        )}
        {pending && !showThumb && (
          <div className="absolute inset-x-0 bottom-0 bg-black/40 py-0.5 text-center text-[9px] leading-none text-white">
            生成中…
          </div>
        )}
      </div>
      {canShowPopup && (
        <div
          className={
            'absolute left-full z-30 ml-3 w-[420px] overflow-hidden rounded-md border bg-white shadow-xl ' +
            (flipUp ? 'bottom-0' : 'top-0')
          }
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          {previewHtml ? (
            <iframe
              title="preview"
              srcDoc={previewHtml}
              sandbox="allow-same-origin"
              className="block h-[480px] w-full"
            />
          ) : preview.isLoading ? (
            <div className="flex h-[480px] w-full items-center justify-center text-xs text-muted-foreground">
              加载预览中…
            </div>
          ) : (
            <div className="flex h-[480px] w-full items-center justify-center text-xs text-muted-foreground">
              暂无邮件内容
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const stopBlur = (e: React.MouseEvent) => e.preventDefault();
  const label = value
    ? STATUS_LABEL[value as CampaignListItem['status']]
    : '全部状态';

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(close, 120)}
        className={
          'flex h-9 w-[120px] items-center justify-between rounded-md border px-3 text-sm transition-colors ' +
          (open
            ? 'border-primary bg-background text-primary'
            : 'border-input bg-background hover:bg-muted/40')
        }
      >
        <span className="truncate">{label}</span>
        {open ? (
          <ChevronUp className="size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-20 mt-1 w-[120px] overflow-hidden rounded-md border bg-popover py-1 shadow-lg"
          onMouseDown={stopBlur}
        >
          <StatusItem
            active={value === ''}
            onClick={() => {
              onChange('');
              close();
            }}
          >
            全部状态
          </StatusItem>
          {(Object.keys(STATUS_LABEL) as CampaignListItem['status'][]).map(
            (s) => (
              <StatusItem
                key={s}
                active={value === s}
                onClick={() => {
                  onChange(s);
                  close();
                }}
              >
                {STATUS_LABEL[s]}
              </StatusItem>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function StatusItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'block w-full px-3 py-2 text-left text-sm hover:bg-muted/60 ' +
        (active ? 'text-primary' : 'text-foreground')
      }
    >
      {children}
    </button>
  );
}

function ActionMenu({ c }: { c: CampaignListItem }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();

  const invalidate = () => qc.invalidateQueries({ queryKey: ['campaigns'] });

  const duplicateMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${c.id}/duplicate`),
    onError: (err) => toast(`复制失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/api/campaigns/${c.id}`),
    onError: (err) => toast(`删除失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const pauseMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${c.id}/pause`),
    onError: (err) => toast(`暂停失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const resumeMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${c.id}/resume`),
    onError: (err) => toast(`继续失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });
  const cancelMut = useMutation({
    mutationFn: () => api.post(`/api/campaigns/${c.id}/cancel`),
    onError: (err) => toast(`取消失败:${apiErrMessage(err)}`, 'error'),
    onSuccess: invalidate,
  });

  const close = () => setOpen(false);
  const stopBlur = (e: React.MouseEvent) => e.preventDefault();

  const canPause = c.status === 'sending' || c.status === 'scheduled';
  const canResume = c.status === 'paused';
  const canCancel = c.status === 'sending' || c.status === 'scheduled' || c.status === 'paused';
  const canDelete = c.status !== 'sending';
  // 菜单触发器在任一 mutation 进行中时禁用,避免重复打开菜单触发并发请求。
  const anyPending =
    duplicateMut.isPending ||
    deleteMut.isPending ||
    pauseMut.isPending ||
    resumeMut.isPending ||
    cancelMut.isPending;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(close, 120)}
        disabled={anyPending}
        className={
          'flex h-8 w-[88px] items-center justify-between rounded-md border px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
          (open
            ? 'border-primary bg-background text-primary'
            : 'border-input bg-background hover:bg-muted/40')
        }
      >
        操作
        {open ? (
          <ChevronUp className="size-3.5" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-[88px] overflow-hidden rounded-md border bg-popover py-1 shadow-lg"
          onMouseDown={stopBlur}
        >
          {(c.status === 'draft' || c.status === 'scheduled') && (
            <MenuLink to={`/campaigns/${c.id}/edit`} onClick={close}>
              编辑
            </MenuLink>
          )}
          {c.status !== 'draft' && c.status !== 'scheduled' && (
            <MenuLink to={`/campaigns/${c.id}`} onClick={close}>
              任务详情
            </MenuLink>
          )}
          {c.status !== 'draft' && c.status !== 'scheduled' && (
            <MenuLink to={`/campaigns/${c.id}/analytics`} onClick={close}>
              查看数据
            </MenuLink>
          )}
          {canPause && (
            <MenuButton
              onClick={() => {
                pauseMut.mutate();
                close();
              }}
            >
              暂停
            </MenuButton>
          )}
          {canResume && (
            <MenuButton
              onClick={() => {
                resumeMut.mutate();
                close();
              }}
            >
              继续
            </MenuButton>
          )}
          {canCancel && (
            <MenuButton
              danger
              onClick={async () => {
                close();
                const ok = await confirm({
                  title: '取消活动',
                  description: (
                    <>
                      确定取消「<span className="font-medium">{c.name}</span>」吗?已发送的邮件无法撤回。
                    </>
                  ),
                  confirmLabel: '取消活动',
                  cancelLabel: '不,继续发送',
                  variant: 'danger',
                });
                if (ok) cancelMut.mutate();
              }}
            >
              取消
            </MenuButton>
          )}
          <MenuButton
            onClick={() => {
              duplicateMut.mutate();
              close();
            }}
          >
            复制
          </MenuButton>
          {canDelete && (
            <MenuButton
              danger
              onClick={async () => {
                close();
                const ok = await confirm({
                  title: '删除活动',
                  description: (
                    <>
                      确定删除活动「<span className="font-medium">{c.name}</span>」吗?该操作不可撤销。
                    </>
                  ),
                  confirmLabel: '删除',
                  variant: 'danger',
                });
                if (ok) deleteMut.mutate();
              }}
            >
              删除
            </MenuButton>
          )}
        </div>
      )}
    </div>
  );
}

function MenuLink({
  to,
  children,
  onClick,
}: {
  to: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="block px-3 py-2 text-sm text-foreground hover:bg-muted/60"
    >
      {children}
    </Link>
  );
}

function MenuButton({
  children,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'block w-full px-3 py-2 text-left text-sm hover:bg-muted/60 ' +
        (danger ? 'text-destructive' : 'text-foreground')
      }
    >
      {children}
    </button>
  );
}
