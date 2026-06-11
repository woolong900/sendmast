import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyStateRow } from '@/components/ui/empty-state';
import { TableSkeletonRows } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/utils';
import type { QuotaOrderView } from '@sendmast/shared';

/**
 * Self-service order history — paid receipts only. The backend filters
 * to `status='paid'`, so this is a static-ish list that doesn't need
 * polling: live state of an unfinished order lives in the QR-pay modal,
 * and once an order flips to paid the modal invalidates this query as
 * it closes (see UpgradeQuotaModal).
 *
 * The `?tradeNo=<id>` URL param is supported for future redirect-back
 * flows (e.g. WeChat in-browser pay). Today's QR-scan flow doesn't use
 * it — the modal handles polling there.
 */
export function OrdersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tradeNo = params.get('tradeNo');

  const { data: orders = [], isLoading } = useQuery<QuotaOrderView[]>({
    queryKey: ['quota-orders'],
    queryFn: async () => (await api.get('/api/quota-orders')).data,
  });

  // Specifically poll the order referenced by `?tradeNo=` so the page
  // surfaces its paid status the moment the gateway notify lands.
  const { data: justReturnedOrder } = useQuery<QuotaOrderView>({
    queryKey: ['quota-order', tradeNo],
    queryFn: async () =>
      (await api.get(`/api/quota-orders/${encodeURIComponent(tradeNo!)}`)).data,
    enabled: !!tradeNo,
    refetchInterval: (q) =>
      q.state.data && q.state.data.status === 'pending' ? 3_000 : false,
  });

  // When the just-returned order flips to `paid`, raise a toast and clear
  // the URL param so a refresh doesn't keep the polling running.
  useEffect(() => {
    if (justReturnedOrder?.status === 'paid') {
      toast(`支付成功 +${formatNumber(justReturnedOrder.emails)} 邮件已到账`, 'success');
      void qc.invalidateQueries({ queryKey: ['quota-orders'] });
      void qc.invalidateQueries({ queryKey: ['me', 'quota'] });
      setParams({});
    }
  }, [justReturnedOrder?.status, justReturnedOrder?.emails]);

  // Show the just-returned order at the top if the list query is slower
  // than the single-order query (keeps the redirect feel snappy).
  const merged = useMemo(() => {
    if (!justReturnedOrder) return orders;
    if (orders.some((o) => o.id === justReturnedOrder.id)) return orders;
    return [justReturnedOrder, ...orders];
  }, [justReturnedOrder, orders]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">我的订单</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          通过「购买额度」自助购买的已支付订单记录。
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {/* 7 columns can't fit a phone — wrap with horizontal scroll
              instead of trying to hide columns. min-w on the table forces
              the row to its natural width inside the scroll container. */}
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">订单号</th>
                <th className="px-4 py-3 font-medium">购买额度</th>
                <th className="px-4 py-3 font-medium">USD 售价</th>
                <th className="px-4 py-3 font-medium">CNY 实付</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">下单时间</th>
                <th className="px-4 py-3 font-medium">支付时间</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeletonRows columns={7} />}
              {!isLoading && merged.length === 0 && <EmptyStateRow colSpan={7} />}
              {merged.map((o) => (
                <tr key={o.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{o.providerOrderId}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">
                    +{formatNumber(o.emails)}
                  </td>
                  <td className="px-4 py-3 tabular-nums">US${o.amountUsd}</td>
                  <td className="px-4 py-3 tabular-nums">
                    ¥{o.amountCny.toFixed(2)}{' '}
                    <span className="text-xs text-muted-foreground">
                      @ {o.fxRate.toFixed(4)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <OrderStatusBadge status={o.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(o.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDateTime(o.paidAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: QuotaOrderView['status'] }) {
  if (status === 'paid') return <Badge variant="success">已支付</Badge>;
  if (status === 'pending') return <Badge variant="warning">待支付</Badge>;
  if (status === 'failed') return <Badge variant="danger">失败</Badge>;
  return <Badge variant="muted">已取消</Badge>;
}
