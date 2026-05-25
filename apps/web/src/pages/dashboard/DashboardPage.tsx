import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Users, Send, ShoppingCart, MailOpen, Plus, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/utils';
import { useAuth } from '@/store/auth';
import type { TenantQuotaView } from '@sendmast/shared';

interface DashboardSummary {
  contacts: { total: number; subscribed: number };
  campaigns: { draft: number; scheduled: number; sending: number; sent: number };
  metrics30d: { sent: number; uniqueOpens: number; openRate: number };
  shopConnected: boolean;
  sales: { revenue: number; orders: number; aov: number };
}

export function DashboardPage() {
  const { user, account } = useAuth();
  const accountStatus = account?.status;
  const canCreate = !accountStatus || accountStatus === 'active';
  const disabledHint =
    accountStatus === 'pending_activation'
      ? '请先激活账号(点击注册邮箱里的激活链接)后再创建活动。'
      : accountStatus === 'suspended'
        ? '账号已被封禁,无法创建活动。'
        : '';

  const { data, isLoading } = useQuery<DashboardSummary>({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get('/api/dashboard/summary')).data,
  });
  const { data: quota } = useQuery<TenantQuotaView>({
    queryKey: ['me', 'quota'],
    queryFn: async () => (await api.get('/api/accounts/me/quota')).data,
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            欢迎，{user?.displayName ?? '朋友'} 👋
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{account?.name} 的运营概览</p>
        </div>
        {canCreate ? (
          <Button asChild>
            <Link to="/campaigns/new">
              <Plus className="mr-1 size-4" />
              新建营销活动
            </Link>
          </Button>
        ) : (
          <Button disabled title={disabledHint}>
            <Plus className="mr-1 size-4" />
            新建营销活动
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<Wallet className="size-5" />}
          label="剩余发送额度"
          value={quota ? formatNumber(quota.remaining) : '...'}
          tone={
            quota?.remaining === 0
              ? 'destructive'
              : (quota?.remaining ?? 0) < 1000
                ? 'amber'
                : 'primary'
          }
          link="/settings/quota"
        />
        <StatCard
          icon={<Users className="size-5" />}
          label="联系人总数"
          value={isLoading ? '...' : formatNumber(data?.contacts.total ?? 0)}
          tone="emerald"
          link="/contacts"
        />
        <StatCard
          icon={<Send className="size-5" />}
          label="近 30 日发送量"
          value={isLoading ? '...' : formatNumber(data?.metrics30d.sent ?? 0)}
          tone="blue"
          link="/campaigns"
        />
        <StatCard
          icon={<MailOpen className="size-5" />}
          label="近 30 日打开率"
          value={
            isLoading
              ? '...'
              : `${((data?.metrics30d.openRate ?? 0) * 100).toFixed(1)}%`
          }
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">活动状态</h2>
              <Button asChild variant="ghost" size="sm">
                <Link to="/campaigns">查看全部</Link>
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <StatusItem label="草稿" value={data?.campaigns.draft ?? 0} variant="muted" />
              <StatusItem label="已定时" value={data?.campaigns.scheduled ?? 0} variant="warning" />
              <StatusItem label="发送中" value={data?.campaigns.sending ?? 0} variant="default" />
              <StatusItem label="已完成" value={data?.campaigns.sent ?? 0} variant="success" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">销售概览</h2>
              <Badge variant="muted">即将上线</Badge>
            </div>
            {data?.shopConnected ? (
              <div>...</div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <ShoppingCart className="mb-2 size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  尚未关联店铺。在 v0.5 版本中可接入 Shopify / WooCommerce / 自建店铺，看到邮件带来的销售额。
                </p>
                <Button variant="outline" size="sm" className="mt-4" disabled>
                  关联店铺（即将开放）
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const TONE_BG: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  emerald: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  blue: 'bg-blue-100 text-blue-700',
  destructive: 'bg-destructive/10 text-destructive',
};

function StatCard({
  icon,
  label,
  value,
  tone,
  link,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone: keyof typeof TONE_BG;
  link?: string;
}) {
  const inner = (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold">{value}</div>
        </div>
        <div className={`flex size-10 items-center justify-center rounded-lg ${TONE_BG[tone]}`}>
          {icon}
        </div>
      </CardContent>
    </Card>
  );
  return link ? <Link to={link}>{inner}</Link> : inner;
}

function StatusItem({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'success' | 'warning' | 'default' | 'muted';
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Badge variant={variant}>{formatNumber(value)}</Badge>
      </div>
    </div>
  );
}
