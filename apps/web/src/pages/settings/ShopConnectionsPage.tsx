import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Store, Unplug, Info, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Link } from 'react-router-dom';
import { api, apiErrMessage } from '@/lib/api';
import type { ShopConnectionView } from '@sendmast/shared';

interface ShopConnectionsResponse {
  configured: boolean;
  connections: ShopConnectionView[];
}

const STATUS_BADGE: Record<
  ShopConnectionView['status'],
  { label: string; variant: 'success' | 'warning' | 'muted' }
> = {
  active: { label: '已连接', variant: 'success' },
  expired: { label: '已过期', variant: 'warning' },
  revoked: { label: '已解绑', variant: 'muted' },
};

export function ShopConnectionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const { data, isLoading } = useQuery<ShopConnectionsResponse>({
    queryKey: ['shop-connections'],
    queryFn: async () => (await api.get('/api/integrations/shopyy')).data,
  });

  const disconnectMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/integrations/shopyy/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-connections'] });
      toast('已解绑店铺', 'success');
    },
    onError: (err) => toast(apiErrMessage(err), 'error'),
  });

  const connections = data?.connections ?? [];
  const active = connections.filter((c) => c.status !== 'revoked');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">店铺连接</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          连接 Shopyy（OEMSAAS）店铺后，可统计邮件带来的订单与销售额。订单/发货/弃单等自动化邮件请在
          <Link to="/automations" className="mx-1 font-medium text-primary hover:underline">
            自动化
          </Link>
          菜单中配置。
        </p>
      </div>

      {!isLoading && data && !data.configured && (
        <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium">店铺集成尚未配置</div>
            <p className="mt-0.5 text-amber-800/90">
              平台尚未配置 Shopyy 应用密钥（需与官方合作获取）。配置完成前无法绑定店铺。
            </p>
          </div>
        </div>
      )}

      <ConnectHint configured={data?.configured ?? false} />

      <div className="space-y-3">
        {isLoading && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">加载中...</CardContent>
          </Card>
        )}

        {!isLoading && active.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <Store className="mb-2 size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">尚未连接任何店铺。</p>
            </CardContent>
          </Card>
        )}

        {active.map((c) => {
          const badge = STATUS_BADGE[c.status];
          return (
            <Card key={c.id}>
              <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                    <Store className="size-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.shopName ?? c.shopDomain ?? '店铺'}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {c.shopDomain ?? c.mainDomain ?? `店铺 #${c.externalStoreId}`}
                      {' · '}连接于 {new Date(c.connectedAt).toLocaleString('zh-CN')}
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const ok = await confirm({
                      title: '解绑店铺？',
                      description: '解绑后将停止统计该店铺订单并暂停相关自动化，历史数据保留。',
                      variant: 'danger',
                      confirmLabel: '解绑',
                    });
                    if (ok) disconnectMut.mutate(c.id);
                  }}
                >
                  <Unplug className="mr-1 size-4" />
                  解绑
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ConnectHint({ configured }: { configured: boolean }) {
  return (
    <div className="flex gap-3 rounded-lg border border-blue-100 bg-blue-50/60 p-4 text-sm text-blue-900">
      <Info className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <div className="space-y-1">
        <div className="font-medium">如何连接店铺？</div>
        <ol className="list-decimal space-y-0.5 pl-5 text-blue-800/90">
          <li>在 Shopyy 后台的应用市场中找到并安装 SendMast 应用。</li>
          <li>在授权页点击「同意授权」，Shopyy 会跳转回 SendMast 完成绑定。</li>
          <li>绑定成功后即可在此查看店铺状态、配置自动化邮件。</li>
        </ol>
        {configured && (
          <div className="flex items-center gap-1 pt-1 text-emerald-700">
            <CheckCircle2 className="size-3.5" /> 集成已配置，可进行授权绑定。
          </div>
        )}
      </div>
    </div>
  );
}
