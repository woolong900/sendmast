import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FilterSelect } from '@/components/ui/filter-select';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';
import {
  SHOP_AUTOMATION_LABELS,
  type ShopAutomationSendListResponse,
  type ShopAutomationType,
  type ShopConnectionView,
} from '@sendmast/shared';

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  queued: '队列中',
  sent: '已发送',
  failed: '失败',
  skipped: '已跳过',
};
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
];
const AUTOMATION_TYPE_OPTIONS = [
  { value: '', label: '全部流程' },
  ...Object.entries(SHOP_AUTOMATION_LABELS).map(([value, label]) => ({ value, label })),
];

export function AutomationSendsPage() {
  const [connectionId, setConnectionId] = useState('');
  const [automationType, setAutomationType] = useState('');
  const [status, setStatus] = useState('');
  const [emailForm, setEmailForm] = useState('');
  const [email, setEmail] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const connections = useQuery<{ connections: ShopConnectionView[] }>({
    queryKey: ['shop-connections'],
    queryFn: async () => (await api.get('/api/integrations/shopyy')).data,
  });
  const params = useMemo(() => {
    const out: Record<string, string> = {
      offset: String((page - 1) * pageSize),
      limit: String(pageSize),
    };
    if (connectionId) out.connectionId = connectionId;
    if (automationType) out.automationType = automationType;
    if (status) out.status = status;
    if (email) out.email = email;
    return out;
  }, [connectionId, automationType, status, email, page, pageSize]);
  const sends = useQuery<ShopAutomationSendListResponse>({
    queryKey: ['automation-sends', params],
    queryFn: async () =>
      (await api.get('/api/integrations/shopyy/automation-sends/list', { params })).data,
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link to="/automations">
            <ArrowLeft className="mr-1 size-4" />
            返回自动化
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">自动化发送记录</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          查看每次店铺事件触发的邮件，以及跳过和失败原因。
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-4">
          <FilterSelect
            value={connectionId}
            onChange={(value) => {
              setConnectionId(value);
              setPage(1);
            }}
            options={[
              { value: '', label: '全部店铺' },
              ...(connections.data?.connections.map((c) => ({
                value: c.id,
                label: c.shopName ?? c.shopDomain ?? c.externalStoreId,
              })) ?? []),
            ]}
          />
          <FilterSelect
            value={automationType}
            onChange={(value) => {
              setAutomationType(value);
              setPage(1);
            }}
            options={AUTOMATION_TYPE_OPTIONS}
          />
          <FilterSelect
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={STATUS_OPTIONS}
          />
          <div className="flex gap-2">
            <Input
              value={emailForm}
              placeholder="搜索收件人邮箱"
              onChange={(e) => setEmailForm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setEmail(emailForm.trim());
                  setPage(1);
                }
              }}
            />
            <Button
              size="icon"
              onClick={() => {
                setEmail(emailForm.trim());
                setPage(1);
              }}
              title="搜索"
            >
              <Search className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            共{' '}
            <span className="font-medium text-foreground">
              {formatNumber(sends.data?.total ?? 0)}
            </span>{' '}
            条
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">触发时间</th>
                  <th className="px-4 py-3 font-medium">店铺 / 流程</th>
                  <th className="px-4 py-3 font-medium">订单号</th>
                  <th className="px-4 py-3 font-medium">收件人</th>
                  <th className="px-4 py-3 font-medium">主题</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">发送时间 / 原因</th>
                </tr>
              </thead>
              <tbody>
                {sends.isLoading && <TableSkeletonRows columns={7} cellClassName="px-4 py-3" />}
                {!sends.isLoading && sends.data?.rows.length === 0 && <EmptyStateRow colSpan={7} />}
                {sends.data?.rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.shopName ?? '店铺'}</div>
                      <div className="text-xs text-muted-foreground">
                        {SHOP_AUTOMATION_LABELS[row.automationType as ShopAutomationType]}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{row.orderNo ?? '—'}</td>
                    <td className="px-4 py-3 text-xs">{row.email}</td>
                    <td className="max-w-64 truncate px-4 py-3 text-xs" title={row.subject ?? ''}>
                      {row.subject ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={
                          row.status === 'sent'
                            ? 'success'
                            : row.status === 'failed'
                              ? 'danger'
                              : row.status === 'skipped'
                                ? 'muted'
                                : 'warning'
                        }
                      >
                        {STATUS_LABEL[row.status] ?? row.status}
                      </Badge>
                    </td>
                    <td className="max-w-72 px-4 py-3 text-xs text-muted-foreground">
                      {row.errorMessage ?? (row.sentAt ? formatDateTime(row.sentAt) : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(sends.data?.total ?? 0) > 0 && (
            <div className="flex justify-end border-t px-4 py-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={sends.data?.total ?? 0}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
