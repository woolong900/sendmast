import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { DateRangePicker, type DateRange } from '@/components/ui/date-range-picker';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';
import type {
  AcsAccountView,
  AdminAccountView,
  SendLogListResponse,
  SendLogView,
} from '@sendmast/shared';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';

interface Filters {
  accountId: string;
  acsAccountId: string;
  source: '' | 'campaign' | 'automation';
  domain: string;
  status: '' | 'success' | 'failed';
  range: DateRange | null;
}

const EMPTY_FILTERS: Filters = {
  accountId: '',
  acsAccountId: '',
  source: '',
  domain: '',
  status: '',
  range: null,
};

const PAGE_SIZE_DEFAULT = 50;

export function SendLogsAdminPage() {
  // Two layers of state: the form (mutable as user types) and the active
  // query (frozen until "搜索" is clicked). This avoids hammering the API
  // on every keystroke in the domain input.
  const [form, setForm] = useState<Filters>(EMPTY_FILTERS);
  const [active, setActive] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [detail, setDetail] = useState<SendLogView | null>(null);

  const { data: accounts } = useQuery<AdminAccountView[]>({
    queryKey: ['admin', 'accounts'],
    queryFn: async () => (await api.get('/api/admin/accounts')).data,
  });
  const { data: acsAccounts } = useQuery<AcsAccountView[]>({
    queryKey: ['admin', 'acs-accounts'],
    queryFn: async () => (await api.get('/api/admin/acs-accounts')).data,
  });

  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      offset: String((page - 1) * pageSize),
      limit: String(pageSize),
    };
    if (active.accountId) params.accountId = active.accountId;
    if (active.acsAccountId) params.acsAccountId = active.acsAccountId;
    if (active.source) params.source = active.source;
    if (active.domain.trim()) params.domain = active.domain.trim().toLowerCase();
    if (active.status === 'success') params.ok = 'true';
    if (active.status === 'failed') params.ok = 'false';
    if (active.range) {
      params.from = active.range.from;
      params.to = active.range.to;
    }
    return params;
  }, [active, page, pageSize]);

  const { data, isLoading, isFetching } = useQuery<SendLogListResponse>({
    queryKey: ['admin', 'send-logs', queryParams],
    queryFn: async () => (await api.get('/api/admin/send-logs', { params: queryParams })).data,
    placeholderData: (prev) => prev,
  });

  function applySearch() {
    setActive(form);
    setPage(1);
  }
  function reset() {
    setForm(EMPTY_FILTERS);
    setActive(EMPTY_FILTERS);
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">发送日志</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每次 ACS 调用的发送记录,用于排查发送失败、监控延迟、审计租户使用情况。
        </p>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3 lg:grid-cols-7">
          <Field label="租户">
            <select
              className={selectCls}
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
            >
              <option value="">全部</option>
              {accounts?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="ACS 账号">
            <select
              className={selectCls}
              value={form.acsAccountId}
              onChange={(e) => setForm({ ...form, acsAccountId: e.target.value })}
            >
              <option value="">全部</option>
              {acsAccounts?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="来源">
            <select
              className={selectCls}
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value as Filters['source'] })}
            >
              <option value="">全部</option>
              <option value="campaign">营销活动</option>
              <option value="automation">自动化</option>
            </select>
          </Field>
          <Field label="发件域名">
            <Input
              placeholder="例如 example.com"
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            />
          </Field>
          <Field label="状态">
            <select
              className={selectCls}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as Filters['status'] })}
            >
              <option value="">全部</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
            </select>
          </Field>
          <div className="lg:col-span-2">
            <Field label="时间区间">
              <DateRangePicker
                value={form.range}
                onChange={(range) => setForm({ ...form, range })}
                className="w-full"
              />
            </Field>
          </div>

          <div className="md:col-span-3 lg:col-span-7 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={reset}>
              重置
            </Button>
            <Button onClick={applySearch}>
              <Search className="mr-1 size-4" />
              搜索
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <div>
              共{' '}
              <span className="font-medium tabular-nums text-foreground">
                {formatNumber(data?.total ?? 0)}
              </span>{' '}
              条{isFetching && !isLoading && <span className="ml-2 opacity-60">刷新中…</span>}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">时间</th>
                <th className="px-4 py-3 font-medium">租户</th>
                <th className="px-4 py-3 font-medium">ACS</th>
                <th className="px-4 py-3 font-medium">来源</th>
                <th className="px-4 py-3 font-medium">发件人</th>
                <th className="px-4 py-3 font-medium">收件人</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">耗时</th>
                <th className="px-4 py-3 font-medium">message id</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={10} cellClassName="px-4 py-3" />}
              {!isLoading && data?.rows.length === 0 && <EmptyStateRow colSpan={10} />}
              {data?.rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                  onClick={() => setDetail(r)}
                >
                  <td className="px-4 py-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(r.sentAt)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium">{r.account.name}</div>
                    <div className="text-xs text-muted-foreground">{r.account.slug}</div>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {r.acsAccount?.name ?? <span className="opacity-60">— 已删除</span>}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={r.source === 'automation' ? 'warning' : 'muted'}>
                      {r.source === 'automation' ? '自动化' : '营销活动'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{r.fromAddress}</td>
                  <td className="px-4 py-2 text-xs">{r.toAddress}</td>
                  <td className="px-4 py-2">
                    {r.ok ? (
                      <Badge variant="success">成功</Badge>
                    ) : (
                      <Badge variant="danger">{r.providerStatus ?? '失败'}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs tabular-nums text-muted-foreground">
                    {r.latencyMs != null ? `${r.latencyMs} ms` : '—'}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">
                    {r.messageId ? (
                      <span title={r.messageId}>{r.messageId.slice(0, 12)}…</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="ghost">
                      查看
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data?.total ?? 0) > 0 && (
            <div className="flex items-center justify-end border-t px-4 py-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={data?.total ?? 0}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {detail && <DetailDialog row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

const selectCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function DetailDialog({ row, onClose }: { row: SendLogView; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="text-base font-semibold">发送日志详情</h2>
            <p className="text-xs text-muted-foreground">{formatDateTime(row.sentAt)}</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          <Grid>
            <KV label="租户" value={`${row.account.name} (${row.account.slug})`} />
            <KV label="ACS 账号" value={row.acsAccount?.name ?? '— 已删除 —'} />
            <KV
              label="来源"
              value={
                row.source === 'automation'
                  ? `自动化 · ${row.automation?.shopName ?? row.automation?.type ?? '未知流程'}`
                  : `营销活动 · ${row.campaign?.name ?? '已删除'}`
              }
            />
            <KV label="收件人" value={row.toAddress} mono />
            <KV label="发件人" value={row.fromAddress} mono />
            <KV
              label={row.source === 'automation' ? 'automation send id' : 'recipient id'}
              value={row.automationSendId ?? row.recipientId ?? '—'}
              mono
            />
          </Grid>

          <Grid>
            <KV
              label="状态"
              value={row.ok ? '成功' : `失败(${row.providerStatus ?? '未知'})`}
              tone={row.ok ? 'success' : 'destructive'}
            />
            <KV label="耗时" value={row.latencyMs != null ? `${row.latencyMs} ms` : '—'} />
            <KV label="error code" value={row.errorCode ?? '—'} mono />
            <KV label="message id" value={row.messageId ?? '—'} mono />
          </Grid>

          {row.errorMessage && (
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">error message</Label>
              <pre className="overflow-x-auto rounded-md bg-destructive/5 p-3 text-xs text-destructive">
                {row.errorMessage}
              </pre>
            </div>
          )}

          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">
              ACS 响应原文 (response_payload)
            </Label>
            <pre className="max-h-[40vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
              {row.responsePayload != null
                ? JSON.stringify(row.responsePayload, null, 2)
                : '— 无 —'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>;
}

function KV({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: 'success' | 'destructive';
}) {
  const valueCls =
    (mono ? 'font-mono text-xs ' : 'text-sm ') +
    (tone === 'success'
      ? 'text-emerald-700 font-medium'
      : tone === 'destructive'
        ? 'text-destructive font-medium'
        : 'text-foreground');
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 break-all ${valueCls}`}>{value}</div>
    </div>
  );
}
